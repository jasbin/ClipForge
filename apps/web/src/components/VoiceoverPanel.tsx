"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, fmtTime, type Clip, type ScriptLine, type VoiceLibrary } from "@/lib/api";
import { normalizeStyle, type Cue } from "@/lib/captions";
import { CaptionOverlay, useFrameTime } from "./CaptionOverlay";
import { errorMessage, useFeedback } from "./feedback";
import { Icon } from "./icons";
import { Alert, Button, Field, Input, ProgressTrack, Segmented, Select, Textarea, buttonClass, cx } from "./ui";

const STYLE_IDEAS = [
  "Speak like an enthusiastic product presenter.",
  "Calm, confident and warm, like a premium brand ad.",
  "Fast-paced and energetic, like a tech YouTuber.",
  "Friendly and conversational, like explaining to a friend.",
];

const DIRECTION_IDEAS = [
  "Explain it simply for someone who isn't into tech.",
  "Make it punchy and a little funny.",
  "Turn it into a persuasive sales pitch.",
  "Explain it like a detailed tech review.",
  "Tell it as a quick story.",
];

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export function VoiceoverPanel({
  clip, voices, onStarted, onOpenStudio,
}: {
  clip: Clip;
  voices: VoiceLibrary | null;
  onStarted: () => void;
  onOpenStudio: () => void;
}) {
  const { toast, confirm } = useFeedback();
  const [preview, setPreview] = useState<number | null>(null); // cache-buster while open
  const [voiceId, setVoiceId] = useState<string | null>(null); // null = use the saved default
  const [style, setStyle] = useState("");
  const [background, setBackground] = useState(0);
  // A saved script (from the server) survives page reloads; start from it if present.
  const [mode, setMode] = useState<"exact" | "rewrite">(clip.script ? "rewrite" : "exact");
  const [direction, setDirection] = useState(clip.script?.direction ?? "");
  const [script, setScript] = useState<ScriptLine[] | null>(clip.script?.lines ?? null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  // Word-highlight captions on the preview, timed from the generated speech itself.
  const previewRef = useRef<HTMLVideoElement>(null);
  const [previewCues, setPreviewCues] = useState<Cue[] | null>(null);
  const captionStyle = { ...normalizeStyle(clip.caption_style), format: "original" as const };
  const previewTime = useFrameTime(previewRef, preview !== null);
  useEffect(() => {
    if (preview === null || clip.voice_status !== "done") return;
    setPreviewCues(null);
    api.clipCaptions(clip.id, "voiceover", captionStyle.words_per_line).then(setPreviewCues, () => setPreviewCues([]));
  }, [preview, clip.id, clip.voice_status, captionStyle.words_per_line]);

  const chosen = voiceId ?? voices?.default ?? "qwen:ryan";
  const isSpeaker = chosen.startsWith("qwen:");
  const busy = clip.voice_status === "queued" || clip.voice_status === "running";
  const needsScript = mode === "rewrite" && !script;

  function editLine(i: number, text: string) {
    if (!script) return;
    const next = script.map((l, j) => (j === i ? { ...l, text } : l));
    setScript(next);
    // Autosave shortly after typing stops.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(() => {
      api.saveScript(clip.id, next.map((l) => l.text), direction)
        .then(() => setSaveState("saved"), () => setSaveState("error"));
    }, 800);
  }

  async function discardScript() {
    const ok = await confirm({
      title: "Discard this script?",
      description: "Your edits will be lost. You can write a new one any time.",
      confirmLabel: "Discard", danger: true,
    });
    if (!ok) return;
    try {
      await api.discardScript(clip.id);
      setScript(null);
      setSaveState("idle");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function writeScript() {
    setWriting(true);
    setError(null);
    try {
      setScript((await api.writeScript(clip.id, direction)).lines);
      setSaveState("saved");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWriting(false);
    }
  }

  async function start() {
    setStarting(true);
    setError(null);
    try {
      await api.startVoiceover(clip.id, {
        voice_id: chosen,
        style: isSpeaker ? style : "",
        original_volume: background,
        script: mode === "rewrite" && script ? script.map((l) => l.text) : undefined,
      });
      setPreview(null);
      toast({ tone: "success", title: "Voiceover queued", description: `#${clip.rank} ${clip.title}` });
      onStarted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    setStopping(true);
    try {
      await api.cancelVoiceover(clip.id);
      onStarted(); // refresh clip status
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {/* Narration: the clip's own words, or a new script written by the LLM */}
      <div className="grid grid-cols-1 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented label="Narration" size="sm" value={mode} onChange={setMode} disabled={busy} className="w-full sm:w-auto"
            options={[
              { value: "exact", label: "Original words" },
              { value: "rewrite", label: <><Icon.Sparkles width={12} height={12} /> Rewrite with AI</> },
            ]} />
          <Link href="/voices" className="text-xs text-accent-fg hover:underline">Manage voices →</Link>
        </div>

        {mode === "rewrite" && (
          <div className="grid grid-cols-1 gap-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input list={`dir-${clip.id}`} value={direction} onChange={(e) => setDirection(e.target.value)}
                disabled={busy || writing} maxLength={500} aria-label="Script direction"
                placeholder="How should it be told? e.g. Explain it simply for beginners."
                className="h-9 min-w-0 sm:flex-1" />
              <datalist id={`dir-${clip.id}`}>
                {DIRECTION_IDEAS.map((d) => <option key={d} value={d} />)}
              </datalist>
              <Button onClick={writeScript} loading={writing} disabled={busy} size="sm" className="h-9"
                icon={!writing && (script ? <Icon.Refresh width={14} height={14} /> : <Icon.Sparkles width={14} height={14} />)}>
                {writing ? "Writing… (~1 min)" : script ? "Rewrite" : "Write script"}
              </Button>
            </div>

            {script && (
              <div className="grid grid-cols-1 gap-2.5">
                <ol className="grid grid-cols-1 gap-2.5">
                  {script.map((line, i) => {
                    const n = words(line.text);
                    const over = n > line.max_words;
                    return (
                      <li key={i} className="grid min-w-0 grid-cols-1 gap-1">
                        <div className="flex justify-between gap-3 text-[11px] text-muted">
                          <span className="min-w-0 truncate" title={line.original}>
                            <span className="font-mono">{fmtTime(line.start)}–{fmtTime(line.end)}</span> · was: “{line.original}”
                          </span>
                          <span className={cx("shrink-0 tabular-nums", over && "font-semibold text-warning")}>{n}/{line.max_words} words</span>
                        </div>
                        <Textarea value={line.text} rows={Math.max(1, Math.ceil(line.text.length / 70))} disabled={busy}
                          onChange={(e) => editLine(i, e.target.value)} aria-label={`Line ${i + 1}`}
                          placeholder="(silent at this moment)"
                          className={cx("resize-y", over && "border-warning/60")} />
                      </li>
                    );
                  })}
                </ol>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted">
                    Each line plays at its moment in the video. Lines over the word budget are sped up slightly.
                  </span>
                  <span className="flex items-center gap-3">
                    <span className={saveState === "error" ? "text-danger" : "text-muted"} aria-live="polite">
                      {{ idle: "", saving: "Saving…", saved: "Saved", error: "Couldn't save" }[saveState]}
                    </span>
                    <button onClick={discardScript} disabled={busy} className="cursor-pointer text-danger hover:underline disabled:opacity-50">
                      Discard script
                    </button>
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Voice">
          <Select value={chosen} onChange={(e) => setVoiceId(e.target.value)} disabled={busy}>
            <optgroup label="Qwen voices">
              {voices?.speakers.map((s) => (
                <option key={s.id} value={s.id}>{s.name} — {s.native}</option>
              )) ?? <option value="qwen:ryan">Ryan — English</option>}
            </optgroup>
            {!!voices?.voices.length && (
              <optgroup label="Your voices (cloned)">
                {voices.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </optgroup>
            )}
          </Select>
        </Field>
        <Field label="Original audio underneath">
          <Select value={background} onChange={(e) => setBackground(Number(e.target.value))} disabled={busy}>
            <option value={0}>Off (replace)</option>
            <option value={0.1}>10%</option>
            <option value={0.2}>20%</option>
          </Select>
        </Field>
        {isSpeaker && (
          <Field label={<>Speaking style <span className="font-normal text-muted">(optional)</span></>} className="sm:col-span-2">
            <Input list={`styles-${clip.id}`} value={style} onChange={(e) => setStyle(e.target.value)} disabled={busy}
              maxLength={300} placeholder="e.g. Speak like an enthusiastic product presenter." />
            <datalist id={`styles-${clip.id}`}>
              {STYLE_IDEAS.map((s) => <option key={s} value={s} />)}
            </datalist>
          </Field>
        )}
      </div>

      {busy ? (
        <div className="grid gap-2 rounded-lg bg-surface-2 p-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">{clip.voice_status === "queued" ? "Waiting in queue…" : "Generating speech on the Metal GPU…"}</span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums text-muted">{clip.voice_progress.toFixed(0)}%</span>
              <Button size="xs" variant="danger-ghost" loading={stopping} onClick={stop} icon={<Icon.Stop width={10} height={10} />}>
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            </span>
          </div>
          <ProgressTrack value={clip.voice_progress} indeterminate={clip.voice_status === "queued"} />
          <p className="text-xs text-muted">Roughly 2 s of generation per second of speech.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={start} loading={starting} disabled={needsScript} variant="primary" size="sm"
            title={needsScript ? "Write the script first" : undefined}
            icon={<Icon.Mic width={14} height={14} />}>
            {clip.voice_status === "done" ? "Re-generate voiceover" : "Generate voiceover"}
          </Button>
          {clip.voice_status === "done" && (
            <>
              <Button size="sm" onClick={() => setPreview((p) => (p ? null : Date.now()))}
                icon={preview ? <Icon.X width={14} height={14} /> : <Icon.Play width={14} height={14} />}>
                {preview ? "Hide preview" : "Preview"}
              </Button>
              <a href={api.voiceoverUrl(clip.id)} download className={buttonClass("secondary", "sm")}>
                <Icon.Download width={14} height={14} /> Voiceover MP4
              </a>
              <Button size="sm" onClick={onOpenStudio}
                icon={<span className="rounded-[3px] border-[1.5px] border-current px-[2px] text-[8px] leading-[10px] font-bold">CC</span>}>
                Add captions &amp; music
              </Button>
            </>
          )}
          {clip.voice_status === "cancelled" && <span className="text-xs text-warning">Stopped.</span>}
        </div>
      )}

      {preview !== null && clip.voice_status === "done" && (
        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
          <video ref={previewRef} src={api.voiceoverUrl(clip.id, preview)} controls autoPlay className="absolute inset-0 h-full w-full" />
          {previewCues && <CaptionOverlay cues={previewCues} style={captionStyle} time={previewTime} />}
        </div>
      )}
      {clip.voice_status === "error" && clip.voice_error && <Alert title="Voiceover failed">{clip.voice_error}</Alert>}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
