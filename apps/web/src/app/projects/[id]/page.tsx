"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptionOverlay, useFrameTime } from "@/components/CaptionOverlay";
import { ClipCard } from "@/components/ClipCard";
import { errorMessage, useFeedback } from "@/components/feedback";
import { Icon } from "@/components/icons";
import { ProgressBar } from "@/components/ProgressBar";
import { StatusBadge } from "@/components/StatusBadge";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { Alert, Button, EmptyState, Kbd, Segmented, Select, Skeleton, buttonClass, cx } from "@/components/ui";
import {
  ApiError, api, fmtDuration, fmtTime, isActive, parseDate, plural, settingsOf,
  type Clip, type Project, type ProgressEvent, type Sentence, type VoiceLibrary,
} from "@/lib/api";
import { normalizeStyle, type CaptionStyle, type Cue } from "@/lib/captions";

const LANGUAGE_NAMES: Record<string, string> = { en: "English", es: "Spanish", hi: "Hindi", ne: "Nepali", fr: "French", de: "German" };

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast, confirm } = useFeedback();
  const videoRef = useRef<HTMLVideoElement>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [sentences, setSentences] = useState<Sentence[] | null>(null);
  const [activeClip, setActiveClip] = useState<Clip | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<"score" | "time">("score");
  const [tab, setTab] = useState<"clips" | "transcript">("clips");
  const [copiedAll, setCopiedAll] = useState(false);
  const [voices, setVoices] = useState<VoiceLibrary | null>(null);
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [videoAspect, setVideoAspect] = useState(16 / 9);
  const [cc, setCc] = useState(true);
  const [cueCache, setCueCache] = useState<Record<number, Cue[]>>({});

  useEffect(() => {
    try { if (localStorage.getItem("clipforge-cc") === "off") setCc(false); } catch {}
  }, []);

  function toggleCc() {
    setCc((on) => {
      try { localStorage.setItem("clipforge-cc", on ? "off" : "on"); } catch {}
      return !on;
    });
  }

  // Player captions use the playing clip's saved style (or the default), always in the source framing.
  const styledClip = clips?.find((c) => c.id === activeClip?.id) ?? null;
  const playerStyle: CaptionStyle = { ...normalizeStyle(styledClip?.caption_style), format: "original" };
  const wpl = playerStyle.words_per_line;
  const frameTime = useFrameTime(videoRef, cc && project?.status === "done");

  useEffect(() => {
    if (!cc || project?.status !== "done" || cueCache[wpl]) return;
    api.captions(id, wpl).then((cues) => setCueCache((m) => ({ ...m, [wpl]: cues })), () => {});
  }, [cc, project?.status, id, wpl, cueCache]);

  const onCaptionStyle = useCallback((clipId: string, style: CaptionStyle) => {
    setClips((cs) => cs?.map((c) => (c.id === clipId ? { ...c, caption_style: style } : c)) ?? cs);
  }, []);

  useEffect(() => {
    api.voices().then(setVoices, () => setVoices(null));
  }, []);

  useEffect(() => {
    if (project) document.title = `${project.title} · ClipForge`;
  }, [project]);

  const refreshClips = useCallback(() => {
    api.clips(id).then(setClips, () => {});
  }, [id]);

  // Poll clip status while any voiceover is queued or generating.
  const voicing = clips?.some((c) => c.voice_status === "queued" || c.voice_status === "running");
  useEffect(() => {
    if (!voicing) return;
    const t = setInterval(refreshClips, 2000);
    return () => clearInterval(t);
  }, [voicing, refreshClips]);

  const loadResults = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api.project(id), api.clips(id)]);
      setProject(p);
      setClips(c);
    } catch (e) {
      toast({ tone: "error", title: "Couldn't load clips", description: errorMessage(e) });
    }
    api.transcript(id).then((t) => setSentences(t.sentences), () => setSentences([]));
  }, [id, toast]);

  const loadProject = useCallback(() => {
    setLoadError(null);
    api.project(id).then((p) => {
      setProject(p);
      if (p.status === "done") loadResults();
    }, (e) => {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setLoadError(errorMessage(e));
    });
  }, [id, loadResults]);

  useEffect(() => { loadProject(); }, [loadProject]);

  const processing = project ? isActive(project.status) : false;

  // Live progress over Server-Sent Events while the worker runs. EventSource reconnects by itself;
  // we only surface that it's happening.
  useEffect(() => {
    if (!processing) return;
    const es = api.events(id);
    es.onopen = () => setReconnecting(false);
    es.onerror = () => setReconnecting(true);
    es.onmessage = (e) => {
      const ev: ProgressEvent = JSON.parse(e.data);
      setReconnecting(false);
      setProgress(ev);
      setProject((p) => (p ? { ...p, ...ev } : p));
      if (ev.status === "done" || ev.status === "error" || ev.status === "cancelled") {
        es.close();
        if (ev.status === "done") {
          loadResults();
          toast({ tone: "success", title: "Clips are ready" });
        }
      }
    };
    return () => es.close();
  }, [id, processing, loadResults, toast]);

  const sorted = useMemo(
    () => [...(clips ?? [])].sort((a, b) => (sortBy === "score" ? a.rank - b.rank : a.start - b.start)),
    [clips, sortBy],
  );

  const playClip = useCallback((c: Clip, scrollCard = false) => {
    setActiveClip(c);
    const v = videoRef.current;
    if (v) {
      v.currentTime = c.start;
      v.play().catch(() => {});
      if (window.matchMedia("(max-width: 1023px)").matches) v.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    if (scrollCard) document.getElementById(`clip-${c.id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  function seek(t: number) {
    setActiveClip(null);
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    v.play().catch(() => {});
  }

  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    if (activeClip && v.currentTime >= activeClip.end) {
      v.pause();
      setActiveClip(null);
    }
  }

  // Keyboard: J/K next/previous clip, Space play/pause, Esc leaves clip mode.
  useEffect(() => {
    if (project?.status !== "done") return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable], dialog")) return;
      const v = videoRef.current;
      if (e.key === "j" || e.key === "k") {
        if (!sorted.length) return;
        const i = activeClip ? sorted.findIndex((c) => c.id === activeClip.id) : -1;
        const next = e.key === "j" ? Math.min(sorted.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
        playClip(sorted[next], true);
      } else if (e.key === " " && v && t.tagName !== "BUTTON" && t.tagName !== "VIDEO") {
        e.preventDefault();
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      } else if (e.key === "Escape") {
        setActiveClip(null);
      } else if (e.key === "c") {
        toggleCc();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project?.status, sorted, activeClip, playClip]);

  async function retry() {
    setRetrying(true);
    try {
      const p = await api.retry(id);
      setProject(p);
      setClips(null);
      setSentences(null);
      setActiveClip(null);
      setProgress({ status: p.status, stage: p.stage, progress: p.progress, error: null });
    } catch (e) {
      toast({ tone: "error", title: "Couldn't re-run", description: errorMessage(e) });
    } finally {
      setRetrying(false);
    }
  }

  async function stop() {
    setStopping(true);
    try {
      const p = await api.cancelProject(id);
      if (p.status === "cancelled") setProject(p); // was only queued; running ones end via SSE
    } catch (e) {
      toast({ tone: "error", title: "Couldn't stop", description: errorMessage(e) });
    } finally {
      setStopping(false);
    }
  }

  async function remove() {
    if (!project) return;
    const ok = await confirm({
      title: "Delete this project?",
      description: <>“{project.title}” and all its clips, transcripts and voiceovers will be permanently deleted.</>,
      confirmLabel: "Delete", danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteProject(id);
      toast({ tone: "success", title: "Project deleted" });
      router.push("/");
    } catch (e) {
      toast({ tone: "error", title: "Couldn't delete project", description: errorMessage(e) });
    }
  }

  async function copyAll() {
    const text = sorted.map((c) => `#${c.rank} ${c.title}\n${c.hook}`).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    } catch {
      toast({ tone: "error", title: "Clipboard unavailable" });
    }
  }

  if (notFound) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-16">
        <EmptyState icon={<Icon.Search />} title="Project not found"
          action={<Link href="/" className={buttonClass("secondary", "sm")}><Icon.ArrowLeft width={14} height={14} /> All projects</Link>}>
          It may have been deleted, or the link is wrong.
        </EmptyState>
      </main>
    );
  }
  if (loadError && !project) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-10">
        <Alert title="Couldn't load this project" action={<Button size="xs" onClick={loadProject} icon={<Icon.Refresh />}>Try again</Button>}>
          {loadError}
        </Alert>
      </main>
    );
  }
  if (!project) return <PageSkeleton />;

  const settings = settingsOf(project);
  const duration = project.duration ?? videoDuration;

  return (
    <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 sm:py-8">
      <div className="grid gap-3">
        <Link href="/" className="inline-flex w-fit items-center gap-1 text-sm text-muted hover:text-fg">
          <Icon.ArrowLeft width={14} height={14} /> All projects
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{project.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
              <StatusBadge status={project.status} />
              {project.duration != null && <span>{fmtDuration(project.duration)}</span>}
              {settings && (
                <>
                  <span>{settings.min_seconds}–{settings.max_seconds}s clips</span>
                  <span>top {settings.top_n}</span>
                  <span>{settings.use_llm === false ? "audio-only" : "AI ranked"}</span>
                  <span>{settings.language ? LANGUAGE_NAMES[settings.language] ?? settings.language : "auto language"}</span>
                </>
              )}
              <time title={parseDate(project.created_at).toLocaleString()}>
                {parseDate(project.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </time>
              {project.source_url && (
                <a href={project.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-fg hover:underline">
                  Source <Icon.External width={12} height={12} />
                </a>
              )}
            </div>
          </div>
          {!processing && (
            <div className="flex gap-2">
              <Button onClick={retry} loading={retrying} icon={<Icon.Refresh width={14} height={14} />}>Re-run</Button>
              <Button onClick={remove} variant="danger-ghost" icon={<Icon.Trash width={14} height={14} />}>Delete</Button>
            </div>
          )}
        </div>
      </div>

      {processing && (
        <ProgressBar
          progress={progress ?? { status: project.status, stage: project.stage, progress: project.progress, error: null }}
          since={parseDate(project.created_at)} onStop={stop} stopping={stopping} reconnecting={reconnecting} />
      )}

      {project.status === "cancelled" && (
        <Alert tone="warning" title="Processing was stopped"
          action={<Button variant="primary" size="sm" loading={retrying} onClick={retry} icon={<Icon.Refresh width={14} height={14} />}>Resume</Button>}>
          Finished steps are cached, so re-running continues from where it stopped.
        </Alert>
      )}

      {project.status === "error" && (
        <Alert title="Processing failed"
          action={<Button variant="danger" size="sm" loading={retrying} onClick={retry} icon={<Icon.Refresh width={14} height={14} />}>Try again</Button>}>
          <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs whitespace-pre-wrap break-words text-fg/80">
            {project.error}
          </pre>
        </Alert>
      )}

      {project.status === "done" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          <div className="grid h-fit grid-cols-1 gap-3 lg:sticky lg:top-20">
            <div className="relative overflow-hidden rounded-2xl border border-line bg-black shadow-card" style={{ aspectRatio: videoAspect }}>
              <video ref={videoRef} src={api.proxyUrl(id)} controls preload="metadata" playsInline
                onTimeUpdate={onTimeUpdate}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  setVideoDuration(v.duration);
                  if (v.videoWidth) setVideoAspect(v.videoWidth / v.videoHeight);
                }}
                className="absolute inset-0 h-full w-full" />
              {cc && cueCache[wpl] && <CaptionOverlay cues={cueCache[wpl]} style={playerStyle} time={frameTime} />}
            </div>
            {duration && clips && clips.length > 0 && (
              <ClipTimeline clips={clips} duration={duration} currentTime={currentTime} activeId={activeClip?.id}
                onPick={(c) => playClip(c, true)} onSeek={seek} />
            )}
            <div className="flex min-h-6 items-center justify-between gap-3 text-sm">
              {activeClip ? (
                <p className="min-w-0 truncate">
                  <span className="text-muted">Playing</span> <span className="font-medium">#{activeClip.rank} {activeClip.title}</span>
                </p>
              ) : <span />}
              <span className="flex shrink-0 items-center gap-3">
                <span className="hidden items-center gap-1.5 text-xs text-muted sm:flex">
                  <Kbd>J</Kbd><Kbd>K</Kbd> clips <Kbd>Space</Kbd> play <Kbd>C</Kbd> captions
                </span>
                <Button size="xs" variant={cc ? "primary" : "secondary"} onClick={toggleCc} aria-pressed={cc}
                  title="Show word-highlighted captions on the player">
                  <span className="rounded-[3px] border-[1.5px] border-current px-[2px] text-[8px] leading-[10px] font-bold">CC</span>
                  Captions
                </Button>
              </span>
            </div>

            <Segmented label="View" value={tab} onChange={setTab} className="w-full lg:hidden"
              options={[{ value: "clips", label: `Clips${clips ? ` (${clips.length})` : ""}` }, { value: "transcript", label: "Transcript" }]} />

            <div className={cx(tab === "transcript" ? "" : "hidden", "lg:block")}>
              <h2 className="mb-2 hidden text-sm font-semibold lg:block">Transcript</h2>
              {sentences === null ? (
                <Skeleton className="h-64 rounded-2xl" />
              ) : sentences.length ? (
                <TranscriptPanel sentences={sentences} clips={clips ?? []} activeClip={activeClip}
                  currentTime={currentTime} onSeek={seek} />
              ) : (
                <EmptyState title="No transcript available" className="py-8" />
              )}
            </div>
          </div>

          <div className={cx(tab === "clips" ? "grid" : "hidden", "h-fit grid-cols-1 gap-4 lg:grid")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">{clips ? plural(clips.length, "clip") : "Clips"}</h2>
              <div className="flex flex-wrap gap-2">
                <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as "score" | "time")} aria-label="Sort clips"
                  className="[&_select]:h-8 [&_select]:text-sm">
                  <option value="score">Best first</option>
                  <option value="time">By time</option>
                </Select>
                <Button onClick={copyAll} disabled={!clips?.length}
                  icon={copiedAll ? <Icon.Check width={14} height={14} /> : <Icon.Copy width={14} height={14} />}>
                  {copiedAll ? "Copied" : "Copy titles"}
                </Button>
                <a href={api.clipsJsonUrl(id)} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
                  <Icon.Download width={14} height={14} /> JSON
                </a>
              </div>
            </div>
            {clips === null ? (
              [0, 1].map((i) => <Skeleton key={i} className="h-72 rounded-2xl" />)
            ) : clips.length === 0 ? (
              <EmptyState icon={<Icon.Film />} title="No clips passed review"
                action={<Button size="sm" onClick={retry} loading={retrying} icon={<Icon.Refresh width={14} height={14} />}>Re-run</Button>}>
                Try a different clip length, or turn AI ranking off for audio-only results.
              </EmptyState>
            ) : (
              sorted.map((c) => (
                <ClipCard key={c.id} clip={c} active={activeClip?.id === c.id} onPlay={() => playClip(c)}
                  voices={voices} onVoiceoverStarted={() => {
                    refreshClips();
                    api.voices().then(setVoices, () => {}); // the chosen voice is now the default
                  }}
                  onCaptionStyle={onCaptionStyle} />
              ))
            )}
          </div>
        </div>
      )}
    </main>
  );
}

