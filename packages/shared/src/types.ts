/* Domain model. Quiz is reusable content; Session is one night's run of it.
   Teams and answers belong to the Session, so the same quiz can be run twice
   without mutating the question bank. */

export type AnswerFormat =
  | "yes_no"
  | "text"
  /** Everyone answers the same question; the first correct answer scores more. */
  | "fastest"
  /** Teams file a list of words into categories. */
  | "sort";
export type MediaType = "none" | "audio" | "video" | "image";
export type MediaSource = "none" | "youtube" | "file";

export interface Question {
  id: string;
  order: number;
  prompt: string;
  correct: string;
  /** Extra spellings the grader pre-accepts as a suggestion. */
  accepted: string[];
  /** null falls back to Round.defaultMaxPoints */
  maxPoints: number | null;
  /** fastest: how a correct answer is decided. */
  fastestMode?: "exact" | "closest";
  /** sort: the buckets, and which word belongs in which. */
  categories?: string[];
  items?: { word: string; category: string }[];
  mediaSource: MediaSource;
  /** YouTube URL or id, when mediaSource is "youtube" */
  url?: string;
  /** Uploaded file URL, when mediaSource is "file" */
  mediaUrl?: string;
  clipStart?: number;
  clipEnd?: number;
}

export interface Round {
  id: string;
  order: number;
  title: string;
  answerFormat: AnswerFormat;
  mediaType: MediaType;
  timeLimit: number;
  defaultMaxPoints: number;
  /** fastest rounds: what the first correct answer is worth. Everyone else
      who was right gets defaultMaxPoints. */
  fastestPoints?: number;
  questions: Question[];
}

export interface Tiebreaker {
  id: string;
  order: number;
  prompt: string;
  correct: string;
  /** "closest" can't tie in practice — keep one last. */
  mode: "exact" | "closest";
  timeLimit: number;
}

export interface Quiz {
  id: string;
  title: string;
  rounds: Round[];
  tiebreakers: Tiebreaker[];
  updatedAt: number;
}

export interface Team {
  id: string;
  name: string;
  connected: boolean;
  lastSeen: number;
}

export interface Answer {
  /** For sort rounds this is JSON: { [word]: category }. */
  value: string;
  /** For fastest rounds this is the commit time and never moves, because the
      server refuses to overwrite an existing answer. */
  submittedAt: number;
  /** null means ungraded. Grader awards 0..maxPoints. */
  points: number | null;
}

export type SessionState =
  | "lobby"
  | "in_round"
  | "round_review"
  | "leaderboard"
  | "break"
  | "tiebreaker"
  | "finished";

export type QuestionPhase =
  | "idle"
  | "revealed"
  | "playing_media"
  | "answering"
  | "locked";

export interface Session {
  id: string;
  joinCode: string;
  presenterToken: string;
  quiz: Quiz;
  state: SessionState;
  roundIdx: number;
  questionIdx: number;
  phase: QuestionPhase;
  /** Epoch ms. Clients derive their countdown from this, never a pushed tick. */
  questionStartedAt: number | null;
  mediaStartedAt: number | null;
  reviewRound: number | null;
  /** Epoch ms. Like every other clock here, clients derive the countdown
      rather than being sent ticks. */
  breakEndsAt: number | null;
  breakStartedAt: number | null;
  /** Where to go back to when the break ends. */
  breakReturn: SessionState | null;
  teams: Team[];
  /** keyed `${teamId}:${questionId}` */
  answers: Record<string, Answer>;
  tiebreakIdx: number;
  tiebreakTeams: string[];
  tiebreakAnswers: Record<string, string>;
  winnerTeamId: string | null;
  createdAt: number;
}

export interface Standing {
  teamId: string;
  name: string;
  score: number;
  rank: number;
}

/** What a client receives. Always a complete snapshot, never a diff —
    that is what makes reconnection the same code path as first load. */
export interface Snapshot {
  session: Session;
  standings: Standing[];
  ungradedCount: number;
  /** Lets the client compute its clock offset against the server. */
  serverNow: number;
  /** Present only for team connections: this team's own identity. */
  you?: { teamId: string; name: string };
}

