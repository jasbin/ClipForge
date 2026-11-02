import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { forwardRef } from "react";
import { Icon } from "./icons";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

/* ---------- Button ---------- */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
type Size = "xs" | "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover shadow-card",
  secondary: "border border-line bg-surface text-fg hover:bg-hover shadow-card",
  ghost: "text-muted hover:bg-hover hover:text-fg",
  danger: "bg-danger text-white hover:opacity-90 shadow-card",
  "danger-ghost": "text-danger hover:bg-danger-soft",
};
const SIZES: Record<Size, string> = {
  xs: "h-7 gap-1.5 rounded-md px-2 text-xs",
  sm: "h-8 gap-1.5 rounded-lg px-3 text-sm",
  md: "h-10 gap-2 rounded-lg px-4 text-sm",
};

export function buttonClass(variant: Variant = "secondary", size: Size = "sm", className?: string) {
  return cx(
    "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors",
    "disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
    VARIANTS[variant], SIZES[size], className,
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "sm", loading, icon, className, children, disabled, type = "button", ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)} {...rest}>
      {loading ? <Spinner className="h-3.5 w-3.5" /> : icon}
      {children}
    </button>
  );
});

/* ---------- Form controls ---------- */

const control =
  "w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg shadow-card placeholder:text-muted/70 " +
  "transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest }, ref,
) {
  return <input ref={ref} className={cx(control, "h-10", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest }, ref,
) {
  return <textarea ref={ref} className={cx(control, "py-2 leading-relaxed", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx("relative", className)}>
      <select className={cx(control, "h-10 cursor-pointer appearance-none pr-9")} {...rest}>{children}</select>
      <Icon.Chevron className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("grid content-start gap-1.5", className)}>
      <span className="text-xs font-medium text-fg/80">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

/* ---------- Segmented control ---------- */

export function Segmented<T extends string>({
  value, onChange, options, size = "md", disabled, label, className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: ReactNode }[];
  size?: "sm" | "md";
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label}
      className={cx("inline-flex gap-1 rounded-lg bg-surface-2 p-1", disabled && "opacity-60", className)}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors cursor-pointer",
            size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3.5 text-sm",
            value === o.value ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg",
          )}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Surfaces & feedback ---------- */

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("rounded-2xl border border-line bg-surface shadow-card", className)} {...rest} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx("h-4 w-4 animate-spin", className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-surface-2", className)} />;
}

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  accent: "bg-accent-soft text-accent-fg",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Alert({
  tone = "danger", title, children, action, className,
}: { tone?: "danger" | "warning" | "info"; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const styles = {
    danger: "border-danger/30 bg-danger-soft text-danger",
    warning: "border-warning/30 bg-warning-soft text-warning",
    info: "border-accent/25 bg-accent-soft text-accent-fg",
  }[tone];
  const IconC = tone === "info" ? Icon.Info : Icon.Alert;
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex gap-3 rounded-xl border p-3.5 text-sm", styles, className)}>
      <IconC className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cx("text-fg/80", !!title && "mt-1")}>{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

export function ProgressTrack({ value, indeterminate, className }: { value: number; indeterminate?: boolean; className?: string }) {
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(value)}
      className={cx("h-1.5 overflow-hidden rounded-full bg-surface-2", className)}>
      {indeterminate ? (
        <div className="animate-indeterminate h-full w-1/3 rounded-full bg-accent" />
      ) : (
        <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${Math.min(100, Math.max(2, value))}%` }} />
      )}
    </div>
  );
}

export function EmptyState({ icon, title, children, action, className }: {
  icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div className={cx("grid place-items-center gap-2 rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center", className)}>
      {icon && <div className="mb-1 grid h-11 w-11 place-items-center rounded-full bg-surface-2 text-muted">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid min-w-5 place-items-center rounded border border-line bg-surface-2 px-1 font-mono text-[10px] leading-4 text-muted">
      {children}
    </kbd>
  );
}
