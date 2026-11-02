"""The clip-finding pipeline: ingest → transcribe → features → propose → review → rank.

Every stage writes its output to ./data/{project_id}/ and is skipped on re-run if
that output already exists, so iterating on prompts doesn't re-transcribe.
"""

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from pydantic import TypeAdapter

from . import config, features, ingest, llm, media, ranking, transcribe
from .ranking import ClipResult
from .transcribe import Sentence, Transcript

log = logging.getLogger(__name__)

ProgressFn = Callable[[str, float], None]  # (stage, percent 0..100)


@dataclass
class FindOptions:
    min_seconds: float = 15
    max_seconds: float = 60
    top_n: int = 10
    language: str | None = None
    use_llm: bool = True


def _noop(stage: str, pct: float) -> None:
    pass


def chunk_sentences(sentences: list[Sentence]) -> list[list[Sentence]]:
    """~20 min windows overlapping by ~2 min, split on sentence boundaries."""
    if not sentences:
        return []
    chunks, t0, total = [], 0.0, sentences[-1].end
    step = config.CHUNK_SECONDS - config.CHUNK_OVERLAP_SECONDS
    while True:
        chunk = [s for s in sentences if t0 <= s.start < t0 + config.CHUNK_SECONDS]
        if chunk:
            chunks.append(chunk)
        if t0 + config.CHUNK_SECONDS >= total:
            return chunks
        t0 += step


def _candidates_for_chunk(minutes: float) -> int:
    return max(4, min(20, round(minutes * 0.6)))


def _clamp10(x: int) -> float:
    return max(0, min(10, x)) / 10


def _duration(sentences: list[Sentence], a: int, b: int) -> float:
    return sentences[b].end - sentences[a].start


def _llm_candidates(
    chunk: list[Sentence], all_sentences: list[Sentence], feats: features.AudioFeatures,
    opts: FindOptions,
) -> list[dict]:
    lo, hi = chunk[0].id, chunk[-1].id
    minutes = (chunk[-1].end - chunk[0].start) / 60
    peaks = [p for p in feats.peaks(n=40) if chunk[0].start <= p[0] <= chunk[-1].end][:10]

    proposals = llm.propose(
        chunk, min_seconds=opts.min_seconds, max_seconds=opts.max_seconds,
        n_candidates=_candidates_for_chunk(minutes), excitement_peaks=peaks,
    )
    valid: list[tuple[int, llm.ProposedClip]] = []
    for p in proposals:
        a, b = sorted((p.start_sentence, p.end_sentence))
        if a < lo or b > hi:
            log.warning("dropping out-of-range proposal S%s–S%s", a, b)
            continue
        p.start_sentence, p.end_sentence = a, b
        valid.append((len(valid), p))
    if not valid:
        return []

    reviews = {r.candidate_id: r for r in llm.review(
        chunk, valid, min_seconds=opts.min_seconds, max_seconds=opts.max_seconds)}

    out = []
    for cid, p in valid:
        r = reviews.get(cid)
        if r is None or not r.keep:
            continue
        a, b = sorted((r.start_sentence, r.end_sentence))
        if a < lo or b > hi:
            a, b = p.start_sentence, p.end_sentence
        out.append({
            "start_sentence": a, "end_sentence": b,
            "title": p.title,
            "hook_text": all_sentences[a].text if a != p.start_sentence else p.hook_text,
            "reason": p.reason, "missing_context": r.missing_context,
            "scores": {
                "hook": _clamp10(r.hook), "payoff": _clamp10(p.payoff),
                "standalone": _clamp10(r.standalone), "quotability": _clamp10(p.quotability),
                "emotion": _clamp10(p.emotion),
            },
        })
    return out


_HOOKY = re.compile(r"\?|\d|\b(never|always|secret|mistake|nobody|worst|best|why|how)\b", re.I)


