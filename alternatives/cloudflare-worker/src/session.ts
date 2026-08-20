import { DurableObject } from "cloudflare:workers";
import {
  ClientMessageSchema,
  makeToken,
  LATE_SUBMIT_GRACE_MS,
  type ServerMessage,
  type ConnectionRole,
  type HostAction,
} from "@quiz/shared";
import {
  answerKey,
  computeStandings,
  countUngraded,
  maxPointsOf,
  normalise,
  tiedForFirst,
  type Quiz,
  type Session,
  type Snapshot,
} from "@quiz/shared";
import type { Env } from "./index";

interface SocketMeta {
  role: ConnectionRole;
  teamId?: string;
}

/* One Durable Object per live quiz. Every client for a session addresses the
   same object by id, so broadcast is a local loop and session state can live
   in memory — the single-process design from the plan, made serverless. */
export class QuizSession extends DurableObject<Env> {
  private session: Session | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.session = (await ctx.storage.get<Session>("session")) ?? null;
    });
  }

  /* ---------- lifecycle ---------- */

  async create(quiz: Quiz, joinCode: string): Promise<{ joinCode: string; presenterToken: string; id: string }> {
    const now = Date.now();
    this.session = {
      id: this.ctx.id.toString(),
      joinCode,
      presenterToken: makeToken(),
      quiz,
      state: "lobby",
      roundIdx: 0,
      questionIdx: 0,
      phase: "idle",
      questionStartedAt: null,
      mediaStartedAt: null,
      reviewRound: null,
      teams: [],
      answers: {},
      tiebreakIdx: 0,
      tiebreakTeams: [],
      tiebreakAnswers: {},
      winnerTeamId: null,
      createdAt: now,
    };
    await this.persist();
    return {
      joinCode: this.session.joinCode,
      presenterToken: this.session.presenterToken,
      id: this.session.id,
    };
  }

  async info(): Promise<{ joinCode: string; state: string; teams: number } | null> {
    if (!this.session) return null;
    return {
      joinCode: this.session.joinCode,
      state: this.session.state,
      teams: this.session.teams.length,
    };
  }

  /** Joining is idempotent: an existing token returns the same team, which is
      how a cleared-cache device gets relinked without losing its score. */
  async joinTeam(name: string, token: string | null): Promise<{ teamId: string; teamToken: string } | { error: string }> {
    if (!this.session) return { error: "Session not found" };
    if (token) {
      const existing = await this.ctx.storage.get<string>(`token:${token}`);
      if (existing && this.session.teams.some((t) => t.id === existing)) {
        return { teamId: existing, teamToken: token };
      }
    }
    if (this.session.state !== "lobby") return { error: "The quiz has already started" };
    const clean = name.trim().slice(0, 60);
    if (!clean) return { error: "Pick a team name" };
    if (this.session.teams.some((t) => normalise(t.name) === normalise(clean))) {
      return { error: "That name is taken — pick another" };
    }
    const teamId = makeToken(8);
    const teamToken = makeToken();
    this.session.teams.push({ id: teamId, name: clean, connected: false, lastSeen: Date.now() });
    await this.ctx.storage.put(`token:${teamToken}`, teamId);
    await this.persist();
    this.broadcast();
    return { teamId, teamToken };
  }

  /* ---------- websockets ---------- */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = (url.searchParams.get("role") ?? "team") as ConnectionRole;
    const teamId = url.searchParams.get("teamId") ?? undefined;

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    if (!this.session) return new Response("No such session", { status: 404 });
    if (role === "presenter" && url.searchParams.get("token") !== this.session.presenterToken) {
      return new Response("Bad presenter token", { status: 403 });
    }

    const pair = new WebSocketPair();
    const meta: SocketMeta = { role, teamId };
    // Hibernation API: the tag survives eviction, so a woken object still
    // knows who each socket belongs to.
    this.ctx.acceptWebSocket(pair[1], [JSON.stringify(meta)]);

    if (teamId) this.setConnected(teamId, true);
    this.sendTo(pair[1], { type: "snapshot", snapshot: this.snapshot(teamId) });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.session) return;
    const meta = this.metaOf(ws);
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.sendTo(ws, { type: "error", message: "Malformed message" });
    }
    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      return this.sendTo(ws, { type: "error", message: "Unrecognised message" });
    }
    const msg = result.data;

    if (msg.type === "ping") return;

    if (msg.type === "answer") {
      if (!meta.teamId) return;
      this.recordAnswer(meta.teamId, msg.questionId, msg.value);
      await this.persist();
      this.broadcast();
      return;
    }

    if (msg.type === "tiebreak_answer") {
      if (!meta.teamId || !this.session.tiebreakTeams.includes(meta.teamId)) return;
      this.session.tiebreakAnswers[meta.teamId] = msg.value;
      await this.persist();
      this.broadcast();
      return;
    }

    if (msg.type === "host") {
      if (meta.role !== "host") {
        return this.sendTo(ws, { type: "error", message: "Not the host" });
      }
      await this.applyHostAction(msg.payload);
      return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = this.metaOf(ws);
    if (meta.teamId) {
      this.setConnected(meta.teamId, false);
      await this.persist();
      this.broadcast();
    }
  }

  /** Auto-lock when the clock runs out. An Alarm rather than setTimeout,
      because any timer callback would disable hibernation entirely. */
  async alarm(): Promise<void> {
    if (!this.session) return;
    if (this.session.phase === "answering") {
      this.lockQuestion();
      await this.persist();
      this.broadcast();
    }
  }

  /* ---------- host actions ---------- */

  private async applyHostAction(a: HostAction): Promise<void> {
    const s = this.session;
    if (!s) return;
    const round = s.quiz.rounds[s.roundIdx];

    switch (a.action) {
      case "begin_round":
        s.state = "in_round";
        s.phase = "idle";
        s.reviewRound = null;
        break;

      case "reveal_question":
        s.phase = "revealed";
        s.questionStartedAt = null;
        s.mediaStartedAt = null;
        break;

      case "play_media":
      case "replay_media":
        s.phase = "playing_media";
        s.mediaStartedAt = Date.now();
        s.questionStartedAt = null;
        break;

      case "start_timer":
        if (!round) break;
        s.phase = "answering";
        s.questionStartedAt = Date.now();
        s.mediaStartedAt = null;
        await this.ctx.storage.setAlarm(Date.now() + round.timeLimit * 1000 + LATE_SUBMIT_GRACE_MS);
        break;

      case "extend":
        if (s.questionStartedAt) {
          s.questionStartedAt += a.seconds * 1000;
          if (round) {
            await this.ctx.storage.setAlarm(
              s.questionStartedAt + round.timeLimit * 1000 + LATE_SUBMIT_GRACE_MS
            );
          }
        }
        break;

      case "lock":
        this.lockQuestion();
        break;

      case "reopen":
        if (!round) break;
        s.phase = "answering";
        s.questionStartedAt = Date.now();
        await this.ctx.storage.setAlarm(Date.now() + round.timeLimit * 1000 + LATE_SUBMIT_GRACE_MS);
        break;

      case "next_question":
        if (!round) break;
        if (s.questionIdx + 1 < round.questions.length) {
          s.questionIdx += 1;
          s.phase = "idle";
          s.questionStartedAt = null;
          s.mediaStartedAt = null;
        } else {
          s.state = "round_review";
          s.reviewRound = s.roundIdx;
          s.phase = "idle";
          s.questionStartedAt = null;
        }
        break;

      case "next_round":
        if (s.roundIdx + 1 < s.quiz.rounds.length) {
          s.roundIdx += 1;
          s.questionIdx = 0;
          s.state = "in_round";
          s.phase = "idle";
          s.questionStartedAt = null;
          s.reviewRound = null;
        } else {
          s.state = "leaderboard";
          s.reviewRound = null;
        }
        break;

      case "show_review":
        s.state = "round_review";
        s.reviewRound = s.roundIdx;
        break;

      case "show_leaderboard":
        s.state = "leaderboard";
        break;

      case "finish":
        s.state = "finished";
        break;

      case "run_tiebreaker": {
        const tied = tiedForFirst(s);
        if (tied.length < 2) break;
        s.state = "tiebreaker";
        s.tiebreakIdx = 0;
        s.tiebreakTeams = tied.map((t) => t.teamId);
        s.tiebreakAnswers = {};
        break;
      }

      case "resolve_tiebreak":
        s.winnerTeamId = a.teamId;
        s.state = "finished";
        break;

      case "grade": {
        // Partial credit: the grader awards anywhere from 0 to max.
        const q = this.findQuestion(a.questionId);
        if (!q) break;
        const cap = maxPointsOf(q.round, q.question);
        const points = Math.min(a.points, cap);
        for (const teamId of a.teamIds) {
          const k = answerKey(teamId, a.questionId);
          const existing = s.answers[k];
          if (existing) s.answers[k] = { ...existing, points };
        }
        break;
      }

      case "rename_team": {
        const t = s.teams.find((x) => x.id === a.teamId);
        if (t) t.name = a.name.trim().slice(0, 60);
        break;
      }

      case "remove_team":
        s.teams = s.teams.filter((t) => t.id !== a.teamId);
        break;

      case "relink_team": {
        // Issues a fresh token for an existing team so a wiped device can
        // rejoin without losing its score.
        const fresh = makeToken();
        await this.ctx.storage.put(`token:${fresh}`, a.teamId);
        this.broadcastTo("host", { type: "joined", teamId: a.teamId, teamToken: fresh });
        break;
      }
    }

    await this.persist();
    this.broadcast();
  }

  /* ---------- helpers ---------- */

  private lockQuestion(): void {
    const s = this.session;
    if (!s || s.phase === "locked") return;
    const round = s.quiz.rounds[s.roundIdx];
    const q = round?.questions[s.questionIdx];
    if (round && q && round.answerFormat === "yes_no") {
      // Yes/no grades itself the moment it locks.
      const cap = maxPointsOf(round, q);
      for (const t of s.teams) {
        const k = answerKey(t.id, q.id);
        const a = s.answers[k];
        if (a) a.points = normalise(a.value) === normalise(q.correct) ? cap : 0;
      }
    }
    s.phase = "locked";
  }

  private recordAnswer(teamId: string, questionId: string, value: string): void {
    const s = this.session;
    if (!s || s.phase !== "answering") return;
    const round = s.quiz.rounds[s.roundIdx];
    const q = round?.questions[s.questionIdx];
    if (!round || !q || q.id !== questionId) return;
    // Reject anything that arrives after the clock plus a latency grace.
    if (s.questionStartedAt != null) {
      const deadline = s.questionStartedAt + round.timeLimit * 1000 + LATE_SUBMIT_GRACE_MS;
      if (Date.now() > deadline) return;
    }
    const k = answerKey(teamId, questionId);
    s.answers[k] = { value, submittedAt: Date.now(), points: s.answers[k]?.points ?? null };
  }

  private findQuestion(questionId: string) {
    const s = this.session;
    if (!s) return null;
    for (const round of s.quiz.rounds) {
      const question = round.questions.find((q) => q.id === questionId);
      if (question) return { round, question };
    }
    return null;
  }

  private setConnected(teamId: string, connected: boolean): void {
    const t = this.session?.teams.find((x) => x.id === teamId);
    if (t) {
      t.connected = connected;
      t.lastSeen = Date.now();
    }
  }

  private metaOf(ws: WebSocket): SocketMeta {
    const tags = this.ctx.getTags(ws);
    try {
      return JSON.parse(tags[0] ?? "{}") as SocketMeta;
    } catch {
      return { role: "team" };
    }
  }

  private snapshot(teamId?: string): Snapshot {
    const s = this.session!;
    const you = teamId ? s.teams.find((t) => t.id === teamId) : undefined;
    return {
      session: s,
      standings: computeStandings(s),
      ungradedCount: countUngraded(s),
      serverNow: Date.now(),
      you: you ? { teamId: you.id, name: you.name } : undefined,
    };
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already gone */
    }
  }

  private broadcast(): void {
    if (!this.session) return;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.metaOf(ws);
      this.sendTo(ws, { type: "snapshot", snapshot: this.snapshot(meta.teamId) });
    }
  }

  private broadcastTo(role: ConnectionRole, msg: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.metaOf(ws).role === role) this.sendTo(ws, msg);
    }
  }

  private async persist(): Promise<void> {
    if (this.session) await this.ctx.storage.put("session", this.session);
  }
}
