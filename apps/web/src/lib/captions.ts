import type { CSSProperties } from "react";

/* Word-highlight captions. Mirrors CaptionStyle / PRESET_LOOK / MARGIN in
   services/api/clipforge/captions.py, so the browser preview matches the burned-in export. */

export type CaptionPreset = "pop" | "karaoke" | "box" | "minimal";
export type CaptionPosition = "bottom" | "middle" | "top";
export type CaptionFormat = "original" | "vertical_crop" | "vertical_blur";

export type CaptionStyle = {
  preset: CaptionPreset;
  font: string;
  size: number; // % of the output's shorter side
  text_color: string;
  highlight_color: string;
  outline_color: string;
  uppercase: boolean;
  words_per_line: number;
  position: CaptionPosition;
  format: CaptionFormat;
};

export type CueWord = { text: string; start: number; end: number };
export type Cue = { start: number; end: number; words: CueWord[] };

export const PRESETS: Record<CaptionPreset, { label: string; description: string; defaults: Partial<CaptionStyle> }> = {
  pop: {
    label: "Bold Pop",
    description: "Heavy outlined caps; the spoken word pops in colour",
    defaults: { font: "Arial Black", highlight_color: "#FFE600", text_color: "#FFFFFF", uppercase: true, words_per_line: 3, size: 7 },
  },
  box: {
    label: "Highlight box",
    description: "A coloured box jumps to each word as it's spoken",
    defaults: { font: "Arial Black", highlight_color: "#F43F5E", text_color: "#FFFFFF", uppercase: true, words_per_line: 3, size: 6.5 },
  },
  karaoke: {
    label: "Karaoke",
    description: "Words fill with colour as they're spoken",
    defaults: { font: "Futura", highlight_color: "#22D3EE", text_color: "#FFFFFF", uppercase: false, words_per_line: 5, size: 6 },
  },
  minimal: {
    label: "Minimal",
    description: "Clean type; the current word is bright, the rest dimmed",
    defaults: { font: "Avenir Next", highlight_color: "#FFFFFF", text_color: "#FFFFFF", uppercase: false, words_per_line: 6, size: 5 },
  },
};

export const DEFAULT_STYLE: CaptionStyle = {
  preset: "pop",
  font: "Arial Black",
  size: 7,
  text_color: "#FFFFFF",
  highlight_color: "#FFE600",
  outline_color: "#000000",
  uppercase: true,
  words_per_line: 3,
  position: "bottom",
  format: "original",
};

/** Fonts available to both the browser (macOS) and libass. `em` = CSS em per libass font-size unit. */
export const FONTS: { name: string; em: number }[] = [
  { name: "Arial Black", em: 0.709 },
  { name: "Impact", em: 0.82 },
  { name: "Futura", em: 0.77 },
  { name: "Avenir Next", em: 0.732 },
  { name: "Helvetica Neue", em: 0.858 },
  { name: "Verdana", em: 0.823 },
  { name: "Trebuchet MS", em: 0.861 },
];

export const HIGHLIGHT_SWATCHES = ["#FFE600", "#22D3EE", "#4ADE80", "#F43F5E", "#A78BFA", "#FB923C", "#FFFFFF"];

const LOOK: Record<CaptionPreset, { outline: number; shadow: number; pop: boolean }> = {
  pop: { outline: 0.1, shadow: 0, pop: true },
  karaoke: { outline: 0.08, shadow: 0, pop: false },
  box: { outline: 0, shadow: 0, pop: false },
  minimal: { outline: 0, shadow: 0.05, pop: false },
};
const MARGIN: Record<CaptionFormat, number> = { original: 0.1, vertical_crop: 0.24, vertical_blur: 0.24 };
const BOX_PAD = 0.18;

export const withPreset = (style: CaptionStyle, preset: CaptionPreset): CaptionStyle => ({ ...style, ...PRESETS[preset].defaults, preset });

export function normalizeStyle(s: Partial<CaptionStyle> | null | undefined): CaptionStyle {
  return { ...DEFAULT_STYLE, ...(s ?? {}) };
}

/** Index of the word being spoken at time t (the highlight holds until the next word starts). */
export function activeWord(cue: Cue, t: number) {
  let i = 0;
  for (let j = 0; j < cue.words.length; j++) if (t >= cue.words[j].start) i = j;
  return i;
}

export function cueAt(cues: Cue[], t: number) {
  // Cues are sorted and short, so a binary search keeps 60 fps updates cheap on long videos.
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < cues[mid].start) hi = mid - 1;
    else if (t >= cues[mid].end) lo = mid + 1;
    else return cues[mid];
  }
  return null;
}

/**
 * CSS for the caption block. Sizes use container-query units of the video frame (cqmin/cqh),
 * so the overlay scales with the player exactly as the ASS file scales with the output.
 */
export function blockStyle(s: CaptionStyle): CSSProperties {
  const em = FONTS.find((f) => f.name === s.font)?.em ?? 0.8;
  const look = LOOK[s.preset];
  const fontSize = `${s.size * em}cqmin`;
  const outline = `${s.size * look.outline}cqmin`;
  const margin = `${MARGIN[s.format] * 100}cqh`;
  const pos: CSSProperties =
    s.position === "bottom" ? { bottom: margin } : s.position === "top" ? { top: margin } : { top: "50%", transform: "translateY(-50%)" };
  return {
    position: "absolute",
    left: "6%",
    right: "6%",
    ...pos,
    textAlign: "center",
    fontFamily: `"${s.font}", system-ui, sans-serif`,
    fontWeight: s.font === "Arial Black" || s.font === "Impact" ? 400 : 700,
    fontSize,
    lineHeight: 1.18,
    color: s.text_color,
    textTransform: s.uppercase ? "uppercase" : "none",
    WebkitTextStroke: look.outline ? `calc(${outline} * 2) ${s.outline_color}` : undefined,
    paintOrder: "stroke fill",
    textShadow: look.shadow ? `0 calc(${s.size * look.shadow}cqmin) calc(${s.size * look.shadow * 2}cqmin) rgb(0 0 0 / 0.6)` : undefined,
    pointerEvents: "none",
  };
}

export function wordStyle(s: CaptionStyle, index: number, active: number): CSSProperties {
  const on = index === active;
  // libass pads the box by BOX_PAD × its font size, which is 1/em CSS ems.
  const pad = `${BOX_PAD / (FONTS.find((f) => f.name === s.font)?.em ?? 0.8)}em`;
  switch (s.preset) {
    case "pop":
      return on
        ? { color: s.highlight_color, display: "inline-block", transform: "scale(1.06)", animation: "caption-pop 180ms ease-out" }
        : { display: "inline-block" };
    case "karaoke":
      return { color: index <= active ? s.highlight_color : s.text_color };
    case "minimal":
      return { opacity: on ? 1 : 0.55 };
    case "box":
      return on
        ? { background: s.highlight_color, boxShadow: `0 0 0 ${pad} ${s.highlight_color}`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }
        : {};
  }
}
