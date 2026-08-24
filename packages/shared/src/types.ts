/* Domain model. Quiz is reusable content; Session is one night's run of it.
   Teams and answers belong to the Session, so the same quiz can be run twice
   without mutating the question bank. */

export type AnswerFormat =
  | "yes_no"
  | "text"
  /** Everyone answers the same question; the first correct answer scores more. */
  | "fastest"
  /** Teams file a list of words into categories. */
  | "sort"
  /** Teams put items into a sequence: first, second, third. */
  | "order"
  /** Multiple choice: A, B, C, D. */
  | "choice"
  /** "Name 7 of the 13…" — several answers from a known pool. */
  | "list"
  /** One-to-one pairing: author to book, capital to country. */
  | "match"
  /** One team member answers on their own phone; the rest guess what they
      said. The nominee is the answer key, so there is no "correct" answer. */
  | "nominee"
  /** Clues revealed one at a time; the longer you wait, the less it's worth. */
  | "clues";
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
  /** order: the items in their correct sequence. Never shown in this order. */
  sequence?: string[];
  /** choice: the options, shown as A/B/C/D in this order for everyone. */
  options?: string[];
  /** choice: more than one right answer. `correctOptions` replaces `correct`. */
  multi?: boolean;
  correctOptions?: string[];
  /** clues: revealed in order, on the host's cue. */
  clues?: string[];
  /** list: the full pool of acceptable answers, and how many to name. */
  listAnswers?: string[];
  requiredCount?: number;
  /** match: the correct pairings. Right-hand items are shuffled for teams. */
  pairs?: { left: string; right: string }[];
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
  /** fastest rounds: the higher award. Who receives it depends on bonusRule. */
  fastestPoints?: number;
  /** fastest rounds: what earns the higher award.
      "speed"    — everyone right gets defaultMaxPoints, the first of them
                   gets fastestPoints instead.
      "accuracy" — everyone with the best answer gets fastestPoints, however
                   long they took. */
  bonusRule?: "speed" | "accuracy";
  /** Wipeout rounds: what a wrong answer costs. Only applied to formats the
      server marks itself, so nobody loses points to a marking judgement. */
  penaltyForWrong?: number;
  /** One clock for the whole round instead of one per question. */
  rapidFire?: boolean;
  /** Play the clip with the sound off — for a video round where the picture
      alone is the question, or where the soundtrack would give it away. */
  muteMedia?: boolean;
  /** Show teams and the room how this round works before it starts. */
  explainRound?: boolean;
  /** Optional extra wording; the rest is generated from the round's settings
      so it can't drift out of date when you change them. */
  howItWorks?: string;
  /** Teams stake points before the question is shown. */
  wager?: boolean;
  maxWager?: number;
  /** Which power-ups teams may spend on this round. Empty or absent means
      none — the host opts each round in. */
  allowedPowerUps?: PowerUp[];
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

/** A free-standing page the host can put on the screen at any point —
    house rules, a sponsor, "back in ten". */
export interface InfoSlide {
  id: string;
  title: string;
  body: string;
  imageUrl?: string;
}

/** Branding for the projector, like a slide master. Everything is optional
    and falls back to the built-in palette. */
export interface QuizTheme {
  logoUrl?: string;
  /** Bottom-corner line on the projector — pub name, hashtag, sponsor. */
  footer?: string;
  page?: string;
  card?: string;
  ink?: string;
  accent?: string;
  highlight?: string;
}

export interface Quiz {
  id: string;
  title: string;
  infoSlides?: InfoSlide[];
  theme?: QuizTheme;
  rounds: Round[];
  tiebreakers: Tiebreaker[];
  updatedAt: number;
}

export interface Team {
  id: string;
  name: string;
  connected: boolean;
  lastSeen: number;
  /** Index of the round this team doubled, if they've spent that power-up. */
  jokerRound?: number | null;
  /** Each power-up is once per game. Records where it was spent. */
  usedPowerUps?: Partial<Record<PowerUp, PowerUpUse>>;
  /** Set once someone joins as this team's nominee, on their own device. */
  nomineeName?: string | null;
  /** Host has released the name so a replacement device can claim it — for
      when a phone dies mid-quiz. */
  awaitingRelink?: boolean;
}

export type PowerUp = "double" | "steal" | "hint";

export interface PowerUpUse {
  roundIdx: number;
  questionId?: string;
  /** steal: whose answer was taken. */
  targetTeamId?: string;
  at: number;
}

export const POWER_UP_LABELS: Record<PowerUp, { name: string; blurb: string }> = {
  double: { name: "Double", blurb: "One round counts twice" },
  steal: { name: "Steal", blurb: "See another team's answer" },
  hint: { name: "Hint", blurb: "Reveal the first letter" },
};

