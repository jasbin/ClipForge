"use client";

import { useEffect, useState, type RefObject } from "react";
import { activeWord, blockStyle, cueAt, wordStyle, type CaptionStyle, type Cue } from "@/lib/captions";

/**
 * The video's current time, sampled every frame while it plays. `timeupdate` only fires ~4×/s,
 * far too coarse to highlight words as they are spoken.
 */
export function useFrameTime(ref: RefObject<HTMLVideoElement | null>, enabled = true) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const v = ref.current;
    if (!v || !enabled) return;
    let raf = 0;
    const tick = () => {
      setT(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    const start = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(raf); setT(v.currentTime); };
    v.addEventListener("play", start);
    v.addEventListener("pause", stop);
    v.addEventListener("seeked", stop);
    v.addEventListener("ended", stop);
    if (!v.paused) start(); else setT(v.currentTime);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("play", start);
      v.removeEventListener("pause", stop);
      v.removeEventListener("seeked", stop);
      v.removeEventListener("ended", stop);
    };
  }, [ref, enabled]);
  return t;
}

/** Draws the caption line for time `t`. Place inside a positioned box the size of the video frame. */
export function CaptionOverlay({ cues, style, time }: { cues: Cue[]; style: CaptionStyle; time: number }) {
  const cue = cueAt(cues, time);
  const active = cue ? activeWord(cue, time) : -1;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden [container-type:size]" aria-hidden>
      {cue && (
        <div style={blockStyle(style)}>
          {cue.words.map((w, i) => (
            <span key={`${cue.start}-${i}`}>
              {i > 0 && " "}
              <span style={wordStyle(style, i, active)}>{w.text}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
