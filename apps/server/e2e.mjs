import WebSocket from "ws";
const PORT = process.env.PORT ?? "8899";
const API = `http://127.0.0.1:${PORT}`;
const KEY = "test-password";
const post = async (p, body, auth) => {
  const r = await fetch(API + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const quiz = {
  id: "t", title: "Test", updatedAt: 0, tiebreakers: [],
  rounds: [{
    id: "r1", order: 0, title: "TF", answerFormat: "yes_no", mediaType: "none",
    timeLimit: 2, defaultMaxPoints: 1,
    questions: [{ id: "q1", order: 0, prompt: "Sky is blue?", correct: "Yes", accepted: [], maxPoints: null, mediaSource: "none" }],
  }, {
    id: "r2", order: 1, title: "Text", answerFormat: "text", mediaType: "none",
    timeLimit: 30, defaultMaxPoints: 2,
    questions: [{ id: "q2", order: 0, prompt: "Symbol W?", correct: "Tungsten", accepted: ["wolfram"], maxPoints: null, mediaSource: "none" }],
  }],
};
const open = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.snaps = [];
  ws.on("message", (m) => { const p = JSON.parse(m); if (p.type === "snapshot") ws.snaps.push(p.snapshot); });
  ws.on("open", () => res(ws));
  ws.on("error", rej);
});
const last = (ws) => ws.snaps[ws.snaps.length - 1];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok " + m); };

// Auth must actually be enforced.
let rejected = false;
try { await post("/api/sessions", { quiz }, false); } catch { rejected = true; }
assert(rejected, "unauthenticated room creation is rejected");

const { joinCode, presenterToken } = await post("/api/sessions", { quiz }, KEY);
assert(/^[A-Z0-9]{5}$/.test(joinCode), `room opened with code ${joinCode}`);

const a = await post("/api/join", { code: joinCode, name: "Team A" });
const b = await post("/api/join", { code: joinCode, name: "Team B" });
assert(a.teamId !== b.teamId, "two teams joined");

let dupe = false;
try { await post("/api/join", { code: joinCode, name: "team a" }); } catch { dupe = true; }
assert(dupe, "duplicate team name rejected case-insensitively");

const host = await open(`ws://127.0.0.1:${PORT}/ws?code=${joinCode}&role=host&key=${KEY}`);
const pres = await open(`ws://127.0.0.1:${PORT}/ws?code=${joinCode}&role=presenter&token=${presenterToken}`);
const wsA = await open(`ws://127.0.0.1:${PORT}/ws?code=${joinCode}&role=team&teamId=${a.teamId}`);
const wsB = await open(`ws://127.0.0.1:${PORT}/ws?code=${joinCode}&role=team&teamId=${b.teamId}`);
await wait(150);
assert(last(host).session.teams.length === 2, "host sees both teams");

/* A rejected credential now closes with 4003 rather than destroying the
   socket, so the client can tell "wrong password" from "wifi dropped". */
const badHost = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?code=${joinCode}&role=host&key=wrong`);
  ws.on("close", (c) => resolve(c));
  ws.on("error", () => resolve(-1));
});
assert(badHost === 4003, `wrong host password closed with 4003 (got ${badHost})`);

const act = (payload) => host.send(JSON.stringify({ type: "host", payload }));
act({ action: "begin_round" }); await wait(80);
act({ action: "reveal_question" }); await wait(80);
act({ action: "start_timer" }); await wait(120);
assert(last(wsA).session.phase === "answering", "lockstep: team sees answering phase");
assert(last(pres).session.phase === "answering", "lockstep: presenter sees answering phase");
assert(typeof last(wsA).serverNow === "number", "snapshot carries serverNow for clock offset");

wsA.send(JSON.stringify({ type: "answer", questionId: "q1", value: "Yes" }));
wsB.send(JSON.stringify({ type: "answer", questionId: "q1", value: "No" }));
await wait(150);
assert(Object.keys(last(host).session.answers).length === 2, "both answers recorded");

// Timer is 2s, plus the 2s late-submission grace, so the lock lands at ~4s.
await wait(4400);
assert(last(host).session.phase === "locked", "auto-lock fired without host input");
assert(last(host).standings[0].name === "Team A", "yes/no auto-graded, Team A leads");
assert(last(host).standings[0].score === 1, "correct answer scored 1");

// Late submissions must be refused.
wsB.send(JSON.stringify({ type: "answer", questionId: "q1", value: "Yes" }));
await wait(150);
assert(last(host).standings.find(s => s.name === "Team B").score === 0, "late answer after lock refused");

// A team can't drive the host.
wsA.send(JSON.stringify({ type: "host", payload: { action: "next_round" } }));
await wait(150);
assert(last(host).session.roundIdx === 0, "team cannot issue host actions");

act({ action: "next_question" }); await wait(80);
act({ action: "next_round" }); await wait(80);
act({ action: "reveal_question" }); await wait(80);
act({ action: "start_timer" }); await wait(100);
wsA.send(JSON.stringify({ type: "answer", questionId: "q2", value: "Tungsten" }));
wsB.send(JSON.stringify({ type: "answer", questionId: "q2", value: "tungsten!" }));
await wait(200);
act({ action: "lock" }); await wait(100);
assert(last(host).ungradedCount === 2, "text answers await marking");

// Partial credit, applied to a whole cluster in one action.
act({ action: "grade", questionId: "q2", teamIds: [a.teamId, b.teamId], points: 1 });
await wait(150);
assert(last(host).ungradedCount === 0, "marking clears the ungraded count");
assert(last(host).standings.find(s => s.name === "Team B").score === 1, "partial credit awarded to cluster");

// Reconnection: drop a team and bring it back with the same id.
wsA.close(); await wait(200);
const wsA2 = await open(`ws://127.0.0.1:${PORT}/ws?code=${joinCode}&role=team&teamId=${a.teamId}`);
await wait(200);
assert(last(wsA2).session.answers[`${a.teamId}:q2`].value === "Tungsten", "reconnect restores the team's answer");
assert(last(wsA2).you.name === "Team A", "reconnect restores team identity");

