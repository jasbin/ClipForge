"""Stage 2: word-level transcription and sentence grouping."""

import logging
import platform
from pathlib import Path

from pydantic import BaseModel

from . import config

log = logging.getLogger(__name__)

# A gap this long between words ends a sentence even without punctuation.
SENTENCE_PAUSE = 0.8
MAX_SENTENCE_WORDS = 45
_TERMINALS = (".", "?", "!", "…")


class Word(BaseModel):
    text: str
    start: float
    end: float
    prob: float = 1.0


class Sentence(BaseModel):
    id: int
    start: float
    end: float
    text: str
    first_word: int
    last_word: int  # inclusive


class Transcript(BaseModel):
    language: str
    words: list[Word]
    sentences: list[Sentence]

    def save(self, path: Path) -> None:
        path.write_text(self.model_dump_json())

    @classmethod
    def load(cls, path: Path) -> "Transcript":
        return cls.model_validate_json(path.read_text())


def _transcribe_mlx(audio: Path, language: str | None) -> tuple[str, list[Word]]:
    import mlx.core as mx
    import mlx_whisper
    from mlx_whisper.transcribe import ModelHolder

    try:
        result = mlx_whisper.transcribe(
            str(audio),
            path_or_hf_repo=config.WHISPER_MLX_MODEL,
            word_timestamps=True,
            language=language,
            condition_on_previous_text=False,  # reduces hallucinated repeats on long audio
        )
    finally:
        # Free the ~1.6 GB model so a local LLM has the memory for the next stage.
        ModelHolder.model = ModelHolder.model_path = None
        mx.clear_cache()
    words = [
        Word(text=w["word"].strip(), start=float(w["start"]), end=float(w["end"]),
             prob=float(w.get("probability", 1.0)))
        for seg in result["segments"] for w in seg.get("words", [])
        if w["word"].strip()
    ]
    return result.get("language") or language or "en", words


def _transcribe_cpu(audio: Path, language: str | None) -> tuple[str, list[Word]]:
    from faster_whisper import WhisperModel

    model = WhisperModel(config.WHISPER_CPU_MODEL, device="auto", compute_type="int8")
    segments, info = model.transcribe(str(audio), word_timestamps=True, language=language, vad_filter=True)
    words = [
        Word(text=w.word.strip(), start=w.start, end=w.end, prob=w.probability)
        for seg in segments for w in (seg.words or []) if w.word.strip()
    ]
    return info.language, words


def _use_mlx() -> bool:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        return False
    try:
        import mlx_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def join_words(words: list[Word]) -> str:
    """Join tokens, without a space before ones Whisper split off (",000", "'s", "%")."""
    out = ""
    for w in words:
        out += w.text if not out or w.text[0] in ",.!?%:;)'’" else " " + w.text
    return out


def group_sentences(words: list[Word]) -> list[Sentence]:
    sentences: list[Sentence] = []
    start_idx = 0
    for i, w in enumerate(words):
        is_last = i == len(words) - 1
        gap = (words[i + 1].start - w.end) if not is_last else 0.0
        n = i - start_idx + 1
        if is_last or w.text.endswith(_TERMINALS) or gap >= SENTENCE_PAUSE or n >= MAX_SENTENCE_WORDS:
            chunk = words[start_idx:i + 1]
            sentences.append(Sentence(
                id=len(sentences), start=chunk[0].start, end=chunk[-1].end,
                text=join_words(chunk), first_word=start_idx, last_word=i,
            ))
            start_idx = i + 1
    return sentences


def transcribe(audio: Path, language: str | None = None) -> Transcript:
    if _use_mlx():
        log.info("transcribing with mlx-whisper (%s)", config.WHISPER_MLX_MODEL)
        lang, words = _transcribe_mlx(audio, language)
    else:
        log.info("transcribing with faster-whisper (%s)", config.WHISPER_CPU_MODEL)
        lang, words = _transcribe_cpu(audio, language)
    # Whisper occasionally emits zero/negative-length or out-of-order words.
    words.sort(key=lambda w: w.start)
    for w in words:
        if w.end <= w.start:
            w.end = w.start + 0.05
    return Transcript(language=lang, words=words, sentences=group_sentences(words))


def fmt_ts(t: float) -> str:
    m, s = divmod(t, 60)
    return f"{int(m):02d}:{s:04.1f}"

