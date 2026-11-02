"use client";

import { useState } from "react";
import { api, fmtTime, type Clip, type VoiceLibrary } from "@/lib/api";
import type { AudioSource } from "@/lib/api";
import type { CaptionStyle } from "@/lib/captions";
import { CaptionStudio } from "./CaptionStudio";
import { errorMessage, useFeedback } from "./feedback";
import { Icon } from "./icons";
import { Badge, Button, buttonClass, cx } from "./ui";
import { VoiceoverPanel } from "./VoiceoverPanel";

const SCORE_LABELS: Record<string, string> = {
  hook: "Hook",
  payoff: "Payoff",
  standalone: "Standalone",
  quotability: "Quotable",
  emotion: "Emotion",
  audio_excitement: "Audio energy",
};

function scoreTone(v: number) {
  return v >= 75 ? "text-success" : v >= 60 ? "text-accent-fg" : "text-muted";
}

/** Circular score gauge for the overall virality score (0–100). */
function ScoreRing({ value }: { value: number }) {
  const r = 20, c = 2 * Math.PI * r;
  return (
    <div className={cx("relative grid h-14 w-14 shrink-0 place-items-center", scoreTone(value))} title={`Virality score ${value.toFixed(0)}/100`}>
      <svg viewBox="0 0 48 48" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="24" cy="24" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="4" />
        <circle cx="24" cy="24" r={r} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, value) / 100)} />
      </svg>
      <span className="text-base font-semibold tabular-nums">{value.toFixed(0)}</span>
    </div>
  );
}

const VOICE_BADGE: Partial<Record<Clip["voice_status"], { tone: "accent" | "success" | "danger" | "warning"; label: string }>> = {
  queued: { tone: "accent", label: "Queued" },
  running: { tone: "accent", label: "Generating" },
  done: { tone: "success", label: "Ready" },
  error: { tone: "danger", label: "Failed" },
  cancelled: { tone: "warning", label: "Stopped" },
};

