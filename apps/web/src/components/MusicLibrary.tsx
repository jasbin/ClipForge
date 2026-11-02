"use client";

import { useEffect, useRef, useState } from "react";
import { api, fmtDuration, type Track } from "@/lib/api";
import { errorMessage, useFeedback } from "./feedback";
import { Icon } from "./icons";
import { Alert, Button, Card, EmptyState, Skeleton, cx } from "./ui";

/** Where to find music that is actually free to use in exported videos. */
const SOURCES = [
  {
    name: "YouTube Audio Library",
    url: "https://studio.youtube.com/channel/UC/music",
    note: "Thousands of tracks, free for any video. Some ask for a credit line in the description.",
  },
  {
    name: "Pixabay Music",
    url: "https://pixabay.com/music/",
    note: "Popular, modern-sounding tracks under the Pixabay licence. No credit required.",
  },
  {
    name: "FreePD",
    url: "https://freepd.com/",
    note: "Public-domain (CC0) music. Use it anywhere, no strings attached.",
  },
];

export function MusicLibrary() {
  const { toast, confirm } = useFeedback();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = () => { setError(null); api.music().then(setTracks, (e) => setError(errorMessage(e))); };
  useEffect(load, []);

  async function upload(files: FileList | null | undefined) {
    for (const f of Array.from(files ?? [])) {
      if (!f.type.startsWith("audio/") && !f.type.startsWith("video/") && !/\.(mp3|m4a|wav|aac|flac|ogg|opus)$/i.test(f.name)) {
        toast({ tone: "error", title: "Not an audio file", description: f.name });
        continue;
      }
      setUploading(f.name);
      try {
        setTracks(await api.uploadMusic(f, f.name.replace(/\.[^.]+$/, "")));
        toast({ tone: "success", title: "Track added", description: f.name });
      } catch (e) {
        toast({ tone: "error", title: "Couldn't add track", description: errorMessage(e) });
      }
    }
    setUploading(null);
  }

  async function remove(t: Track) {
    if (!(await confirm({ title: `Delete “${t.name}”?`, description: "It will be removed from the library.", confirmLabel: "Delete", danger: true }))) return;
    try {
      setTracks(await api.deleteMusic(t.id));
    } catch (e) {
      toast({ tone: "error", title: "Couldn't delete track", description: errorMessage(e) });
    }
  }

  return (
    <div className="grid gap-8">
      <div
        role="button" tabIndex={0} aria-label="Add music files"
        onClick={() => !uploading && input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.current?.click())}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!uploading) upload(e.dataTransfer.files); }}
        className={cx("grid cursor-pointer place-items-center gap-2 rounded-2xl border-2 border-dashed bg-surface px-4 py-10 text-center transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent/60", uploading && "pointer-events-none opacity-70")}>
        <input ref={input} type="file" accept="audio/*,video/*" multiple className="hidden"
          onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        <span className="grid h-11 w-11 place-items-center rounded-full bg-accent-soft text-accent-fg">
          {uploading ? <Icon.Refresh className="animate-spin" /> : <Icon.Upload />}
        </span>
        <p className="font-medium">{uploading ? `Adding “${uploading}”…` : <>Drop music files here, or <span className="text-accent-fg">browse</span></>}</p>
        <p className="text-xs text-muted">MP3, M4A, WAV and more. Several at once is fine.</p>
      </div>

      <section className="grid gap-3">
        <h2 className="font-semibold">Your tracks {tracks && <span className="font-normal text-muted">({tracks.length})</span>}</h2>
        {error ? (
          <Alert title="Couldn't load music" action={<Button size="xs" onClick={load} icon={<Icon.Refresh />}>Retry</Button>}>{error}</Alert>
        ) : !tracks ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : !tracks.length ? (
          <EmptyState icon={<span className="text-lg">♪</span>} title="No music yet" className="py-8">
            Download a few tracks from the free libraries below and drop them in above.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            {tracks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-fg">♪</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.name}</div>
                  <div className="text-xs text-muted">{fmtDuration(t.duration)}</div>
                </div>
                <audio src={api.mediaUrl(t.url)} controls preload="none" className="h-8 w-full max-w-64 sm:w-64" />
                <Button size="xs" variant="danger-ghost" aria-label={`Delete ${t.name}`} onClick={() => remove(t)}>
                  <Icon.Trash width={14} height={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card className="grid gap-4 p-5 sm:p-6">
        <div>
          <h2 className="font-semibold">Where to get free music</h2>
          <p className="mt-1 text-sm text-muted">
            Trending songs on TikTok and Reels are licensed only for use inside those apps; burned into an exported video
            they can get it muted or claimed. These libraries are free to use in your own videos:
          </p>
        </div>
        <ul className="grid gap-3 sm:grid-cols-3">
          {SOURCES.map((s) => (
            <li key={s.name}>
              <a href={s.url} target="_blank" rel="noreferrer"
                className="grid h-full gap-1 rounded-xl border border-line p-3.5 transition-colors hover:border-accent/50 hover:bg-hover">
                <span className="flex items-center gap-1.5 text-sm font-medium">{s.name} <Icon.External width={12} height={12} className="text-muted" /></span>
                <span className="text-xs text-muted">{s.note}</span>
              </a>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">Always check each track&apos;s licence; some require a credit in your video description.</p>
      </Card>
    </div>
  );
}
