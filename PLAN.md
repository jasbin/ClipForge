# ClipForge — Viral Clip Finder & Clipper (Web App)

Paste a long video (upload or URL). The app finds the moments most likely to perform as Shorts/Reels/TikToks, scores each one, reframes it to 9:16 around the speaker, adds animated word-by-word captions, and lets you trim and export it.

---

## 1. Research findings (what the problem actually is)

**How the leaders do it (Opus Clip, Vizard, Klap, open-source ViralCutter / AI-Shorts-Generator):**
the same pipeline every time: **transcribe → find candidate moments → score → reframe to 9:16 → captions → render.** The "AI" part is mostly an LLM reading a timestamped transcript, plus audio and visual signals.

**What goes into a virality score** (Opus Clip publishes its signals; scores run 0–100, and 70 or more counts as "above median"):

| Signal family | Concrete signals |
|---|---|
| Transcript | Hook strength in the first ~3 s, a complete narrative arc (setup → payoff), information density, emotional valence, a quotable stand-alone line |
| Audio | Speaker pace speeding up, pitch variability (a proxy for emotional intensity), laughter or applause, emphasis pauses |
| Visual | Gesture intensity, facial expressiveness, edit pace |

**Why retention depends on the hook:** viewers decide within about 3 s whether to keep watching. Below roughly 70% 3-second retention, TikTok and Reels distribution collapses. **The clip must start on its hook.** It cannot start on a preamble.

**Where current tools fail.** Independent testing found that people throw away 20–40% of Opus Clip output. The reasons:
1. **The clip is missing context.** It needs something said earlier to make sense. This is the #1 failure.
2. **The cut lands mid-sentence or mid-word.**
3. **The captions drift out of sync.**
4. **The reframe is bad** (the crop is on the wrong person, or it jitters).

→ Our edge comes from attacking these directly: a dedicated *"does this clip stand alone?"* LLM check, cut points snapped to sentence boundaries and silences, word-level forced-aligned timestamps, and shot-aware smoothed reframing.

**Building blocks we'll use (all proven in open-source clippers):**
- **Transcription:** `mlx-whisper` (Whisper large-v3-turbo, very fast on Apple Silicon M4), with `faster-whisper` as a cross-platform fallback. Both give word-level timestamps.
- **Scoring / selection:** Claude (`claude-sonnet-5-5`) with structured JSON output, reading the transcript as numbered sentences.
- **Audio features:** `librosa` for RMS energy, pitch variance and speech rate. Laughter and applause come from an energy/spectral heuristic first; a pretrained classifier can come later.
- **Reframing:** MediaPipe face detection plus mouth-movement activity for the active speaker, and PySceneDetect for shot boundaries. This follows the approach of Google AutoFlip.
- **Captions:** ASS subtitles generated from word timings (karaoke/pop styles), burned in with ffmpeg + libass (confirmed present locally).
- **Encode:** `h264_videotoolbox` (hardware, fast previews) and `libx264` (final quality).

---

## 2. Architecture

```
┌────────────── Next.js (web) ──────────────┐        ┌──────── FastAPI (api) ────────┐
│ Upload / URL → Project page → Clip grid   │  REST  │ /projects /clips /render       │
│ Clip editor: transcript-trim, caption     │◄──────►│ SQLite (SQLModel)              │
│ style, reframe override, preview, export  │  SSE   │ serves media from ./data       │
└───────────────────────────────────────────┘ (progress)└──────────┬────────────────┘
                                                              │ job table
                                                   ┌──────────▼──────────┐
                                                   │ Worker process       │
                                                   │ ingest → transcribe →│
                                                   │ segment → score →    │
                                                   │ reframe → render     │
                                                   └──────────────────────┘
```

