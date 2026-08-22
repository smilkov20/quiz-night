import type { WebSocket } from "ws";
import {
  ClientMessageSchema, makeToken, LATE_SUBMIT_GRACE_MS, CLOSE_NO_ROOM,
  answerKey, computeStandings, countUngraded, maxPointsOf, normalise, tiedForFirst,
  scoreFastest, scoreSort, scoreOrder, scoreList, scoreMatch, scoreNominee,
  scoreMulti, scoreClues, powerUpAllowed, powerUpSpent, firstLetterHint, redactQuiz,
  type ConnectionRole, type HostAction, type Quiz, type ServerMessage,
  type Session, type Snapshot, type Round, type PowerUp,
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
      teams: [], answers: {}, nomineeAnswers: {},
      wagers: {}, reveals: {}, cluesShown: 0, tiebreakIdx: 0, tiebreakTeams: [], tiebreakAnswers: {},
      winnerTeamId: null, createdAt: Date.now(),
    };
  }

  /** Idempotent: a known token returns the same team, which is how a wiped
      device rejoins without losing its score. */
  /** A nominee attaches to an existing team on their own device, rather than
      creating a team of their own. */
  joinAsNominee(teamId: string, name: string): { teamId: string; teamToken: string } | { error: string } {
    const team = this.session.teams.find((t) => t.id === teamId);
    if (!team) return { error: "No such team" };
    if (team.nomineeName) return { error: `${team.name} already has a nominee` };
    const clean = (name || "").trim().slice(0, 40);
    if (!clean) return { error: "Give your name" };
    team.nomineeName = clean;
    const teamToken = makeToken();
    this.tokens.set(teamToken, teamId);
    this.broadcast();
    return { teamId, teamToken };
  }

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
    const existing = this.session.teams.find((t) => normalise(t.name) === normalise(clean));
    if (existing) {
      if (!existing.awaitingRelink) return { error: "That name is taken — pick another" };
      // The host released it, so this device takes the team over with its score.
      existing.awaitingRelink = false;
      const replacement = makeToken();
      this.tokens.set(replacement, existing.id);
      this.broadcast();
      return { teamId: existing.id, teamToken: replacement };
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

    this.send(conn, { type: "snapshot", snapshot: this.snapshot(teamId, role) });
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
      if (conn.role === "nominee") this.recordNomineeAnswer(conn.teamId, msg.questionId, msg.value);
      else this.recordAnswer(conn.teamId, msg.questionId, msg.value);
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

    if (msg.type === "set_wager") {
      if (!conn.teamId || conn.role === "nominee") return;
      const wRound = this.session.quiz.rounds[this.session.roundIdx];
      const wQ = wRound?.questions[this.session.questionIdx];
      // Only before the question is shown — a stake placed after seeing it
      // isn't a gamble.
      if (!wRound?.wager || !wQ || this.session.phase !== "revealed") return;
      this.session.wagers[answerKey(conn.teamId, wQ.id)] =
        Math.min(msg.amount, wRound.maxWager ?? 5);
      this.broadcast();
      return;
    }

    if (msg.type === "use_powerup") {
      if (!conn.teamId || conn.role === "nominee") return;
      const err = this.usePowerUp(conn.teamId, msg.power, msg.roundIdx, msg.targetTeamId);
      if (err) return this.send(conn, { type: "error", message: err });
      this.broadcast();
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
        s.phase = "revealed"; s.questionStartedAt = null; s.mediaStartedAt = null;
        // The first clue comes free; the rest are the host's to release.
        s.cluesShown = round?.answerFormat === "clues" ? 1 : 0;
        break;
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
      case "reveal_clue": {
        const q = round?.questions[s.questionIdx];
        if (round?.answerFormat === "clues" && q) {
          s.cluesShown = Math.min(s.cluesShown + 1, (q.clues ?? []).length);
        }
        break;
      }
      case "reopen":
        if (!round) break;
        s.phase = "answering"; s.questionStartedAt = Date.now(); this.armLock(round.timeLimit); break;
      case "next_question":
        if (!round) break;
        if (round.rapidFire && s.questionIdx + 1 < round.questions.length && s.phase === "answering") {
          // Same clock, next question — no reveal, no restart.
          s.questionIdx += 1;
          break;
        }
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
          if (!existing) continue;
          if (found.round.wager) {
            // The host's award only decides right or wrong; the stake decides
            // how much.
            const stake = s.wagers[answerKey(teamId, a.questionId)] ?? 0;
            existing.points = points > 0 ? stake : -stake;
          } else {
            existing.points = points;
          }
        }
        break;
      }
      case "rename_team": {
        const t = s.teams.find((x) => x.id === a.teamId);
        if (t) t.name = a.name.trim().slice(0, 60);
        break;
      }
      case "remove_team": {
        s.teams = s.teams.filter((t) => t.id !== a.teamId);
        const mine = (k: string) => k.startsWith(`${a.teamId}:`);
        for (const k of Object.keys(s.answers)) if (mine(k)) delete s.answers[k];
        for (const k of Object.keys(s.nomineeAnswers)) if (mine(k)) delete s.nomineeAnswers[k];
        for (const k of Object.keys(s.wagers)) if (mine(k)) delete s.wagers[k];
        for (const k of Object.keys(s.reveals)) if (mine(k)) delete s.reveals[k];
        s.tiebreakTeams = s.tiebreakTeams.filter((id) => id !== a.teamId);
        delete s.tiebreakAnswers[a.teamId];
        break;
      }
      case "void_question": {
        const found = this.findQuestion(a.questionId);
        if (!found) break;
        for (const t of s.teams) {
          const ans = s.answers[answerKey(t.id, a.questionId)];
          if (ans) ans.points = 0;
          // Returning the stake matters — a bad question shouldn't cost anyone.
          delete s.wagers[answerKey(t.id, a.questionId)];
        }
        break;
      }
      case "relink_team": {
        const relinking = s.teams.find((t) => t.id === a.teamId);
        if (relinking) relinking.awaitingRelink = true;
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
    if (round?.rapidFire) {
      // One clock covered the whole round, so mark all of it.
      const from = s.questionIdx;
      round.questions.forEach((_, i) => { s.questionIdx = i; this.markQuestion(round); });
      s.questionIdx = from;
      s.phase = "locked";
      return;
    }
    this.markQuestion(round);
    s.phase = "locked";
  }

  private markQuestion(round: Round | undefined): void {
    const s = this.session;
    const q = round?.questions[s.questionIdx];
    if (round && q) {
      const cap = maxPointsOf(round, q);

      if (round.answerFormat === "yes_no" || (round.answerFormat === "choice" && !q.multi)) {
        for (const t of s.teams) {
          const a = s.answers[answerKey(t.id, q.id)];
          if (a) a.points = normalise(a.value) === normalise(q.correct) ? cap : 0;
        }
      }

      if (round.answerFormat === "choice" && q.multi) {
        for (const t of s.teams) {
          const a = s.answers[answerKey(t.id, q.id)];
          if (!a) continue;
          const { correct, total } = scoreMulti(a.value, q);
          a.points = total === 0 ? 0 : Math.round((correct / total) * cap);
        }
      }

      if (round.answerFormat === "clues") {
        for (const t of s.teams) {
          const a = s.answers[answerKey(t.id, q.id)];
          if (!a) continue;
          a.points = normalise(a.value) === normalise(q.correct)
            ? scoreClues(a.atClue, cap)
            : 0;
        }
      }

      if (round.answerFormat === "fastest") {
        // Both modes are computable, so the host never has to arbitrate a
        // race in front of a room.
        const entries = s.teams
          .map((t) => ({ teamId: t.id, answer: s.answers[answerKey(t.id, q.id)] }))
          .filter((x) => x.answer)
          .map((x) => ({ teamId: x.teamId, value: x.answer!.value, submittedAt: x.answer!.submittedAt }));
        const { points } = scoreFastest(
          entries, q, cap, round.fastestPoints ?? cap + 1, round.bonusRule ?? "speed"
        );
        for (const [teamId, pts] of Object.entries(points)) {
          const a = s.answers[answerKey(teamId, q.id)];
          if (a) a.points = pts;
        }
      }

      if (round.answerFormat === "nominee") {
        for (const t of s.teams) {
          const guess = s.answers[answerKey(t.id, q.id)];
          if (!guess) continue;
          const said = s.nomineeAnswers[answerKey(t.id, q.id)];
          guess.points = scoreNominee(guess.value, said?.value) ? cap : 0;
        }
      }

      if (round.answerFormat === "list") {
        for (const t of s.teams) {
          const a = s.answers[answerKey(t.id, q.id)];
          if (!a) continue;
          const { correct, total } = scoreList(a.value, q);
          a.points = total === 0 ? 0 : Math.round((correct / total) * cap);
        }
      }

      if (round.answerFormat === "match") {
        for (const t of s.teams) {
          const a = s.answers[answerKey(t.id, q.id)];
          if (!a) continue;
          const { correct, total } = scoreMatch(a.value, q);
          a.points = total === 0 ? 0 : Math.round((correct / total) * cap);
        }
      }

      if (round.answerFormat === "order") {
        for (const t of s.teams) {
          const a = s.answers[answerKey(t.id, q.id)];
          if (!a) continue;
          const { correct, total } = scoreOrder(a.value, q);
          a.points = total === 0 ? 0 : Math.round((correct / total) * cap);
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
      /* A wager replaces the question's own points: stake it, win it or lose
         it. Applied after marking so it works with any self-marked format. */
      if (round.wager) {
        for (const t of s.teams) {
          const a = s.answers[answerKey(t.id, q.id)];
          if (!a || a.points == null) continue;
          const stake = s.wagers[answerKey(t.id, q.id)] ?? 0;
          a.points = a.points > 0 ? stake : -stake;
        }
      }

      const penalty = round.penaltyForWrong ?? 0;
      const selfMarked = ["yes_no", "choice", "fastest"].includes(round.answerFormat);
      if (penalty > 0 && selfMarked && !round.wager) {
        for (const t of s.teams) {
          const a = s.answers[answerKey(t.id, q.id)];
          if (a && a.points === 0) a.points = -penalty;
        }
      }
    }
    s.phase = "locked";
  }

  /** Each power-up is once per game, and only on a round the host opened it
      up for. Returns an error message, or null on success. */
  private usePowerUp(
    teamId: string,
    power: PowerUp,
    roundIdx?: number,
    targetTeamId?: string
  ): string | null {
    const s = this.session;
    const team = s.teams.find((t) => t.id === teamId);
    if (!team) return "No such team";
    if (powerUpSpent(team, power)) return "You've already used that one";

    if (power === "double") {
      // Nominated ahead of the round, like the joker it replaces.
      const idx = roundIdx ?? -1;
      if (idx < 0 || idx >= s.quiz.rounds.length) return "No such round";
      if (!powerUpAllowed(s.quiz.rounds[idx], "double")) return "Not available on that round";
      if (s.state !== "lobby" && idx <= s.roundIdx) return "That round has already started";
      team.jokerRound = idx;
      team.usedPowerUps = { ...team.usedPowerUps, double: { roundIdx: idx, at: Date.now() } };
      return null;
    }

    // steal and hint are spent on the question in front of you.
    const round = s.quiz.rounds[s.roundIdx];
    const q = round?.questions[s.questionIdx];
    if (!round || !q) return "Nothing to use it on";
    if (!powerUpAllowed(round, power)) return "Not available on this round";
    if (s.phase !== "answering") return "Only while the clock is running";

    if (power === "hint") {
      const answer = round.answerFormat === "nominee"
        ? s.nomineeAnswers[answerKey(teamId, q.id)]?.value ?? ""
        : q.correct;
      if (!answer) return "There's no hint to give on this one";
      const k = answerKey(teamId, q.id);
      s.reveals[k] = { ...s.reveals[k], hint: firstLetterHint(answer) };
      team.usedPowerUps = { ...team.usedPowerUps, hint: { roundIdx: s.roundIdx, questionId: q.id, at: Date.now() } };
      return null;
    }

    // steal
    if (!targetTeamId || targetTeamId === teamId) return "Pick another team";
    const target = s.teams.find((t) => t.id === targetTeamId);
    if (!target) return "No such team";
    const theirs = s.answers[answerKey(targetTeamId, q.id)]?.value;
    if (!theirs) return `${target.name} hasn't answered yet`;
    const k = answerKey(teamId, q.id);
    s.reveals[k] = { ...s.reveals[k], steal: { from: target.name, value: theirs } };
    team.usedPowerUps = {
      ...team.usedPowerUps,
      steal: { roundIdx: s.roundIdx, questionId: q.id, targetTeamId, at: Date.now() },
    };
    return null;
  }

  private recordNomineeAnswer(teamId: string, questionId: string, value: string): void {
    const s = this.session;
    if (s.phase !== "answering") return;
    const round = s.quiz.rounds[s.roundIdx];
    const q = round?.questions[s.questionIdx];
    if (!round || !q || q.id !== questionId || round.answerFormat !== "nominee") return;
    s.nomineeAnswers[answerKey(teamId, questionId)] = {
      value, submittedAt: Date.now(), points: null,
    };
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
    // Speed and clue rounds both commit once — otherwise "when you answered"
    // means nothing.
    if ((round.answerFormat === "fastest" || round.answerFormat === "clues") && existing) return;
    s.answers[k] = {
      value, submittedAt: Date.now(), points: existing?.points ?? null,
      ...(round.answerFormat === "clues" ? { atClue: s.cluesShown } : {}),
    };
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

  private snapshot(teamId?: string, role: ConnectionRole = "team"): Snapshot {
    const you = teamId ? this.session.teams.find((t) => t.id === teamId) : undefined;

    /* The whole session goes over the wire, so nominee answers have to be
       stripped per recipient — otherwise a team could read what their own
       nominee said straight out of devtools and the round is pointless.
       The host sees everything; a nominee sees only their own. */
    let nomineeAnswers = this.session.nomineeAnswers;
    if (role === "host") {
      // keep
    } else if (role === "nominee" && teamId) {
      nomineeAnswers = Object.fromEntries(
        Object.entries(nomineeAnswers).filter(([k]) => k.startsWith(`${teamId}:`))
      );
    } else {
      nomineeAnswers = {};
    }

    let reveals = this.session.reveals;
    if (role !== "host" && teamId) {
      reveals = Object.fromEntries(
        Object.entries(reveals).filter(([k]) => k.startsWith(`${teamId}:`))
      );
    } else if (role !== "host") {
      reveals = {};
    }

    /* Teams and the projector must never receive the answer key. The host
       gets the quiz whole, because marking needs it. */
    const quiz = role === "host"
      ? this.session.quiz
      : redactQuiz(this.session.quiz, {
          revealRound: this.session.state === "round_review" ? this.session.reviewRound : null,
          cluesShown: this.session.cluesShown,
          currentRoundIdx: this.session.roundIdx,
          currentQuestionIdx: this.session.questionIdx,
          seed: teamId ?? "presenter",
        });

    return {
      session: { ...this.session, quiz, nomineeAnswers, reveals },
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
      this.send(conn, { type: "snapshot", snapshot: this.snapshot(conn.teamId, conn.role) });
    }
  }

  dispose(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    for (const c of this.conns) c.ws.close();
    this.conns.clear();
  }
}
