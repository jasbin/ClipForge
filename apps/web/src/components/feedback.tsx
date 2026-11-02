"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { Button, cx } from "./ui";

/* Toasts and confirm dialogs, replacing window.alert / window.confirm. */

type ToastTone = "success" | "error" | "info";
type Toast = { id: number; tone: ToastTone; title: string; description?: string };

type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type Ctx = {
  toast: (t: Omit<Toast, "id">) => void;
  confirm: (o: ConfirmOptions) => Promise<boolean>;
};

const FeedbackContext = createContext<Ctx | null>(null);

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = nextId.current++;
    setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
    setTimeout(() => dismiss(id), t.tone === "error" ? 7000 : 3500);
  }, [dismiss]);

  // Confirm dialog: one at a time, resolved by the buttons, Esc or a backdrop click.
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })), []);

  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <ConfirmDialog pending={pending} onClose={(ok) => { pending?.resolve(ok); setPending(null); }} />
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === "error" ? "alert" : "status"}
            className="animate-toast-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-pop">
            <span className={cx("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full",
              t.tone === "success" ? "bg-success-soft text-success" : t.tone === "error" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-fg")}>
              {t.tone === "success" ? <Icon.Check width={12} height={12} /> : t.tone === "error" ? <Icon.X width={12} height={12} /> : <Icon.Info width={12} height={12} />}
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">{t.title}</p>
              {t.description && <p className="mt-0.5 break-words text-muted">{t.description}</p>}
            </div>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="cursor-pointer rounded p-0.5 text-muted hover:text-fg">
              <Icon.X width={14} height={14} />
            </button>
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

function ConfirmDialog({ pending, onClose }: {
  pending: (ConfirmOptions & { resolve: (v: boolean) => void }) | null;
  onClose: (ok: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (pending && !d.open) d.showModal();
    if (!pending && d.open) d.close();
  }, [pending]);

  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onClose(false); }}
      onClick={(e) => { if (e.target === ref.current) onClose(false); }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-line bg-surface p-0 text-fg shadow-pop">
      {pending && (
        <div className="grid gap-4 p-5">
          <div className="flex gap-3">
            {pending.danger && (
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-danger-soft text-danger">
                <Icon.Alert />
              </span>
            )}
            <div className="min-w-0">
              <h2 className="font-semibold">{pending.title}</h2>
              {pending.description && <div className="mt-1 text-sm text-muted">{pending.description}</div>}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => onClose(false)}>{pending.cancelLabel ?? "Cancel"}</Button>
            <Button autoFocus variant={pending.danger ? "danger" : "primary"} onClick={() => onClose(true)}>
              {pending.confirmLabel ?? "Confirm"}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}

export function useFeedback() {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error("useFeedback must be used inside <FeedbackProvider>");
  return ctx;
}