- **Monorepo:** `apps/web` (Next.js 15, TypeScript, Tailwind, shadcn/ui) and `services/api` (Python 3.12 via `uv`, FastAPI, worker).
- **Python 3.12, not the system 3.14:** mlx, mediapipe and ctranslate2 wheels lag behind new Python releases. `uv` will manage the 3.12 install.
- **Jobs:** a SQLite-backed job table polled by one worker process. This avoids needing Redis for the MVP. The interface is kept thin, so it can be swapped for Redis + RQ/Celery when we go multi-user or cloud.
- **Storage:** `./data/{project_id}/` holds the source, a low-res proxy, the transcript JSON, features and rendered clips. An S3-compatible adapter comes later.
- **Progress:** the worker writes stage and percent to the DB, and the API streams them to the UI over Server-Sent Events.

---

## 3. The clip-finding pipeline (core IP)

**Stage 1: Ingest.** Upload a file (chunked) or give a URL (`yt-dlp`, intended for content you own or have rights to). ffprobe reads the metadata. We make a 540p proxy for fast analysis and in-browser preview, and extract 16 kHz mono WAV audio.

**Stage 2: Transcribe.** Whisper large-v3-turbo produces word timestamps. Words are grouped into sentences and each sentence gets an ID. Silences come from VAD/`silencedetect`. Diarization (pyannote) is an optional Phase-3 addition that improves speaker reframing.

**Stage 3: Feature extraction (per sentence, per 1 s window).** RMS energy z-score, pitch variance, words per second, laughter/applause likelihood, and pause before/after. These merge into an "audio excitement" curve.

**Stage 4: Candidate proposal (LLM pass 1).** The transcript goes to Claude as `[S12 03:41.2] sentence…`, in chunks of about 20 min that overlap by 2 min, along with the top audio-excitement peaks as hints. Claude returns 8–20 candidates per chunk, each as `{start_sentence, end_sentence, hook_text, title, reason, scores{hook, payoff, emotion, quotability, standalone}}`. Targets: 15–60 s by default (user-selectable 15–30 / 30–60 / 60–90). The hook should be the first sentence. Clips may *start later than the natural beginning* if the setup can be cut.

**Stage 5: Standalone & boundary refinement (LLM pass 2: the anti-discard step).** For each candidate, Claude sees the clip text plus ±3 sentences of context and answers: Does it make sense to a cold viewer? Should it extend earlier or later? Is there a stronger first line inside it? The boundaries are then **snapped to sentence edges and the nearest silence** (a padding of about 150 ms), so we never cut mid-word.

**Stage 6: Scoring & ranking.**
```
virality = 100 * (0.30*hook + 0.20*payoff + 0.15*standalone + 0.10*quotability
                  + 0.10*emotion + 0.15*audio_excitement)   # weights tunable
```
Then dedupe overlapping clips (keep the higher score when IoU > 0.4), and return the top N with per-dimension breakdowns. The UI shows *why* each clip scored as it did.

**Stage 7: Reframe to 9:16.** PySceneDetect finds the shots. Faces are detected at 5 fps. When several faces are present, the active speaker is the face with the highest mouth-landmark variance during speech. Per shot:
- **One clear subject:** a smoothed crop path (dead-zone plus an exponential moving average). This avoids jitter, and the crop only pans when the subject leaves the middle third.
- **Two speakers alternating:** hard-cut between them at speaker changes, like a camera operator would.
- **No faces, or a screen recording / slide:** a "fit + blurred background" layout, or a split layout (screen on top, face below).

The output is a crop keyframe list that the user can override in the editor.

**Stage 8: Captions & render.** ASS file per clip from the word timings: 1–3 words per line, active-word highlight, a pop scale-in animation, safe-area placement (above the TikTok UI chrome). Presets: *Bold Pop* (Hormozi-style), *Karaoke*, *Minimal*, *Boxed*. Optional: emoji/keyword emphasis chosen by the LLM. The ffmpeg graph is trim → crop/scale (or blur-pad) → ass → loudness normalize (`loudnorm` to −14 LUFS) → 1080×1920 H.264/AAC. We also export SRT and the title/description/hashtags.

---

## 4. Web app features

