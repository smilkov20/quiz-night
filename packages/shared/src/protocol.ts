import { z } from "zod";

/* Every message crossing the socket is validated on arrival. The server
   never trusts a client-supplied score, phase or timestamp — it only
   accepts intents, and recomputes state itself. */

export const HostActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin_round") }),
  z.object({ action: z.literal("reveal_question") }),
  z.object({ action: z.literal("play_media") }),
  z.object({ action: z.literal("replay_media") }),
  z.object({ action: z.literal("start_timer") }),
  z.object({ action: z.literal("extend"), seconds: z.number().int().min(1).max(600) }),
  z.object({ action: z.literal("lock") }),
  z.object({ action: z.literal("reopen") }),
  z.object({ action: z.literal("next_question") }),
  z.object({ action: z.literal("next_round") }),
  z.object({ action: z.literal("show_review") }),
  z.object({ action: z.literal("show_leaderboard") }),
  z.object({ action: z.literal("start_break"), minutes: z.number().int().min(1).max(60) }),
  z.object({ action: z.literal("extend_break"), minutes: z.number().int().min(1).max(60) }),
  z.object({ action: z.literal("end_break") }),
  z.object({ action: z.literal("finish") }),
  z.object({ action: z.literal("run_tiebreaker") }),
  z.object({ action: z.literal("next_tiebreaker") }),
  z.object({ action: z.literal("resolve_tiebreak"), teamId: z.string() }),
  z.object({
    action: z.literal("grade"),
    questionId: z.string(),
    teamIds: z.array(z.string()),
    points: z.number().int().min(0).max(100),
  }),
  z.object({ action: z.literal("rename_team"), teamId: z.string(), name: z.string().min(1).max(60) }),
  z.object({ action: z.literal("remove_team"), teamId: z.string() }),
  z.object({ action: z.literal("relink_team"), teamId: z.string() }),
]);
export type HostAction = z.infer<typeof HostActionSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  /** Team answer. Autosaved on a debounce, so every save is the submission. */
  z.object({
    type: z.literal("answer"),
    questionId: z.string(),
    value: z.string().max(500),
  }),
  z.object({
    type: z.literal("tiebreak_answer"),
    value: z.string().max(200),
  }),
  z.object({ type: z.literal("host"), payload: HostActionSchema }),
  /* Presenter only: the clip actually finished. The server also has its own
     timer, so this is an optimisation rather than a dependency. */
  z.object({ type: z.literal("media_ended") }),
  /** Keeps a hibernating Durable Object's connection accounted for. */
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "snapshot"; snapshot: import("./types").Snapshot }
  | { type: "joined"; teamId: string; teamToken: string }
  | { type: "error"; message: string };

export type ConnectionRole = "host" | "presenter" | "team";

/** Join codes skip 0/O and 1/I/L — they get misread across a noisy room. */
export const JOIN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeJoinCode(len = 5): string {
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += JOIN_ALPHABET[bytes[i] % JOIN_ALPHABET.length];
  return out;
}

export function makeToken(bytes = 18): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Grace for network latency on a submission that raced the clock. */
export const LATE_SUBMIT_GRACE_MS = 2000;

/* WebSocket close codes in the 4000-4999 application range. The client uses
   these to decide whether reconnecting could ever succeed. */
export const CLOSE_NO_ROOM = 4004;
export const CLOSE_UNAUTHORISED = 4003;
export const isFatalClose = (code: number) =>
  code === CLOSE_NO_ROOM || code === CLOSE_UNAUTHORISED;
