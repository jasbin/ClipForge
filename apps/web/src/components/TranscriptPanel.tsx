"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtTime, type Clip, type Sentence } from "@/lib/api";
import { Icon } from "./icons";
import { Input, cx } from "./ui";

export function TranscriptPanel({
  sentences, clips, activeClip, currentTime, onSeek,
}: {
  sentences: Sentence[];
  clips: Clip[];
  activeClip: Clip | null;
  currentTime: number;
  onSeek: (t: number) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const playingId = sentences.find((s) => currentTime >= s.start && currentTime < s.end + 0.3)?.id;

  // Keep the spoken sentence in view, scrolling only inside the panel (not while searching).
  useEffect(() => {
    const el = activeRef.current, box = boxRef.current;
    if (!el || !box || q) return;
    const top = el.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 60) {
      box.scrollTo({ top: top - 80, behavior: "smooth" });
    }
  }, [playingId, q]);

  const clipFor = (s: Sentence) => clips.find((c) => s.start < c.end && s.end > c.start);
  const shown = useMemo(() => (q ? sentences.filter((s) => s.text.toLowerCase().includes(q)) : sentences), [sentences, q]);

  function highlight(text: string) {
    if (!q) return text;
    const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
    return parts.map((p, i) => (p.toLowerCase() === q ? <mark key={i} className="rounded bg-warning-soft px-0.5 text-fg">{p}</mark> : p));
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="relative border-b border-line p-2">
        <Icon.Search className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-muted" width={14} height={14} />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search transcript"
          aria-label="Search transcript" className="h-8 border-transparent pl-8 shadow-none" />
        {q && (
          <span className="absolute top-1/2 right-5 -translate-y-1/2 text-xs text-muted">{shown.length} found</span>
        )}
      </div>
      <div ref={boxRef} className="relative max-h-[55vh] overflow-y-auto p-2 text-sm">
        {shown.length === 0 && <p className="p-4 text-center text-sm text-muted">No lines match “{query}”.</p>}
        {shown.map((s) => {
          const clip = clipFor(s);
          const inActive = activeClip && s.start < activeClip.end && s.end > activeClip.start;
          return (
            <button key={s.id} ref={s.id === playingId ? activeRef : undefined} onClick={() => onSeek(s.start)}
              className={cx("flex w-full cursor-pointer gap-3 rounded-lg border-l-2 px-2 py-1.5 text-left transition-colors hover:bg-hover",
                inActive ? "border-accent bg-accent-soft" : clip ? "border-accent/40" : "border-transparent",
                s.id === playingId && "font-medium")}>
              <span className="w-11 shrink-0 pt-px font-mono text-[11px] text-muted">{fmtTime(s.start)}</span>
              <span className={clip ? "" : "text-muted"}>
                {highlight(s.text)}
                {clip && s.start <= clip.start + 0.5 && s.end >= clip.start && (
                  <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-on-accent">#{clip.rank}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
