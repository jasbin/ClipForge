"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, fmtDuration, fmtTime, type AudioSource, type Clip, type MusicChoice, type Track } from "@/lib/api";
import {
  FONTS, HIGHLIGHT_SWATCHES, PRESETS, blockStyle, cueAt, normalizeStyle, withPreset, wordStyle,
  type CaptionFormat, type CaptionPreset, type CaptionStyle, type Cue,
} from "@/lib/captions";
import { CaptionOverlay, useFrameTime } from "./CaptionOverlay";
import { errorMessage, useFeedback } from "./feedback";
import { Icon } from "./icons";
import { Alert, Button, Field, Segmented, Select, Spinner, cx } from "./ui";

const FORMATS: { value: CaptionFormat; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "vertical_crop", label: "9:16 crop" },
  { value: "vertical_blur", label: "9:16 fit" },
];

const MUSIC_KEY = "clipforge-music";

function storedMusic(): MusicChoice | null {
  try {
    return JSON.parse(localStorage.getItem(MUSIC_KEY) ?? "null");
  } catch {
    return null;
  }
}

/**
 * Full-screen export editor for one clip: soundtrack (original or AI voiceover), word-highlight
 * captions, framing and background music, with a live preview that matches the exported MP4.
 */
export function CaptionStudio({ clip, onClose, onStyleSaved, initialSource = "original" }: {
  clip: Clip;
  onClose: () => void;
  onStyleSaved: (style: CaptionStyle) => void;
  initialSource?: AudioSource;
}) {
  const { toast } = useFeedback();
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  const [style, setStyle] = useState<CaptionStyle>(() => normalizeStyle(clip.caption_style));
  const hasVoiceover = clip.voice_status === "done";
  const [source, setSource] = useState<AudioSource>(hasVoiceover ? initialSource : "original");
  const [captionsOn, setCaptionsOn] = useState(true);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [music, setMusic] = useState<MusicChoice | null>(null);
  const [voiceBust] = useState(() => Date.now());
  const audio = useRef<HTMLAudioElement>(null);
  const [cues, setCues] = useState<Cue[] | null>(null);
  const [cueError, setCueError] = useState<string | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const [playing, setPlaying] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [exporting, setExporting] = useState(false);
  const [exportStarted, setExportStarted] = useState(0);
  const [now, setNow] = useState(0);
  const exportAbort = useRef<AbortController | null>(null);
  const time = useFrameTime(video);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // Size the preview frame to fit the stage at the output's aspect ratio, so the caption overlay
  // lines up with the picture exactly like the export does.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const duration = clip.end - clip.start;
  // The original plays from the full proxy at the clip's absolute times; the voiceover MP4 is
  // already cut, so its clock starts at 0.
  const t0 = source === "voiceover" ? 0 : clip.start;
  const t1 = t0 + duration;
  const vertical = style.format !== "original";
  const ratio = vertical ? 9 / 16 : aspect;
  const frameW = Math.min(box.w, box.h * ratio);
  const frame = { width: frameW, height: frameW / ratio };

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  // Caption lines depend on the soundtrack and words-per-line; refetch when either changes.
  // The first voiceover request times its words with Whisper, which takes a few seconds.
  useEffect(() => {
    let alive = true;
    setCueError(null);
    const t = setTimeout(() => {
      api.clipCaptions(clip.id, source, style.words_per_line)
        .then((c) => alive && setCues(c), (e) => alive && setCueError(errorMessage(e)));
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [clip.id, source, style.words_per_line]);

  useEffect(() => { setCues(null); }, [source]);

  // Music library, and the last music settings used (remembered per browser).
  useEffect(() => {
    api.music().then((ts) => {
      setTracks(ts);
      const m = storedMusic();
      if (m && ts.some((t) => t.id === m.track_id)) setMusic(m);
    }, () => setTracks([]));
  }, []);

  function changeMusic(m: MusicChoice | null) {
    setMusic(m);
    try {
      if (m) localStorage.setItem(MUSIC_KEY, JSON.stringify(m));
      else localStorage.removeItem(MUSIC_KEY);
    } catch {}
  }

  // Keep the music preview in step with the video, and dip it while someone is speaking
  // (an approximation of the sidechain ducking the export applies).
  const track = tracks?.find((t) => t.id === music?.track_id) ?? null;
  useEffect(() => {
    const a = audio.current, v = video.current;
    if (!a || !v || !track || !music) return;
    if (v.paused) {
      if (!a.paused) a.pause();
      return;
    }
    const expected = (music.offset + Math.max(0, time - t0)) % Math.max(1, track.duration);
    if (Math.abs(a.currentTime - expected) > 0.3) a.currentTime = expected;
    const speaking = !!cues && cueAt(cues, time) !== null;
    const fade = Math.min(1, (time - t0) / 0.8, (t1 - time) / 1.5);
    a.volume = Math.max(0, Math.min(1, music.volume * (music.duck && speaking ? 0.3 : 1) * Math.max(0, fade)));
    if (a.paused) a.play().catch(() => {});
  }, [time, track, music, cues, t0, t1]);

  // Autosave the style shortly after the last change. The callback lives in a ref so a new
  // function from the parent doesn't retrigger the save.
  const savedCb = useRef(onStyleSaved);
  savedCb.current = onStyleSaved;
  const lastSaved = useRef(JSON.stringify(style));
  useEffect(() => {
    const json = JSON.stringify(style);
    if (json === lastSaved.current) return;
    setSaveState("saving");
    const t = setTimeout(() => {
      api.saveCaptionStyle(clip.id, style).then(() => {
        lastSaved.current = json;
        setSaveState("saved");
        savedCb.current(style);
      }, () => setSaveState("error"));
    }, 600);
    return () => clearTimeout(t);
  }, [style, clip.id]);

  // Loop playback inside the clip.
  useEffect(() => {
    const v = video.current;
    if (v && time >= t1 - 0.05) {
      v.currentTime = t0;
      v.play().catch(() => {});
    }
  }, [time, t0, t1]);

  // Blurred backdrop for the "9:16 fit" format, drawn from the playing video.
  useEffect(() => {
    if (style.format !== "vertical_blur") return;
    const v = video.current, c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!v || !c || !ctx) return;
    let raf = 0;
    const draw = () => {
      if (v.videoWidth) {
        const scale = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
        const w = v.videoWidth * scale, h = v.videoHeight * scale;
        ctx.drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [style.format]);

  // Space toggles playback (outside form fields).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (e.key !== " " || t.closest("input, textarea, select, button")) return;
      e.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!exporting) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [exporting]);

  const set = <K extends keyof CaptionStyle>(k: K, v: CaptionStyle[K]) => setStyle((s) => ({ ...s, [k]: v }));

  function toggle() {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < t0 || v.currentTime >= t1 - 0.05) v.currentTime = t0;
      v.play().catch(() => {});
    } else v.pause();
  }

  function seekFraction(f: number) {
    const v = video.current;
    if (v) v.currentTime = t0 + Math.min(0.999, Math.max(0, f)) * duration;
  }

  async function exportMp4() {
    setExporting(true);
    setExportStarted(Date.now());
    setNow(Date.now());
    exportAbort.current = new AbortController();
    try {
      await api.exportClip(clip.id, { style, captions: captionsOn, source, music: track ? music : null },
        `clip-${clip.rank}.mp4`, exportAbort.current.signal);
      toast({ tone: "success", title: "Clip exported" });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        toast({ tone: "info", title: "Stopped waiting", description: "The render keeps going and will be instant next time." });
      } else {
        toast({ tone: "error", title: "Export failed", description: errorMessage(e) });
      }
    } finally {
      setExporting(false);
    }
  }

  const close = () => { video.current?.pause(); audio.current?.pause(); exportAbort.current?.abort(); onClose(); };
  const progress = Math.min(1, Math.max(0, (time - t0) / duration));
  // Rendering runs at a few × real time; the blurred format does two scales per frame.
  const estimate = Math.max(5, Math.round(duration * (style.format === "vertical_blur" ? 0.6 : 0.35)));

  return (
    <dialog ref={dialog} onCancel={(e) => { e.preventDefault(); close(); }}
      className="m-auto h-[min(100dvh,56rem)] max-h-none w-[min(100vw,80rem)] max-w-none overflow-hidden bg-bg p-0 text-fg shadow-pop sm:h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)] sm:rounded-2xl sm:border sm:border-line">
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-soft text-xs font-bold text-accent-fg">CC</span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold">Export studio · #{clip.rank} {clip.title}</h2>
            <p className="text-xs text-muted">Captions light up each word as it&apos;s spoken. What you see and hear is what gets exported.</p>
          </div>
          <span className="hidden text-xs text-muted sm:block" aria-live="polite">
            {{ idle: "", saving: "Saving…", saved: "Style saved", error: "Couldn't save style" }[saveState]}
          </span>
          <Button variant="ghost" size="sm" onClick={close} aria-label="Close"><Icon.X /></Button>
        </header>

        <div className="grid min-h-0 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_22rem] lg:overflow-hidden">
          {/* Preview */}
          <section className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3 bg-surface-2/60 p-4 lg:p-6">
            <div ref={stage} className="grid h-[60vh] place-items-center lg:h-auto lg:min-h-0">
              <div className="relative overflow-hidden rounded-xl bg-black shadow-pop" style={frame}>
                {style.format === "vertical_blur" && (
                  <canvas ref={canvas} width={90} height={160} className="absolute inset-0 h-full w-full scale-110 blur-xl brightness-90" />
                )}
                <video ref={video} playsInline preload="auto"
                  src={source === "voiceover" ? api.voiceoverUrl(clip.id, voiceBust) : `${api.proxyUrl(clip.project_id)}#t=${clip.start},${clip.end}`}
                  onClick={toggle} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth) setAspect(v.videoWidth / v.videoHeight);
                    v.currentTime = t0;
                  }}
                  className={cx("absolute inset-0 h-full w-full cursor-pointer", style.format === "vertical_crop" ? "object-cover" : "object-contain")} />
                {track && <audio ref={audio} src={api.mediaUrl(track.url)} preload="auto" loop />}
                {captionsOn && cues && <CaptionOverlay cues={cues} style={style} time={time} />}
                {captionsOn && !cues && !cueError && (
                  <div className="absolute inset-0 grid place-items-center text-white/70"><Spinner className="h-6 w-6" /></div>
                )}
                {!playing && (
                  <button onClick={toggle} aria-label="Play preview"
                    className="absolute top-1/2 left-1/2 grid h-14 w-14 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70">
                    <Icon.Play width={22} height={22} />
                  </button>
                )}
              </div>
            </div>

            <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
              <Button size="sm" variant="secondary" onClick={toggle} aria-label={playing ? "Pause" : "Play"}
                icon={playing ? <Icon.Pause width={14} height={14} /> : <Icon.Play width={14} height={14} />} />
              <div role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(progress * duration)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight") seekFraction(progress + 2 / duration);
                  if (e.key === "ArrowLeft") seekFraction(progress - 2 / duration);
                }}
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seekFraction((e.clientX - r.left) / r.width); }}
                className="relative h-2 flex-1 cursor-pointer rounded-full bg-line">
                <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
                <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-surface"
                  style={{ left: `${progress * 100}%` }} />
              </div>
              <span className="shrink-0 font-mono text-xs text-muted tabular-nums">
                {fmtTime(Math.max(0, time - t0))} / {fmtTime(duration)}
              </span>
            </div>
            {captionsOn && cueError && <Alert className="mx-auto w-full max-w-2xl">{cueError}</Alert>}
            {captionsOn && cues && cues.length === 0 && (
              <Alert tone="warning" className="mx-auto w-full max-w-2xl">No spoken words were found in this clip.</Alert>
            )}
          </section>

          {/* Controls */}
          <aside className="grid content-start gap-6 border-t border-line bg-surface p-5 lg:overflow-y-auto lg:border-t-0 lg:border-l">
            <section className="grid gap-4">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Output</h3>
              <Field label="Soundtrack" hint={!hasVoiceover ? "Generate an AI voiceover for this clip to use it here." : source === "voiceover" ? "Captions follow the AI narration word by word." : undefined}>
                <Segmented label="Soundtrack" size="sm" value={source} onChange={setSource} disabled={!hasVoiceover} className="w-full"
                  options={[{ value: "original", label: "Original audio" }, { value: "voiceover", label: "AI voiceover" }]} />
              </Field>
              <Field label="Format">
                <Segmented label="Format" size="sm" value={style.format} onChange={(v) => set("format", v)} options={FORMATS} className="w-full" />
              </Field>
            </section>

            <section className="grid gap-3 border-t border-line pt-5">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Background music</h3>
              <Select value={music?.track_id ?? ""} aria-label="Background music"
                onChange={(e) => changeMusic(e.target.value ? { volume: 0.15, offset: 0, duck: true, ...(music ?? {}), track_id: e.target.value } : null)}>
                <option value="">None</option>
                {tracks?.map((t) => <option key={t.id} value={t.id}>{t.name} ({fmtDuration(t.duration)})</option>)}
              </Select>
              {tracks && tracks.length === 0 && (
                <p className="text-xs text-muted">
                  Your library is empty. <Link href="/music" className="text-accent-fg hover:underline">Add royalty-free tracks →</Link>
                </p>
              )}
              {track && music && (
                <div className="grid gap-3">
                  <div className="grid grid-cols-2 gap-4">
                    <Field label={<span className="flex justify-between">Volume <span className="text-muted tabular-nums">{Math.round(music.volume * 100)}%</span></span>}>
                      <input type="range" min={0.02} max={0.6} step={0.01} value={music.volume}
                        onChange={(e) => changeMusic({ ...music, volume: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
                    </Field>
                    <Field label={<span className="flex justify-between">Start at <span className="text-muted tabular-nums">{fmtTime(music.offset)}</span></span>}>
                      <input type="range" min={0} max={Math.max(0, Math.floor(track.duration - 5))} step={1} value={music.offset}
                        onChange={(e) => changeMusic({ ...music, offset: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
                    </Field>
                  </div>
                  <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
                    <span>Lower music while speaking <span className="text-muted">(ducking)</span></span>
                    <input type="checkbox" checked={music.duck} onChange={(e) => changeMusic({ ...music, duck: e.target.checked })}
                      className="h-4 w-4 accent-[var(--accent)]" />
                  </label>
                  <Link href="/music" className="text-xs text-accent-fg hover:underline">Manage music library →</Link>
                </div>
              )}
            </section>

            <section className="grid gap-5 border-t border-line pt-5">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Captions</h3>
              <input type="checkbox" checked={captionsOn} onChange={(e) => setCaptionsOn(e.target.checked)} aria-label="Burn in captions"
                className="h-4 w-4 accent-[var(--accent)]" />
            </label>
            <fieldset disabled={!captionsOn} className={cx("grid min-w-0 gap-6", !captionsOn && "opacity-40")}>
            <div className="grid gap-2">
              <span className="text-xs font-medium text-fg/80">Style</span>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(PRESETS) as CaptionPreset[]).map((p) => {
                  const preview = withPreset({ ...style, size: 7, position: "middle", format: "original" }, p);
                  return (
                    <button key={p} onClick={() => setStyle((s) => withPreset(s, p))} aria-pressed={style.preset === p}
                      title={PRESETS[p].description}
                      className={cx("grid cursor-pointer gap-2 rounded-xl border p-2 text-left transition-colors",
                        style.preset === p ? "border-accent ring-2 ring-accent/25" : "border-line hover:border-line-strong")}>
                      <span className="relative block h-14 overflow-hidden rounded-lg bg-gradient-to-br from-zinc-700 to-zinc-900 [container-type:size]">
                        <span style={{ ...blockStyle(preview), fontSize: `${(preview.size ?? 7) * 2.4}cqmin` }}>
                          {["the", "word", "now"].map((w, i) => (
                            <span key={w}>{i > 0 && " "}<span style={wordStyle(preview, i, 1)}>{w}</span></span>
                          ))}
                        </span>
                      </span>
                      <span className="px-0.5 text-xs font-medium">{PRESETS[p].label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <Field label="Font">
              <Select value={style.font} onChange={(e) => set("font", e.target.value)}>
                {FONTS.map((f) => <option key={f.name} value={f.name} style={{ fontFamily: f.name }}>{f.name}</option>)}
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label={<span className="flex justify-between">Size <span className="text-muted tabular-nums">{style.size.toFixed(1)}</span></span>}>
                <input type="range" min={3} max={12} step={0.5} value={style.size} onChange={(e) => set("size", Number(e.target.value))}
                  className="w-full accent-[var(--accent)]" />
              </Field>
              <Field label={<span className="flex justify-between">Words / line <span className="text-muted tabular-nums">{style.words_per_line}</span></span>}>
                <input type="range" min={1} max={8} step={1} value={style.words_per_line} onChange={(e) => set("words_per_line", Number(e.target.value))}
                  className="w-full accent-[var(--accent)]" />
              </Field>
            </div>

            <Field label="Position">
              <Segmented label="Position" size="sm" value={style.position} onChange={(v) => set("position", v)} className="w-full"
                options={[{ value: "top", label: "Top" }, { value: "middle", label: "Middle" }, { value: "bottom", label: "Bottom" }]} />
            </Field>

            <div className="grid gap-2">
              <span className="text-xs font-medium text-fg/80">{style.preset === "box" ? "Box colour" : "Highlight colour"}</span>
              <div className="flex flex-wrap items-center gap-2">
                {HIGHLIGHT_SWATCHES.map((c) => (
                  <button key={c} onClick={() => set("highlight_color", c)} aria-label={`Highlight ${c}`} aria-pressed={style.highlight_color.toUpperCase() === c}
                    className={cx("h-7 w-7 cursor-pointer rounded-full border border-black/10 transition",
                      style.highlight_color.toUpperCase() === c && "ring-2 ring-accent ring-offset-2 ring-offset-surface")}
                    style={{ background: c }} />
                ))}
                <ColorInput label="Custom highlight colour" value={style.highlight_color} onChange={(v) => set("highlight_color", v)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <span className="text-xs font-medium text-fg/80">Text colour</span>
                <ColorInput label="Text colour" value={style.text_color} onChange={(v) => set("text_color", v)} showValue />
              </div>
              <div className="grid gap-2">
                <span className="text-xs font-medium text-fg/80">Outline</span>
                <ColorInput label="Outline colour" value={style.outline_color} onChange={(v) => set("outline_color", v)} showValue
                  disabled={style.preset === "box" || style.preset === "minimal"} />
              </div>
            </div>

            <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
              <span>ALL CAPS</span>
              <input type="checkbox" checked={style.uppercase} onChange={(e) => set("uppercase", e.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]" />
            </label>

            </fieldset>
            </section>

            <div className="sticky -bottom-5 -mx-5 -mb-5 grid gap-2 border-t border-line bg-surface p-5">
              <Button variant="primary" size="md" loading={exporting} onClick={exportMp4} disabled={captionsOn && !cues?.length}
                icon={<Icon.Download width={16} height={16} />}>
                {exporting ? `Rendering… ${Math.round((now - exportStarted) / 1000)}s` : "Export MP4"}
              </Button>
              <p className="text-center text-xs text-muted">
                {exporting
                  ? <>Usually about {estimate}s for this clip. <button onClick={() => exportAbort.current?.abort()} className="cursor-pointer text-accent-fg hover:underline">Stop waiting</button></>
                  : <>Full quality{vertical ? ", 1080×1920" : ""}{source === "voiceover" ? " · AI voiceover" : ""}{captionsOn ? " · captions" : ""}{track ? " · music" : ""}</>}
              </p>
            </div>
          </aside>
        </div>
      </div>
    </dialog>
  );
}

function ColorInput({ label, value, onChange, showValue, disabled }: {
  label: string; value: string; onChange: (v: string) => void; showValue?: boolean; disabled?: boolean;
}) {
  return (
    <label className={cx("flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-line px-1.5 text-xs hover:bg-hover",
      disabled && "pointer-events-none opacity-40")} title={label}>
      <span className="relative h-5 w-5 overflow-hidden rounded-md border border-black/10" style={{ background: value }}>
        <input type="color" value={value} disabled={disabled} aria-label={label}
          onChange={(e) => onChange(e.target.value.toUpperCase())} className="absolute inset-0 cursor-pointer opacity-0" />
      </span>
      {showValue ? <span className="font-mono text-muted">{value.toUpperCase()}</span> : <Icon.Settings width={12} height={12} className="text-muted" />}
    </label>
  );
}
