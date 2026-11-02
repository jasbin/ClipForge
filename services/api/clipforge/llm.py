"""Stages 4–5: an LLM (Claude or a local Ollama model) proposes candidate clips, then
reviews each for stand-alone sense.

Both passes send the same system prompt and transcript block first, with a cache
breakpoint on the transcript, so pass 2 reads the chunk from the prompt cache.
"""

import logging
from typing import TypeVar

import anthropic
from pydantic import BaseModel

from . import config
from .transcribe import Sentence, fmt_ts

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

SYSTEM_PROMPT = """\
You are a senior short-form video editor who cuts long videos (podcasts, talks, \
interviews, streams) into Shorts, Reels and TikToks that people actually watch to the end.

You work from a timestamped transcript. Each line is one sentence:
[S<id> mm:ss.s] sentence text
Clips are always whole sentences: a clip runs from the start of one sentence ID to the \
end of another (inclusive).

What makes a clip perform:
- Hook: viewers decide in the first ~3 seconds. The first sentence must grab attention on \
its own: a bold claim, a surprising number, a question, conflict, or the middle of a story. \
Never start on filler, greetings, "so, um", or setup that only makes sense later. It is \
fine to start a clip after the natural beginning of a passage if the setup can be cut.
- Payoff: the clip resolves what the hook promised (a punchline, an answer, a lesson, a twist).
- Standalone: a cold viewer who saw nothing else must understand it. Unresolved \
references ("as I said earlier", "that guy", "this one", an unexplained acronym) to things \
outside the clip are the #1 reason clips get thrown away.
- Emotion: humor, anger, vulnerability, excitement, awe.
- Quotability: a crisp line someone would screenshot or repeat.

Scores are integers from 0 (absent) to 10 (exceptional). Be a harsh, calibrated judge: \
a typical passage is a 3–5; reserve 8+ for moments you would bet on.\
"""


class ProposedClip(BaseModel):
    start_sentence: int
    end_sentence: int
    title: str
    hook_text: str
    reason: str
    hook: int
    payoff: int
    emotion: int
    quotability: int
    standalone: int


class Proposals(BaseModel):
    clips: list[ProposedClip]


class ClipReview(BaseModel):
    candidate_id: int
    keep: bool
    start_sentence: int
    end_sentence: int
    hook: int
    standalone: int
    missing_context: str


class Reviews(BaseModel):
    reviews: list[ClipReview]


class LLMRefusal(RuntimeError):
    pass


_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(max_retries=4)
    return _client


def format_transcript(sentences: list[Sentence]) -> str:
    return "\n".join(f"[S{s.id} {fmt_ts(s.start)}] {s.text}" for s in sentences)


def _call(transcript_block: str, task: str, schema: type[T], system: str = SYSTEM_PROMPT) -> T:
    if config.LLM_PROVIDER == "ollama":
        return _call_ollama(transcript_block, task, schema, system)
    return _call_anthropic(transcript_block, task, schema, system)


def _call_ollama(transcript_block: str, task: str, schema: type[T], system: str) -> T:
    import ollama

    try:
        response = ollama.Client(host=config.OLLAMA_HOST).chat(
            model=config.LLM_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": f"<transcript>\n{transcript_block}\n</transcript>\n\n{task}"},
            ],
            format=schema.model_json_schema(),  # Ollama constrains output to this schema
            # gpt-oss takes low/medium/high reasoning levels; other models take on/off.
            think=config.LLM_EFFORT if "gpt-oss" in config.LLM_MODEL else None,
            options={"num_ctx": config.OLLAMA_NUM_CTX, "temperature": 0.3},
        )
    except ollama.ResponseError as e:
        if e.status_code == 404:
            raise RuntimeError(f"Ollama model {config.LLM_MODEL!r} not found; run: ollama pull {config.LLM_MODEL}") from e
        raise
    except ConnectionError as e:
        raise RuntimeError(f"cannot reach Ollama at {config.OLLAMA_HOST}; run: ollama serve") from e

    log.info("llm %s (ollama %s): in=%s out=%s done=%s", schema.__name__, config.LLM_MODEL,
             response.prompt_eval_count, response.eval_count, response.done_reason)
    if response.prompt_eval_count and response.prompt_eval_count >= config.OLLAMA_NUM_CTX:
        log.warning("prompt filled the %d-token context; raise CLIPFORGE_OLLAMA_NUM_CTX", config.OLLAMA_NUM_CTX)
    if response.done_reason == "length":
        raise RuntimeError("Ollama output was cut off; raise CLIPFORGE_OLLAMA_NUM_CTX")
    return schema.model_validate_json(response.message.content)


