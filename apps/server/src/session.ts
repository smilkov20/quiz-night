import type { WebSocket } from "ws";
import {
  ClientMessageSchema, makeToken, LATE_SUBMIT_GRACE_MS, CLOSE_NO_ROOM,
  answerKey, computeStandings, countUngraded, maxPointsOf, normalise, tiedForFirst,
  scoreFastest, scoreSort,
  type ConnectionRole, type HostAction, type Quiz, type ServerMessage,
  type Session, type Snapshot, type Round,
} from "@quiz/shared";

interface Conn { ws: WebSocket; role: ConnectionRole; teamId?: string }

/**
 * One live quiz, held in memory by the single Node process.
 *
 * Sessions are deliberately not persisted — the design treats them as
 * disposable. Quiz *content* lives in the host's browser, so nothing durable
 * is at stake here and there is no database to provision.
 */
export class LiveSession {
  session: Session;
  private conns = new Set<Conn>();
  private tokens = new Map<string, string>();
  private lockTimer: NodeJS.Timeout | null = null;
  private mediaTimer: NodeJS.Timeout | null = null;

  /** Called when the room closes itself, so the server can drop it from the
      lookup table. */
  onClosed?: () => void;

  constructor(quiz: Quiz, joinCode: string) {
    this.session = {
      id: makeToken(8), joinCode, presenterToken: makeToken(), quiz,
      state: "lobby", roundIdx: 0, questionIdx: 0, phase: "idle",
      questionStartedAt: null, mediaStartedAt: null, reviewRound: null,
      breakEndsAt: null, breakStartedAt: null, breakReturn: null,
      teams: [], answers: {}, tiebreakIdx: 0, tiebreakTeams: [], tiebreakAnswers: {},
      winnerTeamId: null, createdAt: Date.now(),
    };
  }

  /** Idempotent: a known token returns the same team, which is how a wiped
      device rejoins without losing its score. */
  join(name: string, token: string | null): { teamId: string; teamToken: string } | { error: string } {
    if (token) {
      const existing = this.tokens.get(token);
      if (existing && this.session.teams.some((t) => t.id === existing)) {
        return { teamId: existing, teamToken: token };
      }
    }
    if (this.session.state === "finished") return { error: "This quiz has finished" };
    const clean = name.trim().slice(0, 60);
    if (!clean) return { error: "Pick a team name" };
    if (this.session.teams.some((t) => normalise(t.name) === normalise(clean))) {
      return { error: "That name is taken — pick another" };
    }
    const teamId = makeToken(8);
    const teamToken = makeToken();
    this.session.teams.push({ id: teamId, name: clean, connected: false, lastSeen: Date.now() });
    this.tokens.set(teamToken, teamId);
    this.broadcast();
    return { teamId, teamToken };
  }

  addSocket(ws: WebSocket, role: ConnectionRole, teamId?: string): void {
    const conn: Conn = { ws, role, teamId };
    this.conns.add(conn);
    if (teamId) this.setConnected(teamId, true);

    ws.on("message", (raw: unknown) => this.handleMessage(conn, String(raw)));
    ws.on("close", () => {
      this.conns.delete(conn);
      if (teamId) this.setConnected(teamId, false);
      this.broadcast();
    });
    ws.on("error", () => ws.close());

    this.send(conn, { type: "snapshot", snapshot: this.snapshot(teamId) });
    this.broadcast();
  }

  get connectionCount(): number { return this.conns.size; }