// Rejoining with a stored token returns the same team, not a duplicate.
const again = await post("/api/join", { code: joinCode, name: "ignored", token: a.teamToken });
assert(again.teamId === a.teamId, "token rejoin is idempotent");

act({ action: "next_question" }); await wait(80);
act({ action: "show_leaderboard" }); await wait(80);
act({ action: "finish" }); await wait(120);
assert(last(pres).session.state === "finished", "quiz finished, presenter in sync");

/* A phone holding last week's code must be told the room is gone, not left
   retrying forever. Regression guard for the stale-room bug. */
const closeCode = await new Promise((resolve) => {
  const dead = new WebSocket(`ws://127.0.0.1:${PORT}/ws?code=ZZZZZ&role=team&teamId=nobody`);
  dead.on("close", (code) => resolve(code));
  dead.on("error", () => resolve(-1));
});
assert(closeCode === 4004, `unknown room closes with 4004 (got ${closeCode})`);

const badPresenter = await new Promise((resolve) => {
  const dead = new WebSocket(`ws://127.0.0.1:${PORT}/ws?code=${joinCode}&role=presenter&token=wrong`);
  dead.on("close", (c) => resolve(c));
  dead.on("error", () => resolve(-1));
});
assert(badPresenter === 4003, `bad presenter token closes with 4003 (got ${badPresenter})`);

/* A media round must reach the answer phase on the server's own timer. The
   presenter can't issue host actions, so depending on its ENDED event meant
   the music round hung forever. */
