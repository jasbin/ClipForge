"""Re-voice a clip: speak its exact transcript with Qwen3-TTS and swap the audio.

Voices are either one of Qwen's predefined speakers (the "CustomVoice" model, with
an optional style instruction) or a clone of a recording you saved (the "Base" model).

Each transcript sentence is generated separately and placed where the original
sentence started, so the narration stays in sync with what's on screen. A sentence
that comes out longer than its slot is sped up (up to MAX_TEMPO) to fit.
"""

import gc
import json
import logging
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import soundfile as sf

from . import config, media
from .transcribe import Sentence, Word

log = logging.getLogger(__name__)

MAX_TEMPO = 1.3        # never speed a sentence up more than this to fit its slot
TRIM_TOP_DB = 40       # trim TTS leading/trailing silence quieter than this
VOICE_SAMPLE_SR = 24_000
CODEC_HZ = 12          # Qwen3-TTS-12Hz emits 12 codec tokens per second of audio

# Qwen's predefined speakers (from the Qwen3-TTS CustomVoice model card). Each can
# speak every supported language; "native" is the language it sounds most natural in.
SPEAKERS = [
    ("ryan", "Ryan", "Dynamic male voice with strong rhythmic drive", "English"),
    ("aiden", "Aiden", "Sunny American male voice with a clear midrange", "English"),
    ("vivian", "Vivian", "Bright, slightly edgy young female voice", "Chinese"),
    ("serena", "Serena", "Warm, gentle young female voice", "Chinese"),
    ("uncle_fu", "Uncle Fu", "Seasoned male voice with a low, mellow timbre", "Chinese"),
    ("dylan", "Dylan", "Youthful Beijing male voice with a clear, natural timbre", "Chinese (Beijing)"),
    ("eric", "Eric", "Lively Chengdu male voice with a slightly husky brightness", "Chinese (Sichuan)"),
    ("ono_anna", "Ono Anna", "Playful Japanese female voice with a light, nimble timbre", "Japanese"),
    ("sohee", "Sohee", "Warm Korean female voice with rich emotion", "Korean"),
]
SPEAKER_PREFIX = "qwen:"
DEFAULT_VOICE = SPEAKER_PREFIX + config.QWEN_DEFAULT_SPEAKER

# Whisper language codes → Qwen3-TTS language names.
LANGUAGES = {"en": "English", "zh": "Chinese", "fr": "French", "de": "German", "it": "Italian",
             "ja": "Japanese", "ko": "Korean", "pt": "Portuguese", "ru": "Russian", "es": "Spanish"}

PREVIEW_TEXT = "Hi, I'm {name}. Let me walk you through this product and show you what makes it special."


def is_speaker(voice_id: str | None) -> bool:
    return bool(voice_id) and voice_id.startswith(SPEAKER_PREFIX)


def speaker_ids() -> set[str]:
    return {SPEAKER_PREFIX + key for key, *_ in SPEAKERS}


def preview_path(voice_id: str) -> Path:
    return config.VOICES_DIR / "previews" / f"{voice_id.removeprefix(SPEAKER_PREFIX)}.wav"


# --- Voice library -------------------------------------------------------------
# data/voices/<id>.wav (your recordings) plus voices.json:
#   {"voices": [{id, name, created, ref_text}], "default": "qwen:ryan" | <id>}

def _index_path() -> Path:
    return config.VOICES_DIR / "voices.json"


