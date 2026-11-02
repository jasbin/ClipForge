"""Worker process: polls the SQLite job table and runs the pipeline.

python -m clipforge.worker

Each job runs in its own child process (python -m clipforge.worker --job <id>) so a
running job can be stopped immediately (the API sets status "cancel_requested" and
the supervisor terminates the child), and GPU memory is released when a job ends.
"""

import argparse
import json
import logging
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import select

from . import db, voiceover
from .ingest import project_dir
from .media import probe
from .pipeline import FindOptions, find_clips
from .transcribe import Transcript

log = logging.getLogger("clipforge.worker")
POLL_SECONDS = 1.0
MAX_ATTEMPTS = 2


def _claim() -> db.Job | None:
    with db.session() as s:
        job = s.exec(select(db.Job).where(db.Job.status == "queued").order_by(db.Job.created_at)).first()
        if job is None:
            return None
        job.status, job.attempts, job.updated_at = "running", job.attempts + 1, datetime.now(timezone.utc)
        s.add(job)
        s.commit()
        s.refresh(job)
        return job


def _update_project(project_id: str, **fields) -> None:
    with db.session() as s:
        p = s.get(db.Project, project_id)
        for k, v in fields.items():
            setattr(p, k, v)
        s.add(p)
        s.commit()


def run_find(job: db.Job) -> None:
    with db.session() as s:
        project = s.get(db.Project, job.project_id)
        settings = json.loads(project.settings_json)
        path = Path(project.source_path) if project.source_path else None
        url = project.source_url

    last = [0.0]

    def progress(stage: str, pct: float) -> None:
        # Throttle DB writes; always record stage changes.
        if pct - last[0] >= 1 or pct in (0, 100) or stage != "find":
            last[0] = pct
            _update_project(job.project_id, stage=stage, progress=round(pct, 1), status="running")

    clips = find_clips(job.project_id, path=path, url=url, opts=FindOptions(**settings), progress=progress)

    d = project_dir(job.project_id)
    transcript = Transcript.load(d / "transcript.json")
    source = next(p for p in d.glob("source.*") if p.suffix != ".part")
    with db.session() as s:
        for old in s.exec(select(db.Clip).where(db.Clip.project_id == job.project_id)):
            s.delete(old)
        existing = s.get(db.Transcript, job.project_id)
        if existing:
            s.delete(existing)
        s.add(db.Transcript(
            project_id=job.project_id, language=transcript.language,
            words_json=json.dumps([w.model_dump() for w in transcript.words]),
            sentences_json=json.dumps([x.model_dump() for x in transcript.sentences]),
        ))
        for rank, c in enumerate(clips, 1):
            s.add(db.Clip(
                project_id=job.project_id, rank=rank, start=c.start, end=c.end, title=c.title,
                hook=c.hook_text, reason=c.reason, missing_context=c.missing_context,
                scores_json=json.dumps(c.scores), virality=c.virality, text=c.text,
            ))
        p = s.get(db.Project, job.project_id)
        p.status, p.stage, p.progress, p.error = "done", "done", 100.0, None
        p.duration = probe(source).duration
        s.add(p)
        s.commit()


def _update_clip(clip_id: str, **fields) -> None:
    with db.session() as s:
        c = s.get(db.Clip, clip_id)
        for k, v in fields.items():
            setattr(c, k, v)
        s.add(c)
        s.commit()


def run_voiceover(job: db.Job) -> None:
    params = json.loads(job.params_json or "{}")
    with db.session() as s:
        clip = s.get(db.Clip, job.clip_id)
        if clip is None:  # clip was replaced by a re-run of clip finding
            log.info("voiceover job %s: clip %s no longer exists", job.id, job.clip_id)
            return
        start, end = clip.start, clip.end
    d = project_dir(job.project_id)
    transcript = Transcript.load(d / "transcript.json")
    source = next(p for p in d.glob("source.*") if ".part" not in p.suffixes)

    _update_clip(job.clip_id, voice_status="running", voice_progress=0.0, voice_error=None)
    try:
        out = voiceover.revoice_clip(
            source, transcript.sentences, start, end, d / "voiceover", job.clip_id,
            voice_id=params.get("voice_id") or voiceover.DEFAULT_VOICE,
            style=params.get("style", ""),
            language=transcript.language,
            script=params.get("script"),
            original_volume=float(params.get("original_volume", 0.0)),
            progress=lambda done, total: _update_clip(job.clip_id, voice_progress=round(100 * done / total, 1)),
        )
    except Exception as e:
        _update_clip(job.clip_id, voice_status="error", voice_error=f"{type(e).__name__}: {e}")
        raise
    _update_clip(job.clip_id, voice_status="done", voice_progress=100.0, voice_path=str(out))


