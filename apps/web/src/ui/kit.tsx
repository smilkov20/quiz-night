import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { C, FONT_BODY, FONT_DISPLAY, fmtClock } from "./theme";

type Tone = "primary" | "danger" | "quiet" | "solid";

export function Btn({
  children, onClick, tone = "quiet", disabled, wide, small, title, type = "button",
}: {
  children: ReactNode; onClick?: () => void; tone?: Tone;
  disabled?: boolean; wide?: boolean; small?: boolean; title?: string;
  type?: "button" | "submit";
}) {
  const tones: Record<Tone, { bg: string; fg: string; bd: string }> = {
    primary: { bg: C.biro, fg: C.onInk, bd: C.biro },
    danger: { bg: C.marker, fg: C.onInk, bd: C.marker },
    quiet: { bg: "transparent", fg: C.ink, bd: C.rule },
    solid: { bg: C.row, fg: C.ink, bd: C.rule },
  };
  const t = tones[tone];
  return (
    <button
      type={type} title={title} onClick={onClick} disabled={disabled}
      className={
        "inline-flex items-center justify-center gap-2 rounded-md border transition-[filter] " +
        (small ? "px-2 py-1 text-xs " : "px-3 py-2 text-sm ") +
        (wide ? "w-full " : "") +
        (disabled ? "opacity-40 cursor-not-allowed " : "hover:brightness-95 cursor-pointer ")
      }
      style={{ background: t.bg, color: t.fg, borderColor: t.bd, fontFamily: FONT_BODY, fontWeight: 600 }}
    >
      {children}
    </button>
  );
}

export function Panel({ children, title, right, pad = true }: {
  children: ReactNode; title?: string; right?: ReactNode; pad?: boolean;
}) {
  return (
    <section className="rounded-lg border overflow-hidden"
      style={{ borderColor: C.rule, background: C.card, boxShadow: "0 1px 2px rgba(21,35,79,0.06)" }}>
      {title && (
        <header className="flex items-center justify-between px-3 py-2 border-b"
          style={{ borderColor: C.rule, background: C.row }}>
          <h3 className="text-xs uppercase"
            style={{ color: C.biro, fontFamily: FONT_BODY, fontWeight: 700, letterSpacing: "0.14em" }}>
            {title}
          </h3>
          {right}
        </header>
      )}
      <div className={pad ? "p-3" : ""}>{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs uppercase mb-1"
      style={{ color: C.inkDim, fontFamily: FONT_BODY, fontWeight: 700, letterSpacing: "0.16em" }}>
      {children}
    </div>
  );
}

export function Pill({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "biro" | "live" | "danger" }) {
  const map = { dim: C.inkDim, biro: C.biro, live: C.correct, danger: C.marker };
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
      style={{ borderColor: map[tone], color: map[tone], fontFamily: FONT_BODY, fontWeight: 600 }}>
      {children}
    </span>
  );
}

/** The scoreboard clock. Counts down locally from a server timestamp, so a
    laggy connection doesn't make it stutter and a skewed device clock
    doesn't hand anyone extra seconds. */
export function Countdown({ remaining, total, size = "md", label }: {
  remaining: number; total: number; size?: "sm" | "md" | "lg"; label?: string;
}) {
  const frac = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  const urgent = remaining <= 5 && remaining > 0;
  const dims = { sm: 64, md: 120, lg: 260 }[size];
  const stroke = { sm: 5, md: 9, lg: 16 }[size];
  const r = (dims - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: dims, height: dims }}>
      <svg width={dims} height={dims} style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
        <circle cx={dims / 2} cy={dims / 2} r={r} fill="none" stroke={C.rule} strokeWidth={stroke} />
        <circle cx={dims / 2} cy={dims / 2} r={r} fill="none"
          stroke={urgent ? C.marker : C.biro} strokeWidth={stroke}
          strokeDasharray={circ} strokeDashoffset={circ * (1 - frac)}
          style={{ transition: "stroke-dashoffset 120ms linear, stroke 200ms" }} />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span style={{
          fontFamily: FONT_DISPLAY, fontSize: { sm: 18, md: 34, lg: 72 }[size],
          lineHeight: 1, color: urgent ? C.marker : C.ink, fontVariantNumeric: "tabular-nums",
        }}>{fmtClock(remaining)}</span>
        {label && <span className="text-xs uppercase mt-1"
          style={{ color: C.inkDim, letterSpacing: "0.14em", fontFamily: FONT_BODY }}>{label}</span>}
      </div>
    </div>
  );
}

