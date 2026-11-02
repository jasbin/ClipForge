"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtDuration, isActive, parseDate, plural, timeAgo, type Project } from "@/lib/api";
import { errorMessage, useFeedback } from "./feedback";
import { Icon } from "./icons";
import { StatusBadge } from "./StatusBadge";
import { Alert, Button, EmptyState, Input, ProgressTrack, Segmented, Skeleton, cx } from "./ui";

type Filter = "all" | "active" | "done" | "failed";
const FILTERS: Record<Filter, (p: Project) => boolean> = {
  all: () => true,
  active: (p) => isActive(p.status),
  done: (p) => p.status === "done",
  failed: (p) => p.status === "error" || p.status === "cancelled",
};

const STAGE_LABEL: Record<string, string> = {
  queued: "Waiting", ingest: "Preparing video", transcribe: "Transcribing", features: "Analysing audio",
  find: "Finding clips", rank: "Ranking", done: "Finishing",
};

export function ProjectList() {
  const { toast, confirm } = useFeedback();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(() => {
    api.projects().then((p) => { setProjects(p); setError(null); }, (e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll while anything is processing; otherwise refresh when the tab regains focus.
  const active = projects?.some((p) => isActive(p.status));
  useEffect(() => {
    if (active) {
      const t = setInterval(load, 2000);
      return () => clearInterval(t);
    }
    const onFocus = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [active, load]);

  // Retry while the API is unreachable.
  useEffect(() => {
    if (!error) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [error, load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (projects ?? []).filter((p) => FILTERS[filter](p) && (!q || p.title.toLowerCase().includes(q)));
  }, [projects, query, filter]);

  async function stop(p: Project) {
    try {
      await api.cancelProject(p.id);
      toast({ tone: "info", title: "Stopping…", description: p.title });
      load();
    } catch (e) {
      toast({ tone: "error", title: "Couldn't stop project", description: errorMessage(e) });
    }
  }

  async function remove(p: Project) {
    const ok = await confirm({
      title: "Delete this project?",
      description: <>“{p.title}” and all its clips, transcripts and voiceovers will be permanently deleted.</>,
      confirmLabel: "Delete", danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteProject(p.id);
      setProjects((ps) => ps?.filter((x) => x.id !== p.id) ?? null);
      toast({ tone: "success", title: "Project deleted" });
    } catch (e) {
      toast({ tone: "error", title: "Couldn't delete project", description: errorMessage(e) });
    }
  }

  const counts = useMemo(() => {
    const ps = projects ?? [];
    return Object.fromEntries((Object.keys(FILTERS) as Filter[]).map((f) => [f, ps.filter(FILTERS[f]).length])) as Record<Filter, number>;
  }, [projects]);

  return (
    <section className="grid gap-4" aria-labelledby="projects-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="projects-heading" className="text-lg font-semibold">
          Projects {projects && <span className="font-normal text-muted">({projects.length})</span>}
        </h2>
        {!!projects?.length && (
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <Icon.Search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects"
                aria-label="Search projects" className="h-9 pl-9" />
            </div>
            <Segmented label="Filter projects" size="sm" value={filter} onChange={setFilter} className="h-9 items-center"
              options={[
                { value: "all", label: "All" },
                { value: "active", label: `Active${counts.active ? ` ${counts.active}` : ""}` },
                { value: "done", label: "Ready" },
                { value: "failed", label: "Failed" },
              ]} />
          </div>
        )}
      </div>

      {error && !projects ? (
        <Alert title="Couldn't load projects" action={<Button size="xs" onClick={load} icon={<Icon.Refresh />}>Retry now</Button>}>
          {error}
        </Alert>
      ) : !projects ? (
        <ul className="grid gap-3">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-3">
              <Skeleton className="h-16 w-28 rounded-lg" />
              <div className="grid flex-1 gap-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-1/3" /></div>
            </li>
          ))}
        </ul>
      ) : !projects.length ? (
        <EmptyState icon={<Icon.Film />} title="No projects yet">
          Paste a link or drop a video above. Your projects will show up here.
        </EmptyState>
      ) : !visible.length ? (
        <EmptyState icon={<Icon.Search />} title="No matching projects"
          action={<Button size="xs" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</Button>}>
          Nothing matches the current search or filter.
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {visible.map((p) => <ProjectRow key={p.id} p={p} onStop={() => stop(p)} onDelete={() => remove(p)} />)}
        </ul>
      )}
    </section>
  );
}

function ProjectRow({ p, onStop, onDelete }: { p: Project; onStop: () => void; onDelete: () => void }) {
  const created = parseDate(p.created_at);
  const running = isActive(p.status);
  return (
    <li className="group relative flex items-center gap-4 rounded-2xl border border-line bg-surface p-3 shadow-card transition-colors hover:border-line-strong">
      <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-surface-2 sm:w-32">
        {p.status === "done" ? (
          <video src={`${api.proxyUrl(p.id)}#t=3`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden
            className="h-full w-full object-cover" />
        ) : (
          <div className={cx("grid h-full place-items-center", p.status === "error" ? "text-danger" : "text-muted")}>
            {p.status === "error" ? <Icon.Alert /> : <Icon.Film />}
          </div>
        )}
        {p.duration != null && (
          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
            {fmtDuration(p.duration)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {/* Stretched link: the whole row is clickable, buttons sit above it. */}
        <Link href={`/projects/${p.id}`} className="block truncate font-medium after:absolute after:inset-0 after:rounded-2xl after:content-['']">
          {p.title}
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <StatusBadge status={p.status} />
          {p.status === "done" && <span>{plural(p.clip_count ?? 0, "clip")}</span>}
          <time dateTime={created.toISOString()} title={created.toLocaleString()}>{timeAgo(created)}</time>
        </div>
        {running && (
          <div className="mt-2 flex max-w-sm items-center gap-2 text-xs text-muted">
            <ProgressTrack value={p.progress} indeterminate={p.status === "queued"} className="flex-1" />
            <span className="shrink-0">{STAGE_LABEL[p.stage] ?? p.stage} · {p.progress.toFixed(0)}%</span>
          </div>
        )}
        {p.status === "error" && p.error && <p className="mt-1.5 truncate text-xs text-danger">{p.error}</p>}
      </div>

      <div className="relative z-10 flex shrink-0 items-center gap-1">
        {running ? (
          <Button size="xs" variant="danger-ghost" icon={<Icon.Stop width={12} height={12} />} onClick={onStop}>Stop</Button>
        ) : (
          <Button size="xs" variant="ghost" aria-label={`Delete ${p.title}`} title="Delete project" onClick={onDelete}
            className="opacity-100 hover:text-danger sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
            <Icon.Trash />
          </Button>
        )}
      </div>
    </li>
  );
}