  private handleMessage(conn: Conn, raw: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return this.send(conn, { type: "error", message: "Malformed message" }); }

    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) return this.send(conn, { type: "error", message: "Unrecognised message" });
    const msg = result.data;

    if (msg.type === "ping") return;

    if (msg.type === "answer") {
      if (!conn.teamId) return;
      this.recordAnswer(conn.teamId, msg.questionId, msg.value);
      return this.broadcast();
    }
    if (msg.type === "tiebreak_answer") {
      if (!conn.teamId || !this.session.tiebreakTeams.includes(conn.teamId)) return;
      this.session.tiebreakAnswers[conn.teamId] = msg.value;
      return this.broadcast();
    }
    if (msg.type === "media_ended") {
      if (conn.role === "presenter") this.finishMedia();
      return;
    }

    if (msg.type === "host") {
      if (conn.role !== "host") return this.send(conn, { type: "error", message: "Not the host" });
      this.applyHostAction(msg.payload);
    }
  }

  private applyHostAction(a: HostAction): void {
    const s = this.session;
    const round = s.quiz.rounds[s.roundIdx];

    switch (a.action) {
      case "begin_round":
        s.state = "in_round"; s.phase = "idle"; s.reviewRound = null; break;
      case "reveal_question":
        s.phase = "revealed"; s.questionStartedAt = null; s.mediaStartedAt = null; break;
      case "play_media":
      case "replay_media": {
        s.phase = "playing_media"; s.mediaStartedAt = Date.now(); s.questionStartedAt = null;
        this.armMedia(round);
        break;
      }
      case "start_timer":
        if (!round) break;
        s.phase = "answering"; s.questionStartedAt = Date.now(); s.mediaStartedAt = null;
        this.armLock(round.timeLimit); break;
      case "extend":
        if (s.questionStartedAt && round) {
          s.questionStartedAt += a.seconds * 1000;
          this.armLock((s.questionStartedAt + round.timeLimit * 1000 - Date.now()) / 1000);
        }
        break;
      case "lock": this.lockQuestion(); break;
      case "reopen":
        if (!round) break;
        s.phase = "answering"; s.questionStartedAt = Date.now(); this.armLock(round.timeLimit); break;
      case "next_question":
        if (!round) break;
        if (s.questionIdx + 1 < round.questions.length) {
          s.questionIdx += 1; s.phase = "idle";
          s.questionStartedAt = null; s.mediaStartedAt = null;
        } else {
          s.state = "round_review"; s.reviewRound = s.roundIdx;
          s.phase = "idle"; s.questionStartedAt = null;
        }
        break;
      case "next_round":
        if (s.roundIdx + 1 < s.quiz.rounds.length) {
          s.roundIdx += 1; s.questionIdx = 0; s.state = "in_round";
          s.phase = "idle"; s.questionStartedAt = null; s.reviewRound = null;
        } else { s.state = "leaderboard"; s.reviewRound = null; }
        break;
      case "show_review": s.state = "round_review"; s.reviewRound = s.roundIdx; break;
      case "show_leaderboard": s.state = "leaderboard"; break;
      case "start_break":
        /* The break is host-ended, never self-ending: the clock reaching zero
           doesn't mean the marking is done. */
        if (s.state !== "break") s.breakReturn = s.state;
        s.state = "break";
        s.breakStartedAt = Date.now();
        s.breakEndsAt = Date.now() + a.minutes * 60_000;
        break;
      case "extend_break":
        if (s.state === "break") {
          const from = Math.max(s.breakEndsAt ?? Date.now(), Date.now());
          s.breakEndsAt = from + a.minutes * 60_000;
        }
        break;
      case "end_break":
        if (s.state === "break") {
          s.state = s.breakReturn ?? "round_review";
          s.breakReturn = null;
          s.breakEndsAt = null;
          s.breakStartedAt = null;
        }
        break;
      case "finish": s.state = "finished"; break;
      case "close_room":
        // 4004 is the same code a vanished room sends, so every client already
        // knows to forget its stored session and show the join screen.
        for (const c of this.conns) {
          try { c.ws.close(CLOSE_NO_ROOM, "room-closed"); } catch { /* already gone */ }
        }
        this.dispose();
        this.onClosed?.();
        return;
      case "run_tiebreaker": {
        const tied = tiedForFirst(s);
        if (tied.length < 2) break;
        s.state = "tiebreaker"; s.tiebreakIdx = 0;
        s.tiebreakTeams = tied.map((t) => t.teamId); s.tiebreakAnswers = {};
        break;
      }
      case "next_tiebreaker":
        if (s.tiebreakIdx + 1 < s.quiz.tiebreakers.length) {
          s.tiebreakIdx += 1;
          s.tiebreakAnswers = {};
        }
        break;
      case "resolve_tiebreak": s.winnerTeamId = a.teamId; s.state = "finished"; break;
      case "grade": {
        const found = this.findQuestion(a.questionId);
        if (!found) break;
        const points = Math.min(a.points, maxPointsOf(found.round, found.question));
        for (const teamId of a.teamIds) {
          const existing = s.answers[answerKey(teamId, a.questionId)];
          if (existing) existing.points = points;
        }
        break;
      }
      case "rename_team": {
        const t = s.teams.find((x) => x.id === a.teamId);
        if (t) t.name = a.name.trim().slice(0, 60);
        break;
      }
      case "remove_team": s.teams = s.teams.filter((t) => t.id !== a.teamId); break;
      case "relink_team": {
        const fresh = makeToken();
        this.tokens.set(fresh, a.teamId);
        for (const c of this.conns) {
          if (c.role === "host") this.send(c, { type: "joined", teamId: a.teamId, teamToken: fresh });
        }
        break;
      }
    }
    this.broadcast();
  }

  /** Clip length is known from the question, so the server can advance to the
      answer phase itself. The presenter may report an earlier real finish via
      mediaEnded(), but nothing depends on that message arriving. */
  private armMedia(round: Round | undefined): void {
    if (this.mediaTimer) clearTimeout(this.mediaTimer);
    const q = round?.questions[this.session.questionIdx];
    if (!round || !q) return;
    const seconds = Math.max(1, (q.clipEnd ?? 0) - (q.clipStart ?? 0));
    this.mediaTimer = setTimeout(() => this.finishMedia(), seconds * 1000 + 400);
  }

  /** Called by the alarm above, or early by the presenter when the real clip
      ends sooner than its configured range. */
  finishMedia(): void {
    const s = this.session;
    if (s.phase !== "playing_media") return;
    if (this.mediaTimer) { clearTimeout(this.mediaTimer); this.mediaTimer = null; }
    const round = s.quiz.rounds[s.roundIdx];
    if (!round) return;
    s.phase = "answering";
    s.questionStartedAt = Date.now();
    s.mediaStartedAt = null;
    this.armLock(round.timeLimit);
    this.broadcast();
  }

  /** Plain setTimeout is fine here — no hibernation to protect, unlike the
      Durable Object version this was ported from. */
  private armLock(seconds: number): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => {
      if (this.session.phase === "answering") { this.lockQuestion(); this.broadcast(); }
    }, Math.max(0, seconds * 1000) + LATE_SUBMIT_GRACE_MS);
  }

  private lockQuestion(): void {
    const s = this.session;
    if (s.phase === "locked") return;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    if (this.mediaTimer) { clearTimeout(this.mediaTimer); this.mediaTimer = null; }
    const round = s.quiz.rounds[s.roundIdx];
    const q = round?.questions[s.questionIdx];
    if (round && q) {
      const cap = maxPointsOf(round, q);

      if (round.answerFormat === "yes_no") {
        for (const t of s.teams) {
          const a = s.answers[answerKey(t.id, q.id)];
          if (a) a.points = normalise(a.value) === normalise(q.correct) ? cap : 0;
        }
      }

      if (round.answerFormat === "fastest") {
        // Both modes are computable, so the host never has to arbitrate a
        // race in front of a room.
        const entries = s.teams
          .map((t) => ({ teamId: t.id, answer: s.answers[answerKey(t.id, q.id)] }))
          .filter((x) => x.answer)
          .map((x) => ({ teamId: x.teamId, value: x.answer!.value, submittedAt: x.answer!.submittedAt }));
        const { points } = scoreFastest(entries, q, cap, round.fastestPoints ?? cap + 1);
        for (const [teamId, pts] of Object.entries(points)) {
          const a = s.answers[answerKey(teamId, q.id)];
          if (a) a.points = pts;
        }
      }

      if (round.answerFormat === "sort") {
        // One point per correctly filed word, scaled to the question's max.
        for (const t of s.teams) {
          const a = s.answers[answerKey(t.id, q.id)];
          if (!a) continue;
          const { correct, total } = scoreSort(a.value, q);
          a.points = total === 0 ? 0 : Math.round((correct / total) * cap);
        }
      }
    }
    s.phase = "locked";
  }

  private recordAnswer(teamId: string, questionId: string, value: string): void {
    const s = this.session;
    if (s.phase !== "answering") return;
    const round = s.quiz.rounds[s.roundIdx];
    const q = round?.questions[s.questionIdx];
    if (!round || !q || q.id !== questionId) return;
    if (s.questionStartedAt != null) {
      const deadline = s.questionStartedAt + round.timeLimit * 1000 + LATE_SUBMIT_GRACE_MS;
      if (Date.now() > deadline) return;
    }
    const k = answerKey(teamId, questionId);
    const existing = s.answers[k];
    if (round.answerFormat === "fastest" && existing) return;
    s.answers[k] = { value, submittedAt: Date.now(), points: existing?.points ?? null };
  }

  private findQuestion(questionId: string) {
    for (const round of this.session.quiz.rounds) {
      const question = round.questions.find((q) => q.id === questionId);
      if (question) return { round, question };
    }
    return null;
  }

  private setConnected(teamId: string, connected: boolean): void {
    const t = this.session.teams.find((x) => x.id === teamId);
    if (t) { t.connected = connected; t.lastSeen = Date.now(); }
  }

  private snapshot(teamId?: string): Snapshot {
    const you = teamId ? this.session.teams.find((t) => t.id === teamId) : undefined;
    return {
      session: this.session,
      standings: computeStandings(this.session),
      ungradedCount: countUngraded(this.session),
      serverNow: Date.now(),
      you: you ? { teamId: you.id, name: you.name } : undefined,
    };
  }

  private send(conn: Conn, msg: ServerMessage): void {
    try { if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg)); } catch { /* gone */ }
  }

  private broadcast(): void {
    for (const conn of this.conns) {
      this.send(conn, { type: "snapshot", snapshot: this.snapshot(conn.teamId) });
    }
  }

  dispose(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    for (const c of this.conns) c.ws.close();
    this.conns.clear();
  }
}
