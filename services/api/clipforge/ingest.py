"""Stage 1: get the source into ./data/{project_id}/ and derive the proxy + WAV."""

import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from . import config, media


@dataclass
class IngestResult:
    source: Path
    proxy: Path
    audio: Path
    info: media.ProbeInfo


def project_dir(project_id: str) -> Path:
    d = config.DATA_DIR / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def download_url(url: str, dest_dir: Path) -> Path:
    """Fetch a URL with yt-dlp. Intended for content you own or have rights to."""
    # Prefer the copy installed in this venv; its bin dir isn't necessarily on PATH.
    venv_ytdlp = Path(sys.executable).parent / "yt-dlp"
    ytdlp = str(venv_ytdlp) if venv_ytdlp.exists() else shutil.which("yt-dlp")
    if not ytdlp:
        raise media.MediaError("yt-dlp is not installed (pip install 'clipforge[url]')")
    template = str(dest_dir / "source.%(ext)s")
    args = [ytdlp, "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4",
            "-o", template, "--no-playlist", url]
    # YouTube needs a JS runtime; yt-dlp only looks for deno unless told otherwise.
    if not shutil.which("deno") and shutil.which("node"):
        args[1:1] = ["--js-runtimes", "node"]
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise media.MediaError(f"yt-dlp failed: {proc.stderr[-2000:]}")
    matches = sorted(dest_dir.glob("source.*"))
    if not matches:
        raise media.MediaError("yt-dlp produced no file")
    return matches[0]


def ingest(project_id: str, *, path: Path | None = None, url: str | None = None) -> IngestResult:
    d = project_dir(project_id)
    existing = [p for p in d.glob("source.*") if p.suffix != ".part"]
    if existing:
        source = existing[0]
    elif path is not None:
        source = d / f"source{path.suffix.lower() or '.mp4'}"
        if path.resolve() != source.resolve():
            # Hard-link when possible so big files aren't duplicated.
            try:
                source.hardlink_to(path)
            except OSError:
                shutil.copy2(path, source)
    elif url:
        source = download_url(url, d)
    else:
        raise ValueError("ingest needs a path or a url")

    info = media.probe(source)
    if not info.has_audio:
        raise media.MediaError("source has no audio track")

    proxy, audio = d / "proxy.mp4", d / "audio.wav"
    if not audio.exists():
        media.extract_audio(source, audio)
    if not proxy.exists() and info.width:
        media.make_proxy(source, proxy)
    return IngestResult(source=source, proxy=proxy, audio=audio, info=info)