def _heuristic_candidates(sentences: list[Sentence], opts: FindOptions) -> list[dict]:
    """No-LLM fallback: windows of whole sentences near the target length."""
    target = (opts.min_seconds + opts.max_seconds) / 2
    out = []
    for i, s in enumerate(sentences):
        j = i
        while j + 1 < len(sentences) and _duration(sentences, i, j + 1) <= target:
            j += 1
        if _duration(sentences, i, j) < opts.min_seconds:
            continue
        hook = 0.7 if _HOOKY.search(s.text) else 0.3
        out.append({
            "start_sentence": i, "end_sentence": j,
            "title": s.text[:70], "hook_text": s.text,
            "reason": "audio excitement (heuristic mode, no LLM)", "missing_context": "",
            "scores": {"hook": hook, "payoff": 0.5, "standalone": 0.5, "quotability": 0.5, "emotion": 0.5},
        })
    return out


def find_clips(
    project_id: str,
    *,
    path: Path | None = None,
    url: str | None = None,
    opts: FindOptions | None = None,
    progress: ProgressFn = _noop,
) -> list[ClipResult]:
    opts = opts or FindOptions()
    d = ingest.project_dir(project_id)

    progress("ingest", 0)
    src = ingest.ingest(project_id, path=path, url=url)

    progress("transcribe", 10)
    tpath = d / "transcript.json"
    if tpath.exists():
        transcript = Transcript.load(tpath)
    else:
        transcript = transcribe.transcribe(src.audio, opts.language)
        transcript.save(tpath)
    sentences = transcript.sentences
    if not sentences:
        raise media.MediaError("no speech found in the video")

    progress("features", 40)
    spath, fpath = d / "silences.json", d / "features.npz"
    if spath.exists():
        silences = [tuple(x) for x in json.loads(spath.read_text())]
    else:
        silences = media.detect_silences(src.audio)
        spath.write_text(json.dumps(silences))
    if fpath.exists():
        feats = features.AudioFeatures.load(fpath)
    else:
        feats = features.extract(src.audio, transcript)
        feats.save(fpath)

    candidates: list[dict] = []
    if opts.use_llm:
        chunks = chunk_sentences(sentences)
        for i, chunk in enumerate(chunks):
            progress("find", 50 + 45 * i / len(chunks))
            model_tag = re.sub(r"[^\w.-]", "_", f"{config.LLM_PROVIDER}-{config.LLM_MODEL}")
            cache = d / f"llm_{model_tag}_{opts.min_seconds:g}-{opts.max_seconds:g}_{i}.json"
            if cache.exists():
                found = json.loads(cache.read_text())
            else:
                try:
                    found = _llm_candidates(chunk, sentences, feats, opts)
                except llm.LLMRefusal as e:
                    log.warning("chunk %d declined by the model: %s", i, e)
                    found = []
                cache.write_text(json.dumps(found))
            candidates.extend(found)
    else:
        progress("find", 50)
        candidates = _heuristic_candidates(sentences, opts)

    progress("rank", 95)
    clips: list[ClipResult] = []
    for c in candidates:
        a, b = c["start_sentence"], c["end_sentence"]
        dur = _duration(sentences, a, b)
        if not (opts.min_seconds * 0.8 <= dur <= opts.max_seconds * 1.25):
            continue
        start, end = ranking.snap(sentences, a, b, silences)
        scores = {**c["scores"], "audio_excitement": round(feats.mean_excitement(start, end), 3)}
        clips.append(ClipResult(
            start=start, end=end, start_sentence=a, end_sentence=b,
            title=c["title"], hook_text=c["hook_text"], reason=c["reason"],
            missing_context=c["missing_context"], scores=scores,
            virality=ranking.virality(scores),
            text=" ".join(s.text for s in sentences[a:b + 1]),
        ))

    ranked = ranking.dedupe(clips)[:opts.top_n]
    (d / "clips.json").write_text(
        TypeAdapter(list[ClipResult]).dump_json(ranked, indent=2).decode())
    progress("done", 100)
    return ranked