/** Where each clip sits in the full video; click a segment to play it, or the track to seek. */
function ClipTimeline({ clips, duration, currentTime, activeId, onPick, onSeek }: {
  clips: Clip[];
  duration: number;
  currentTime: number;
  activeId?: string;
  onPick: (c: Clip) => void;
  onSeek: (t: number) => void;
}) {
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
  return (
    <div className="grid gap-1">
      <div className="relative h-7 cursor-pointer rounded-lg bg-surface-2"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * duration);
        }}>
        {clips.map((c) => (
          <button key={c.id} title={`#${c.rank} ${c.title} (${fmtTime(c.start)}–${fmtTime(c.end)})`}
            aria-label={`Play clip ${c.rank}: ${c.title}`}
            onClick={(e) => { e.stopPropagation(); onPick(c); }}
            className={cx("absolute inset-y-1 cursor-pointer rounded transition-colors",
              c.id === activeId ? "bg-accent" : "bg-accent/35 hover:bg-accent/60")}
            style={{ left: pct(c.start), width: `max(4px, ${pct(c.end - c.start)})` }}>
            <span className="sr-only">#{c.rank}</span>
          </button>
        ))}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 rounded bg-fg" style={{ left: pct(currentTime) }} />
      </div>
      <div className="flex justify-between font-mono text-[10px] text-muted">
        <span>{fmtTime(currentTime)}</span>
        <span>{fmtDuration(duration)}</span>
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8" aria-busy="true">
      <div className="grid gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="aspect-video rounded-2xl" />
        <div className="grid gap-4"><Skeleton className="h-56 rounded-2xl" /><Skeleton className="h-56 rounded-2xl" /></div>
      </div>
    </main>
  );
}