export function ClipCard({
  clip, active, onPlay, voices, onVoiceoverStarted, onCaptionStyle,
}: {
  clip: Clip;
  active: boolean;
  onPlay: () => void;
  voices: VoiceLibrary | null;
  onVoiceoverStarted: () => void;
  onCaptionStyle: (clipId: string, style: CaptionStyle) => void;
}) {
  const { toast } = useFeedback();
  const [feedback, setFeedback] = useState(clip.feedback ?? 0);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [studio, setStudio] = useState<AudioSource | null>(null); // open, with this soundtrack
  const [voiceOpen, setVoiceOpen] = useState(clip.voice_status !== "none" || !!clip.script);

  async function vote(v: -1 | 1) {
    const prev = feedback;
    const next = feedback === v ? 0 : v;
    setFeedback(next);
    try {
      await api.feedback(clip.id, next as -1 | 0 | 1);
    } catch (e) {
      setFeedback(prev);
      toast({ tone: "error", title: "Couldn't save feedback", description: errorMessage(e) });
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${clip.title}\n\n${clip.hook}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ tone: "error", title: "Clipboard unavailable" });
    }
  }

  async function download() {
    // The first download cuts the clip with ffmpeg, which takes a few seconds.
    setDownloading(true);
    try {
      await api.downloadClip(clip.id, `clip-${clip.rank}.mp4`);
    } catch (e) {
      toast({ tone: "error", title: "Download failed", description: errorMessage(e) });
    } finally {
      setDownloading(false);
    }
  }

  const duration = clip.end - clip.start;
  const vb = VOICE_BADGE[clip.voice_status];

  return (
    <article id={`clip-${clip.id}`} aria-current={active || undefined}
      className={cx("scroll-mt-20 grid grid-cols-1 gap-4 rounded-2xl border bg-surface p-4 shadow-card transition-[border-color,box-shadow] sm:p-5",
        active ? "border-accent ring-3 ring-accent/20" : "border-line")}>
      <header className="flex items-start gap-3.5">
        <ScoreRing value={clip.virality} />
        <div className="min-w-0 flex-1">
          <h3 className="leading-snug font-semibold text-pretty">
            <span className="mr-1.5 text-muted tabular-nums">#{clip.rank}</span>{clip.title}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted tabular-nums">
            <span>{fmtTime(clip.start)} – {fmtTime(clip.end)}</span>
            <span aria-hidden>·</span>
            <span>{duration.toFixed(0)}s</span>
          </p>
        </div>
        <div className="flex shrink-0 gap-0.5" role="group" aria-label="Rate this clip">
          <button onClick={() => vote(1)} aria-pressed={feedback === 1} title="Good clip"
            className={cx("grid h-8 w-8 cursor-pointer place-items-center rounded-lg transition-colors",
              feedback === 1 ? "bg-success-soft text-success" : "text-muted hover:bg-hover hover:text-fg")}>
            <Icon.ThumbUp />
          </button>
          <button onClick={() => vote(-1)} aria-pressed={feedback === -1} title="Bad clip"
            className={cx("grid h-8 w-8 cursor-pointer place-items-center rounded-lg transition-colors",
              feedback === -1 ? "bg-danger-soft text-danger" : "text-muted hover:bg-hover hover:text-fg")}>
            <Icon.ThumbDown />
          </button>
        </div>
      </header>

      <blockquote className="rounded-r-lg border-l-2 border-accent bg-accent-soft/50 py-2 pr-3 pl-3.5 text-sm italic">
        “{clip.hook}”
      </blockquote>
      <p className="text-sm leading-relaxed text-muted">{clip.reason}</p>
      {clip.missing_context && (
        <p className="flex gap-2 rounded-lg bg-warning-soft p-2.5 text-xs text-warning">
          <Icon.Alert className="mt-px shrink-0" width={14} height={14} />
          <span><span className="font-semibold">Missing context:</span> {clip.missing_context}</span>
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-3">
        {Object.entries(clip.scores).map(([k, v]) => (
          <div key={k} className="text-xs">
            <div className="flex justify-between">
              <dt className="text-muted">{SCORE_LABELS[k] ?? k}</dt>
              <dd className="font-medium tabular-nums">{Math.round(v * 100)}</dd>
            </div>
            <div className="mt-1 h-1 rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(1, v) * 100}%` }} />
            </div>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button size="sm" variant="primary" icon={<Icon.Play width={14} height={14} />} onClick={onPlay}>Play</Button>
        <Button size="sm" onClick={() => setStudio(clip.voice_status === "done" ? "voiceover" : "original")}
          icon={<span className="rounded-[3px] border-[1.5px] border-current px-[2px] text-[8px] leading-[10px] font-bold">CC</span>}>
          Captions &amp; music
        </Button>
        <Button size="sm" loading={downloading} icon={<Icon.Download width={14} height={14} />} onClick={download}>
          {downloading ? "Cutting…" : "MP4"}
        </Button>
        <a href={api.srtUrl(clip.id)} className={buttonClass("secondary", "sm")} download>
          <Icon.FileText width={14} height={14} /> SRT
        </a>
        <Button size="sm" variant="ghost" icon={copied ? <Icon.Check width={14} height={14} /> : <Icon.Copy width={14} height={14} />} onClick={copy}>
          {copied ? "Copied" : "Copy text"}
        </Button>
      </div>

      {studio && (
        <CaptionStudio clip={clip} initialSource={studio} onClose={() => setStudio(null)}
          onStyleSaved={(style) => onCaptionStyle(clip.id, style)} />
      )}

      <div className="rounded-xl border border-line">
        <button onClick={() => setVoiceOpen((o) => !o)} aria-expanded={voiceOpen}
          className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-3.5 py-2.5 text-left text-sm hover:bg-hover">
          <Icon.Mic className="text-muted" />
          <span className="font-medium">AI voiceover</span>
          {vb && <Badge tone={vb.tone}>{vb.label}{clip.voice_status === "running" && ` ${clip.voice_progress.toFixed(0)}%`}</Badge>}
          <Icon.Chevron className={cx("ml-auto text-muted transition-transform", voiceOpen && "rotate-180")} />
        </button>
        {voiceOpen && (
          <div className="border-t border-line p-3.5">
            <VoiceoverPanel clip={clip} voices={voices} onStarted={onVoiceoverStarted} onOpenStudio={() => setStudio("voiceover")} />
          </div>
        )}
      </div>
    </article>
  );
}
