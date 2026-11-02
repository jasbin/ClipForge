"""Background-music library: tracks you upload, mixed under clips at export.

data/music/<id>.m4a (normalised AAC) plus music.json: {"tracks": [{id, name, duration, created}]}.
Only add music you have the rights to use (royalty-free libraries, or your own).
"""

import json
import time
import uuid
from pathlib import Path

from . import config, media


def _index_path() -> Path:
    return config.MUSIC_DIR / "music.json"


def _read() -> list[dict]:
    try:
        tracks = json.loads(_index_path().read_text())["tracks"]
    except (OSError, ValueError, KeyError):
        return []
    return [t for t in tracks if track_path(t["id"]).exists()]


def _write(tracks: list[dict]) -> None:
    config.MUSIC_DIR.mkdir(parents=True, exist_ok=True)
    _index_path().write_text(json.dumps({"tracks": tracks}, indent=2))


def track_path(track_id: str) -> Path:
    return config.MUSIC_DIR / f"{track_id}.m4a"


def list_tracks() -> list[dict]:
    return [{**t, "url": f"/media/music/{t['id']}.m4a"} for t in sorted(_read(), key=lambda t: -t["created"])]


def get_track(track_id: str) -> dict | None:
    return next((t for t in _read() if t["id"] == track_id), None)


def add_track(name: str, src: Path) -> dict:
    """Convert any audio (or video) file to 44.1 kHz stereo AAC so every export mixes the same way."""
    track_id = uuid.uuid4().hex[:10]
    dst = track_path(track_id)
    config.MUSIC_DIR.mkdir(parents=True, exist_ok=True)
    media._run([
        media._require("ffmpeg"), "-y", "-v", "error", "-i", str(src), "-vn", "-t", "900",
        "-ac", "2", "-ar", "44100", "-c:a", "aac", "-b:a", "192k", str(dst),
    ])
    duration = media.probe(dst).duration
    tracks = _read()
    track = {"id": track_id, "name": name.strip()[:100] or "Untitled", "duration": round(duration, 2),
             "created": time.time()}
    _write([*tracks, track])
    return track


def delete_track(track_id: str) -> None:
    _write([t for t in _read() if t["id"] != track_id])
    track_path(track_id).unlink(missing_ok=True)
