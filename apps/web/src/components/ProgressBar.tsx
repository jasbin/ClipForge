"use client";

import { useEffect, useState } from "react";
import type { ProgressEvent } from "@/lib/api";
import { Icon } from "./icons";
import { Button, Card, ProgressTrack, Spinner, cx } from "./ui";

const STAGES = [
  { key: "ingest", label: "Prepare video", detail: "Downloading and converting the source" },
  { key: "transcribe", label: "Transcribe", detail: "Turning speech into timed text" },
  { key: "features", label: "Analyse audio", detail: "Measuring energy, pitch and laughter" },
  { key: "find", label: "Find clips", detail: "The LLM proposes and reviews moments" },
  { key: "rank", label: "Rank", detail: "Snapping cuts and scoring clips" },
];

function fmtElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function ProgressBar({ progress, since, onStop, stopping, reconnecting }: {
  progress: ProgressEvent;
  since: Date;
  onStop: () => void;
  stopping: boolean;
  reconnecting?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const queued = progress.status === "queued" || progress.stage === "queued";
  const current = progress.stage === "done" ? STAGES.length : STAGES.findIndex((s) => s.key === progress.stage);
  const stage = STAGES[current];

  return (
    <Card className="grid gap-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-accent-soft text-accent-fg">
            <Spinner className="h-5 w-5" />
          </span>
          <div>
            <p className="font-semibold">{queued ? "Waiting in queue" : stage ? `${stage.label}…` : "Finishing up…"}</p>
            <p className="text-sm text-muted">
              {queued ? "The worker will pick this up shortly." : stage?.detail ?? "Saving results"}
            </p>
          </div>
        </div>
        <Button size="sm" variant="danger-ghost" loading={stopping} icon={<Icon.Stop width={12} height={12} />} onClick={onStop}>
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      </div>

      <div className="grid gap-2">
        <ProgressTrack value={progress.progress} indeterminate={queued} className="h-2" />
        <div className="flex justify-between text-xs text-muted">
          <span className="tabular-nums">{queued ? "—" : `${progress.progress.toFixed(0)}%`}</span>
          <span className="tabular-nums">
            {reconnecting && <span className="mr-2 text-warning">Reconnecting…</span>}
            Elapsed {fmtElapsed(now - since.getTime())}
          </span>
        </div>
      </div>

      <ol className="grid gap-2 sm:grid-cols-5">
        {STAGES.map((s, i) => {
          const state = i < current ? "done" : i === current ? "active" : "todo";
          return (
            <li key={s.key} className={cx("flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs",
              state === "active" ? "border-accent/40 bg-accent-soft font-medium text-accent-fg"
                : state === "done" ? "border-line text-fg" : "border-line text-muted")}>
              <span className={cx("grid h-4 w-4 shrink-0 place-items-center rounded-full",
                state === "done" ? "bg-success text-white" : state === "active" ? "" : "border border-line-strong")}>
                {state === "done" ? <Icon.Check width={10} height={10} strokeWidth={3} /> : state === "active" ? <Spinner className="h-3.5 w-3.5" /> : null}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