HANDLERS = {"find": run_find, "voiceover": run_voiceover}


def _set_job(job_id: str, **fields) -> None:
    with db.session() as s:
        j = s.get(db.Job, job_id)
        for k, v in fields.items():
            setattr(j, k, v)
        j.updated_at = datetime.now(timezone.utc)
        s.add(j)
        s.commit()


def execute(job_id: str) -> None:
    """Run one claimed job to completion (inside the child process)."""
    with db.session() as s:
        job = s.get(db.Job, job_id)
    log.info("job %s (%s) for project %s", job.id, job.kind, job.project_id)
    try:
        HANDLERS[job.kind](job)
        status, error = "done", None
    except Exception as e:  # noqa: BLE001 — record every failure on the job
        log.error("job %s failed:\n%s", job.id, traceback.format_exc())
        retryable = job.kind == "find" and job.attempts < MAX_ATTEMPTS
        status = "queued" if retryable else "error"
        error = f"{type(e).__name__}: {e}"
        if status == "error" and job.kind == "find":
            _update_project(job.project_id, status="error", error=error)
    _set_job(job.id, status=status, error=error)


def mark_cancelled(job: db.Job) -> None:
    _set_job(job.id, status="cancelled", error="stopped by user")
    if job.kind == "find":
        _update_project(job.project_id, status="cancelled", error=None)
    elif job.kind == "voiceover" and job.clip_id:
        with db.session() as s:
            if s.get(db.Clip, job.clip_id):
                _update_clip(job.clip_id, voice_status="cancelled", voice_error=None)


def run_once() -> bool:
    """Claim the next job and supervise its child process until it ends or is stopped."""
    job = _claim()
    if job is None:
        return False
    child = subprocess.Popen([sys.executable, "-m", "clipforge.worker", "--job", job.id])
    while child.poll() is None:
        time.sleep(POLL_SECONDS)
        with db.session() as s:
            status = s.get(db.Job, job.id).status
        if status == "cancel_requested":
            log.info("stopping job %s", job.id)
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            mark_cancelled(job)
            return True

    with db.session() as s:
        status = s.get(db.Job, job.id).status
    if status == "cancel_requested":  # stop arrived just as the job finished
        mark_cancelled(job)
    elif status == "running":  # child died without recording a result (crash / OOM)
        error = f"worker process exited with code {child.returncode}"
        _set_job(job.id, status="error", error=error)
        if job.kind == "find":
            _update_project(job.project_id, status="error", error=error)
        elif job.clip_id:
            _update_clip(job.clip_id, voice_status="error", voice_error=error)
    return True


def recover_stale() -> None:
    """Jobs left 'running' by a crashed worker go back to the queue."""
    with db.session() as s:
        for j in s.exec(select(db.Job).where(db.Job.status == "running")):
            j.status = "queued"
            s.add(j)
        stopping = list(s.exec(select(db.Job).where(db.Job.status == "cancel_requested")))
        for c in s.exec(select(db.Clip).where(db.Clip.voice_status == "running")):
            c.voice_status, c.voice_progress = "queued", 0.0
            s.add(c)
        s.commit()
    for j in stopping:
        mark_cancelled(j)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", help="run this one job and exit (used by the supervisor)")
    args = ap.parse_args()
    if args.job:
        execute(args.job)
        return

    db.init_db()
    recover_stale()
    log.info("worker started")
    try:
        voiceover.ensure_speaker_previews()  # one-time: samples for the Voices page
    except Exception:  # noqa: BLE001 — previews are optional
        log.warning("could not render speaker previews:\n%s", traceback.format_exc())
    while True:
        if not run_once():
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
