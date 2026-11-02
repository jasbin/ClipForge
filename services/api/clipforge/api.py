"""FastAPI app: projects, clips, progress (SSE) and media.

uvicorn clipforge.api:app --reload
"""

import asyncio
import hashlib
import json
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlmodel import delete, select

from . import captions, config, db, llm, media, music, voiceover
from .ingest import project_dir
from .transcribe import Sentence, Word


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="ClipForge API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media", StaticFiles(directory=config.DATA_DIR), name="media")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "llm_provider": config.LLM_PROVIDER, "llm_model": config.LLM_MODEL}


@app.post("/projects", status_code=201)
async def create_project(
    file: UploadFile | None = File(None),
    url: str | None = Form(None),
    title: str | None = Form(None),
    min_seconds: float = Form(15),
    max_seconds: float = Form(60),
    top_n: int = Form(10),
    language: str | None = Form(None),
    use_llm: bool = Form(True),
) -> db.Project:
    if (file is None) == (not url):
        raise HTTPException(400, "provide exactly one of file or url")
    if not 5 <= min_seconds < max_seconds <= 180:
        raise HTTPException(400, "need 5 <= min_seconds < max_seconds <= 180")

    settings = {"min_seconds": min_seconds, "max_seconds": max_seconds,
                "top_n": max(1, min(top_n, 50)), "language": language or None, "use_llm": use_llm}
    project = db.Project(title=title or (file.filename if file else url), source_url=url,
                         settings_json=json.dumps(settings))
    if file is not None:
        suffix = "." + file.filename.rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ".mp4"
        dest = project_dir(project.id) / f"upload{suffix}"
        with dest.open("wb") as out:
            await asyncio.to_thread(shutil.copyfileobj, file.file, out, 8 * 1024 * 1024)
        project.source_path = str(dest)

    with db.session() as s:
        s.add(project)
        s.add(db.Job(project_id=project.id, kind="find"))
        s.commit()
        s.refresh(project)
        return project


@app.get("/projects")
def list_projects() -> list[dict]:
    with db.session() as s:
        counts = dict(s.exec(select(db.Clip.project_id, func.count()).group_by(db.Clip.project_id)).all())
        projects = s.exec(select(db.Project).order_by(db.Project.created_at.desc()))
        return [{**p.model_dump(), "clip_count": counts.get(p.id, 0)} for p in projects]


def _get_project(project_id: str) -> db.Project:
    with db.session() as s:
        p = s.get(db.Project, project_id)
        if p is None:
            raise HTTPException(404, "project not found")
        return p


@app.get("/projects/{project_id}")
def get_project(project_id: str) -> db.Project:
    return _get_project(project_id)


@app.get("/projects/{project_id}/clips")
def list_clips(project_id: str) -> list[dict]:
    _get_project(project_id)
    with db.session() as s:
        clips = s.exec(select(db.Clip).where(db.Clip.project_id == project_id).order_by(db.Clip.rank))
        return [{**c.model_dump(exclude={"scores_json", "script_json", "caption_style_json"}),
                 "scores": json.loads(c.scores_json),
                 "script": json.loads(c.script_json) if c.script_json else None,
                 "caption_style": json.loads(c.caption_style_json) if c.caption_style_json else None}
                for c in clips]


@app.get("/projects/{project_id}/transcript")
def get_transcript(project_id: str) -> dict:
    _get_project(project_id)
    with db.session() as s:
        t = s.get(db.Transcript, project_id)
        if t is None:
            raise HTTPException(404, "no transcript yet")
        return {"language": t.language, "sentences": json.loads(t.sentences_json)}


@app.post("/projects/{project_id}/retry")
def retry_project(project_id: str) -> db.Project:
    """Re-run clip finding. Cached stages (download, transcript, features) are reused."""
    with db.session() as s:
        p = s.get(db.Project, project_id)
        if p is None:
            raise HTTPException(404, "project not found")
        if p.status in ("queued", "running"):
            raise HTTPException(409, "project is already processing")
        p.status, p.stage, p.progress, p.error = "queued", "queued", 0.0, None
        s.add(p)
        s.add(db.Job(project_id=project_id, kind="find"))
        s.commit()
        s.refresh(p)
        return p


