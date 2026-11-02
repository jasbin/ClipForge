import type { CaptionStyle, Cue } from "./captions";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type ProjectStatus = "queued" | "running" | "done" | "error" | "cancelled";

export type Project = {
  id: string;
  title: string;
  source_url: string | null;
  status: ProjectStatus;
  stage: string;
  progress: number;
  error: string | null;
  duration: number | null;
  settings_json: string;
  created_at: string;
  clip_count?: number;
};

export type ProjectSettings = {
  min_seconds: number;
  max_seconds: number;
  top_n: number;
  language: string | null;
  use_llm: boolean;
};

export type Clip = {
  id: string;
  project_id: string;
  rank: number;
  start: number;
  end: number;
  title: string;
  hook: string;
  reason: string;
  missing_context: string;
  virality: number;
  scores: Record<string, number>;
  text: string;
  feedback: number | null;
  voice_status: "none" | "queued" | "running" | "done" | "error" | "cancelled";
  voice_progress: number;
  voice_error: string | null;
  script: ClipScript | null; // saved "Rewrite with AI" narration
  caption_style: Partial<CaptionStyle> | null; // last style used in the caption studio
};

/** A recording you saved; Qwen3-TTS clones it. */
export type Voice = { id: string; name: string; created: number; url: string; ref_text?: string };
/** One of Qwen's predefined speakers (id "qwen:<name>"). */
export type Speaker = { id: string; name: string; description: string; native: string; url: string | null };
export type VoiceLibrary = { speakers: Speaker[]; voices: Voice[]; default: string; device: string; engine: string };

export type VoiceoverOptions = { voice_id: string; style: string; original_volume: number; script?: string[] };

/** One timed narration line; `original` is what was said at that moment. */
export type ScriptLine = { text: string; original: string; start: number; end: number; max_words: number };
export type ClipScript = { language: string; direction?: string; lines: ScriptLine[] };

export type AudioSource = "original" | "voiceover";

/** A background-music track in the library. */
export type Track = { id: string; name: string; duration: number; created: number; url: string };

export type MusicChoice = { track_id: string; volume: number; offset: number; duck: boolean };

export type ExportRequest = { style: CaptionStyle; captions: boolean; source: AudioSource; music: MusicChoice | null };

export type Sentence = { id: number; start: number; end: number; text: string };

export type ProgressEvent = Pick<Project, "status" | "stage" | "progress" | "error">;

export type Health = { ok: boolean; llm_provider: string; llm_model: string };

/** FastAPI errors carry `detail` as a string, or a list of validation errors. */
function detailOf(body: unknown): string | null {
  const d = (body as { detail?: unknown })?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => x?.msg ?? JSON.stringify(x)).join("; ");
  return null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(detailOf(body) ?? `${res.status} ${res.statusText}`, res.status);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

const OFFLINE = `Can't reach the ClipForge API at ${API_URL}. Is it running (make dev)?`;

/** fetch, with a readable message when the API isn't reachable at all. */
function call(path: string, init?: RequestInit) {
  return fetch(`${API_URL}${path}`, init).catch((e) => {
    throw e instanceof DOMException && e.name === "AbortError" ? e : new ApiError(OFFLINE);
  });
}

const get = <T>(path: string) => call(path, { cache: "no-store" }).then(json<T>);
const send = <T>(method: string, path: string, body?: BodyInit, headers?: HeadersInit) =>
  call(path, { method, body, headers }).then(json<T>);

