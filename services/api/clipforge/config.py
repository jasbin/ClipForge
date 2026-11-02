"""Settings, read from the environment (and a .env file at the repo root)."""

import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(REPO_ROOT / ".env")
# A blank key from .env would shadow other credential sources (e.g. `ant auth login`).
if os.environ.get("ANTHROPIC_API_KEY") == "":
    del os.environ["ANTHROPIC_API_KEY"]

DATA_DIR = Path(os.getenv("CLIPFORGE_DATA_DIR", REPO_ROOT / "data")).resolve()
DB_URL = os.getenv("CLIPFORGE_DB_URL", f"sqlite:///{DATA_DIR / 'clipforge.db'}")

# "anthropic" (Claude API) or "ollama" (local models, no API key).
LLM_PROVIDER = os.getenv("CLIPFORGE_LLM_PROVIDER", "anthropic").lower()
LLM_MODEL = os.getenv(
    "CLIPFORGE_LLM_MODEL", "gpt-oss:20b" if LLM_PROVIDER == "ollama" else "claude-sonnet-5-5")
# low | medium | high. Local models default to low: gpt-oss at medium is ~6x slower on a Mac.
LLM_EFFORT = os.getenv("CLIPFORGE_LLM_EFFORT", "low" if LLM_PROVIDER == "ollama" else "medium")

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
# Context window for Ollama; a 20-min transcript chunk is ~6k tokens plus prompt and output.
OLLAMA_NUM_CTX = int(os.getenv("CLIPFORGE_OLLAMA_NUM_CTX", "16384"))

WHISPER_MLX_MODEL = os.getenv("CLIPFORGE_WHISPER_MLX_MODEL", "mlx-community/whisper-large-v3-turbo")
WHISPER_CPU_MODEL = os.getenv("CLIPFORGE_WHISPER_CPU_MODEL", "large-v3-turbo")

# Qwen3-TTS (qwen-tts) runs on the Mac's Metal GPU ("mps") by default.
TTS_DEVICE = os.getenv("CLIPFORGE_TTS_DEVICE", "mps")
QWEN_TTS_SIZE = os.getenv("CLIPFORGE_QWEN_TTS_SIZE", "1.7B")  # 1.7B (supports style) | 0.6B
QWEN_TTS_SPEAKER_MODEL = f"Qwen/Qwen3-TTS-12Hz-{QWEN_TTS_SIZE}-CustomVoice"  # predefined speakers
QWEN_TTS_CLONE_MODEL = f"Qwen/Qwen3-TTS-12Hz-{QWEN_TTS_SIZE}-Base"           # clones your recordings
QWEN_DEFAULT_SPEAKER = "ryan"
VOICES_DIR = DATA_DIR / "voices"
MUSIC_DIR = DATA_DIR / "music"

PROXY_HEIGHT = 540
AUDIO_SR = 16_000

# Transcript chunking for the LLM passes.
CHUNK_SECONDS = 20 * 60
CHUNK_OVERLAP_SECONDS = 2 * 60

# virality = 100 * weighted sum of 0..1 components
SCORE_WEIGHTS = {
    "hook": 0.30,
    "payoff": 0.20,
    "standalone": 0.15,
    "quotability": 0.10,
    "emotion": 0.10,
    "audio_excitement": 0.15,
}
DEDUPE_IOU = 0.4

DATA_DIR.mkdir(parents=True, exist_ok=True)