const mediaQuiz = JSON.parse(JSON.stringify(quiz));
mediaQuiz.rounds = [{
  id: "m1", order: 0, title: "Music", answerFormat: "text", mediaType: "audio",
  timeLimit: 3, defaultMaxPoints: 1,
  questions: [{ id: "mq1", order: 0, prompt: "Name it", correct: "X", accepted: [],
                maxPoints: null, mediaSource: "youtube", url: "", clipStart: 0, clipEnd: 1 }],
}];
const m = await post("/api/sessions", { quiz: mediaQuiz }, KEY);
const mHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${m.joinCode}&role=host&key=${KEY}`);
await wait(100);
const mAct = (payload) => mHost.send(JSON.stringify({ type: "host", payload }));
mAct({ action: "begin_round" }); await wait(60);
mAct({ action: "reveal_question" }); await wait(60);
mAct({ action: "play_media" }); await wait(60);
assert(last(mHost).session.phase === "playing_media", "clip is playing");
await wait(1800);
assert(last(mHost).session.phase === "answering",
  `media auto-advances to answering without any client event (got ${last(mHost).session.phase})`);

/* Teams arriving during round one is normal in a pub. */
const late = await post("/api/join", { code: m.joinCode, name: "Latecomers" });
assert(!late.error && late.teamId, "a team can still join after the quiz has started");

/* The sign-in screen checks the password up front now, so these two must
   behave predictably. */
const rejects = async (p, body, auth) => {
  try { await post(p, body, auth); return false; } catch { return true; }
};
assert(!(await rejects("/api/auth", {}, KEY)), "correct password accepted by /api/auth");
assert(await rejects("/api/auth", {}, "definitely-wrong"), "wrong password rejected by /api/auth");
/* Whitespace padding is handled at both ends: HTTP trims header values, and
   the server trims HOST_PASSWORD, since env vars pasted into a dashboard
   often carry a trailing newline. Run the server with a padded password and
   this still passes. */
assert(!(await rejects("/api/auth", {}, `  ${KEY}  `)), "surrounding whitespace tolerated");
assert(await rejects("/api/sessions", { quiz }, "definitely-wrong"),
  "wrong password cannot open a room");

/* A break must be host-ended, and must return to wherever it interrupted —
   the clock hitting zero doesn't mean the marking is finished. */
const bAct = (payload) => mHost.send(JSON.stringify({ type: "host", payload }));
bAct({ action: "lock" }); await wait(60);
bAct({ action: "next_question" }); await wait(60);
const before = last(mHost).session.state;
bAct({ action: "start_break", minutes: 1 }); await wait(80);
const inBreak = last(mHost).session;
assert(inBreak.state === "break", "host can start a break");
assert(inBreak.breakEndsAt > Date.now(), "break has an end time clients can count down to");
assert(inBreak.breakStartedAt != null, "break records its start, so the ring is proportional");

const endsAt = inBreak.breakEndsAt;
bAct({ action: "extend_break", minutes: 5 }); await wait(80);
assert(last(mHost).session.breakEndsAt > endsAt, "break can be extended");

bAct({ action: "end_break" }); await wait(80);
assert(last(mHost).session.state === before,
  `ending a break returns to where it interrupted (${before})`);
assert(last(mHost).session.breakEndsAt === null, "break clock is cleared on resume");

/* Your example: answer 39, three teams say 38, the quickest of them takes 2
   and the other two take 1. */
const fastQuiz = JSON.parse(JSON.stringify(quiz));
fastQuiz.rounds = [{
  id: "f1", order: 0, title: "Fastest", answerFormat: "fastest", mediaType: "none",
  timeLimit: 30, defaultMaxPoints: 1, fastestPoints: 2,
  questions: [{ id: "fq1", order: 0, prompt: "How many?", correct: "39", accepted: [],
                maxPoints: null, fastestMode: "closest", mediaSource: "none" }],
}];
const f = await post("/api/sessions", { quiz: fastQuiz }, KEY);
const fHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${f.joinCode}&role=host&key=${KEY}`);
const names = ["Quick", "Middle", "Slow", "Wrong"];
const joined = [];
for (const n of names) joined.push(await post("/api/join", { code: f.joinCode, name: n }));
const socks = [];
for (const j of joined) socks.push(await open(`ws://127.0.0.1:${PORT}/ws?code=${f.joinCode}&role=team&teamId=${j.teamId}`));
await wait(120);
const fAct = (payload) => fHost.send(JSON.stringify({ type: "host", payload }));
fAct({ action: "begin_round" }); await wait(60);
fAct({ action: "reveal_question" }); await wait(60);
fAct({ action: "start_timer" }); await wait(60);

// Three teams answer 38, spaced out; the fourth is miles off.
socks[0].send(JSON.stringify({ type: "answer", questionId: "fq1", value: "38" })); await wait(120);
socks[1].send(JSON.stringify({ type: "answer", questionId: "fq1", value: "38" })); await wait(120);
socks[2].send(JSON.stringify({ type: "answer", questionId: "fq1", value: "38" })); await wait(120);
socks[3].send(JSON.stringify({ type: "answer", questionId: "fq1", value: "900" })); await wait(120);

// A speed round must refuse a second answer, or "first" means nothing.
socks[2].send(JSON.stringify({ type: "answer", questionId: "fq1", value: "39" })); await wait(120);

fAct({ action: "lock" }); await wait(150);
const fs = last(fHost).session;
const ptsOf = (i) => fs.answers[`${joined[i].teamId}:fq1`]?.points;
assert(fs.answers[`${joined[2].teamId}:fq1`].value === "38", "a second answer is refused in a speed round");
assert(ptsOf(0) === 2, `fastest correct answer takes the bonus (got ${ptsOf(0)})`);
assert(ptsOf(1) === 1 && ptsOf(2) === 1, `equally-correct but slower teams take the base points (${ptsOf(1)}, ${ptsOf(2)})`);
assert(ptsOf(3) === 0, `a wrong answer scores nothing (got ${ptsOf(3)})`);

