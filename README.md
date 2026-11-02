# ClipForge

Finds the moments in a long video most likely to work as Shorts/Reels/TikToks, and ranks them with a score breakdown. See [PLAN.md](PLAN.md) for the full design.

**Status:** milestones M0–M2 are done (scaffold, ingest + transcription, clip finding). Reframing, captions and rendering (M3) are next.

## Setup

Requires macOS on Apple Silicon (for mlx-whisper), Python 3.12, Node 20+ and ffmpeg.

```sh
make setup              # venv + Python deps + web deps, creates .env
# put your key in .env:  ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```sh
make find VIDEO=~/Movies/podcast.mp4                    # CLI: prints ranked clips
make find VIDEO=talk.mp4 ARGS="--min 15 --max 30 --top 5"
make find VIDEO=talk.mp4 ARGS="--no-llm"                # no API key: audio heuristics only

make dev                                                # API :8000 + worker + web :3000
```

The first run downloads the Whisper model (~1.6 GB). Each stage caches its output in `data/<project>/`, so re-running on the same file skips transcription. Delete the `llm_*.json` files there to re-run only the Claude passes, or run `make clean-data` to start over.

## Layout

```
apps/web/                 Next.js 15 UI (upload, live progress, clip list)
services/api/clipforge/
  ingest.py      Stage 1  source → 540p proxy + 16 kHz WAV (ffmpeg, yt-dlp for URLs)
  transcribe.py  Stage 2  word timestamps (mlx-whisper / faster-whisper) → sentences
  features.py    Stage 3  loudness, pitch variance, speech rate, laughter → excitement curve
  llm.py         Stage 4–5 Claude proposes clips, then reviews each for stand-alone sense
  ranking.py     Stage 5–6 snap cuts to sentence edges + silences, score, dedupe
  pipeline.py    runs the stages with on-disk caching
  find.py        CLI
  api.py         FastAPI: /projects, /projects/{id}/clips, /projects/{id}/events (SSE), /media
  worker.py      polls the SQLite job table and runs the pipeline
  db.py          SQLModel tables
```

## LLM usage

Each ~20-minute transcript chunk makes two LLM calls. The first proposes candidates. The second reviews them for missing context and fixes their boundaries. Set the provider in `.env` with `CLIPFORGE_LLM_PROVIDER`. Token usage is logged with `-v`.

**Local (Ollama, the default in `.env`).** Free, private, no key. Start the server with `ollama serve`; the default model is `gpt-oss:20b` (13 GB). On a 24 GB M4, a 2-minute talk takes about 2 min at `low` effort (the default) and about 13 min at `CLIPFORGE_LLM_EFFORT=medium`. Medium finds more of the good moments.

**Claude (`CLIPFORGE_LLM_PROVIDER=anthropic`).** Needs `ANTHROPIC_API_KEY`; the default model is `claude-sonnet-5-5`. The transcript block is prompt-cached, so the second call reads it at the cache rate. If the model declines a request, the server-side fallback (`fallbacks: "default"`) retries it on another model.
