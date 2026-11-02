"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, fmtBytes } from "@/lib/api";
import { errorMessage, useFeedback } from "./feedback";
import { Icon } from "./icons";
import { Alert, Button, Card, Field, Input, ProgressTrack, Segmented, Select, cx } from "./ui";

const LENGTHS = { "15-30": [15, 30], "30-60": [30, 60], "60-90": [60, 90] } as const;
type Length = keyof typeof LENGTHS;

const LANGUAGES = [
  ["", "Auto-detect"], ["en", "English"], ["es", "Spanish"], ["hi", "Hindi"],
  ["ne", "Nepali"], ["fr", "French"], ["de", "German"],
] as const;

const isMedia = (f: File) => f.type.startsWith("video/") || f.type.startsWith("audio/") ||
  /\.(mp4|mov|mkv|webm|avi|m4v|mp3|m4a|wav|aac|flac|ogg)$/i.test(f.name);

function validUrl(s: string) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function NewProjectForm() {
  const router = useRouter();
  const { toast } = useFeedback();
  const [mode, setMode] = useState<"url" | "file">("url");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [length, setLength] = useState<Length>("30-60");
  const [topN, setTopN] = useState(10);
  const [language, setLanguage] = useState("");
  const [title, setTitle] = useState("");
  const [useLlm, setUseLlm] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState<number | null>(null); // 0..1 while uploading
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function pick(f: File | undefined | null) {
    if (!f) return;
    if (!isMedia(f)) return setError(`"${f.name}" doesn't look like a video or audio file.`);
    setError(null);
    setFile(f);
    setMode("file");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const form = new FormData();
    if (mode === "file") {
      if (!file) return setError("Choose a video or audio file to upload.");
      form.set("file", file);
    } else {
      const u = url.trim();
      if (!u) return setError("Paste a link to a video.");
      if (!validUrl(u)) return setError("That doesn't look like a valid http(s) link.");
      form.set("url", u);
    }
    const [min, max] = LENGTHS[length];
    form.set("min_seconds", String(min));
    form.set("max_seconds", String(max));
    form.set("top_n", String(Math.min(50, Math.max(1, topN || 10))));
    if (language) form.set("language", language);
    if (title.trim()) form.set("title", title.trim());
    form.set("use_llm", useLlm ? "true" : "false");

    setError(null);
    setBusy(true);
    abort.current = new AbortController();
    if (mode === "file") setUploaded(0);
    try {
      const project = await api.createProject(form, mode === "file" ? setUploaded : undefined, abort.current.signal);
      toast({ tone: "success", title: "Project created", description: "Processing has started." });
      router.push(`/projects/${project.id}`);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") toast({ tone: "info", title: "Upload cancelled" });
      else setError(errorMessage(err));
      setBusy(false);
      setUploaded(null);
    }
  }

  return (
    <Card className="overflow-hidden">
      <form onSubmit={onSubmit} noValidate
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) pick(e.dataTransfer.files[0]); }}
        className="grid gap-5 p-5 sm:p-6">
        <Segmented label="Source" value={mode} onChange={(m) => { setMode(m); setError(null); }} disabled={busy}
          className="w-full sm:w-fit"
          options={[
            { value: "url", label: <><Icon.Link width={14} height={14} /> Paste link</> },
            { value: "file", label: <><Icon.Upload width={14} height={14} /> Upload file</> },
          ]} />

        {mode === "url" ? (
          <div className="relative">
            <Icon.Link className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" />
            <Input type="url" inputMode="url" autoFocus value={url} disabled={busy} aria-label="Video link"
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=…" className="h-12 pl-10 text-base" />
          </div>
        ) : (
          <div
            role="button" tabIndex={0} aria-label="Choose a video file"
            onClick={() => !busy && fileInput.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), fileInput.current?.click())}
            className={cx(
              "grid cursor-pointer place-items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
              dragging ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent/60 hover:bg-hover",
              busy && "pointer-events-none opacity-70",
            )}>
            <input ref={fileInput} type="file" accept="video/*,audio/*" className="hidden"
              onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
            {file ? (
              <>
                <span className="grid h-10 w-10 place-items-center rounded-full bg-accent-soft text-accent-fg"><Icon.Film /></span>
                <p className="max-w-full truncate font-medium">{file.name}</p>
                <p className="text-xs text-muted">{fmtBytes(file.size)} · click to choose a different file</p>
              </>
            ) : (
              <>
                <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-2 text-muted"><Icon.Upload /></span>
                <p className="font-medium">Drop a video here, or <span className="text-accent-fg">browse</span></p>
                <p className="text-xs text-muted">MP4, MOV, MKV, WebM, or audio files</p>
              </>
            )}
          </div>
        )}
        {dragging && mode === "url" && (
          <p className="-mt-2 text-center text-sm text-accent-fg">Drop to upload this file instead</p>
        )}

        <div className="grid gap-4 sm:grid-cols-[auto_1fr_1fr] sm:items-end">
          <Field label="Clip length">
            <Segmented label="Clip length" size="sm" value={length} onChange={setLength} disabled={busy}
              className="h-10 w-full items-center"
              options={(Object.keys(LENGTHS) as Length[]).map((k) => ({ value: k, label: `${k.replace("-", "–")}s` }))} />
          </Field>
          <Field label="Max clips">
            <Input type="number" min={1} max={50} value={topN} disabled={busy}
              onChange={(e) => setTopN(Number(e.target.value))} />
          </Field>
          <Field label="Language">
            <Select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>
              {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 sm:items-end">
          <Field label={<>Project name <span className="font-normal text-muted">(optional)</span></>}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} maxLength={200}
              placeholder={file?.name ?? "e.g. Podcast ep. 12"} />
          </Field>
          <label className="flex h-10 cursor-pointer items-center gap-3 rounded-lg border border-line px-3 text-sm hover:bg-hover">
            <input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} disabled={busy}
              className="h-4 w-4 accent-[var(--accent)]" />
            <span className="min-w-0 flex-1 truncate">
              AI ranking <span className="text-muted">· off = fast, audio-only</span>
            </span>
          </label>
        </div>

        {error && <Alert>{error}</Alert>}

        {uploaded !== null ? (
          <div className="grid gap-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{uploaded < 1 ? "Uploading…" : "Upload complete, starting…"}</span>
              <span className="flex items-center gap-3">
                <span className="tabular-nums text-muted">
                  {file && `${fmtBytes(file.size * uploaded)} / ${fmtBytes(file.size)} · `}{Math.round(uploaded * 100)}%
                </span>
                {uploaded < 1 && <Button size="xs" variant="ghost" onClick={() => abort.current?.abort()}>Cancel</Button>}
              </span>
            </div>
            <ProgressTrack value={uploaded * 100} />
          </div>
        ) : (
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="md" loading={busy} icon={<Icon.Sparkles />} className="w-full sm:w-auto">
              {busy ? "Starting…" : "Find clips"}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
