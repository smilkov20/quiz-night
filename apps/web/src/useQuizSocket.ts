import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "@quiz/shared";
import type { ClientMessage, ConnectionRole, HostAction } from "@quiz/shared";
import { isFatalClose, CLOSE_NO_ROOM } from "@quiz/shared";

/* Empty means same origin, which is the deployed case: one Node process
   serves the frontend and the socket. Set VITE_API_URL only when the two are
   hosted separately. */
export const API = import.meta.env.VITE_API_URL ?? "";
const WS = (API || window.location.origin).replace(/^http/, "ws");

export type ConnStatus = "connecting" | "open" | "closed";

interface Options {
  code: string | null;
  role: ConnectionRole;
  teamId?: string | null;
  /** Presenter token, for the read-only projector surface. */
  token?: string | null;
  /** Host password. Rides in the query string because a browser can't set
      headers on a WebSocket handshake. */
  hostKey?: string | null;
}

/**
 * One socket, one snapshot. Every server message replaces state wholesale,
 * so reconnecting after a dropped wifi or an accidental refresh is the same
 * code path as the first load — there is no diff to replay.
 */
export function useQuizSocket({ code, role, teamId, token, hostKey }: Options) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  /* Set when the server closes with a reason that reconnecting can never fix
     — a room that no longer exists, or a rejected credential. */
  const [fatal, setFatal] = useState<"no-room" | "unauthorised" | null>(null);
  /** serverNow - clientNow. Applied to every countdown so a skewed device
      clock can't hand one team extra seconds. */
  const offset = useRef(0);
  const ws = useRef<WebSocket | null>(null);
  const retry = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    if (!code) return;
    alive.current = true;

    const connect = () => {
      if (!alive.current) return;
      setStatus("connecting");
      const params = new URLSearchParams({ code, role });
      if (teamId) params.set("teamId", teamId);
      if (token) params.set("token", token);
      if (hostKey) params.set("key", hostKey);

      const socket = new WebSocket(`${WS}/ws?${params}`);
      ws.current = socket;

      socket.onopen = () => {
        retry.current = 0;
        setStatus("open");
        setError(null);
        setFatal(null);
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "snapshot") {
            offset.current = msg.snapshot.serverNow - Date.now();
            setSnapshot(msg.snapshot);
          } else if (msg.type === "error") {
            setError(msg.message);
          }
        } catch {
          /* ignore malformed frame */
        }
      };
      socket.onclose = (ev) => {
        setStatus("closed");
        if (!alive.current) return;
        if (isFatalClose(ev.code)) {
          // Retrying is pointless: the room is gone or we aren't allowed in.
          setFatal(ev.code === CLOSE_NO_ROOM ? "no-room" : "unauthorised");
          return;
        }
        // Backoff, capped — a pub's wifi drops often enough that hammering
        // reconnects would make things worse, not better.
        const delay = Math.min(1000 * 2 ** retry.current, 10000);
        retry.current += 1;
        setTimeout(connect, delay);
      };
      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      alive.current = false;
      ws.current?.close();
    };
  }, [code, role, teamId, token, hostKey]);

  // Keeps the connection accounted for without preventing hibernation.
  useEffect(() => {
    const id = setInterval(() => send({ type: "ping" }), 25000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    }
  }, []);

  const host = useCallback((payload: HostAction) => send({ type: "host", payload }), [send]);

  const answer = useCallback(
    (questionId: string, value: string) => send({ type: "answer", questionId, value }),
    [send]
  );

  /** Server time, not device time. */
  const now = useCallback(() => Date.now() + offset.current, []);

  return { snapshot, status, error, fatal, send, host, answer, now };
}

/* ---------- REST helpers ---------- */

export async function apiFetch<T>(path: string, init: RequestInit = {}, hostKey?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(hostKey ? { Authorization: `Bearer ${hostKey}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? "Request failed");
  }
  return res.json() as Promise<T>;
}
