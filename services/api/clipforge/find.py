"""CLI: python -m clipforge.find VIDEO_OR_URL [options]

Prints ranked clips so clip-finding quality can be judged before any UI exists.
"""

import argparse
import hashlib
import json
import logging
import sys
import time
from pathlib import Path

from .pipeline import FindOptions, find_clips
from .transcribe import fmt_ts


def project_id_for(source: str) -> str:
    """Stable ID so re-running on the same input reuses cached stages."""
    p = Path(source).expanduser()
    if p.exists():
        st = p.stat()
        key = f"{p.resolve()}|{st.st_size}|{int(st.st_mtime)}"
    else:
        key = source
    return "cli-" + hashlib.sha1(key.encode()).hexdigest()[:12]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="clipforge.find", description=__doc__.split("\n")[0])
    ap.add_argument("source", help="video file path or URL")
    ap.add_argument("--min", type=float, default=15, dest="min_seconds")
    ap.add_argument("--max", type=float, default=60, dest="max_seconds")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--lang", default=None, help="force language, e.g. en")
    ap.add_argument("--no-llm", action="store_true", help="heuristic ranking only (no API key needed)")
    ap.add_argument("--json", action="store_true", help="print JSON instead of a table")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")

    is_url = args.source.startswith(("http://", "https://"))
    if not is_url and not Path(args.source).expanduser().exists():
        print(f"error: {args.source} does not exist", file=sys.stderr)
        return 2

    t0 = time.time()

    def progress(stage: str, pct: float) -> None:
        print(f"\r[{pct:5.1f}%] {stage:<12} {time.time() - t0:6.1f}s", end="", file=sys.stderr, flush=True)

    clips = find_clips(
        project_id_for(args.source),
        path=None if is_url else Path(args.source).expanduser(),
        url=args.source if is_url else None,
        opts=FindOptions(min_seconds=args.min_seconds, max_seconds=args.max_seconds,
                         top_n=args.top, language=args.lang, use_llm=not args.no_llm),
        progress=progress,
    )
    print(file=sys.stderr)

    if args.json:
        print(json.dumps([c.model_dump() for c in clips], indent=2))
        return 0
    if not clips:
        print("No clips found.")
        return 0
    for rank, c in enumerate(clips, 1):
        breakdown = "  ".join(f"{k}={v:.2f}" for k, v in c.scores.items())
        print(f"\n#{rank}  {c.virality:5.1f}  {fmt_ts(c.start)} → {fmt_ts(c.end)}  ({c.duration:.1f}s)")
        print(f"    {c.title}")
        print(f"    hook: \"{c.hook_text}\"")
        print(f"    why:  {c.reason}")
        if c.missing_context:
            print(f"    ⚠ missing context: {c.missing_context}")
        print(f"    {breakdown}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