def _cancel_jobs(query) -> int:
    """Cancel queued jobs now; flag running ones for the worker to stop. Returns how many."""
    n = 0
    with db.session() as s:
        for job in s.exec(query.where(db.Job.status.in_(("queued", "running")))):
            job.status = "cancelled" if job.status == "queued" else "cancel_requested"
            job.error = "stopped by user" if job.status == "cancelled" else None
            s.add(job)
            n += 1
        s.commit()
    return n


@app.post("/projects/{project_id}/cancel")
def cancel_project(project_id: str) -> db.Project:
    """Stop clip finding for this project (also its queued/running voiceovers)."""
    _get_project(project_id)
    found = _cancel_jobs(select(db.Job).where(db.Job.project_id == project_id))
    if not found:
        raise HTTPException(409, "nothing is running for this project")
    with db.session() as s:
        p = s.get(db.Project, project_id)
        if p.status == "queued":  # never started: cancelled right away
            p.status = "cancelled"
            s.add(p)
        for c in s.exec(select(db.Clip).where(db.Clip.project_id == project_id,
                                              db.Clip.voice_status == "queued")):
            c.voice_status = "cancelled"
            s.add(c)
        s.commit()
        s.refresh(p)
        return p


@app.post("/clips/{clip_id}/voiceover/cancel")
def cancel_voiceover(clip_id: str) -> dict:
    clip = _get_clip(clip_id)
    found = _cancel_jobs(select(db.Job).where(db.Job.clip_id == clip_id, db.Job.kind == "voiceover"))
    if not found:
        raise HTTPException(409, "no voiceover is running for this clip")
    if clip.voice_status == "queued":
        with db.session() as s:
            c = s.get(db.Clip, clip_id)
            c.voice_status = "cancelled"
            s.add(c)
            s.commit()
    return {"ok": True}


@app.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str) -> None:
    with db.session() as s:
        p = s.get(db.Project, project_id)
        if p is None:
            raise HTTPException(404, "project not found")
        if p.status == "running":
            raise HTTPException(409, "project is processing; delete it when it finishes")
        for model in (db.Clip, db.Job, db.Transcript):
            s.exec(delete(model).where(model.project_id == project_id))
        s.delete(p)
        s.commit()
    d = (config.DATA_DIR / project_id).resolve()
    if d.parent == config.DATA_DIR and d.is_dir():
        shutil.rmtree(d)


def _get_clip(clip_id: str) -> db.Clip:
    with db.session() as s:
        clip = s.get(db.Clip, clip_id)
        if clip is None:
            raise HTTPException(404, "clip not found")
        return clip


def _slug(text: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in text.lower()).strip("-")[:60] or "clip"


@app.get("/clips/{clip_id}/download")
async def download_clip(clip_id: str) -> FileResponse:
    """MP4 cut from the full-quality source (cached after the first request)."""
    clip = _get_clip(clip_id)
    d = project_dir(clip.project_id)
    sources = [p for p in d.glob("source.*") if ".part" not in p.suffixes]
    if not sources:
        raise HTTPException(404, "source video missing")
    out = d / "clips" / f"{clip.id}_{clip.start:.2f}-{clip.end:.2f}.mp4"
    if not out.exists():
        out.parent.mkdir(exist_ok=True)
        try:
            await asyncio.to_thread(media.cut_clip, sources[0], out, clip.start, clip.end)
        except media.MediaError as e:
            raise HTTPException(500, str(e)) from e
    return FileResponse(out, media_type="video/mp4", filename=f"{clip.rank:02d}-{_slug(clip.title)}.mp4")


