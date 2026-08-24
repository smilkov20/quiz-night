import { useEffect, useRef, useState } from "react";
import type { Question } from "@quiz/shared";
import { C } from "./theme";

declare global { interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void } }

const YT_ERRORS: Record<number, string> = {
  2: "Bad video link",
  5: "Player couldn't load this one",
  100: "Video removed or private",
  101: "Owner disabled embedding",
  150: "Owner disabled embedding",
};

export function parseYouTube(input?: string): string | null {
  if (!input) return null;
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

export function parseStamp(input?: string): number | null {
  if (!input) return null;
  const m = input.match(/[?&](?:t|start)=(\d+)/);
  return m ? Number(m[1]) : null;
}

export const clipLen = (q: Pick<Question, "clipStart" | "clipEnd">) =>
  Math.max(1, (q.clipEnd ?? 0) - (q.clipStart ?? 0));

/**
 * One player for the whole session. The clip is authoritative about when it
 * ends — ENDED starts the answer timer — with a timeout as backup, because a
 * missed event would mean the clock never starts in front of a full room.
 */
export function YouTubeStage({
  question, playing, coverPicture, onEnded, size, muted = false, onNeedsUnlock,
}: {
  question: Question | null;
  playing: boolean;
  /** Music round: the room hears it but must not see the answer on screen. */
  coverPicture: boolean;
  onEnded?: () => void;
  size: "projector" | "monitor" | "hidden";
  /** The host's monitor is silent — only one surface may make noise, or the
      room hears the clip twice, slightly out of sync. */
  muted?: boolean;
  /** Presenter only: lets the surface show an unlock prompt. */
  onNeedsUnlock?: (unlock: () => void, needed: boolean) => void;
}) {
  const player = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallback = useRef<number | null>(null);
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;
  const fire = () => endedRef.current?.();

  useEffect(() => {
    let cancelled = false;
    const boot = () => {
      if (cancelled || player.current || !document.getElementById("yt-stage")) return;
      player.current = new window.YT.Player("yt-stage", {
        playerVars: { controls: 0, modestbranding: 1, rel: 0, disablekb: 1, fs: 0, playsinline: 1, iv_load_policy: 3 },
        events: {
          onReady: () => setReady(true),
          onError: (e: { data: number }) => setError(YT_ERRORS[e.data] ?? "Clip failed to play"),
          onStateChange: (e: { data: number }) => {
            if (e.data === window.YT?.PlayerState?.ENDED) fire();
          },
        },
      });
    };
    if (window.YT?.Player) boot();
    else {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); boot(); };
      if (!document.getElementById("yt-api")) {
        const tag = document.createElement("script");
        tag.id = "yt-api";
        tag.src = "https://www.youtube.com/iframe_api";
        tag.onerror = () => setFailed(true);
        document.body.appendChild(tag);
      }
    }
    const t = window.setTimeout(() => { if (!player.current) setFailed(true); }, 8000);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, []);

  useEffect(() => {
    if (!playing || !question || !ready) return;
    const id = parseYouTube(question.url);
    if (!id) { setError("No YouTube link on this question"); return; }
    setError(null);
    const from = question.clipStart ?? 0;
    if (muted) player.current?.mute?.(); else player.current?.unMute?.();
    player.current?.loadVideoById({ videoId: id, startSeconds: from, endSeconds: question.clipEnd ?? from + 15 });
    if (fallback.current) window.clearTimeout(fallback.current);
    fallback.current = window.setTimeout(() => fire(), clipLen(question) * 1000 + 800);
    return () => { if (fallback.current) window.clearTimeout(fallback.current); };
  }, [playing, question?.id, question?.url, ready, muted]);

  useEffect(() => {
    if (!playing) player.current?.stopVideo?.();
  }, [playing]);

  /* A browser will not play audio in a window that has never been clicked.
     The host presses Play on their console, which is a different window from
     the projector — so without this the room hears nothing. One click on the
     presenter, once, satisfies the gesture requirement for the night.

     The callback identity changes on every render, so it lives in a ref: as a
     dependency it re-ran the effect, which re-armed the prompt the instant it
     was dismissed, and it could never be got rid of. */
  const needsUnlockRef = useRef(onNeedsUnlock);
  needsUnlockRef.current = onNeedsUnlock;
  const unlockedRef = useRef(false);

  useEffect(() => {
    if (muted || !ready || unlockedRef.current) return;

    const unlock = () => {
      if (unlockedRef.current) return;
      unlockedRef.current = true;
      const p = player.current;
      try {
        p?.mute?.();
        p?.playVideo?.();
        p?.pauseVideo?.();
        p?.unMute?.();
      } catch { /* nothing loaded yet, which is fine */ }
      needsUnlockRef.current?.(unlock, false);
    };

    // Any click anywhere counts, so the prompt is only ever a hint.
    const onAnyClick = () => unlock();
    window.addEventListener("pointerdown", onAnyClick, { once: true });
    needsUnlockRef.current?.(unlock, true);
    return () => window.removeEventListener("pointerdown", onAnyClick);
  }, [ready, muted]);

  const geometry =
    size === "projector"
      ? { position: "fixed" as const, top: "20vh", left: "50%", transform: "translateX(-50%)",
          width: "min(1000px,94vw)", height: "min(540px,48vh)", zIndex: 30, borderRadius: 12,
          overflow: "hidden" as const, border: `2px solid ${C.ink}`, background: C.ink }
      : size === "monitor"
      ? { position: "fixed" as const, bottom: 16, right: 16, width: 240, height: 140, zIndex: 30,
          borderRadius: 8, overflow: "hidden" as const, border: `1px solid ${C.ink}`, background: C.ink }
      : { position: "fixed" as const, bottom: 0, right: 0, width: 1, height: 1, opacity: 0,
          pointerEvents: "none" as const, overflow: "hidden" as const, zIndex: -1 };

  return (
    <>
      <div style={geometry}>
        <div id="yt-stage" style={{ width: "100%", height: "100%" }} />
        {playing && coverPicture && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: C.card }}>
            <Waveform />
          </div>
        )}
      </div>
      {(error || failed) && size !== "hidden" && (
        <div className="fixed bottom-4 left-4 z-50 rounded-md border px-3 py-2 text-sm"
          style={{ background: C.card, borderColor: C.marker, color: C.ink }}>
          {failed ? "YouTube player blocked in this browser" : error}
        </div>
      )}
    </>
  );
}

function Waveform() {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT(Date.now() / 220), 60);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-end gap-1.5" style={{ height: "45%" }}>
      {Array.from({ length: 24 }).map((_, i) => (
        <div key={i} style={{ width: 6, height: `${20 + Math.abs(Math.sin(t + i * 0.55)) * 80}%`, background: C.biro, opacity: 0.6 }} />
      ))}
    </div>
  );
}
