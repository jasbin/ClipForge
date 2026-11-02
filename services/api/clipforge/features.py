"""Stage 3: per-second audio features merged into an "audio excitement" curve (0..1)."""

from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from .transcribe import Transcript

HOP = 512
BLOCK_SECONDS = 60  # process in blocks so long files don't need huge STFTs


@dataclass
class AudioFeatures:
    rms_db: np.ndarray        # mean loudness per second
    pitch_std: np.ndarray     # pitch variability (semitones) per second
    voiced: np.ndarray        # fraction of voiced frames per second
    flatness: np.ndarray      # spectral flatness (noisy = laughter/applause-ish)
    wps: np.ndarray           # words per second
    excitement: np.ndarray    # combined, percentile-ranked 0..1

    def save(self, path: Path) -> None:
        np.savez_compressed(path, **self.__dict__)

    @classmethod
    def load(cls, path: Path) -> "AudioFeatures":
        with np.load(path) as z:
            return cls(**{k: z[k] for k in z.files})

    def mean_excitement(self, start: float, end: float) -> float:
        a, b = int(start), max(int(start) + 1, int(np.ceil(end)))
        window = self.excitement[a:b]
        return float(window.mean()) if window.size else 0.0

    def peaks(self, n: int = 10, min_separation: float = 30.0) -> list[tuple[float, float]]:
        """Top-n (second, excitement) peaks of the 5 s-smoothed curve, spaced apart."""
        smooth = _smooth(self.excitement, 5)
        order = np.argsort(smooth)[::-1]
        picked: list[tuple[float, float]] = []
        for i in order:
            if all(abs(i - p) >= min_separation for p, _ in picked):
                picked.append((float(i), float(smooth[i])))
                if len(picked) == n:
                    break
        return sorted(picked)


def _smooth(x: np.ndarray, width: int) -> np.ndarray:
    if x.size < width:
        return x.copy()
    return np.convolve(x, np.ones(width) / width, mode="same")


def _z(x: np.ndarray) -> np.ndarray:
    sd = x.std()
    return (x - x.mean()) / sd if sd > 1e-9 else np.zeros_like(x)


def _per_second(frame_values: np.ndarray, frames_per_sec: float, n_sec: int, reducer) -> np.ndarray:
    out = np.zeros(n_sec, dtype=np.float32)
    for s in range(n_sec):
        seg = frame_values[int(s * frames_per_sec):int((s + 1) * frames_per_sec)]
        out[s] = reducer(seg) if seg.size else 0.0
    return out


def _pitch_std(f0_semitones: np.ndarray) -> float:
    voiced = f0_semitones[~np.isnan(f0_semitones)]
    return float(voiced.std()) if voiced.size >= 4 else 0.0


def extract(audio: Path, transcript: Transcript) -> AudioFeatures:
    info = sf.info(str(audio))
    sr = info.samplerate
    n_sec = int(np.ceil(info.frames / sr))
    fps = sr / HOP

    rms_db = np.zeros(n_sec, np.float32)
    pitch_std = np.zeros(n_sec, np.float32)
    voiced = np.zeros(n_sec, np.float32)
    flatness = np.zeros(n_sec, np.float32)

    block = BLOCK_SECONDS * sr
    for b0 in range(0, info.frames, block):
        y, _ = sf.read(str(audio), start=b0, frames=block, dtype="float32", always_2d=False)
        if y.ndim > 1:
            y = y.mean(axis=1)
        sec0 = b0 // sr
        secs = int(np.ceil(len(y) / sr))
        if len(y) < 2048:
            continue

        rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
        db = librosa.amplitude_to_db(rms, ref=1.0)
        f0 = librosa.yin(y, fmin=70, fmax=400, sr=sr, frame_length=2048, hop_length=HOP)
        # yin always returns a value; treat quiet frames and range-edge values as unvoiced.
        loud = db > (np.percentile(db, 30) + 3)
        is_voiced = loud & (f0 > 72) & (f0 < 395)
        semis = np.where(is_voiced, 12 * np.log2(np.maximum(f0, 1) / 100.0), np.nan)
        flat = librosa.feature.spectral_flatness(y=y, n_fft=2048, hop_length=HOP)[0]

        sl = slice(sec0, min(n_sec, sec0 + secs))
        k = sl.stop - sl.start
        rms_db[sl] = _per_second(db, fps, secs, np.mean)[:k]
        pitch_std[sl] = _per_second(semis, fps, secs, _pitch_std)[:k]
        voiced[sl] = _per_second(is_voiced.astype(np.float32), fps, secs, np.mean)[:k]
        flatness[sl] = _per_second(flat, fps, secs, np.mean)[:k]

    wps = np.zeros(n_sec, np.float32)
    for w in transcript.words:
        s = int(w.start)
        if 0 <= s < n_sec:
            wps[s] += 1

    # Laughter/applause heuristic: loud, noisy, and not voiced speech.
    burst = np.clip(_z(rms_db), 0, None) * (1 - voiced) * np.clip(_z(flatness), 0, None)
    raw = (0.35 * _z(rms_db) + 0.25 * _z(pitch_std) + 0.25 * _z(_smooth(wps, 3)) + 0.15 * _z(burst))
    raw = _smooth(raw, 3)
    # Percentile rank → 0..1, robust to differing loudness between videos.
    excitement = (np.argsort(np.argsort(raw)) / max(1, raw.size - 1)).astype(np.float32)

    return AudioFeatures(rms_db=rms_db, pitch_std=pitch_std, voiced=voiced,
                         flatness=flatness, wps=wps, excitement=excitement)