@app.get("/clips/{clip_id}/srt")
def clip_srt(clip_id: str) -> PlainTextResponse:
    clip = _get_clip(clip_id)
    with db.session() as s:
        t = s.get(db.Transcript, clip.project_id)
    if t is None:
        raise HTTPException(404, "no transcript")
    words = [Word(**w) for w in json.loads(t.words_json)]
    name = f"{clip.rank:02d}-{_slug(clip.title)}.srt"
    return PlainTextResponse(captions.srt_for_range(words, clip.start, clip.end),
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


def _words(project_id: str) -> list[Word]:
    with db.session() as s:
        t = s.get(db.Transcript, project_id)
    if t is None:
        raise HTTPException(404, "no transcript")
    return [Word(**w) for w in json.loads(t.words_json)]


@app.get("/projects/{project_id}/captions")
def project_captions(project_id: str, words_per_line: int = 3,
                     start: float | None = None, end: float | None = None) -> dict:
    """Word-timed caption lines (absolute times), the same ones the captioned export burns in."""
    _get_project(project_id)
    cues = captions.build_cues(_words(project_id), max(1, min(words_per_line, 8)), start, end)
    return {"cues": [c.model_dump() for c in cues]}


CaptionSource = Literal["original", "voiceover"]
_voice_words_lock = asyncio.Lock()


def _voiceover_files(clip: db.Clip) -> tuple[Path, Path]:
    if clip.voice_status != "done" or not clip.voice_path or not Path(clip.voice_path).exists():
        raise HTTPException(404, "this clip has no finished voiceover")
    mp4 = Path(clip.voice_path)
    return mp4, mp4.with_suffix(".wav")


async def _voiceover_words(clip: db.Clip) -> list[Word]:
    """Clip-relative word timings of the generated narration (timed once, then cached)."""
    mp4, wav = _voiceover_files(clip)
    path = voiceover.words_path(mp4.parent, clip.id)
    async with _voice_words_lock:
        # Re-time if the voiceover was re-generated after these timings were made.
        if not path.exists() or path.stat().st_mtime < mp4.stat().st_mtime:
            if not wav.exists():
                raise HTTPException(404, "voiceover audio missing; re-generate the voiceover")
            with db.session() as s:
                t = s.get(db.Transcript, clip.project_id)
            await asyncio.to_thread(voiceover.caption_words, wav, None, t.language if t else None, path)
    return [Word(**w) for w in json.loads(path.read_text())]


@app.get("/clips/{clip_id}/captions")
async def clip_captions(clip_id: str, source: CaptionSource = "original", words_per_line: int = 3) -> dict:
    """Caption lines for one clip. Original: absolute times into the source video.
    Voiceover: times into the voiceover MP4 (starting at 0), following the generated speech."""
    clip = _get_clip(clip_id)
    wpl = max(1, min(words_per_line, 8))
    if source == "voiceover":
        cues = captions.build_cues(await _voiceover_words(clip), wpl, 0.0, clip.end - clip.start)
    else:
        cues = captions.build_cues(_words(clip.project_id), wpl, clip.start, clip.end)
    return {"cues": [c.model_dump() for c in cues]}


def _save_caption_style(clip_id: str, style: captions.CaptionStyle) -> None:
    with db.session() as s:
        clip = s.get(db.Clip, clip_id)
        if clip is None:
            raise HTTPException(404, "clip not found")
        clip.caption_style_json = style.model_dump_json()
        s.add(clip)
        s.commit()


@app.put("/clips/{clip_id}/caption-style")
def save_caption_style(clip_id: str, style: captions.CaptionStyle) -> captions.CaptionStyle:
    _save_caption_style(clip_id, style)
    return style


class MusicChoice(BaseModel):
    track_id: str
    volume: float = Field(0.15, ge=0, le=1)
    offset: float = Field(0.0, ge=0)
    duck: bool = True


class ExportRequest(BaseModel):
    style: captions.CaptionStyle = captions.CaptionStyle()
    captions: bool = True
    source: CaptionSource = "original"
    music: MusicChoice | None = None


@app.post("/clips/{clip_id}/export")
async def export_clip(clip_id: str, req: ExportRequest) -> FileResponse:
    """Final MP4: original audio or AI voiceover, word-highlighted captions, optional 9:16 reframe
    and background music. Cached per settings; the first render takes a while."""
    clip = _get_clip(clip_id)
    style = req.style
    if req.captions:
        _save_caption_style(clip_id, style)
    d = project_dir(clip.project_id)
    duration = clip.end - clip.start
    if req.source == "voiceover":
        video, _ = _voiceover_files(clip)
        seg_start, version = 0.0, f"{video.stat().st_mtime_ns}"
    else:
        sources = [p for p in d.glob("source.*") if ".part" not in p.suffixes]
        if not sources:
            raise HTTPException(404, "source video missing")
        video, seg_start, version = sources[0], clip.start, ""
    mix = None
    if req.music:
        if music.get_track(req.music.track_id) is None:
            raise HTTPException(404, "music track not found")
        mix = media.MusicMix(music.track_path(req.music.track_id), req.music.volume, req.music.offset, req.music.duck)
    key = hashlib.sha1(f"{version}-{clip.start:.3f}-{clip.end:.3f}-{req.model_dump_json()}".encode()).hexdigest()[:12]
    out_dir = d / "exports"
    out = out_dir / f"{clip.id}_{key}.mp4"
    if not out.exists():
        out_dir.mkdir(exist_ok=True)
        ass = None
        if req.captions:
            words = await _voiceover_words(clip) if req.source == "voiceover" else _words(clip.project_id)
            cues = captions.build_cues(words, style.words_per_line, seg_start, seg_start + duration)
            w, h = await asyncio.to_thread(media.caption_canvas, video, style.format)
            ass = out_dir / f"{clip.id}_{key}.ass"
            ass.write_text(captions.ass_for_cues(cues, style, w, h, offset=seg_start), encoding="utf-8")
        try:
            await asyncio.to_thread(media.render_export, video, out, seg_start, seg_start + duration,
                                    fmt=style.format, ass=ass, music=mix)
        except media.MediaError as e:
            raise HTTPException(500, str(e)) from e
    tags = [t for t, on in (("voiceover", req.source == "voiceover"), ("captions", req.captions),
                            ("music", bool(mix)), ("vertical", style.format != "original")) if on]
    return FileResponse(out, media_type="video/mp4",
                        filename=f"{clip.rank:02d}-{_slug(clip.title)}{''.join('-' + t for t in tags)}.mp4")


def _clip_lines(clip: db.Clip) -> tuple[list[tuple[str, float, float]], str]:
    with db.session() as s:
        t = s.get(db.Transcript, clip.project_id)
    if t is None:
        raise HTTPException(404, "no transcript")
    sentences = [Sentence(**x) for x in json.loads(t.sentences_json)]
    return voiceover.clip_segments(sentences, clip.start, clip.end), t.language


@app.get("/clips/{clip_id}/script")
def original_script(clip_id: str) -> dict:
    """The clip's narration as timed lines — the starting point for editing."""
    segments, language = _clip_lines(_get_clip(clip_id))
    return {"language": language, "lines": [
        {"text": text, "original": text, "start": a, "end": b, "max_words": max(3, int((b - a) * 2.4))}
        for text, a, b in segments
    ]}


@app.post("/clips/{clip_id}/script")
async def write_script(clip_id: str, instructions: str = Form("")) -> dict:
    """Have the LLM write new narration, line by line, timed to the original."""
    if len(instructions) > 500:
        raise HTTPException(400, "instructions must be under 500 characters")
    segments, language = _clip_lines(_get_clip(clip_id))
    if not segments:
        raise HTTPException(400, "no speech in this clip")
    try:
        new = await asyncio.to_thread(
            llm.rewrite_script, [(text, b - a) for text, a, b in segments],
            instructions=instructions, language=language)
    except Exception as e:  # noqa: BLE001 — surface LLM/connection errors to the UI
        raise HTTPException(502, f"script writer failed: {type(e).__name__}: {e}") from e
    script = {"direction": instructions, "language": language, "lines": [
        {"text": text, "original": orig, "start": a, "end": b, "max_words": max(3, int((b - a) * 2.4))}
        for text, (orig, a, b) in zip(new, segments)
    ]}
    _save_script(clip_id, script)
    return script


def _save_script(clip_id: str, script: dict | None) -> None:
    with db.session() as s:
        clip = s.get(db.Clip, clip_id)
        if clip is None:
            raise HTTPException(404, "clip not found")
        clip.script_json = json.dumps(script) if script else None
        s.add(clip)
        s.commit()


class ScriptEdit(BaseModel):
    lines: list[str]
    direction: str | None = None


@app.put("/clips/{clip_id}/script")
def edit_script(clip_id: str, edit: ScriptEdit) -> dict:
    """Save your edits to the script's lines (the timing stays as written)."""
    clip = _get_clip(clip_id)
    if not clip.script_json:
        raise HTTPException(404, "this clip has no script yet")
    script = json.loads(clip.script_json)
    if len(edit.lines) != len(script["lines"]):
        raise HTTPException(400, f"expected {len(script['lines'])} lines, got {len(edit.lines)}")
    if any(len(t) > 1000 for t in edit.lines):
        raise HTTPException(400, "a line is too long")
    for line, text in zip(script["lines"], edit.lines):
        line["text"] = text
    if edit.direction is not None:
        script["direction"] = edit.direction[:500]
    _save_script(clip_id, script)
    return script


@app.delete("/clips/{clip_id}/script", status_code=204)
def discard_script(clip_id: str) -> None:
    _get_clip(clip_id)
    _save_script(clip_id, None)


@app.post("/clips/{clip_id}/voiceover", status_code=202)
def start_voiceover(
    clip_id: str,
    voice_id: str | None = Form(None),  # "qwen:<speaker>" or a saved recording; omitted = default
    style: str = Form(""),              # e.g. "Speak like an excited product presenter" (Qwen speakers)
    original_volume: float = Form(0.0),
    script: str | None = Form(None),    # JSON list of lines (one per transcript line); omitted = exact words
) -> dict:
    """Queue a Qwen3-TTS re-voicing of this clip's exact transcript."""
    if not 0.0 <= original_volume <= 1.0:
        raise HTTPException(400, "original_volume must be 0–1")
    if len(style) > 300:
        raise HTTPException(400, "style must be under 300 characters")
    lines = None
    if script:
        try:
            lines = json.loads(script)
            assert isinstance(lines, list) and all(isinstance(x, str) for x in lines)
        except (ValueError, AssertionError):
            raise HTTPException(400, "script must be a JSON list of strings") from None
    voice_id = voice_id or voiceover.list_voices()["default"]
    if not voiceover.valid_voice(voice_id):
        raise HTTPException(404, "voice not found")
    # Remember the choice so it's preselected next time.
    voiceover.set_default_voice(voice_id)

    with db.session() as s:
        clip = s.get(db.Clip, clip_id)
        if clip is None:
            raise HTTPException(404, "clip not found")
        if clip.voice_status in ("queued", "running"):
            raise HTTPException(409, "voiceover already in progress")
        clip.voice_status, clip.voice_progress, clip.voice_error = "queued", 0.0, None
        s.add(clip)
        s.add(db.Job(project_id=clip.project_id, clip_id=clip_id, kind="voiceover",
                     params_json=json.dumps({"voice_id": voice_id, "style": style,
                                             "original_volume": original_volume, "script": lines})))
        s.commit()
    return {"ok": True, "voice_id": voice_id}


@app.get("/clips/{clip_id}/voiceover")
def download_voiceover(clip_id: str) -> FileResponse:
    clip = _get_clip(clip_id)
    if clip.voice_status != "done" or not clip.voice_path or not Path(clip.voice_path).exists():
        raise HTTPException(404, "no voiceover yet")
    return FileResponse(clip.voice_path, media_type="video/mp4",
                        filename=f"{clip.rank:02d}-{_slug(clip.title)}-voiceover.mp4")


def _voices() -> dict:
    index = voiceover.list_voices()
    for v in index["voices"]:
        v["url"] = f"/media/voices/{v['id']}.wav"
    for sp in index["speakers"]:
        name = voiceover.preview_path(sp["id"]).name
        sp["url"] = f"/media/voices/previews/{name}" if sp.pop("preview") else None
    return {**index, "device": config.TTS_DEVICE, "engine": f"Qwen3-TTS {config.QWEN_TTS_SIZE}"}


@app.get("/voices")
def get_voices() -> dict:
    return _voices()


@app.post("/voices", status_code=201)
async def upload_voice(file: UploadFile = File(...), name: str = Form("My voice")) -> dict:
    """Save a reference recording (10–30 s of clean speech) for Qwen3-TTS to clone."""
    config.VOICES_DIR.mkdir(parents=True, exist_ok=True)
    raw = config.VOICES_DIR / f"upload-{uuid.uuid4().hex[:8]}{Path(file.filename or '').suffix}"
    with raw.open("wb") as out:
        await asyncio.to_thread(shutil.copyfileobj, file.file, out)
    try:
        await asyncio.to_thread(voiceover.add_voice, name, raw)
    except media.MediaError as e:
        raise HTTPException(400, f"could not read audio: {e}") from e
    finally:
        raw.unlink(missing_ok=True)
    return _voices()


@app.get("/music")
def list_music() -> list[dict]:
    return music.list_tracks()


@app.post("/music", status_code=201)
async def upload_music(file: UploadFile = File(...), name: str = Form("")) -> list[dict]:
    """Add a background track (any audio or video file; converted to AAC)."""
    config.MUSIC_DIR.mkdir(parents=True, exist_ok=True)
    raw = config.MUSIC_DIR / f"upload-{uuid.uuid4().hex[:8]}{Path(file.filename or '').suffix}"
    with raw.open("wb") as out:
        await asyncio.to_thread(shutil.copyfileobj, file.file, out)
    try:
        await asyncio.to_thread(music.add_track, name or Path(file.filename or "Untitled").stem, raw)
    except media.MediaError as e:
        raise HTTPException(400, f"could not read audio: {e}") from e
    finally:
        raw.unlink(missing_ok=True)
    return music.list_tracks()


@app.delete("/music/{track_id}")
def delete_music(track_id: str) -> list[dict]:
    music.delete_track(track_id)
    return music.list_tracks()


@app.post("/voices/default")
def set_default_voice(voice_id: str = Form(...)) -> dict:
    try:
        voiceover.set_default_voice(voice_id)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return _voices()


@app.delete("/voices/{voice_id}")
def delete_voice(voice_id: str) -> dict:
    if voiceover.is_speaker(voice_id):
        raise HTTPException(400, "Qwen's built-in speakers can't be deleted")
    voiceover.delete_voice(voice_id)
    return _voices()


@app.post("/clips/{clip_id}/feedback")
def clip_feedback(clip_id: str, value: int = Form(...)) -> dict:
    if value not in (-1, 0, 1):
        raise HTTPException(400, "value must be -1, 0 or 1")
    with db.session() as s:
        clip = s.get(db.Clip, clip_id)
        if clip is None:
            raise HTTPException(404, "clip not found")
        clip.feedback = value or None
        s.add(clip)
        s.commit()
    return {"ok": True}


@app.get("/projects/{project_id}/events")
async def project_events(project_id: str) -> StreamingResponse:
    """Server-Sent Events: stage/progress until the project finishes."""
    _get_project(project_id)

    async def stream():
        last = None
        while True:
            p = _get_project(project_id)
            state = {"status": p.status, "stage": p.stage, "progress": p.progress, "error": p.error}
            if state != last:
                yield f"data: {json.dumps(state)}\n\n"
                last = state
            if p.status in ("done", "error", "cancelled"):
                return
            await asyncio.sleep(0.5)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