def _call_anthropic(transcript_block: str, task: str, schema: type[T], system: str) -> T:
    response = client().beta.messages.parse(
        model=config.LLM_MODEL,
        max_tokens=16000,
        system=system,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": f"<transcript>\n{transcript_block}\n</transcript>",
                 "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": task},
            ],
        }],
        output_format=schema,
        output_config={"effort": config.LLM_EFFORT},
        # On a safety decline, the API re-runs the request on a suitable fallback model.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    u = response.usage
    log.info("llm %s: in=%s cached=%s out=%s stop=%s", schema.__name__, u.input_tokens,
             u.cache_read_input_tokens, u.output_tokens, response.stop_reason)
    if response.stop_reason == "refusal":
        raise LLMRefusal(getattr(response.stop_details, "explanation", None) or "request declined")
    if response.stop_reason == "max_tokens" or response.parsed_output is None:
        raise RuntimeError(f"LLM output incomplete (stop_reason={response.stop_reason})")
    return response.parsed_output


def propose(
    sentences: list[Sentence],
    *,
    min_seconds: float,
    max_seconds: float,
    n_candidates: int,
    excitement_peaks: list[tuple[float, float]],
) -> list[ProposedClip]:
    peaks = "\n".join(f"- around {fmt_ts(t)} (excitement {e:.2f})" for t, e in excitement_peaks) or "- none"
    task = f"""\
Find the {n_candidates} best short-form clips in this transcript section \
(fewer if the material is weak; never pad with mediocre clips).

Rules:
- Each clip should run {min_seconds:.0f}–{max_seconds:.0f} seconds. Use the timestamps to judge length.
- start_sentence must be the hook. hook_text is that opening line, copied verbatim.
- Clips may overlap only if they are genuinely different takes on a moment.
- title: a punchy, curiosity-driven title of at most 70 characters, no clickbait lies.
- reason: one sentence on why this clip will hold attention.
- Score hook, payoff, emotion, quotability and standalone as described.

Audio analysis flagged these moments as high-energy (loud, animated, laughter or applause). \
Treat them as hints, not requirements:
{peaks}"""
    return _call(format_transcript(sentences), task, Proposals).clips


def review(
    sentences: list[Sentence],
    candidates: list[tuple[int, ProposedClip]],
    *,
    min_seconds: float,
    max_seconds: float,
) -> list[ClipReview]:
    listing = "\n".join(
        f"- candidate_id={cid}: S{c.start_sentence}–S{c.end_sentence} \"{c.title}\""
        for cid, c in candidates
    )
    task = f"""\
Here are candidate clips from this transcript. Review each one as a strict editor who \
must approve it before it is posted. For each, imagine a cold viewer who sees only the \
clip's sentences, and read the ~3 sentences on either side for context.

Candidates:
{listing}

For each candidate return:
- keep: false if it cannot be made to work as a standalone clip of \
{min_seconds:.0f}–{max_seconds:.0f} seconds.
- start_sentence / end_sentence: the corrected boundaries. Move the start earlier if \
essential context is missing, or later if a stronger first line exists inside the clip. \
Move the end so the payoff lands and the clip does not trail off. Keep them unchanged \
if they are already right.
- hook and standalone: re-scored for the corrected boundaries.
- missing_context: what a cold viewer would still not understand, or "" if nothing.

Return one review per candidate_id."""
    return _call(format_transcript(sentences), task, Reviews).reviews


# --- Narration rewrite -----------------------------------------------------------

SCRIPT_SYSTEM_PROMPT = """\
You are a scriptwriter for short-form product and explainer videos. You rewrite the \
narration of a clip so it explains the same thing in a fresh way, while the video \
itself stays exactly as it is.

The narration is split into timed lines, one per moment of the video. Each new line \
replaces the original line at that moment, so it must talk about the same thing the \
original line was about (that is what's on screen then), and it must be speakable within \
the line's word budget. Never invent product facts, numbers or claims that the original \
doesn't support. Write plain spoken text: no emoji, hashtags, stage directions or markup.\
"""


class ScriptLine(BaseModel):
    index: int
    text: str


class Script(BaseModel):
    lines: list[ScriptLine]


def rewrite_script(
    lines: list[tuple[str, float]],
    *,
    instructions: str,
    language: str,
) -> list[str]:
    """New narration aligned to `lines` (original text, seconds available)."""
    block = "\n".join(
        f"[L{i}] ({secs:.1f}s, max {max(3, int(secs * 2.4))} words) {text}"
        for i, (text, secs) in enumerate(lines)
    )
    task = f"""\
Rewrite every line above as new narration.

Direction from the creator: {instructions.strip() or "Explain it in a fresh, engaging way that's easy to follow."}

Rules:
- Return exactly one line per input line, with the same index (0 to {len(lines) - 1}).
- Stay within each line's word budget; shorter is fine. A line may be "" if that moment \
works better in silence.
- Together the lines should flow as one natural script, with a strong first line.
- Write in the language with code "{language}"."""
    result = _call(block, task, Script, system=SCRIPT_SYSTEM_PROMPT)
    by_index = {line.index: line.text.strip() for line in result.lines}
    return [by_index.get(i, "") for i in range(len(lines))]