def _read_index() -> dict:
    try:
        index = json.loads(_index_path().read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        index = {"voices": [], "default": DEFAULT_VOICE}
    # Drop presets left over from the Chatterbox version (macOS-rendered samples).
    for v in [v for v in index["voices"] if v.get("preset")]:
        (config.VOICES_DIR / f"{v['id']}.wav").unlink(missing_ok=True)
    index["voices"] = [v for v in index["voices"] if not v.get("preset")]
    return index


def _write_index(index: dict) -> None:
    config.VOICES_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _index_path().with_suffix(".tmp")
    tmp.write_text(json.dumps(index, indent=2))
    tmp.replace(_index_path())


def voice_path(voice_id: str | None) -> Path | None:
    if not voice_id or is_speaker(voice_id):
        return None
    p = config.VOICES_DIR / f"{voice_id}.wav"
    return p if p.exists() else None


def valid_voice(voice_id: str | None) -> bool:
    return voice_id in speaker_ids() or voice_path(voice_id) is not None


def list_voices() -> dict:
    index = _read_index()
    index["voices"] = [v for v in index["voices"] if voice_path(v["id"])]
    if not valid_voice(index.get("default")):
        index["default"] = DEFAULT_VOICE
    index["speakers"] = [
        {"id": SPEAKER_PREFIX + key, "name": name, "description": desc, "native": native,
         "preview": preview_path(SPEAKER_PREFIX + key).exists()}
        for key, name, desc, native in SPEAKERS
    ]
    return index


def _transcribe_sample(path: Path) -> str:
    """Transcript of a reference recording; Qwen clones far better when it has one."""
    from .transcribe import transcribe
    return " ".join(s.text for s in transcribe(path).sentences).strip()


def add_voice(name: str, src: Path, make_default: bool = True) -> dict:
    """Store a reference recording (24 kHz mono WAV) and its transcript under a name."""
    voice_id = uuid.uuid4().hex[:10]
    config.VOICES_DIR.mkdir(parents=True, exist_ok=True)
    dst = config.VOICES_DIR / f"{voice_id}.wav"
    media._run([
        media._require("ffmpeg"), "-y", "-v", "error", "-i", str(src), "-t", "60",
        "-ac", "1", "-ar", str(VOICE_SAMPLE_SR), "-c:a", "pcm_s16le", str(dst),
    ])
    voice = {"id": voice_id, "name": name.strip() or "My voice", "created": int(time.time()),
             "ref_text": _transcribe_sample(dst)}
    index = _read_index()
    index["voices"].append(voice)
    if make_default:
        index["default"] = voice_id
    _write_index(index)
    return voice


def delete_voice(voice_id: str) -> None:
    index = _read_index()
    index["voices"] = [v for v in index["voices"] if v["id"] != voice_id]
    if index.get("default") == voice_id:
        index["default"] = DEFAULT_VOICE
    _write_index(index)
    (config.VOICES_DIR / f"{voice_id}.wav").unlink(missing_ok=True)


def set_default_voice(voice_id: str) -> None:
    if not valid_voice(voice_id):
        raise ValueError(f"unknown voice {voice_id}")
    index = _read_index()
    index["default"] = voice_id
    _write_index(index)


def _ref_text(voice_id: str) -> str:
    """Saved transcript of a recording, transcribing (and caching) it if missing."""
    index = _read_index()
    voice = next((v for v in index["voices"] if v["id"] == voice_id), None)
    if voice is None:
        return ""
    if not voice.get("ref_text"):
        voice["ref_text"] = _transcribe_sample(config.VOICES_DIR / f"{voice_id}.wav")
        _write_index(index)
    return voice["ref_text"]


# --- Qwen3-TTS engine ----------------------------------------------------------

def _load_model(repo: str):
    import torch
    from qwen_tts import Qwen3TTSModel

    device = config.TTS_DEVICE
    if device == "mps" and not torch.backends.mps.is_available():
        log.warning("Metal (mps) not available; falling back to CPU")
        device = "cpu"
    dtype = torch.float32 if device == "cpu" else torch.bfloat16
    log.info("loading %s on %s", repo, device)
    return Qwen3TTSModel.from_pretrained(repo, device_map=device, dtype=dtype, attn_implementation="sdpa")


def _free_model(model) -> None:
    import torch

    del model
    gc.collect()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()  # give the memory back for Whisper / Ollama


def _max_tokens(text: str) -> int:
    # Generous cap (~0.6 s per word + 3 s) so a runaway generation can't go on forever.
    return int((len(text.split()) * 0.6 + 3) * CODEC_HZ)


class Synthesizer:
    """One loaded Qwen model bound to one voice; call it once per sentence."""

    def __init__(self, voice_id: str, *, style: str = "", language: str | None = None):
        if not valid_voice(voice_id):
            raise ValueError(f"voice {voice_id} not found (was it deleted?)")
        self.voice_id = voice_id
        self.language = LANGUAGES.get((language or "").lower(), "Auto")
        self.style = style.strip()
        if is_speaker(voice_id):
            self.model = _load_model(config.QWEN_TTS_SPEAKER_MODEL)
            self.prompt = None
        else:
            ref_text = _ref_text(voice_id)
            self.model = _load_model(config.QWEN_TTS_CLONE_MODEL)
            self.prompt = self.model.create_voice_clone_prompt(
                ref_audio=str(voice_path(voice_id)), ref_text=ref_text or None,
                x_vector_only_mode=not ref_text,
            )

    def __call__(self, text: str) -> tuple[np.ndarray, int]:
        if self.prompt is None:
            wavs, sr = self.model.generate_custom_voice(
                text=text, speaker=self.voice_id.removeprefix(SPEAKER_PREFIX), language=self.language,
                instruct=self.style or None, max_new_tokens=_max_tokens(text),
            )
        else:
            wavs, sr = self.model.generate_voice_clone(
                text=text, language=self.language, voice_clone_prompt=self.prompt,
                max_new_tokens=_max_tokens(text),
            )
        return np.asarray(wavs[0], dtype=np.float32), sr

    def close(self) -> None:
        _free_model(self.model)
        self.model = None


def ensure_speaker_previews() -> None:
    """Render a short sample of each predefined speaker once, for the Voices page."""
    missing = [(key, name) for key, name, *_ in SPEAKERS if not preview_path(SPEAKER_PREFIX + key).exists()]
    if not missing:
        return
    log.info("rendering %d Qwen speaker previews", len(missing))
    synth = Synthesizer(DEFAULT_VOICE, language="en")
    try:
        for key, name in missing:
            synth.voice_id = SPEAKER_PREFIX + key
            audio, sr = synth(PREVIEW_TEXT.format(name=name))
            path = preview_path(synth.voice_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(path, audio, sr)
    finally:
        synth.close()


# --- Timeline fitting and muxing -------------------------------------------------

def _atempo(audio: np.ndarray, sr: int, tempo: float) -> np.ndarray:
    """Pitch-preserving speed change with ffmpeg's atempo (WSOLA)."""
    if abs(tempo - 1.0) < 0.01:
        return audio
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.wav", Path(tmp) / "out.wav"
        sf.write(src, audio, sr)
        # A single atempo accepts 0.5–2.0; chain for larger factors.
        filters, t = [], tempo
        while t > 2.0:
            filters.append("atempo=2.0")
            t /= 2.0
        filters.append(f"atempo={t:.4f}")
        media._run([media._require("ffmpeg"), "-y", "-v", "error", "-i", str(src),
                    "-filter:a", ",".join(filters), str(dst)])
        out, _ = sf.read(dst, dtype="float32")
    return out


def _speakable(text: str) -> str:
    # Whisper splits hyphenated words into "ultra -thin"; rejoin so TTS reads them naturally.
    # LLM scripts often use non-breaking hyphens (U+2010/U+2011); normalize them too.
    text = text.replace("\u2011", "-").replace("\u2010", "-")
    return re.sub(r"(\w) -(\w)", r"\1-\2", text).strip()


def clip_segments(sentences: list[Sentence], start: float, end: float) -> list[tuple[str, float, float]]:
    """(text, slot_start, slot_end) relative to the clip, for sentences inside it."""
    inside = [s for s in sentences if s.end > start + 0.05 and s.start < end - 0.05]
    duration = end - start
    segs = []
    for i, s in enumerate(inside):
        slot_start = max(0.0, s.start - start)
        slot_end = (inside[i + 1].start - start) if i + 1 < len(inside) else duration
        segs.append((_speakable(s.text), slot_start, min(slot_end, duration)))
    return segs


def build_voice_track(
    segments: list[tuple[str, float, float]],
    duration: float,
    *,
    voice_id: str,
    style: str = "",
    language: str | None = None,
    progress: Callable[[int, int], None] = lambda done, total: None,
) -> tuple[np.ndarray, int]:
    """Generate every sentence and lay them on a timeline `duration` seconds long."""
    synth = Synthesizer(voice_id, style=style, language=language)
    try:
        cursor, sr = 0.0, VOICE_SAMPLE_SR
        pieces: list[tuple[float, np.ndarray]] = []
        for i, (text, slot_start, slot_end) in enumerate(segments):
            if not text.strip():  # a blank script line leaves that moment silent
                progress(i + 1, len(segments))
                continue
            audio, sr = synth(text)
            audio, _ = librosa.effects.trim(audio, top_db=TRIM_TOP_DB)

            pos = max(cursor, slot_start)
            available = max(0.1, slot_end - pos)
            natural = len(audio) / sr
            if natural > available:
                audio = _atempo(audio, sr, min(natural / available, MAX_TEMPO))
            pieces.append((pos, audio))
            cursor = pos + len(audio) / sr
            progress(i + 1, len(segments))
            log.info("voiceover seg %d/%d: %.1fs → slot %.1f–%.1f", i + 1, len(segments),
                     natural, slot_start, slot_end)
    finally:
        synth.close()

    track = np.zeros(int(duration * sr) + 1, dtype=np.float32)
    if cursor > duration:
        # Still too long after per-sentence fitting: speed the whole track up evenly.
        full = np.zeros(int(cursor * sr) + 1, dtype=np.float32)
        for pos, audio in pieces:
            i = int(pos * sr)
            full[i:i + len(audio)] += audio
        log.warning("voiceover ran %.1fs over; speeding whole track ×%.2f", cursor - duration, cursor / duration)
        track = _atempo(full, sr, cursor / duration)[:len(track)]
    else:
        for pos, audio in pieces:
            i = int(pos * sr)
            n = min(len(audio), len(track) - i)
            track[i:i + n] += audio[:n]
    return np.clip(track, -1.0, 1.0), sr


def mux(source: Path, voice_wav: Path, dst: Path, start: float, end: float,
        original_volume: float = 0.0) -> Path:
    """Cut [start, end] from the source and replace (or duck under) its audio."""
    encoder = (["-c:v", "h264_videotoolbox", "-b:v", "8M"] if media._has_videotoolbox()
               else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"])
    voice_chain = "loudnorm=I=-14:TP=-1.5:LRA=11"
    if original_volume > 0:
        audio = (f"[1:a]{voice_chain}[v];[0:a]volume={original_volume:.2f}[o];"
                 f"[v][o]amix=inputs=2:duration=first:normalize=0[a]")
    else:
        audio = f"[1:a]{voice_chain}[a]"
    tmp = dst.with_suffix(".part.mp4")
    media._run([
        media._require("ffmpeg"), "-y", "-v", "error",
        "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", str(source),
        "-i", str(voice_wav),
        "-filter_complex", audio, "-map", "0:v:0", "-map", "[a]",
        *encoder, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", f"{end - start:.3f}", "-movflags", "+faststart", str(tmp),
    ])
    tmp.replace(dst)
    return dst


def revoice_clip(
    source: Path, sentences: list[Sentence], start: float, end: float, out_dir: Path, name: str,
    *, voice_id: str, style: str = "", language: str | None = None, original_volume: float = 0.0,
    script: list[str] | None = None,
    progress: Callable[[int, int], None] = lambda done, total: None,
) -> Path:
    """`script`, if given, replaces the transcript line for line (same count as the segments)."""
    segments = clip_segments(sentences, start, end)
    if not segments:
        raise ValueError("no speech in this clip to re-voice")
    if script is not None:
        if len(script) != len(segments):
            raise ValueError(f"script has {len(script)} lines but the clip has {len(segments)}; rewrite it again")
        segments = [(_speakable(text), a, b) for text, (_, a, b) in zip(script, segments)]
        if not any(text for text, _, _ in segments):
            raise ValueError("the script is empty")
    out_dir.mkdir(parents=True, exist_ok=True)
    track, sr = build_voice_track(segments, end - start, voice_id=voice_id, style=style,
                                  language=language, progress=progress)
    wav = out_dir / f"{name}.wav"
    sf.write(wav, track, sr)
    words_path(out_dir, name).unlink(missing_ok=True)  # captions of the previous take are stale
    out = mux(source, wav, out_dir / f"{name}.mp4", start, end, original_volume)
    try:
        caption_words(wav, " ".join(text for text, _, _ in segments if text), language, words_path(out_dir, name))
    except Exception:  # captions are optional; the API retries this on first request
        log.exception("could not time voiceover words for captions")
    return out


def words_path(out_dir: Path, name: str) -> Path:
    return out_dir / f"{name}.words.json"


def caption_words(wav: Path, intended: str | None, language: str | None, dst: Path) -> list[Word]:
    """Word timings of the generated speech (clip-relative), for word-highlighted captions."""
    from .captions import align_words
    from .transcribe import transcribe
    heard = transcribe(wav, language).words
    words = align_words(intended, heard) if intended else heard
    dst.write_text(json.dumps([w.model_dump() for w in words]))
    return words
