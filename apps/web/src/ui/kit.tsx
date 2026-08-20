import type { ReactNode } from "react";
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