export function Leaderboard({ standings }: { standings: { teamId: string; name: string; score: number }[] }) {
  return (
    <ol className="flex flex-col gap-1.5">
      {standings.map((t, i) => (
        <li key={t.teamId} className="flex items-center gap-3 rounded-md px-3 py-2"
          style={{ background: i === 0 ? C.high : C.row, border: `1px solid ${i === 0 ? C.ink : C.rule}` }}>
          <span style={{ fontFamily: FONT_DISPLAY, fontSize: 21, color: i === 0 ? C.biro : C.inkDim, minWidth: 30 }}>
            {i + 1}
          </span>
          <span className="flex-1 truncate" style={{ fontWeight: 600 }}>{t.name}</span>
          <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 18, color: C.biro, fontVariantNumeric: "tabular-nums" }}>
            {t.score}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ---------------------------------------------------------------
   Confirm dialog. Replaces window.confirm, which can't be styled and
   looks like a browser warning rather than part of the app.
---------------------------------------------------------------- */
interface ConfirmOpts {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOpts) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);

  const settle = useCallback((ok: boolean) => {
    setOpts(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const dialog = opts ? <ConfirmDialog opts={opts} onSettle={settle} /> : null;
  return { confirm, dialog };
}

function ConfirmDialog({ opts, onSettle }: { opts: ConfirmOpts; onSettle: (ok: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus Cancel, not Confirm — a stray Enter shouldn't delete anything.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSettle(false);
      if (e.key === "Enter" && e.target === cancelRef.current) onSettle(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSettle]);

  return (
    <div
      role="dialog" aria-modal="true" aria-label={opts.title}
      onClick={(e) => { if (e.target === e.currentTarget) onSettle(false); }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-5"
      style={{ background: "rgba(21,35,79,0.34)", backdropFilter: "blur(5px)", WebkitBackdropFilter: "blur(5px)" }}
    >
      <div className="w-full max-w-sm rounded-2xl border p-5"
        style={{
          background: C.card, borderColor: C.rule, color: C.ink,
          boxShadow: "0 18px 48px rgba(21,35,79,0.22)",
        }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 22, lineHeight: 1.15, letterSpacing: "-0.02em" }}>
          {opts.title}
        </div>
        {opts.body && (
          <p className="mt-2 text-sm" style={{ color: C.inkDim, lineHeight: 1.5 }}>{opts.body}</p>
        )}
        <div className="mt-5 flex gap-2 justify-end">
          <button ref={cancelRef} onClick={() => onSettle(false)}
            className="rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: C.rule, color: C.ink, fontWeight: 600 }}>
            {opts.cancelLabel ?? "Cancel"}
          </button>
          <button onClick={() => onSettle(true)}
            className="rounded-md px-3 py-2 text-sm"
            style={{
              background: opts.destructive ? C.marker : C.biro,
              color: C.onInk, fontWeight: 600,
            }}>
            {opts.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Toasts. Used on the host console for things that happen without the
   host doing anything — a timer expiring, a round filling up.
---------------------------------------------------------------- */
export interface Toast { id: number; title: string; body?: string; tone?: "info" | "alert" }

export function useToasts(ttl = 6000) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), ttl);
  }, [ttl]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const toasts = (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col gap-2" style={{ maxWidth: 340 }}>
      {items.map((t) => (
        <button key={t.id} onClick={() => dismiss(t.id)}
          className="text-left rounded-lg border px-3 py-2.5"
          style={{
            background: C.card,
            borderColor: t.tone === "alert" ? C.marker : C.biro,
            borderLeftWidth: 4,
            boxShadow: "0 8px 24px rgba(21,35,79,0.16)",
            color: C.ink,
          }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{t.title}</div>
          {t.body && <div className="text-sm" style={{ color: C.inkDim }}>{t.body}</div>}
        </button>
      ))}
    </div>
  );

  return { push, toasts };
}
