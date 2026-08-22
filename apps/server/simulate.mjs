/* Plays the demo quiz end to end with a host, a presenter, four teams and a
   nominee, checking at every step that all three surfaces agree. */
import WebSocket from "ws";
import { readFileSync } from "node:fs";

const PORT = process.env.PORT ?? "8899";
const API = `http://127.0.0.1:${PORT}`;
const KEY = process.env.HOST_PASSWORD ?? "test-password";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b, a) => {
  const r = await fetch(API + p, { method: "POST",
    headers: { "Content-Type": "application/json", ...(a ? { Authorization: `Bearer ${a}` } : {}) },
    body: JSON.stringify(b) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const open = (u) => new Promise((res, rej) => {
  const w = new WebSocket(u);
  w.snaps = []; w.errors = [];
  w.on("message", (m) => { const p = JSON.parse(m);
    if (p.type === "snapshot") w.snaps.push(p.snapshot);
    if (p.type === "error") w.errors.push(p.message); });
  w.on("open", () => res(w)); w.on("error", rej);
});
const S = (w) => w.snaps[w.snaps.length - 1];

const problems = [];
const note = (m) => { problems.push(m); console.log("  !! " + m); };

const quiz = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sess = await post("/api/sessions", { quiz }, KEY);
const host = await open(`ws://127.0.0.1:${PORT}/ws?code=${sess.joinCode}&role=host&key=${KEY}`);
const pres = await open(`ws://127.0.0.1:${PORT}/ws?code=${sess.joinCode}&role=presenter&token=${sess.presenterToken}`);
const act = (payload) => host.send(JSON.stringify({ type: "host", payload }));

const NAMES = ["Quizteama Aguilera", "The Quizzard of Oz", "Agatha Quiztie", "Norfolk Enchants"];
const teams = [];
for (const n of NAMES) {
  const t = await post("/api/join", { code: sess.joinCode, name: n });
  teams.push({ ...t, name: n,
    ws: await open(`ws://127.0.0.1:${PORT}/ws?code=${sess.joinCode}&role=team&teamId=${t.teamId}`) });
}
const nomFor = teams[0];
await post("/api/join", { code: sess.joinCode, name: "Sam", asNomineeFor: nomFor.teamId });
const nomWs = await open(`ws://127.0.0.1:${PORT}/ws?code=${sess.joinCode}&role=nominee&teamId=${nomFor.teamId}`);
await wait(200);
console.log(`Room ${sess.joinCode} — ${teams.length} teams, 1 nominee, presenter connected\n`);

/* Every surface must be looking at the same thing. */
function checkLockstep(label) {
  const h = S(host).session, p = S(pres).session;
  const key = (x) => `${x.state}/${x.roundIdx}/${x.questionIdx}/${x.phase}`;
  if (key(h) !== key(p)) note(`${label}: presenter out of step (host ${key(h)}, presenter ${key(p)})`);
  for (const t of teams) {
    const ts = S(t.ws).session;
    if (key(ts) !== key(h)) note(`${label}: ${t.name} out of step (${key(ts)} vs ${key(h)})`);
  }
}

/* Answers generated from the host's copy, which is the only one with truth. */
function answerFor(round, q, i) {
  const right = i % 4 !== 3;          // one team gets it wrong each time
  const f = round.answerFormat;
  if (f === "yes_no") return right ? q.correct : (q.correct === "Yes" ? "No" : "Yes");
  if (f === "choice" && q.multi) {
    const set = q.correctOptions ?? [];
    return JSON.stringify(right ? set : [...set.slice(1), ...(q.options ?? []).filter((o) => !set.includes(o)).slice(0, 1)]);
  }
  if (f === "choice") return right ? q.correct : (q.options ?? []).find((o) => o !== q.correct) ?? "";
  if (f === "sort") return JSON.stringify(Object.fromEntries((q.items ?? []).map((it, n) =>
    [it.word, right || n === 0 ? it.category : (q.categories ?? [])[0]])));
  if (f === "order") return JSON.stringify(right ? q.sequence : [...(q.sequence ?? [])].reverse());
  if (f === "list") return JSON.stringify((q.listAnswers ?? []).slice(0, right ? q.requiredCount : 1));
  if (f === "match") return JSON.stringify(Object.fromEntries((q.pairs ?? []).map((p, n) =>
    [p.left, right || n === 0 ? p.right : (q.pairs ?? [])[0].right])));
  if (f === "nominee") return right ? "Guinness" : "Wine";
  return right ? q.correct : "definitely not it";
}

let answered = 0, formatsSeen = new Set(), roundsPlayed = 0;
const spent = { hint: false, steal: false, double: false };

for (let ri = 0; ri < quiz.rounds.length; ri++) {
  const round = S(host).session.quiz.rounds[ri];
  act({ action: "begin_round" }); await wait(70);
  checkLockstep(`round ${ri + 1} start`);
  formatsSeen.add(round.answerFormat);
  roundsPlayed++;

  for (let qi = 0; qi < round.questions.length; qi++) {
    const q = S(host).session.quiz.rounds[ri].questions[qi];
    act({ action: "reveal_question" }); await wait(70);

    // Wager rounds take stakes before the question is shown.
    if (round.wager) {
      teams.forEach((t, i) => t.ws.send(JSON.stringify({ type: "set_wager", amount: i + 1 })));
      await wait(90);
      const staked = Object.keys(S(host).session.wagers).filter((k) => k.endsWith(`:${q.id}`)).length;
      if (staked !== teams.length) note(`round ${ri + 1} q${qi + 1}: only ${staked}/${teams.length} stakes registered`);
    }

    act({ action: "start_timer" }); await wait(70);
    checkLockstep(`round ${ri + 1} q${qi + 1} answering`);

    // What the projector needs in order to render this question.
    const pq = S(pres).session.quiz.rounds[ri].questions[qi];
    if (!pq.prompt) note(`round ${ri + 1} q${qi + 1}: presenter has no prompt`);
    if (round.answerFormat === "choice" && (pq.options ?? []).length === 0)
      note(`round ${ri + 1} q${qi + 1}: presenter has no options to show`);
    if (round.answerFormat === "clues" && (pq.clues ?? []).length !== S(host).session.cluesShown)
      note(`round ${ri + 1} q${qi + 1}: presenter clue count ${pq.clues?.length} != shown ${S(host).session.cluesShown}`);

    if (round.answerFormat === "nominee") {
      nomWs.send(JSON.stringify({ type: "answer", questionId: q.id, value: "Guinness" }));
      await wait(90);
    }

    if (round.answerFormat === "clues") {
      // First team answers immediately, others after more clues.
      teams[0].ws.send(JSON.stringify({ type: "answer", questionId: q.id, value: q.correct }));
      await wait(70);
      act({ action: "reveal_clue" }); await wait(70);
      act({ action: "reveal_clue" }); await wait(70);
      teams.slice(1).forEach((t, i) => t.ws.send(JSON.stringify({
        type: "answer", questionId: q.id, value: answerFor(round, q, i + 1) })));
      await wait(90);
    } else {
      for (let i = 0; i < teams.length; i++) {
        teams[i].ws.send(JSON.stringify({ type: "answer", questionId: q.id, value: answerFor(round, q, i) }));
        if (round.answerFormat === "fastest") await wait(60);   // stagger the race
      }
      await wait(110);
    }
    answered += teams.length;

    // Each power-up once per game, on the first round that offers it.
    const allowed = round.allowedPowerUps ?? [];
    if (allowed.includes("hint") && !spent.hint) {
      spent.hint = true;
      teams[3].ws.send(JSON.stringify({ type: "use_powerup", power: "hint" })); await wait(90);
      const rev = S(teams[3].ws).session.reveals[`${teams[3].teamId}:${q.id}`];
      if (!rev?.hint) note(`round ${ri + 1}: hint was spent but nothing came back`);
      if (Object.keys(S(teams[0].ws).session.reveals).length) note("a hint leaked to another team");
    }
    const target = teams.find((t) => t.teamId !== teams[3].teamId && (S(host).session.answers[`${t.teamId}:${q.id}`]?.value ?? "") !== "");
    if (allowed.includes("steal") && !spent.steal && target) {
      spent.steal = true;
      teams[3].ws.send(JSON.stringify({ type: "use_powerup", power: "steal", targetTeamId: target.teamId })); await wait(90);
      const rev = S(teams[3].ws).session.reveals[`${teams[3].teamId}:${q.id}`];
      if (!rev?.steal) note(`round ${ri + 1}: steal was spent but revealed nothing`);
    }
    const futureDouble = quiz.rounds.findIndex((r, n) => n > ri && (r.allowedPowerUps ?? []).includes("double"));
    if (!spent.double && futureDouble > -1) {
      spent.double = true;
      teams[2].ws.send(JSON.stringify({ type: "use_powerup", power: "double", roundIdx: futureDouble }));
      await wait(90);
      if (S(host).session.teams.find((t) => t.id === teams[2].teamId)?.jokerRound !== futureDouble)
        note(`round ${ri + 1}: double was refused on round ${futureDouble + 1}, which allows it`);
    }

    // The projector should never be holding anybody's answers.
    if (Object.keys(S(pres).session.reveals ?? {}).length)
      note(`round ${ri + 1}: presenter is receiving power-up reveals`);

    act({ action: "lock" }); await wait(110);
    if (round.rapidFire && qi < round.questions.length - 1) { act({ action: "reveal_question" }); await wait(50); }
    act({ action: "next_question" }); await wait(80);
    if (round.rapidFire) break;   // one clock covered the lot
  }

  // Mark anything the server couldn't.
  const ungraded = S(host).snapshot?.ungradedCount ?? S(host).ungradedCount;
  if (ungraded > 0) {
    for (const q of S(host).session.quiz.rounds[ri].questions) {
      for (const t of teams) {
        const a = S(host).session.answers[`${t.teamId}:${q.id}`];
        if (a && a.points == null) {
          const ok = a.value.toLowerCase().trim() === (q.correct ?? "").toLowerCase().trim();
          act({ action: "grade", questionId: q.id, teamIds: [t.teamId], points: ok ? (q.maxPoints ?? round.defaultMaxPoints) : 0 });
        }
      }
    }
    await wait(140);
  }

  act({ action: "show_review" }); await wait(90);
  const reviewed = S(teams[0].ws).session.quiz.rounds[ri].questions;
  const describes = (q) => {
    const f = round.answerFormat;
    if (f === "choice" && q.multi) return (q.correctOptions ?? []).length > 0;
    if (f === "list") return (q.listAnswers ?? []).length > 0;
    if (f === "sort") return (q.items ?? []).some((i) => i.category);
    if (f === "order") return (q.sequence ?? []).length > 0;
    if (f === "match") return (q.pairs ?? []).some((p) => p.right);
    if (f === "nominee") return true;
    return Boolean(q.correct);
  };
  const authored = S(host).session.quiz.rounds[ri].questions.some((q) => describes(q));
  if (authored && !reviewed.some((q) => describes(q)))
    note(`round ${ri + 1} (${round.answerFormat}): the review shows teams nothing`);
  const other = S(teams[0].ws).session.quiz.rounds[(ri + 1) % quiz.rounds.length];
  if (ri + 1 < quiz.rounds.length && other.questions.some((x) => x.correct))
    note(`round ${ri + 1}: reviewing one round exposed answers from another`);

  act({ action: "show_leaderboard" }); await wait(70);
  if (ri === 2) { act({ action: "start_break", minutes: 1 }); await wait(70);
                  checkLockstep("break"); act({ action: "end_break" }); await wait(70); }
  if (ri < quiz.rounds.length - 1) { act({ action: "next_round" }); await wait(70); }
}

act({ action: "finish" }); await wait(150);
checkLockstep("finish");

const finalHost = S(host);
console.log(`Played ${roundsPlayed} rounds, ${answered} answers, formats: ${[...formatsSeen].sort().join(", ")}\n`);
console.log("Final standings:");
finalHost.standings.forEach((t) => console.log(`  ${t.rank}. ${t.name.padEnd(24)} ${t.score}`));

const teamView = S(teams[0].ws);
if (teamView.standings.length !== finalHost.standings.length) note("teams see a different leaderboard length");
if (JSON.stringify(teamView.standings.map((x) => x.name)) !== JSON.stringify(finalHost.standings.map((x) => x.name)))
  note("team leaderboard order disagrees with the host's");
if (finalHost.ungradedCount > 0) note(`${finalHost.ungradedCount} answers left unmarked at the end`);
if (finalHost.standings.every((t) => t.score === 0)) note("every team finished on zero — scoring did nothing");
for (const t of teams) if (t.ws.errors.length) note(`${t.name} received errors: ${[...new Set(t.ws.errors)].join("; ")}`);

/* A tie at the top, played out properly — the main quiz rarely produces one. */
console.log("\nTiebreaker scenario:");
const tieQuiz = { id:"tie", title:"Tie", updatedAt:0,
  tiebreakers: quiz.tiebreakers,
  rounds:[{ id:"tr", order:0, title:"Dead heat", answerFormat:"yes_no", mediaType:"none",
            timeLimit:30, defaultMaxPoints:1,
            questions:[{ id:"tq", order:0, prompt:"True?", correct:"Yes", accepted:[],
                         maxPoints:1, mediaSource:"none" }] }] };
const t2 = await post("/api/sessions", { quiz: tieQuiz }, KEY);
const h2 = await open(`ws://127.0.0.1:${PORT}/ws?code=${t2.joinCode}&role=host&key=${KEY}`);
const p2 = await open(`ws://127.0.0.1:${PORT}/ws?code=${t2.joinCode}&role=presenter&token=${t2.presenterToken}`);
const tt = [];
for (const n of ["Level Pegging", "Neck and Neck", "Also Ran"]) {
  const j = await post("/api/join", { code: t2.joinCode, name: n });
  tt.push({ ...j, name: n, ws: await open(`ws://127.0.0.1:${PORT}/ws?code=${t2.joinCode}&role=team&teamId=${j.teamId}`) });
}
await wait(150);
const a2 = (x) => h2.send(JSON.stringify({ type: "host", payload: x }));
a2({ action: "begin_round" }); await wait(70);
a2({ action: "reveal_question" }); await wait(70);
a2({ action: "start_timer" }); await wait(70);
tt[0].ws.send(JSON.stringify({ type:"answer", questionId:"tq", value:"Yes" }));
tt[1].ws.send(JSON.stringify({ type:"answer", questionId:"tq", value:"Yes" }));
tt[2].ws.send(JSON.stringify({ type:"answer", questionId:"tq", value:"No" }));
await wait(140);
a2({ action: "lock" }); await wait(90);
a2({ action: "next_question" }); await wait(90);
a2({ action: "show_leaderboard" }); await wait(120);
const board = S(h2).standings;
console.log(`  standings: ${board.map((b) => `${b.name} ${b.score}`).join(", ")}`);
a2({ action: "run_tiebreaker" }); await wait(140);
if (S(h2).session.state !== "tiebreaker") note("a genuine tie at the top didn't open the tiebreaker");
const contenders = S(h2).session.tiebreakTeams;
if (contenders.length !== 2) note(`expected 2 contenders, got ${contenders.length}`);
if (S(p2).session.state !== "tiebreaker") note("the projector didn't follow into the tiebreaker");
const spectator = tt.find((t) => !contenders.includes(t.teamId));
if (spectator && S(spectator.ws).session.tiebreakTeams.includes(spectator.teamId))
  note("a team not in the tiebreak thinks it is");
for (const id of contenders) tt.find((t) => t.teamId === id)?.ws.send(
  JSON.stringify({ type: "tiebreak_answer", value: "Alaska" }));
await wait(120);
if (Object.keys(S(h2).session.tiebreakAnswers).length !== 2) note("tiebreak answers didn't reach the host");
a2({ action: "next_tiebreaker" }); await wait(110);
if (Object.keys(S(h2).session.tiebreakAnswers).length !== 0) note("moving on didn't clear the previous answers");
a2({ action: "resolve_tiebreak", teamId: contenders[0] }); await wait(140);
if (S(h2).session.state !== "finished") note("resolving didn't finish the quiz");
if (S(h2).standings[0].teamId !== contenders[0]) note("the tiebreak winner isn't top of the table");
console.log(`  ${contenders.length} contenders, winner: ${S(h2).standings[0].name}, final state: ${S(h2).session.state}`);

console.log(problems.length ? `\n${problems.length} PROBLEM(S) FOUND` : "\nNo problems found.");
process.exit(0);