export interface Answer {
  /** For sort rounds this is JSON: { [word]: category }. */
  value: string;
  /** For fastest rounds this is the commit time and never moves, because the
      server refuses to overwrite an existing answer. */
  submittedAt: number;
  /** clues rounds: how many clues were showing when this was committed. */
  atClue?: number;
  /** null means ungraded. Grader awards 0..maxPoints. */
  points: number | null;
}

export type SessionState =
  | "lobby"
  | "in_round"
  | "round_review"
  | "leaderboard"
  | "break"
  | "info"
  | "tiebreaker"
  | "finished";

export type QuestionPhase =
  | "idle"
  | "revealed"
  | "playing_media"
  | "answering"
  | "locked";

/** How answers reach the scoreboard.
    "devices" — teams answer on their own phones, as elsewhere in this app.
    "paper"   — no team devices at all: the projector runs the quiz, teams
                write on paper, and the host types the points in. */
export type ScoringMode = "devices" | "paper";

export interface Session {
  id: string;
  scoring: ScoringMode;
  /** paper mode only, keyed `${teamId}:${roundIdx}`. */
  manualScores: Record<string, number>;
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
  /** Where a break or an info slide should hand back to. */
  breakReturn: SessionState | null;
  /** Which info slide is on screen, when state is "info". */
  infoSlideId: string | null;
  teams: Team[];
  /** keyed `${teamId}:${questionId}` */
  answers: Record<string, Answer>;
  /** Nominee rounds: what the nominee actually said, same key. Kept apart from
      `answers` so a team's own device can never be sent it. */
  nomineeAnswers: Record<string, Answer>;
  /** Wager rounds: what each team staked, keyed `${teamId}:${questionId}`. */
  wagers: Record<string, number>;
  /** What a spent power-up revealed, keyed `${teamId}:${questionId}`. Private
      to that team, so it's redacted from everyone else's snapshot. */
  reveals: Record<string, { hint?: string; steal?: { from: string; value: string } }>;
  /** clues rounds: how many clues are showing for the current question. */
  cluesShown: number;
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
  const paper = session.scoring === "paper";
  const rows = session.teams.map((t) => {
    let score = 0;
    session.quiz.rounds.forEach((round, roundIdx) => {
      let roundScore = paper
        ? session.manualScores[`${t.id}:${roundIdx}`] ?? 0
        : round.questions.reduce((n, q) => {
            const a = session.answers[answerKey(t.id, q.id)];
            return n + (a && a.points != null ? a.points : 0);
          }, 0);
      // The joker doubles a whole round, which is the point of nominating one.
      if (t.jokerRound === roundIdx) roundScore *= 2;
      score += roundScore;
    });
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
  if (session.scoring === "paper") return 0;
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
  fastestPoints: number,
  rule: "speed" | "accuracy" = "speed"
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

  if (rule === "accuracy") {
    // Being closest is the achievement; two teams tied on 88 both take it.
    for (const e of correct) points[e.teamId] = fastestPoints;
    return { points, winnerTeamId: null };
  }

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


/* ---------- order ---------- */

export function parseOrderAnswer(value: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** One point per item in its correct position. Partial credit matters here:
    getting three of five right should beat getting none. */
export function scoreOrder(value: string, question: Question): { correct: number; total: number } {
  const truth = question.sequence ?? [];
  const chosen = parseOrderAnswer(value);
  let correct = 0;
  truth.forEach((item, i) => {
    if (normalise(chosen[i] ?? "") === normalise(item)) correct++;
  });
  return { correct, total: truth.length };
}

/** Deterministic shuffle. The presented order must not be the answer, but it
    also must not change when a team reconnects mid-question — so it's seeded
    from the team and question rather than being random. */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rand = () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return Math.abs(h) / 2147483647;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}


/* ---------- list ---------- */

export function parseListAnswer(value: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** One point per distinct correct name, capped at how many were asked for.
    Duplicates don't pay twice. */
export function scoreList(value: string, question: Question): { correct: number; total: number } {
  const pool = (question.listAnswers ?? []).map(normalise);
  const asked = question.requiredCount ?? pool.length;
  const seen = new Set<string>();
  let correct = 0;
  for (const entry of parseListAnswer(value)) {
    const n = normalise(entry);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (pool.includes(n)) correct++;
  }
  return { correct: Math.min(correct, asked), total: asked };
}

/* ---------- match ---------- */

export function parseMatchAnswer(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function scoreMatch(value: string, question: Question): { correct: number; total: number } {
  const pairs = question.pairs ?? [];
  const chosen = parseMatchAnswer(value);
  let correct = 0;
  for (const p of pairs) {
    if (normalise(chosen[p.left] ?? "") === normalise(p.right)) correct++;
  }
  return { correct, total: pairs.length };
}


/* ---------- nominee ---------- */

/** Renders "{nominee}" in a prompt as that team's nominee. Each team sees
    their own name, which is the whole charm of the round. */
export function withNominee(prompt: string, nomineeName?: string | null): string {
  return prompt.replace(/\{nominee\}/gi, nomineeName || "your nominee");
}

/** The guess scores if it matches what the nominee said. No answer key is
    authored — the nominee supplies it live. */
export function scoreNominee(guess: string | undefined, nominee: string | undefined): boolean {
  if (!guess || !nominee) return false;
  return normalise(guess) === normalise(nominee);
}


/* ---------- multi-select ---------- */

/** Right ticks earn, wrong ticks cost, and you can't go below zero on a
    single question — otherwise guessing everything would be a strategy. */
export function scoreMulti(value: string, question: Question): { correct: number; total: number } {
  const right = (question.correctOptions ?? []).map(normalise);
  const picked = parseListAnswer(value).map(normalise);
  let net = 0;
  for (const p of new Set(picked)) net += right.includes(p) ? 1 : -1;
  return { correct: Math.max(0, net), total: right.length };
}

/* ---------- progressive clues ---------- */

/** Answer after the first clue and it's worth full marks; every further clue
    knocks one off, never below one. */
export function scoreClues(atClue: number | undefined, maxPoints: number): number {
  const used = Math.max(1, atClue ?? 1);
  return Math.max(1, maxPoints - (used - 1));
}

/* ---------- power-ups ---------- */

export function powerUpAllowed(round: Round | undefined, power: PowerUp): boolean {
  return Boolean(round?.allowedPowerUps?.includes(power));
}

export function powerUpSpent(team: Team | undefined, power: PowerUp): boolean {
  return Boolean(team?.usedPowerUps?.[power]);
}

/** First letter, plus the shape of the answer — enough to unstick a team
    without handing it to them. */
export function firstLetterHint(answer: string): string {
  const trimmed = (answer || "").trim();
  if (!trimmed) return "";
  return `Starts with "${trimmed[0].toUpperCase()}" · ${trimmed.length} characters`;
}

/* ---------- redaction ----------
   The whole session goes over the wire, so the quiz itself has to be
   censored per recipient. Without this, any team could read every answer
   out of the WebSocket frames in devtools. */

function shuffleRights(pairs: { left: string; right: string }[], seed: string) {
  const shuffled = seededShuffle(pairs.map((p) => p.right), seed);
  return pairs.map((p, i) => ({ left: p.left, right: shuffled[i] }));
}

export interface RedactOptions {
  /** Answers for this round are being shown, so they may be included. */
  revealRound: number | null;
  /** How many clues are visible on the current question. */
  cluesShown: number;
  currentRoundIdx: number;
  currentQuestionIdx: number;
  /** Stable seed so shuffles don't churn between snapshots. */
  seed: string;
}

export function redactQuiz(quiz: Quiz, o: RedactOptions): Quiz {
  return {
    ...quiz,
    // The host reads tiebreaker answers out; nobody else needs them.
    tiebreakers: quiz.tiebreakers.map((t) => ({ ...t, correct: "" })),
    rounds: quiz.rounds.map((round, ri) => {
      if (ri === o.revealRound) return round; // the reveal is the point
      return {
        ...round,
        questions: round.questions.map((q, qi) => {
          const isCurrent = ri === o.currentRoundIdx && qi === o.currentQuestionIdx;
          const out: Question = {
            ...q,
            correct: "",
            accepted: [],
            listAnswers: undefined,
            // Keep the count — teams must know they're looking for three —
            // but blank the values, which are the actual answer.
            correctOptions: q.correctOptions ? q.correctOptions.map(() => "") : undefined,
          };
          // Which word belongs where is the answer.
          if (q.items) out.items = q.items.map((i) => ({ word: i.word, category: "" }));
          // Send a scrambled order; the true one stays on the server.
          if (q.sequence) out.sequence = seededShuffle(q.sequence, `${o.seed}:${q.id}`);
          // Same for pairings — the left labels are safe, the mapping isn't.
          if (q.pairs) out.pairs = shuffleRights(q.pairs, `${o.seed}:${q.id}`);
          // Only clues actually on screen.
          if (q.clues) out.clues = isCurrent ? q.clues.slice(0, o.cluesShown) : [];
          return out;
        }),
      };
    }),
  };
}

/** A human-readable answer for the round review. Several formats keep their
    answer somewhere other than `correct`, and the review was rendering blank
    for all of them. */
export function describeAnswer(round: Round, q: Question): string {
  switch (round.answerFormat) {
    case "choice":
      return q.multi ? (q.correctOptions ?? []).join(", ") : q.correct;
    case "list": {
      const pool = q.listAnswers ?? [];
      const asked = q.requiredCount ?? pool.length;
      return asked < pool.length
        ? `any ${asked} of: ${pool.join(", ")}`
        : pool.join(", ");
    }
    case "sort":
      return (q.categories ?? [])
        .map((c) => `${c}: ${(q.items ?? []).filter((i) => i.category === c).map((i) => i.word).join(", ")}`)
        .join(" · ");
    case "order":
      return (q.sequence ?? []).join(" → ");
    case "match":
      return (q.pairs ?? []).map((p) => `${p.left} → ${p.right}`).join(" · ");
    case "nominee":
      return "different for every team — ask your nominee";
    default:
      return q.correct;
  }
}


/* ---------- theming ---------- */

export const DEFAULT_THEME = {
  page: "#ECEEE6",
  card: "#FFFFFF",
  ink: "#15234F",
  accent: "#2A47C4",
  highlight: "#F5E45C",
} as const;

export interface ResolvedTheme {
  page: string; card: string; ink: string; accent: string; highlight: string;
  logoUrl?: string; footer?: string;
}

export function resolveTheme(t?: QuizTheme): ResolvedTheme {
  return {
    page: t?.page || DEFAULT_THEME.page,
    card: t?.card || DEFAULT_THEME.card,
    ink: t?.ink || DEFAULT_THEME.ink,
    accent: t?.accent || DEFAULT_THEME.accent,
    highlight: t?.highlight || DEFAULT_THEME.highlight,
    logoUrl: t?.logoUrl,
    footer: t?.footer,
  };
}

/* ---------- "how this round works" ---------- */

/** Generated from the round's own settings rather than typed by hand, so it
    can't tell the room something that stopped being true three edits ago. */
export function describeRound(round: Round): string[] {
  const lines: string[] = [];
  const pts = round.defaultMaxPoints;

  switch (round.answerFormat) {
    case "yes_no": lines.push("Answer yes or no."); break;
    case "text": lines.push("Write your answer. Spelling doesn't have to be perfect."); break;
    case "choice": lines.push("Multiple choice — tap your answer."); break;
    case "fastest":
      lines.push(round.bonusRule === "accuracy"
        ? "Everyone with the best answer scores the most. Speed doesn't matter."
        : "The first correct answer scores the most, so don't hang about.");
      lines.push("You get one go — no changing your mind.");
      break;
    case "sort": lines.push("Tap a word to pick it up, then tap the group it belongs to."); break;
    case "order": lines.push("Tap the items in order. First tap is number one."); break;
    case "list": lines.push("Name as many as you can. Any order, one point each."); break;
    case "match": lines.push("Pick an answer, then tap the row it pairs with."); break;
    case "nominee": lines.push("Your nominee answers on their own phone. Guess what they said."); break;
    case "clues": lines.push("Clues come one at a time. The longer you wait, the less it's worth."); break;
  }

  if (round.mediaType === "audio") lines.push("Listen to the clip — the clock starts when it ends.");
  if (round.mediaType === "video") {
    lines.push(round.muteMedia
      ? "Watch the screen — no sound on this one. The clock starts when the clip ends."
      : "Watch the screen — the clock starts when the clip ends.");
  }
  if (round.mediaType === "image") lines.push("The picture is on your phone as well as the big screen.");

  if (round.answerFormat === "fastest") {
    lines.push(`${pts} point${pts === 1 ? "" : "s"} for a correct answer, ${round.fastestPoints ?? pts + 1} for the best.`);
  } else if (round.answerFormat !== "clues") {
    lines.push(`${pts} point${pts === 1 ? "" : "s"} per question.`);
  } else {
    lines.push(`Up to ${pts} points, dropping by one per clue.`);
  }

  if (round.wager) lines.push(`Stake up to ${round.maxWager ?? 5} points before you see the question. Win it or lose it.`);
  if (round.penaltyForWrong) lines.push(`Careful — a wrong answer costs you ${round.penaltyForWrong}.`);
  if (round.rapidFire) lines.push(`One clock for the whole round: ${round.timeLimit} seconds for the lot.`);
  else lines.push(`${round.timeLimit} seconds per question.`);

  const powers = round.allowedPowerUps ?? [];
  if (powers.length) {
    lines.push(`Power-ups you can spend here: ${powers.map((p) => POWER_UP_LABELS[p].name).join(", ")}.`);
  }

  if (round.howItWorks?.trim()) lines.push(round.howItWorks.trim());
  return lines;
}
