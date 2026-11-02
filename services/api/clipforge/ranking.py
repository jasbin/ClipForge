"""Boundary snapping, virality scoring and de-duplication (Stages 5–6)."""

import bisect

from pydantic import BaseModel

from . import config
from .transcribe import Sentence

START_PAD = 0.15
END_PAD = 0.30
SILENCE_REACH = 0.5  # how far past a word edge we look for a clean silence


class ClipResult(BaseModel):
    start: float
    end: float
    start_sentence: int
    end_sentence: int
    title: str
    hook_text: str
    reason: str
    missing_context: str = ""
    scores: dict[str, float]  # each 0..1
    virality: float           # 0..100
    text: str

    @property
    def duration(self) -> float:
        return self.end - self.start


def virality(scores: dict[str, float]) -> float:
    return round(100 * sum(w * scores.get(k, 0.0) for k, w in config.SCORE_WEIGHTS.items()), 1)


def snap(
    sentences: list[Sentence],
    start_id: int,
    end_id: int,
    silences: list[tuple[float, float]],
) -> tuple[float, float]:
    """Cut points on sentence edges, eased into the nearest silence, never mid-word."""
    first, last = sentences[start_id], sentences[end_id]
    prev_end = sentences[start_id - 1].end if start_id > 0 else 0.0
    next_start = sentences[end_id + 1].start if end_id + 1 < len(sentences) else None

    # Never pad into the neighbouring sentence: stop at the gap midpoint.
    start = max(first.start - START_PAD, (prev_end + first.start) / 2 if start_id > 0 else 0.0)
    end = last.end + END_PAD
    if next_start is not None:
        end = min(end, (last.end + next_start) / 2)

    silence_starts = [a for a, _ in silences]
    # A silence that ends just before the first word: start inside it.
    i = bisect.bisect_right(silence_starts, first.start) - 1
    if i >= 0:
        a, b = silences[i]
        if first.start - SILENCE_REACH <= b <= first.start + 0.05:
            start = min(start, max(b - 0.1, prev_end + 0.02, a))
    # A silence that starts just after the last word: Whisper often clips the final
    # syllable, so extend to where the audio actually goes quiet.
    j = bisect.bisect_left(silence_starts, last.end - 0.1)
    if j < len(silences):
        a, _ = silences[j]
        if a <= last.end + SILENCE_REACH:
            limit = next_start - 0.02 if next_start is not None else a + 0.1
            end = max(end, min(a + 0.1, limit))
    return round(max(0.0, start), 3), round(end, 3)


def iou(a: ClipResult, b: ClipResult) -> float:
    inter = max(0.0, min(a.end, b.end) - max(a.start, b.start))
    union = max(a.end, b.end) - min(a.start, b.start)
    return inter / union if union > 0 else 0.0


def dedupe(clips: list[ClipResult], threshold: float = config.DEDUPE_IOU) -> list[ClipResult]:
    kept: list[ClipResult] = []
    for c in sorted(clips, key=lambda c: c.virality, reverse=True):
        if all(iou(c, k) <= threshold for k in kept):
            kept.append(c)
    return kept