**MVP**
1. **New project:** drag-and-drop upload or a pasted URL, plus options (clip length range, number of clips, language, caption preset).
2. **Live progress:** a stage-by-stage progress bar (SSE).
3. **Clip grid:** ranked cards, each with a score badge, title, hook line, duration, hover preview and a score breakdown.
4. **Clip editor:**
   - video preview
   - a **transcript-based trim**: click words to set start and end, or nudge ±0.5 s
   - caption preset and colour picker
   - an editable caption text fix (fixes ASR errors and re-times them)
   - reframe mode toggle (auto / center / blur-fit / split)
   - re-render
5. **Export:** MP4 download (single file or ZIP of all clips), SRT, and copy-ready title + caption + hashtags.
6. **Feedback:** 👍/👎 per clip, stored to tune the scoring weights later.

**Phase 3+ (after MVP)**
- Speaker diarization and split-screen podcast layout
- B-roll / emoji overlays
- Hook-text title card at 0–2 s
- AI "custom prompt" clipping ("find every moment about pricing")
- Multi-language captions
- Brand templates (fonts, logo, colours)
- Direct posting to YouTube, TikTok and Instagram APIs
- Auth + multi-user + S3 + GPU worker for cloud deployment
- Learning the scoring weights from feedback

---

## 5. Data model (SQLite → Postgres-ready)

- `Project(id, title, source_url, source_path, duration, status, stage, progress, settings_json, created_at)`
- `Transcript(project_id, language, words_json, sentences_json)`
- `Clip(id, project_id, start, end, title, hook, reason, scores_json, virality, reframe_json, caption_style_json, status, output_path, feedback)`
- `Job(id, project_id, clip_id?, kind, status, attempts, error, created_at, updated_at)`

---

## 6. Execution plan (milestones)

| # | Milestone | Deliverable / acceptance check |
|---|---|---|
| **M0** | Scaffold | Monorepo, `uv` env with Python 3.12, Next.js app, FastAPI health endpoint, `make dev` runs all three processes, `.env` for `ANTHROPIC_API_KEY` |
| **M1** | Ingest + transcribe | Upload/URL → proxy + WAV → word-level transcript saved; a 30-min podcast transcribes in about 3 min or less on the M4 |
| **M2** | Clip finding | LLM pass 1 + pass 2, boundary snapping, audio features, ranking; a CLI `python -m clipforge.find video.mp4` prints the ranked clips (lets us judge quality before any UI exists) |
| **M3** | Reframe + captions + render | 9:16 MP4s with tracked crop and animated captions; visually checked on (a) a solo talking head, (b) a two-person podcast, (c) a screen recording |
| **M4** | Web UI | Project creation, live progress, clip grid, preview, download |
| **M5** | Editor | Transcript trim, caption styles/edits, reframe override, re-render, ZIP export, feedback buttons |
| **M6** | Quality pass | Eval set of 5–10 real videos, measure the "would post" rate (target: ≥70% of the top 10, which beats the 60–80% benchmark), tune weights and prompts, error handling, README |

**First run of execution = M0 → M2.** Clip-finding quality is the riskiest and most valuable part, so we prove it on real videos before building the UI on top.

---

## 7. Risks & mitigations

- **LLM cost on long videos:** sentence-ID compression (not raw words) and Claude prompt caching of the transcript between pass 1 and pass 2. Estimate: a few cents per hour of video.
- **Python ML wheel compatibility:** pinned 3.12 via `uv`. `faster-whisper` is the fallback if `mlx-whisper` has issues.
- **Reframe edge cases:** always offer a manual override and a blur-fit fallback.
- **URL downloads (YouTube ToS/copyright):** framed as "your own content". The upload path is primary.
- **Render speed:** hardware encoder for previews, x264 for the final export, and clips render in parallel.

## 8. Open decisions (defaults chosen; change if you disagree)

1. **LLM provider:** Claude Sonnet 5.5 (needs `ANTHROPIC_API_KEY`).
2. **Runs locally on this Mac first;** cloud deploy later.
3. **No auth in the MVP** (single user).
4. **App name "ClipForge"** (placeholder).
