import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "ghost" | "outline" | "danger";

export function Button({ variant = "outline", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" && "bg-accent text-on-accent hover:brightness-110",
        variant === "outline" && "border border-line bg-raised text-text hover:bg-hover",
        variant === "ghost" && "text-muted hover:bg-hover hover:text-text",
        variant === "danger" && "border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20",
        className,
      )}
    />
  );
}

export function IconButton({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={clsx("inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-40", className)}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-raised px-1 py-px font-mono text-[10.5px] text-muted">{children}</kbd>;
}

export function Dialog({ title, onClose, children, width = "max-w-2xl", label }: { title: string; onClose: () => void; children: ReactNode; width?: string; label?: string }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[9vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={label ?? title} className={clsx("flex max-h-[80vh] w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl", width)}>
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-faint">{hint}</span>}
    </label>
  );
}

export const inputClass = "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[12.5px] text-text placeholder:text-faint";

export const STATE_META: Record<string, { label: string; color: string; pulse?: boolean }> = {
  IDLE: { label: "Idle", color: "bg-faint" },
  THINKING: { label: "Thinking", color: "bg-accent", pulse: true },
  PLANNING: { label: "Planning", color: "bg-accent", pulse: true },
  READING: { label: "Reading", color: "bg-info", pulse: true },
  SEARCHING: { label: "Searching", color: "bg-info", pulse: true },
  EDITING: { label: "Editing", color: "bg-accent", pulse: true },
  RUNNING: { label: "Running", color: "bg-accent", pulse: true },
  TESTING: { label: "Testing", color: "bg-accent", pulse: true },
  WAITING_FOR_PERMISSION: { label: "Waiting for approval", color: "bg-warn", pulse: true },
  RECOVERING: { label: "Recovering", color: "bg-warn", pulse: true },
  COMPLETED: { label: "Completed", color: "bg-ok" },
  FAILED: { label: "Failed", color: "bg-bad" },
  CANCELLED: { label: "Cancelled", color: "bg-faint" },
};

export function StateDot({ state }: { state: string }) {
  const m = STATE_META[state] ?? STATE_META.IDLE!;
  return <span aria-hidden className={clsx("inline-block h-2 w-2 rounded-full", m.color, m.pulse && "bc-pulse")} />;
}

export function formatTokens(n: number): string {
  // Context windows are powers of two (32768 → "32K"); other counts use decimal units.
  if (n >= 1024 && n % 1024 === 0 && n < 1024 * 1024) return `${n / 1024}K`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