function formOf(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

/** POST /projects with upload progress. fetch can't report upload progress, so this uses XHR. */
function uploadProject(form: FormData, onProgress?: (fraction: number) => void, signal?: AbortSignal) {
  return new Promise<Project>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/projects`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as Project);
      else reject(new ApiError(detailOf(xhr.response) ?? `${xhr.status} ${xhr.statusText}`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError(OFFLINE));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}

const filenameOf = (res: Response) => /filename="?([^"]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1];

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const api = {
  health: () => get<Health>("/health"),
  projects: () => get<Project[]>("/projects"),
  project: (id: string) => get<Project>(`/projects/${id}`),
  clips: (id: string) => get<Clip[]>(`/projects/${id}/clips`),
  transcript: (id: string) => get<{ language: string; sentences: Sentence[] }>(`/projects/${id}/transcript`),
  createProject: uploadProject,
  retry: (id: string) => send<Project>("POST", `/projects/${id}/retry`),
  cancelProject: (id: string) => send<Project>("POST", `/projects/${id}/cancel`),
  deleteProject: (id: string) => send<void>("DELETE", `/projects/${id}`),
  feedback: (clipId: string, value: -1 | 0 | 1) =>
    send<{ ok: boolean }>("POST", `/clips/${clipId}/feedback`, formOf({ value: String(value) })),
  voices: () => get<VoiceLibrary>("/voices"),
  uploadVoice: (file: Blob, name: string, filename = "voice.webm") => {
    const form = formOf({ name });
    form.set("file", file, filename);
    return send<VoiceLibrary>("POST", "/voices", form);
  },
  setDefaultVoice: (voiceId: string) => send<VoiceLibrary>("POST", "/voices/default", formOf({ voice_id: voiceId })),
  deleteVoice: (voiceId: string) => send<VoiceLibrary>("DELETE", `/voices/${voiceId}`),
  startVoiceover: (clipId: string, opts: VoiceoverOptions) => {
    const form = formOf({ voice_id: opts.voice_id, style: opts.style, original_volume: String(opts.original_volume) });
    if (opts.script) form.set("script", JSON.stringify(opts.script));
    return send<{ ok: boolean }>("POST", `/clips/${clipId}/voiceover`, form);
  },
  cancelVoiceover: (clipId: string) => send<{ ok: boolean }>("POST", `/clips/${clipId}/voiceover/cancel`),
  originalScript: (clipId: string) => get<ClipScript>(`/clips/${clipId}/script`),
  writeScript: (clipId: string, instructions: string) =>
    send<ClipScript>("POST", `/clips/${clipId}/script`, formOf({ instructions })),
  saveScript: (clipId: string, lines: string[], direction?: string) =>
    send<ClipScript>("PUT", `/clips/${clipId}/script`, JSON.stringify({ lines, direction }), { "Content-Type": "application/json" }),
  discardScript: (clipId: string) => send<void>("DELETE", `/clips/${clipId}/script`),
  /** Cuts the clip (first time takes a few seconds) and saves it via a blob download. */
  downloadClip: async (clipId: string, fallbackName: string) => {
    const res = await call(`/clips/${clipId}/download`);
    if (!res.ok) await json(res);
    saveBlob(await res.blob(), filenameOf(res) ?? fallbackName);
  },
  captions: (projectId: string, wordsPerLine: number) =>
    get<{ cues: Cue[] }>(`/projects/${projectId}/captions?words_per_line=${wordsPerLine}`).then((r) => r.cues),
  /** Caption lines for one clip: absolute times (original audio) or 0-based (voiceover MP4). */
  clipCaptions: (clipId: string, source: AudioSource, wordsPerLine: number) =>
    get<{ cues: Cue[] }>(`/clips/${clipId}/captions?source=${source}&words_per_line=${wordsPerLine}`).then((r) => r.cues),
  saveCaptionStyle: (clipId: string, style: CaptionStyle) =>
    send<CaptionStyle>("PUT", `/clips/${clipId}/caption-style`, JSON.stringify(style), { "Content-Type": "application/json" }),
  /** Renders the final MP4 (cached per settings) and saves it via a blob download. */
  exportClip: async (clipId: string, req: ExportRequest, fallbackName: string, signal?: AbortSignal) => {
    const res = await call(`/clips/${clipId}/export`, {
      method: "POST", body: JSON.stringify(req), headers: { "Content-Type": "application/json" }, signal,
    });
    if (!res.ok) await json(res);
    saveBlob(await res.blob(), filenameOf(res) ?? fallbackName);
  },
  music: () => get<Track[]>("/music"),
  uploadMusic: (file: File, name: string) => {
    const form = formOf({ name });
    form.set("file", file);
    return send<Track[]>("POST", "/music", form);
  },
  deleteMusic: (trackId: string) => send<Track[]>("DELETE", `/music/${trackId}`),
  voiceoverUrl: (clipId: string, bust?: string | number) =>
    `${API_URL}/clips/${clipId}/voiceover${bust ? `?v=${bust}` : ""}`,
  mediaUrl: (path: string) => `${API_URL}${path}`,
  events: (id: string) => new EventSource(`${API_URL}/projects/${id}/events`),
  proxyUrl: (id: string) => `${API_URL}/media/${id}/proxy.mp4`,
  clipsJsonUrl: (id: string) => `${API_URL}/media/${id}/clips.json`,
  srtUrl: (clipId: string) => `${API_URL}/clips/${clipId}/srt`,
};

export function settingsOf(p: Project): ProjectSettings | null {
  try {
    return JSON.parse(p.settings_json);
  } catch {
    return null;
  }
}

export function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function fmtDuration(t: number | null) {
  if (t == null) return "";
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.round(t % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

/** The API stores naive UTC timestamps; make sure they parse as UTC. */
export function parseDate(iso: string) {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function timeAgo(date: Date, now = Date.now()) {
  const s = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fmtBytes(n: number) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

export const isActive = (s: ProjectStatus) => s === "queued" || s === "running";

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
