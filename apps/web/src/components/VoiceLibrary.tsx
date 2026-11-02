"use client";

import { useEffect, useRef, useState } from "react";
import { api, type VoiceLibrary as Library } from "@/lib/api";
import { errorMessage, useFeedback } from "./feedback";
import { Icon } from "./icons";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Skeleton, buttonClass, cx } from "./ui";

const SCRIPT =
  "Hi, this is my voice for ClipForge. I'm reading this short paragraph at my normal pace, " +
  "in a quiet room, so the model can learn how I sound. Today I'll walk you through a product, " +
  "explain what makes it different, and show you why it's worth your time.";

const MAX_SECONDS = 45;

export function VoiceLibrary() {
  const { toast, confirm } = useFeedback();
  const [lib, setLib] = useState<Library | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("My voice");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => { setLoadError(null); api.voices().then(setLib, (e) => setLoadError(errorMessage(e))); };
  useEffect(load, []);

  // Release the microphone if the page is left mid-recording.
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    if (recorder.current?.state === "recording") {
      recorder.current.onstop = null;
      recorder.current.stop();
      recorder.current.stream.getTracks().forEach((t) => t.stop());
    }
  }, []);

  async function save(blob: Blob, filename: string) {
    setBusy(true);
    setError(null);
    try {
      setLib(await api.uploadVoice(blob, name.trim() || "My voice", filename));
      toast({ tone: "success", title: "Voice saved", description: name.trim() || "My voice" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) clearInterval(timer.current);
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType });
        save(blob, rec.mimeType.includes("mp4") ? "voice.m4a" : "voice.webm");
      };
      recorder.current = rec;
      rec.start();
      setSeconds(0);
      setRecording(true);
      timer.current = setInterval(() => setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS && rec.state === "recording") rec.stop();
        return s + 1;
      }), 1000);
    } catch (e) {
      setError(`Microphone unavailable: ${errorMessage(e)}`);
    }
  }

  async function act(fn: () => Promise<Library>, success?: string) {
    try {
      setLib(await fn());
      if (success) toast({ tone: "success", title: success });
    } catch (e) {
      toast({ tone: "error", title: "Something went wrong", description: errorMessage(e) });
    }
  }

  async function removeVoice(id: string, voiceName: string) {
    const ok = await confirm({ title: `Delete “${voiceName}”?`, description: "This cloned voice will be permanently removed.", confirmLabel: "Delete", danger: true });
    if (ok) act(() => api.deleteVoice(id), "Voice deleted");
  }

  return (
    <div className="grid gap-8">
      <Card className="grid gap-5 p-5 sm:p-6">
        <div>
          <h2 className="font-semibold">Clone a voice</h2>
          <p className="mt-1 text-sm text-muted">
            Record or upload 10–30 seconds of clean speech (one speaker, no music). It&apos;s transcribed
            automatically, which makes the clone more accurate. Only use your own voice or one you have permission to use.
          </p>
        </div>
        <Field label="Voice name" className="sm:w-72">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={recording || busy} />
        </Field>

        <div className="grid gap-4 rounded-xl bg-surface-2 p-4">
          <p className="text-xs font-medium text-muted">Read this aloud while recording:</p>
          <p className="text-sm leading-relaxed italic">“{SCRIPT}”</p>
          <div className="flex flex-wrap items-center gap-3">
            {recording ? (
              <Button variant="danger" onClick={() => recorder.current?.stop()} icon={<Icon.Stop width={12} height={12} />}>
                Stop &amp; save
              </Button>
            ) : (
              <Button variant="primary" onClick={startRecording} disabled={busy} icon={<Icon.Mic width={14} height={14} />}>
                Record
              </Button>
            )}
            {recording ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
                <span className="font-mono tabular-nums">0:{String(seconds).padStart(2, "0")}</span>
                <span className={seconds < 10 ? "text-warning" : "text-success"}>
                  {seconds < 10 ? "keep going, aim for 15–30 s" : "good length"}
                </span>
              </span>
            ) : (
              <>
                <span className="text-sm text-muted">or</span>
                <label className={cx(buttonClass("secondary", "sm"), busy && "pointer-events-none opacity-50")}>
                  <Icon.Upload width={14} height={14} /> Upload audio
                  <input type="file" accept="audio/*,video/*" className="sr-only" disabled={busy}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) save(f, f.name); e.target.value = ""; }} />
                </label>
              </>
            )}
            {busy && <span className="flex items-center gap-2 text-sm text-muted">Saving and transcribing…</span>}
          </div>
          {recording && (
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-danger transition-[width] duration-1000 ease-linear" style={{ width: `${(seconds / MAX_SECONDS) * 100}%` }} />
            </div>
          )}
        </div>
        {error && <Alert>{error}</Alert>}
      </Card>

      {loadError ? (
        <Alert title="Couldn't load voices" action={<Button size="xs" onClick={load} icon={<Icon.Refresh />}>Retry</Button>}>{loadError}</Alert>
      ) : !lib ? (
        <div className="grid gap-3"><Skeleton className="h-5 w-40" /><Skeleton className="h-64 rounded-2xl" /></div>
      ) : (
        <>
          <section className="grid gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold">Your voices <span className="font-normal text-muted">· cloned</span></h2>
            </div>
            {lib.voices.length ? (
              <VoiceRows lib={lib}
                rows={lib.voices.map((v) => ({
                  id: v.id, name: v.name, url: v.url,
                  sub: v.ref_text ? `“${v.ref_text.slice(0, 90)}${v.ref_text.length > 90 ? "…" : ""}”` : `added ${new Date(v.created * 1000).toLocaleString()}`,
                }))}
                onDefault={(id) => act(() => api.setDefaultVoice(id), "Default voice updated")}
                onDelete={removeVoice} />
            ) : (
              <EmptyState icon={<Icon.Mic />} title="No cloned voices yet" className="py-8">
                Record or upload a sample above to clone a voice.
              </EmptyState>
            )}
          </section>

          <section className="grid gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold">Qwen voices</h2>
              <span className="font-mono text-xs text-muted">
                {lib.engine} · {lib.device === "mps" ? "Apple Metal GPU" : lib.device}
              </span>
            </div>
            <p className="-mt-1 text-sm text-muted">
              9 predefined speakers. Each speaks all 10 supported languages; the label shows the one it sounds most
              natural in. Previews appear once the worker has rendered them.
            </p>
            <VoiceRows lib={lib}
              rows={lib.speakers.map((s) => ({ id: s.id, name: s.name, sub: `${s.description} · ${s.native}`, url: s.url ?? undefined }))}
              onDefault={(id) => act(() => api.setDefaultVoice(id), "Default voice updated")} />
          </section>
        </>
      )}
    </div>
  );
}

type Row = { id: string; name: string; sub: string; url?: string };

function VoiceRows({
  lib, rows, onDefault, onDelete,
}: {
  lib: Library;
  rows: Row[];
  onDefault: (id: string) => void;
  onDelete?: (id: string, name: string) => void;
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      {rows.map((r) => {
        const isDefault = lib.default === r.id;
        return (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent-fg">
              {r.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-medium">
                {r.name}
                {isDefault && <Badge tone="accent">Default</Badge>}
              </div>
              <div className="truncate text-xs text-muted">{r.sub}</div>
            </div>
            {r.url ? (
              <audio src={api.mediaUrl(r.url)} controls preload="none" className="h-8 w-full max-w-56 sm:w-56" />
            ) : (
              <span className="text-xs text-muted">No preview yet</span>
            )}
            {!isDefault && <Button size="xs" onClick={() => onDefault(r.id)}>Make default</Button>}
            {onDelete && (
              <Button size="xs" variant="danger-ghost" aria-label={`Delete ${r.name}`} onClick={() => onDelete(r.id, r.name)}>
                <Icon.Trash width={14} height={14} />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