export const maxPointsOf = (round: Round, q: Question): number =>
  q.maxPoints != null ? q.maxPoints : round.defaultMaxPoints;

export const answerKey = (teamId: string, questionId: string): string =>
  `${teamId}:${questionId}`;

/** Normalised for clustering in the grading screen, so "Tungsten",
    "tungsten" and "Tungsten!" collapse into one row to mark. */
export const normalise = (s: string): string =>
  (s || "").toLowerCase().trim().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");

export function computeStandings(session: Session): Standing[] {
  const rows = session.teams.map((t) => {
    let score = 0;
    for (const round of session.quiz.rounds) {
      for (const q of round.questions) {
        const a = session.answers[answerKey(t.id, q.id)];
        if (a && a.points != null) score += a.points;
      }
    }
    return { teamId: t.id, name: t.name, score, rank: 0 };
  });
  rows.sort((a, b) => {
    if (session.winnerTeamId === a.teamId) return -1;
    if (session.winnerTeamId === b.teamId) return 1;
    return b.score - a.score || a.name.localeCompare(b.name);
  });
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

export function countUngraded(session: Session): number {
  let n = 0;
  for (const round of session.quiz.rounds) {
    for (const q of round.questions) {
      for (const t of session.teams) {
        const a = session.answers[answerKey(t.id, q.id)];
        if (a && a.points == null) n++;
      }
    }
  }
  return n;
}

/** Only ever offered on the final standings, and never on a tie at zero. */
export function tiedForFirst(session: Session): Standing[] {
  const standings = computeStandings(session);
  if (standings.length < 2) return [];
  const onLastRound = session.roundIdx === session.quiz.rounds.length - 1;
  if (!onLastRound) return [];
  const top = standings[0].score;
  if (top === 0) return [];
  const tied = standings.filter((s) => s.score === top);
  return tied.length > 1 ? tied : [];
}


/* ---------- fastest ---------- */

/** Distance from the target for a closest-wins answer, or null if the team
    didn't write a number. */
export function numericDistance(value: string, target: string): number | null {
  const a = Number(String(value).replace(/[^\d.-]/g, ""));
  const b = Number(String(target).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b);
}

export interface FastestOutcome {
  /** teamId -> points, ready to write onto the answers. */
  points: Record<string, number>;
  /** Who got in first among the correct answers, if anyone did. */
  winnerTeamId: string | null;
}

/**
 * Exact mode: everyone matching the answer is correct.
 * Closest mode: everyone tied at the smallest distance is correct.
 * Either way the earliest submission among them takes the bonus.
 */
export function scoreFastest(
  entries: { teamId: string; value: string; submittedAt: number }[],
  question: Question,
  correctPoints: number,
  fastestPoints: number
): FastestOutcome {
  const points: Record<string, number> = {};
  for (const e of entries) points[e.teamId] = 0;

  let correct: typeof entries;
  if ((question.fastestMode ?? "exact") === "closest") {
    const scored = entries
      .map((e) => ({ e, d: numericDistance(e.value, question.correct) }))
      .filter((x): x is { e: (typeof entries)[number]; d: number } => x.d !== null);
    if (scored.length === 0) return { points, winnerTeamId: null };
    const best = Math.min(...scored.map((x) => x.d));
    correct = scored.filter((x) => x.d === best).map((x) => x.e);
  } else {
    correct = entries.filter((e) => normalise(e.value) === normalise(question.correct));
  }

  if (correct.length === 0) return { points, winnerTeamId: null };
  const first = correct.reduce((a, b) => (a.submittedAt <= b.submittedAt ? a : b));
  for (const e of correct) points[e.teamId] = correctPoints;
  points[first.teamId] = fastestPoints;
  return { points, winnerTeamId: first.teamId };
}

/* ---------- sort ---------- */

export function parseSortAnswer(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** One point per correctly filed word, scaled to the question's max. */
export function scoreSort(value: string, question: Question): { correct: number; total: number } {
  const items = question.items ?? [];
  const placed = parseSortAnswer(value);
  let correct = 0;
  for (const item of items) {
    if (normalise(placed[item.word] ?? "") === normalise(item.category)) correct++;
  }
  return { correct, total: items.length };
}
