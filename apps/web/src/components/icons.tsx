import type { SVGProps } from "react";

// Inline stroke icons (Lucide-style, 24×24) so the UI has no icon dependency.
type P = SVGProps<SVGSVGElement>;

function I({ children, ...p }: P) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
      {children}
    </svg>
  );
}

export const Icon = {
  Play: (p: P) => <I {...p}><polygon points="6 3 20 12 6 21 6 3" /></I>,
  Pause: (p: P) => <I {...p}><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></I>,
  Stop: (p: P) => <I {...p}><rect x="5" y="5" width="14" height="14" rx="2" /></I>,
  Download: (p: P) => <I {...p}><path d="M12 15V3" /><path d="m7 10 5 5 5-5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></I>,
  Upload: (p: P) => <I {...p}><path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></I>,
  Link: (p: P) => <I {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></I>,
  Copy: (p: P) => <I {...p}><rect x="8" y="8" width="14" height="14" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></I>,
  Check: (p: P) => <I {...p}><path d="M20 6 9 17l-5-5" /></I>,
  X: (p: P) => <I {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></I>,
  Trash: (p: P) => <I {...p}><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></I>,
  Refresh: (p: P) => <I {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M8 16H3v5" /></I>,
  ThumbUp: (p: P) => <I {...p}><path d="M7 10v12" /><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" /></I>,
  ThumbDown: (p: P) => <I {...p}><path d="M17 14V2" /><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" /></I>,
  Search: (p: P) => <I {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></I>,
  Mic: (p: P) => <I {...p}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" /></I>,
  Sparkles: (p: P) => <I {...p}><path d="M9.94 14.06 4 20" /><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2Z" /></I>,
  Chevron: (p: P) => <I {...p}><path d="m6 9 6 6 6-6" /></I>,
  ArrowLeft: (p: P) => <I {...p}><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></I>,
  External: (p: P) => <I {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></I>,
  Alert: (p: P) => <I {...p}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></I>,
  Info: (p: P) => <I {...p}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></I>,
  Film: (p: P) => <I {...p}><rect x="2" y="2" width="20" height="20" rx="2" /><path d="M7 2v20" /><path d="M17 2v20" /><path d="M2 12h20" /><path d="M2 7h5" /><path d="M2 17h5" /><path d="M17 17h5" /><path d="M17 7h5" /></I>,
  Sun: (p: P) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></I>,
  Moon: (p: P) => <I {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></I>,
  Monitor: (p: P) => <I {...p}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></I>,
  Settings: (p: P) => <I {...p}><path d="M20 7h-9" /><path d="M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></I>,
  FileText: (p: P) => <I {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M16 13H8" /><path d="M16 17H8" /><path d="M10 9H8" /></I>,
  Keyboard: (p: P) => <I {...p}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" /></I>,
};
