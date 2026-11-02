import type { ProjectStatus } from "@/lib/api";
import { Badge } from "./ui";

const META: Record<ProjectStatus, { tone: "neutral" | "accent" | "success" | "danger" | "warning"; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  running: { tone: "accent", label: "Processing" },
  done: { tone: "success", label: "Ready" },
  error: { tone: "danger", label: "Failed" },
  cancelled: { tone: "warning", label: "Stopped" },
};

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const m = META[status] ?? META.queued;
  return (
    <Badge tone={m.tone}>
      {(status === "running" || status === "queued") && (
        <span className={`h-1.5 w-1.5 rounded-full bg-current ${status === "running" ? "animate-pulse" : ""}`} />
      )}
      {m.label}
    </Badge>
  );
}
