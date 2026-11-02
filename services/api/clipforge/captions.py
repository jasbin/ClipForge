"""Subtitles from word timings: SRT export, caption cues for the UI preview, and ASS for burned-in
captions that highlight each word as it is spoken.

The UI preview and the ASS renderer both consume `build_cues`, so what you see in the browser is
what gets burned into the MP4.
"""

import difflib
import re
from typing import Literal

from pydantic import BaseModel, Field

from .transcribe import Word, join_words

MAX_WORDS_PER_CUE = 7
MAX_CUE_SECONDS = 3.0


def _ts(t: float) -> str:
    ms = max(0, round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def srt_for_range(words: list[Word], start: float, end: float) -> str:
    """SRT for the words inside [start, end], with times relative to the clip start."""
    inside = [w for w in words if w.end > start and w.start < end]
    cues: list[list[Word]] = []
    for w in inside:
        cur = cues[-1] if cues else None
        if (cur is None or len(cur) >= MAX_WORDS_PER_CUE or w.end - cur[0].start > MAX_CUE_SECONDS
                or cur[-1].text.endswith((".", "?", "!"))):
            cues.append([w])
        else:
            cur.append(w)
    out = []
    for i, cue in enumerate(cues, 1):
        a = max(0.0, cue[0].start - start)
        b = min(end, cue[-1].end) - start
        out.append(f"{i}\n{_ts(a)} --> {_ts(b)}\n{join_words(cue)}\n")
    return "\n".join(out)


def _norm(t: str) -> str:
    return re.sub(r"[^\w]", "", t.lower())


def align_words(intended: str, heard: list[Word]) -> list[Word]:
    """Timings from `heard` (Whisper on the generated speech), text from `intended` (the script).

    TTS speaks the script almost verbatim, but Whisper may spell names or numbers differently
    ("48-megapixel" vs "48 megapixel"). Matching the two sequences keeps the script's spelling
    while every word still lights up when it is actually heard.
    """
    tokens = intended.split()
    if not tokens or not heard:
        return heard
    a, b = [_norm(t) for t in tokens], [_norm(w.text) for w in heard]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    if sm.ratio() < 0.5:  # not the same speech; trust what was heard
        return heard
    times: list[tuple[float, float] | None] = [None] * len(tokens)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                times[i1 + k] = (heard[j1 + k].start, heard[j1 + k].end)
        elif tag == "replace":
            # Spread the heard span over the script words in proportion to their length.
            t0, t1 = heard[j1].start, heard[j2 - 1].end
            lens = [max(1, len(a[i])) for i in range(i1, i2)]
            total, acc = sum(lens), 0
            for k, n in enumerate(lens):
                times[i1 + k] = (t0 + (t1 - t0) * acc / total, t0 + (t1 - t0) * (acc + n) / total)
                acc += n
    # Script words Whisper missed entirely: squeeze them between their neighbours.
    for i, t in enumerate(times):
        if t is None:
            prev = next((times[j][1] for j in range(i - 1, -1, -1) if times[j]), heard[0].start)
            nxt = next((times[j][0] for j in range(i + 1, len(times)) if times[j]), prev + 0.2)
            times[i] = (prev, max(prev + 0.05, min(nxt, prev + 0.25)))
    return [Word(text=tok, start=t[0], end=t[1]) for tok, t in zip(tokens, times)]  # type: ignore[index]


# --- Word-highlight captions -------------------------------------------------------------------

class CueWord(BaseModel):
    text: str
    start: float
    end: float


class Cue(BaseModel):
    start: float
    end: float
    words: list[CueWord]


PAUSE_BREAK = 0.7  # a silence this long starts a new caption line
CUE_MAX_SECONDS = 2.6
HOLD_AFTER = 0.4  # keep the last line on screen briefly after its final word


def build_cues(words: list[Word], words_per_line: int = 3,
               start: float | None = None, end: float | None = None) -> list[Cue]:
    """Group timed words into short on-screen lines. Times stay absolute (seconds into the video)."""
    lo = float("-inf") if start is None else start
    hi = float("inf") if end is None else end
    merged: list[CueWord] = []
    for w in words:
        if not (w.end > lo and w.start < hi):
            continue
        text = w.text.strip()
        if not text:
            continue
        # Whisper splits some tokens off the previous word (",000", "'s", "%"); glue them back.
        if merged and text[0] in ",.!?%:;)'’":
            merged[-1].text += text
            merged[-1].end = max(merged[-1].end, w.end)
        else:
            merged.append(CueWord(text=text, start=max(w.start, lo), end=min(w.end, hi)))

    groups: list[list[CueWord]] = []
    for w in merged:
        cur = groups[-1] if groups else None
        if (cur is None or len(cur) >= words_per_line or w.start - cur[-1].end > PAUSE_BREAK
                or w.end - cur[0].start > CUE_MAX_SECONDS or cur[-1].text.endswith((".", "?", "!"))):
            groups.append([w])
        else:
            cur.append(w)

    cues: list[Cue] = []
    for i, g in enumerate(groups):
        nxt = groups[i + 1][0].start if i + 1 < len(groups) else hi
        cue_end = min(g[-1].end + HOLD_AFTER, nxt, hi)
        cues.append(Cue(start=g[0].start, end=max(cue_end, g[-1].end), words=g))
    return cues


Preset = Literal["pop", "karaoke", "box", "minimal"]
Position = Literal["bottom", "middle", "top"]
Format = Literal["original", "vertical_crop", "vertical_blur"]


class CaptionStyle(BaseModel):
    """Mirrors `CaptionStyle` in apps/web/src/lib/captions.ts."""
    preset: Preset = "pop"
    font: str = Field("Arial Black", max_length=80)
    size: float = Field(7.0, ge=2, le=16)  # % of the output's shorter side
    text_color: str = Field("#FFFFFF", pattern=r"^#[0-9a-fA-F]{6}$")
    highlight_color: str = Field("#FFE600", pattern=r"^#[0-9a-fA-F]{6}$")
    outline_color: str = Field("#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    uppercase: bool = True
    words_per_line: int = Field(3, ge=1, le=8)
    position: Position = "bottom"
    format: Format = "original"


# Per-preset look. Outline/shadow are fractions of the font size; keep in sync with captions.ts.
PRESET_LOOK = {
    "pop": {"outline": 0.10, "shadow": 0.0, "pop": True},
    "karaoke": {"outline": 0.08, "shadow": 0.0, "pop": False},
    "box": {"outline": 0.0, "shadow": 0.0, "pop": False},
    "minimal": {"outline": 0.0, "shadow": 0.05, "pop": False},
}

# Distance of the caption block from the frame edge, as a fraction of the output height.
# Vertical exports sit higher, above the Shorts/Reels/TikTok UI.
MARGIN = {"original": 0.10, "vertical_crop": 0.24, "vertical_blur": 0.24}
BOX_PAD = 0.18  # box padding around the active word, fraction of font size


def _ass_color(hex_color: str, alpha: int = 0) -> str:
    r, g, b = hex_color[1:3], hex_color[3:5], hex_color[5:7]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _tag_color(hex_color: str) -> str:
    """Colour for inline override tags (\\c, \\3c): &HBBGGRR&, no alpha byte."""
    return f"&H{hex_color[5:7]}{hex_color[3:5]}{hex_color[1:3]}&".upper()


def _ass_time(t: float) -> str:
    cs = max(0, round(t * 100))
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _ass_text(text: str, upper: bool) -> str:
    text = text.replace("\\", "/").replace("{", "(").replace("}", ")")
    return text.upper() if upper else text


def ass_for_cues(cues: list[Cue], style: CaptionStyle, width: int, height: int, offset: float) -> str:
    """ASS subtitles with one event per spoken word, so the highlight follows the audio exactly.

    `offset` is subtracted from every time (the clip start, since the export begins at 0).
    """
    look = PRESET_LOOK[style.preset]
    font_px = round(min(width, height) * style.size / 100)
    outline = round(font_px * look["outline"], 1)
    shadow = round(font_px * look["shadow"], 1)
    margin_v = round(height * MARGIN[style.format])
    margin_h = round(width * 0.06)
    align = {"bottom": 2, "middle": 5, "top": 8}[style.position]
    bold = 0 if style.font in ("Arial Black", "Impact") else 1  # those faces are already heavy
    text_c = _ass_color(style.text_color)
    hi_c = _ass_color(style.highlight_color)
    out_c = _ass_color(style.outline_color)
    text_t, hi_t = _tag_color(style.text_color), _tag_color(style.highlight_color)
    shadow_c = _ass_color("#000000", 0x60)

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,{style.font},{font_px},{text_c},{text_c},{out_c},{shadow_c},{bold},0,0,0,100,100,0,0,1,{outline},{shadow},{align},{margin_h},{margin_h},{margin_v},1
Style: Box,{style.font},{font_px},&HFF000000,&HFF000000,{hi_c},&HFF000000,{bold},0,0,0,100,100,0,0,3,{round(font_px * BOX_PAD, 1)},0,{align},{margin_h},{margin_h},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events: list[str] = []
    for cue in cues:
        n = len(cue.words)
        for i, w in enumerate(cue.words):
            # The highlight moves to word i when it starts and stays until the next word starts,
            # so the line never flickers in the gaps between words.
            a = cue.start if i == 0 else w.start
            b = cue.words[i + 1].start if i + 1 < n else cue.end
            if b - a < 0.01:
                continue
            t0, t1 = _ass_time(a - offset), _ass_time(b - offset)
            parts = []
            box_parts = []
            for j, other in enumerate(cue.words):
                txt = _ass_text(other.text, style.uppercase)
                sep = "" if j == 0 else " "
                if style.preset == "pop":
                    tag = (rf"{{\c{hi_t}\fscx100\fscy100\t(0,90,\fscx112\fscy112)\t(90,180,\fscx106\fscy106)}}"
                           if j == i else rf"{{\c{text_t}\fscx100\fscy100}}")
                elif style.preset == "karaoke":
                    tag = rf"{{\c{hi_t}}}" if j <= i else rf"{{\c{text_t}}}"
                elif style.preset == "minimal":
                    tag = r"{\1a&H00&}" if j == i else r"{\1a&H70&}"
                else:  # box: text stays plain; the box layer below marks the active word
                    tag = rf"{{\c{text_t}}}"
                parts.append(f"{sep}{tag}{txt}")
                # Box layer: same text, invisible glyphs; only the active word's box is opaque.
                box_parts.append(("{\\3a&HFF&} " if j else "") + f"{{\\3a&H{'00' if j == i else 'FF'}&}}{txt}")
            if style.preset == "box":
                events.append(f"Dialogue: 0,{t0},{t1},Box,,0,0,0,,{''.join(box_parts)}")
            events.append(f"Dialogue: 1,{t0},{t1},Main,,0,0,0,,{''.join(parts)}")
    return header + "\n".join(events) + "\n"
