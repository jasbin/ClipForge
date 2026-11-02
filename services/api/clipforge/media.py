"""Thin wrappers around ffmpeg / ffprobe."""

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import config


class MediaError(RuntimeError):
    pass


def _require(binary: str) -> str:
    path = shutil.which(binary)
    if not path:
        raise MediaError(f"{binary} not found on PATH")
    return path


def _run(args: list[str]) -> subprocess.CompletedProcess:
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise MediaError(f"{Path(args[0]).name} failed ({proc.returncode}): {proc.stderr[-2000:]}")
    return proc


@dataclass
class ProbeInfo:
    duration: float
    width: int | None
    height: int | None
    fps: float | None
    has_audio: bool


def probe(path: Path) -> ProbeInfo:
    out = _run([
        _require("ffprobe"), "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]).stdout
    info = json.loads(out)
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    has_audio = any(s["codec_type"] == "audio" for s in info["streams"])
    fps = None
    if video and video.get("avg_frame_rate", "0/0") != "0/0":
        num, den = video["avg_frame_rate"].split("/")
        fps = float(num) / float(den) if float(den) else None
    return ProbeInfo(
        duration=float(info["format"]["duration"]),
        width=video and int(video["width"]),
        height=video and int(video["height"]),
        fps=fps,
        has_audio=has_audio,
    )


def make_proxy(src: Path, dst: Path, height: int = config.PROXY_HEIGHT) -> Path:
    """Low-res H.264 proxy for fast analysis and in-browser preview."""
    _run([
        _require("ffmpeg"), "-y", "-v", "error", "-i", str(src),
        "-vf", f"scale=-2:'min({height},ih)'",
        "-c:v", "h264_videotoolbox", "-b:v", "1500k",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(dst),
    ]) if _has_videotoolbox() else _run([
        _require("ffmpeg"), "-y", "-v", "error", "-i", str(src),
        "-vf", f"scale=-2:'min({height},ih)'",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(dst),
    ])
    return dst


def extract_audio(src: Path, dst: Path, sr: int = config.AUDIO_SR) -> Path:
    """16 kHz mono WAV for Whisper and audio features."""
    _run([
        _require("ffmpeg"), "-y", "-v", "error", "-i", str(src),
        "-vn", "-ac", "1", "-ar", str(sr), "-c:a", "pcm_s16le", str(dst),
    ])
    return dst


_SILENCE_RE = re.compile(r"silence_(start|end): (-?[\d.]+)")


def detect_silences(audio: Path, noise_db: int = -35, min_dur: float = 0.25) -> list[tuple[float, float]]:
    """Return [(start, end)] spans of silence, via ffmpeg silencedetect."""
    proc = subprocess.run(
        [_require("ffmpeg"), "-v", "info", "-i", str(audio),
         "-af", f"silencedetect=noise={noise_db}dB:d={min_dur}", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise MediaError(f"silencedetect failed: {proc.stderr[-2000:]}")
    spans, start = [], None
    for kind, value in _SILENCE_RE.findall(proc.stderr):
        t = max(0.0, float(value))
        if kind == "start":
            start = t
        elif start is not None:
            spans.append((start, t))
            start = None
    return spans


_videotoolbox: bool | None = None


def _has_videotoolbox() -> bool:
    global _videotoolbox
    if _videotoolbox is None:
        out = subprocess.run([_require("ffmpeg"), "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        _videotoolbox = "h264_videotoolbox" in out
    return _videotoolbox


def cut_clip(src: Path, dst: Path, start: float, end: float) -> Path:
    """Frame-accurate cut in the source framing (9:16 reframe + captions come in M3)."""
    encoder = (["-c:v", "h264_videotoolbox", "-b:v", "8M"] if _has_videotoolbox()
               else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"])
    tmp = dst.with_suffix(".part.mp4")
    _run([
        _require("ffmpeg"), "-y", "-v", "error", "-ss", f"{start:.3f}", "-i", str(src),
        "-t", f"{end - start:.3f}", *encoder, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(tmp),
    ])
    tmp.replace(dst)
    return dst


VERTICAL = (1080, 1920)


def caption_canvas(src: Path, fmt: str) -> tuple[int, int]:
    """Output size for a captioned render: the source size, or 1080×1920 for vertical formats."""
    if fmt != "original":
        return VERTICAL
    info = probe(src)
    if not info.width or not info.height:
        raise MediaError("source has no video stream")
    return info.width // 2 * 2, info.height // 2 * 2


@dataclass
class MusicMix:
    path: Path
    volume: float = 0.15  # linear gain on the track
    offset: float = 0.0  # seconds into the track to start from
    duck: bool = True  # dip the music while someone speaks


def render_export(src: Path, dst: Path, start: float, end: float, *, fmt: str,
                  ass: Path | None = None, music: MusicMix | None = None) -> Path:
    """Cut [start, end], optionally reframe to 9:16, burn in ASS captions and mix in music.

    ffmpeg runs inside the work folder so the ass filter can name its file without escaping the
    path (filtergraph escaping breaks on spaces, colons and quotes).
    """
    workdir = (ass or dst).parent
    dur = end - start
    w, h = VERTICAL
    sub = f",ass={ass.name}" if ass else ""
    video = {
        "original": f"[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1{sub}[v]",
        "vertical_crop": f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1{sub}[v]",
        "vertical_blur": (
            f"[0:v]split[a][b];[a]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=24:2,"
            f"eq=brightness=-0.08[bg];[b]scale={w}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1{sub}[v]"
        ),
    }[fmt]
    inputs = ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src.resolve())]
    graph = [video]
    audio_map = ["-map", "0:a?"]
    if music:
        has_audio = probe(src).has_audio
        inputs += ["-stream_loop", "-1", "-ss", f"{music.offset:.3f}", "-i", str(music.path.resolve())]
        fade_out = max(0.0, dur - 1.5)
        graph.append(f"[1:a]atrim=0:{dur:.3f},asetpts=PTS-STARTPTS,volume={music.volume:.3f},"
                     f"afade=t=in:d=0.8,afade=t=out:st={fade_out:.3f}:d=1.5[m]")
        if has_audio and music.duck:
            # Sidechain: the clip's own audio pushes the music down while there is speech.
            graph.append("[0:a]asplit=2[speech][key];"
                         "[m][key]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[md];"
                         "[speech][md]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]")
        elif has_audio:
            graph.append("[0:a][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]")
        else:
            graph.append("[m]anull[aout]")
        audio_map = ["-map", "[aout]"]
    encoder = (["-c:v", "h264_videotoolbox", "-b:v", "10M"] if _has_videotoolbox()
               else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19"])
    tmp = dst.with_suffix(".part.mp4")
    args = [
        _require("ffmpeg"), "-y", "-v", "error", *inputs, "-filter_complex", ";".join(graph),
        "-map", "[v]", *audio_map, *encoder, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
        "-ar", "48000", "-t", f"{dur:.3f}", "-movflags", "+faststart", str(tmp.resolve()),
    ]
    proc = subprocess.run(args, capture_output=True, text=True, cwd=workdir)
    if proc.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise MediaError(f"ffmpeg failed ({proc.returncode}): {proc.stderr[-2000:]}")
    tmp.replace(dst)
    return dst