/* Sorting is marked per word, automatically. */
const sortQuiz = JSON.parse(JSON.stringify(quiz));
sortQuiz.rounds = [{
  id: "s1", order: 0, title: "Sort", answerFormat: "sort", mediaType: "none",
  timeLimit: 30, defaultMaxPoints: 4,
  questions: [{ id: "sq1", order: 0, prompt: "File these", correct: "", accepted: [],
                maxPoints: 4, mediaSource: "none",
                categories: ["Fruit", "Veg"],
                items: [
                  { word: "Apple", category: "Fruit" }, { word: "Pear", category: "Fruit" },
                  { word: "Leek", category: "Veg" }, { word: "Kale", category: "Veg" },
                ] }],
}];
const so = await post("/api/sessions", { quiz: sortQuiz }, KEY);
const sHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${so.joinCode}&role=host&key=${KEY}`);
const sTeam = await post("/api/join", { code: so.joinCode, name: "Sorters" });
const sSock = await open(`ws://127.0.0.1:${PORT}/ws?code=${so.joinCode}&role=team&teamId=${sTeam.teamId}`);
await wait(120);
const sAct = (payload) => sHost.send(JSON.stringify({ type: "host", payload }));
sAct({ action: "begin_round" }); await wait(60);
sAct({ action: "reveal_question" }); await wait(60);
sAct({ action: "start_timer" }); await wait(60);
sSock.send(JSON.stringify({
  type: "answer", questionId: "sq1",
  value: JSON.stringify({ Apple: "Fruit", Pear: "Fruit", Leek: "Veg", Kale: "Fruit" }),
})); await wait(150);
sAct({ action: "lock" }); await wait(150);
const sPts = last(sHost).session.answers[`${sTeam.teamId}:sq1`]?.points;
assert(sPts === 3, `three of four filed correctly scores 3 of 4 (got ${sPts})`);

/* Moving to the next tiebreaker must wipe the previous answers, or a team's
   first guess silently counts as their second. */
const tHost = fHost;
const tAct = (payload) => tHost.send(JSON.stringify({ type: "host", payload }));
socks[0].send(JSON.stringify({ type: "tiebreak_answer", value: "ignored" }));
await wait(80);
tAct({ action: "next_tiebreaker" }); await wait(80);
assert(Object.keys(last(tHost).session.tiebreakAnswers).length === 0,
  "moving to the next tiebreaker clears the previous answers");

/* Closing the room must disconnect everyone with the same code a vanished
   room uses, so every client already knows to forget its session. */
const closed = new Promise((resolve) => socks[0].on("close", (c) => resolve(c)));
tAct({ action: "close_room" });
assert((await closed) === 4004, "closing the room disconnects teams with 4004");
await wait(120);
const gone = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?code=${f.joinCode}&role=team&teamId=x`);
  ws.on("close", (c) => resolve(c));
  ws.on("error", () => resolve(-1));
});
assert(gone === 4004, "a closed room can no longer be rejoined");

/* Ordering: marked per position, and the presented order must never be the
   answer or the round is free points. */
const ordQuiz = JSON.parse(JSON.stringify(quiz));
ordQuiz.rounds = [{
  id: "o1", order: 0, title: "Order", answerFormat: "order", mediaType: "none",
  timeLimit: 30, defaultMaxPoints: 4,
  questions: [{ id: "oq1", order: 0, prompt: "Closest first", correct: "", accepted: [],
                maxPoints: 4, mediaSource: "none",
                sequence: ["Mercury", "Venus", "Earth", "Mars"] }],
}];
const o = await post("/api/sessions", { quiz: ordQuiz }, KEY);
const oHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${o.joinCode}&role=host&key=${KEY}`);
const oTeam = await post("/api/join", { code: o.joinCode, name: "Orderers" });
const oSock = await open(`ws://127.0.0.1:${PORT}/ws?code=${o.joinCode}&role=team&teamId=${oTeam.teamId}`);
await wait(120);
const oAct = (payload) => oHost.send(JSON.stringify({ type: "host", payload }));
oAct({ action: "begin_round" }); await wait(60);
oAct({ action: "reveal_question" }); await wait(60);
oAct({ action: "start_timer" }); await wait(60);
// First two right, last two swapped.
oSock.send(JSON.stringify({
  type: "answer", questionId: "oq1",
  value: JSON.stringify(["Mercury", "Venus", "Mars", "Earth"]),
})); await wait(150);
oAct({ action: "lock" }); await wait(150);
const oPts = last(oHost).session.answers[`${oTeam.teamId}:oq1`]?.points;
assert(oPts === 2, `two of four in the right place scores 2 of 4 (got ${oPts})`);

/* A perfect answer must score full marks, and the sequence must survive the
   round trip intact. */
oAct({ action: "reopen" }); await wait(80);
oSock.send(JSON.stringify({
  type: "answer", questionId: "oq1",
  value: JSON.stringify(["Mercury", "Venus", "Earth", "Mars"]),
})); await wait(150);
oAct({ action: "lock" }); await wait(150);
assert(last(oHost).session.answers[`${oTeam.teamId}:oq1`]?.points === 4,
  "a perfect order scores full marks");
assert(last(oHost).session.quiz.rounds[0].questions[0].sequence.join() === "Mercury,Venus,Earth,Mars",
  "the correct sequence survives the round trip");

console.log("\nALL E2E CHECKS PASSED");
[host, pres, wsA2, wsB].forEach(w => w.close());
process.exit(0);
