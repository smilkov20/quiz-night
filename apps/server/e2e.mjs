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
let note_fail = null;
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

/* accuracy rule: two teams both answer 88 when the answer is 90, and both
   take the higher points — speed is ignored. */
const accQuiz = JSON.parse(JSON.stringify(quiz));
accQuiz.rounds = [{
  id: "a1", order: 0, title: "Accuracy", answerFormat: "fastest", mediaType: "none",
  timeLimit: 30, defaultMaxPoints: 1, fastestPoints: 3, bonusRule: "accuracy",
  questions: [{ id: "aq1", order: 0, prompt: "How many?", correct: "90", accepted: [],
                maxPoints: null, fastestMode: "closest", mediaSource: "none" }],
}];
const ac = await post("/api/sessions", { quiz: accQuiz }, KEY);
const acHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${ac.joinCode}&role=host&key=${KEY}`);
const acTeams = [];
for (const n of ["First", "Second", "Miles off"]) acTeams.push(await post("/api/join", { code: ac.joinCode, name: n }));
const acSocks = [];
for (const t of acTeams) acSocks.push(await open(`ws://127.0.0.1:${PORT}/ws?code=${ac.joinCode}&role=team&teamId=${t.teamId}`));
await wait(120);
const acAct = (p2) => acHost.send(JSON.stringify({ type: "host", payload: p2 }));
acAct({ action: "begin_round" }); await wait(60);
acAct({ action: "reveal_question" }); await wait(60);
acAct({ action: "start_timer" }); await wait(60);
acSocks[0].send(JSON.stringify({ type: "answer", questionId: "aq1", value: "88" })); await wait(150);
acSocks[1].send(JSON.stringify({ type: "answer", questionId: "aq1", value: "88" })); await wait(150);
acSocks[2].send(JSON.stringify({ type: "answer", questionId: "aq1", value: "40" })); await wait(150);
acAct({ action: "lock" }); await wait(150);
const acPts = (i) => last(acHost).session.answers[`${acTeams[i].teamId}:aq1`]?.points;
assert(acPts(0) === 3 && acPts(1) === 3,
  `accuracy rule gives both closest teams the higher points (${acPts(0)}, ${acPts(1)})`);
assert(acPts(2) === 0, "a distant answer still scores nothing under the accuracy rule");

/* Multiple choice marks itself. */
const chQuiz = JSON.parse(JSON.stringify(quiz));
chQuiz.rounds = [{
  id: "c1", order: 0, title: "Choice", answerFormat: "choice", mediaType: "none",
  timeLimit: 30, defaultMaxPoints: 1,
  questions: [{ id: "cq1", order: 0, prompt: "Capital of Australia?", correct: "Canberra",
                accepted: [], maxPoints: null, mediaSource: "none",
                options: ["Sydney", "Melbourne", "Canberra", "Perth"] }],
}];
const ch = await post("/api/sessions", { quiz: chQuiz }, KEY);
const chHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${ch.joinCode}&role=host&key=${KEY}`);
const chRight = await post("/api/join", { code: ch.joinCode, name: "Right" });
const chWrong = await post("/api/join", { code: ch.joinCode, name: "Wrong" });
const chS1 = await open(`ws://127.0.0.1:${PORT}/ws?code=${ch.joinCode}&role=team&teamId=${chRight.teamId}`);
const chS2 = await open(`ws://127.0.0.1:${PORT}/ws?code=${ch.joinCode}&role=team&teamId=${chWrong.teamId}`);
await wait(120);
const chAct = (p2) => chHost.send(JSON.stringify({ type: "host", payload: p2 }));
chAct({ action: "begin_round" }); await wait(60);
chAct({ action: "reveal_question" }); await wait(60);
chAct({ action: "start_timer" }); await wait(60);
chS1.send(JSON.stringify({ type: "answer", questionId: "cq1", value: "Canberra" }));
chS2.send(JSON.stringify({ type: "answer", questionId: "cq1", value: "Sydney" }));
await wait(150);
chAct({ action: "lock" }); await wait(150);
const chSess = last(chHost).session;
assert(chSess.answers[`${chRight.teamId}:cq1`].points === 1, "multiple choice marks a right answer");
assert(chSess.answers[`${chWrong.teamId}:cq1`].points === 0, "multiple choice marks a wrong answer");
assert(chSess.quiz.rounds[0].questions[0].options.join() === "Sydney,Melbourne,Canberra,Perth",
  "options reach every device in the same order, so A/B/C/D means the same thing");

/* list, match, joker doubling and wipeout penalties. */
const extraQuiz = JSON.parse(JSON.stringify(quiz));
extraQuiz.rounds = [
  {id:"l1",order:0,title:"Name them",answerFormat:"list",mediaType:"none",timeLimit:30,defaultMaxPoints:3,
   questions:[{id:"lq1",order:0,prompt:"Name 3",correct:"",accepted:[],maxPoints:3,mediaSource:"none",
               listAnswers:["Kenya","Uganda","Tanzania","Rwanda"],requiredCount:3}]},
  {id:"m1",order:1,title:"Match",answerFormat:"match",mediaType:"none",timeLimit:30,defaultMaxPoints:2,allowedPowerUps:["double"],
   questions:[{id:"mq2",order:0,prompt:"Author to book",correct:"",accepted:[],maxPoints:2,mediaSource:"none",
               pairs:[{left:"Orwell",right:"1984"},{left:"Austen",right:"Emma"}]}]},
  {id:"w1",order:2,title:"Wipeout",answerFormat:"yes_no",mediaType:"none",timeLimit:30,
   defaultMaxPoints:1,penaltyForWrong:2,
   questions:[{id:"wq1",order:0,prompt:"True?",correct:"Yes",accepted:[],maxPoints:null,mediaSource:"none"}]},
];
const x = await post("/api/sessions", { quiz: extraQuiz }, KEY);
const xHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${x.joinCode}&role=host&key=${KEY}`);
const xT = await post("/api/join", { code: x.joinCode, name: "Xs" });
const xS = await open(`ws://127.0.0.1:${PORT}/ws?code=${x.joinCode}&role=team&teamId=${xT.teamId}`);
await wait(120);
const xAct = (p2) => xHost.send(JSON.stringify({ type: "host", payload: p2 }));

// Joker on round 2 (the match round), nominated while still in the lobby.
xS.send(JSON.stringify({ type: "use_powerup", power: "double", roundIdx: 1 })); await wait(120);
assert(last(xHost).session.teams[0].jokerRound === 1, "a team can nominate a round to double");
xS.send(JSON.stringify({ type: "use_powerup", power: "double", roundIdx: 2 })); await wait(120);
assert(last(xHost).session.teams[0].jokerRound === 1, "the double can only be played once");

/* Doubling a round the host didn't open it up for must be refused —
   the old set_joker message skipped this check entirely. */
const strict = await post("/api/sessions", { quiz: extraQuiz }, KEY);
const strictHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${strict.joinCode}&role=host&key=${KEY}`);
const strictT = await post("/api/join", { code: strict.joinCode, name: "Chancer" });
const strictS = await open(`ws://127.0.0.1:${PORT}/ws?code=${strict.joinCode}&role=team&teamId=${strictT.teamId}`);
await wait(150);
strictS.send(JSON.stringify({ type: "use_powerup", power: "double", roundIdx: 0 })); await wait(150);
assert(last(strictHost).session.teams[0].jokerRound == null,
  "a round without the double enabled can't be doubled");

xAct({ action: "begin_round" }); await wait(60);
xAct({ action: "reveal_question" }); await wait(60);
xAct({ action: "start_timer" }); await wait(60);
xS.send(JSON.stringify({ type:"answer", questionId:"lq1",
  value: JSON.stringify(["Kenya","kenya","Uganda"]) })); await wait(150);
xAct({ action: "lock" }); await wait(150);
assert(last(xHost).session.answers[`${xT.teamId}:lq1`].points === 2,
  `duplicates don't pay twice: two distinct names of three scores 2 (got ${last(xHost).session.answers[`${xT.teamId}:lq1`].points})`);

xAct({ action: "next_question" }); await wait(80);
xAct({ action: "next_round" }); await wait(80);
xAct({ action: "reveal_question" }); await wait(60);
xAct({ action: "start_timer" }); await wait(60);
xS.send(JSON.stringify({ type:"answer", questionId:"mq2",
  value: JSON.stringify({ Orwell:"1984", Austen:"1984" }) })); await wait(150);
xAct({ action: "lock" }); await wait(150);
assert(last(xHost).session.answers[`${xT.teamId}:mq2`].points === 1, "one correct pair of two scores 1");
const standing = last(xHost).standings.find((t) => t.teamId === xT.teamId);
assert(standing.score === 2 + 1 * 2, `the jokered round counts double (2 + 1x2 = 4, got ${standing.score})`);

xAct({ action: "next_question" }); await wait(80);
xAct({ action: "next_round" }); await wait(80);
xAct({ action: "reveal_question" }); await wait(60);
xAct({ action: "start_timer" }); await wait(60);
xS.send(JSON.stringify({ type:"answer", questionId:"wq1", value:"No" })); await wait(150);
xAct({ action: "lock" }); await wait(150);
assert(last(xHost).session.answers[`${xT.teamId}:wq1`].points === -2,
  `a wrong answer in a wipeout round costs points (got ${last(xHost).session.answers[`${xT.teamId}:wq1`].points})`);

/* Nominee round: two devices in one team, and the nominee's answer must never
   reach the team's own device. */
const nomQuiz = JSON.parse(JSON.stringify(quiz));
nomQuiz.rounds = [{
  id:"n1",order:0,title:"Guess your nominee",answerFormat:"nominee",mediaType:"none",
  timeLimit:30,defaultMaxPoints:2,
  questions:[
    {id:"nq1",order:0,prompt:"What is {nominee}'s favourite season?",correct:"",accepted:[],maxPoints:2,mediaSource:"none"},
    {id:"nq2",order:1,prompt:"What would {nominee} order at the bar?",correct:"",accepted:[],maxPoints:2,mediaSource:"none"},
  ]}];
const nm = await post("/api/sessions", { quiz: nomQuiz }, KEY);
const nHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${nm.joinCode}&role=host&key=${KEY}`);
const nTeam = await post("/api/join", { code: nm.joinCode, name: "Guessers" });

const listed = await (await fetch(`${API}/api/teams?code=${nm.joinCode}`)).json();
assert(listed.length === 1 && listed[0].hasNominee === false, "teams are listable so a nominee can pick one");

const nom = await post("/api/join", { code: nm.joinCode, name: "Sam", asNomineeFor: nTeam.teamId });
assert(nom.teamId === nTeam.teamId, "the nominee joins the existing team rather than making a new one");
const secondNominee = await post("/api/join", { code: nm.joinCode, name: "Alex", asNomineeFor: nTeam.teamId }).catch(() => null);
assert(secondNominee === null, "a team can only have one nominee");

const nTeamSock = await open(`ws://${"127.0.0.1"}:${PORT}/ws?code=${nm.joinCode}&role=team&teamId=${nTeam.teamId}`);
const nNomSock = await open(`ws://127.0.0.1:${PORT}/ws?code=${nm.joinCode}&role=nominee&teamId=${nTeam.teamId}`);
await wait(150);
const nAct = (p2) => nHost.send(JSON.stringify({ type: "host", payload: p2 }));
nAct({ action: "begin_round" }); await wait(60);
nAct({ action: "reveal_question" }); await wait(60);
nAct({ action: "start_timer" }); await wait(60);

nNomSock.send(JSON.stringify({ type:"answer", questionId:"nq1", value:"Autumn" })); await wait(150);
nTeamSock.send(JSON.stringify({ type:"answer", questionId:"nq1", value:"autumn!" })); await wait(150);

const teamView = last(nTeamSock);
assert(Object.keys(teamView.session.nomineeAnswers || {}).length === 0,
  "the team's own device never receives the nominee's answers");
assert(Object.keys(last(nNomSock).session.nomineeAnswers).length === 1,
  "the nominee sees their own answer, so a refresh restores it");
assert(Object.keys(last(nHost).session.nomineeAnswers).length === 1,
  "the host sees nominee answers, for marking");

nAct({ action: "lock" }); await wait(150);
assert(last(nHost).session.answers[`${nTeam.teamId}:nq1`].points === 2,
  "a guess matching the nominee scores, ignoring case and punctuation");

nAct({ action: "next_question" }); await wait(80);
nAct({ action: "reveal_question" }); await wait(60);
nAct({ action: "start_timer" }); await wait(60);
nNomSock.send(JSON.stringify({ type:"answer", questionId:"nq2", value:"Guinness" })); await wait(150);
nTeamSock.send(JSON.stringify({ type:"answer", questionId:"nq2", value:"Wine" })); await wait(150);
nAct({ action: "lock" }); await wait(150);
assert(last(nHost).session.answers[`${nTeam.teamId}:nq2`].points === 0, "a guess that misses scores nothing");

/* Wagers, clues, multi-select and the power-up rules. */
const pQuiz = JSON.parse(JSON.stringify(quiz));
pQuiz.rounds = [
  {id:"g1",order:0,title:"Wager",answerFormat:"choice",mediaType:"none",timeLimit:30,
   defaultMaxPoints:1,wager:true,maxWager:5,allowedPowerUps:["hint","steal"],
   questions:[{id:"gq1",order:0,prompt:"Capital?",correct:"Canberra",accepted:[],maxPoints:null,
               mediaSource:"none",options:["Sydney","Canberra"]}]},
  {id:"g2",order:1,title:"Clues",answerFormat:"clues",mediaType:"none",timeLimit:60,
   defaultMaxPoints:5,allowedPowerUps:[],
   questions:[{id:"gq2",order:0,prompt:"Who?",correct:"Warhol",accepted:[],maxPoints:5,
               mediaSource:"none",clues:["Born 1928","Pop art","Soup cans"]}]},
  {id:"g3",order:2,title:"Multi",answerFormat:"choice",mediaType:"none",timeLimit:30,
   defaultMaxPoints:2,allowedPowerUps:[],
   questions:[{id:"gq3",order:0,prompt:"Which are primes?",correct:"",accepted:[],maxPoints:2,
               mediaSource:"none",multi:true,options:["2","4","7","9"],correctOptions:["2","7"]}]},
];
const g = await post("/api/sessions", { quiz: pQuiz }, KEY);
const gHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${g.joinCode}&role=host&key=${KEY}`);
const gA = await post("/api/join", { code: g.joinCode, name: "Alpha" });
const gB = await post("/api/join", { code: g.joinCode, name: "Beta" });
const sA = await open(`ws://127.0.0.1:${PORT}/ws?code=${g.joinCode}&role=team&teamId=${gA.teamId}`);
const sB = await open(`ws://127.0.0.1:${PORT}/ws?code=${g.joinCode}&role=team&teamId=${gB.teamId}`);
await wait(150);
const gAct = (p2) => gHost.send(JSON.stringify({ type: "host", payload: p2 }));

gAct({ action: "begin_round" }); await wait(60);
gAct({ action: "reveal_question" }); await wait(60);
sA.send(JSON.stringify({ type:"set_wager", amount: 4 })); await wait(100);
sB.send(JSON.stringify({ type:"set_wager", amount: 3 })); await wait(100);
assert(last(gHost).session.wagers[`${gA.teamId}:gq1`] === 4, "a stake is placed before the question appears");
gAct({ action: "start_timer" }); await wait(60);
sA.send(JSON.stringify({ type:"set_wager", amount: 5 })); await wait(100);
assert(last(gHost).session.wagers[`${gA.teamId}:gq1`] === 4, "the stake can't be changed once the question is up");

sA.send(JSON.stringify({ type:"answer", questionId:"gq1", value:"Canberra" })); await wait(120);
sB.send(JSON.stringify({ type:"answer", questionId:"gq1", value:"Sydney" })); await wait(120);

// Power-ups: hint is private, steal needs a target who has answered.
sB.send(JSON.stringify({ type:"use_powerup", power:"hint" })); await wait(120);
const bReveal = last(sB).session.reveals[`${gB.teamId}:gq1`];
assert(bReveal?.hint?.includes("C"), `hint reveals the first letter (got ${JSON.stringify(bReveal)})`);
assert(Object.keys(last(sA).session.reveals).length === 0, "a hint is private to the team that spent it");
sB.send(JSON.stringify({ type:"use_powerup", power:"hint" })); await wait(120);
assert(Object.values(last(gHost).session.teams.find(t=>t.id===gB.teamId).usedPowerUps).length === 1,
  "a power-up can only be spent once");
sB.send(JSON.stringify({ type:"use_powerup", power:"steal", targetTeamId: gA.teamId })); await wait(120);
assert(last(sB).session.reveals[`${gB.teamId}:gq1`].steal.value === "Canberra",
  "steal shows another team's answer");

gAct({ action: "lock" }); await wait(150);
const wA = last(gHost).session.answers[`${gA.teamId}:gq1`].points;
const wB = last(gHost).session.answers[`${gB.teamId}:gq1`].points;
assert(wA === 4 && wB === -3, `a wager is won or lost, not scored normally (got ${wA}, ${wB})`);

// Clues: answer late, score less.
gAct({ action: "next_question" }); await wait(80);
gAct({ action: "next_round" }); await wait(80);
gAct({ action: "reveal_question" }); await wait(80);
assert(last(gHost).session.cluesShown === 1, "the first clue is free");
gAct({ action: "start_timer" }); await wait(60);
sA.send(JSON.stringify({ type:"answer", questionId:"gq2", value:"Warhol" })); await wait(120);
gAct({ action: "reveal_clue" }); await wait(80);
gAct({ action: "reveal_clue" }); await wait(80);
sB.send(JSON.stringify({ type:"answer", questionId:"gq2", value:"Warhol" })); await wait(120);
gAct({ action: "lock" }); await wait(150);
const cA = last(gHost).session.answers[`${gA.teamId}:gq2`].points;
const cB = last(gHost).session.answers[`${gB.teamId}:gq2`].points;
assert(cA === 5, `answering on the first clue scores full marks (got ${cA})`);
assert(cB === 3, `answering on the third clue scores less (got ${cB})`);

// Multi-select: wrong ticks cancel right ones.
gAct({ action: "next_question" }); await wait(80);
gAct({ action: "next_round" }); await wait(80);
gAct({ action: "reveal_question" }); await wait(60);
gAct({ action: "start_timer" }); await wait(60);
sA.send(JSON.stringify({ type:"answer", questionId:"gq3", value: JSON.stringify(["2","7"]) })); await wait(120);
sB.send(JSON.stringify({ type:"answer", questionId:"gq3", value: JSON.stringify(["2","7","9"]) })); await wait(120);
gAct({ action: "lock" }); await wait(150);
assert(last(gHost).session.answers[`${gA.teamId}:gq3`].points === 2, "both right ticks score full marks");
assert(last(gHost).session.answers[`${gB.teamId}:gq3`].points === 1,
  `a wrong tick cancels a right one (got ${last(gHost).session.answers[`${gB.teamId}:gq3`].points})`);

/* ---- regression guards from the code review ---- */

/* The answer key must never reach a team. This was true of every version
   until now: correct answers, accepted spellings, tiebreakers, sort
   categories, correct orders and unrevealed clues were all readable in
   devtools. */
const secretQuiz = { id:"sec", title:"Sec", updatedAt:0,
  tiebreakers:[{id:"st",order:0,mode:"exact",prompt:"TB",correct:"SECRET_TB",timeLimit:30}],
  rounds:[
    {id:"sr1",order:0,title:"T",answerFormat:"text",mediaType:"none",timeLimit:30,defaultMaxPoints:1,
     questions:[{id:"sq1",order:0,prompt:"P",correct:"SECRET_ANS",accepted:["SECRET_ALT"],
                 maxPoints:null,mediaSource:"none"}]},
    {id:"sr2",order:1,title:"C",answerFormat:"clues",mediaType:"none",timeLimit:30,defaultMaxPoints:3,
     questions:[{id:"sq2",order:0,prompt:"P",correct:"SECRET_CLUE",accepted:[],maxPoints:3,
                 mediaSource:"none",clues:["c1","c2","c3"]}]},
    {id:"sr3",order:2,title:"S",answerFormat:"sort",mediaType:"none",timeLimit:30,defaultMaxPoints:2,
     questions:[{id:"sq3",order:0,prompt:"P",correct:"",accepted:[],maxPoints:2,mediaSource:"none",
                 categories:["A","B"],items:[{word:"w1",category:"A"},{word:"w2",category:"B"}]}]},
  ]};
const sec = await post("/api/sessions", { quiz: secretQuiz }, KEY);
const secTeam = await post("/api/join", { code: sec.joinCode, name: "Spy" });
const secWs = await open(`ws://127.0.0.1:${PORT}/ws?code=${sec.joinCode}&role=team&teamId=${secTeam.teamId}`);
const secHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${sec.joinCode}&role=host&key=${KEY}`);
await wait(200);
const teamBlob = JSON.stringify(last(secWs));
for (const secret of ["SECRET_ANS","SECRET_ALT","SECRET_TB","SECRET_CLUE"])
  assert(!teamBlob.includes(secret), `a team's snapshot never contains ${secret}`);
assert(last(secWs).session.quiz.rounds[2].questions[0].items.every((i) => !i.category),
  "sort categories are stripped, so which word goes where isn't readable");
assert(last(secWs).session.quiz.rounds[1].questions[0].clues.length === 0,
  "unrevealed clues aren't sent ahead of time");
assert(JSON.stringify(last(secHost)).includes("SECRET_ANS"), "the host still receives the answers");

/* Answers are revealed on purpose during a round review. */
const secAct = (p2) => secHost.send(JSON.stringify({ type: "host", payload: p2 }));
secAct({ action: "begin_round" }); await wait(60);
secAct({ action: "reveal_question" }); await wait(60);
secAct({ action: "start_timer" }); await wait(60);
secAct({ action: "lock" }); await wait(60);
secAct({ action: "next_question" }); await wait(150);
assert(JSON.stringify(last(secWs)).includes("SECRET_ANS"),
  "the round review does show the answers — that's the point of it");

/* A wager must survive manual marking, and must not be penalised twice. */
const wQuiz = { ...secretQuiz, id:"w", rounds:[
  {id:"wr",order:0,title:"W",answerFormat:"text",mediaType:"none",timeLimit:30,
   defaultMaxPoints:1,wager:true,maxWager:5,penaltyForWrong:2,
   questions:[{id:"wq",order:0,prompt:"P",correct:"yes",accepted:[],maxPoints:1,mediaSource:"none"}]}]};
const w = await post("/api/sessions", { quiz: wQuiz }, KEY);
const wHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${w.joinCode}&role=host&key=${KEY}`);
const wgA = await post("/api/join", { code: w.joinCode, name: "A" });
const wgB = await post("/api/join", { code: w.joinCode, name: "B" });
const wgsA = await open(`ws://127.0.0.1:${PORT}/ws?code=${w.joinCode}&role=team&teamId=${wgA.teamId}`);
const wgsB = await open(`ws://127.0.0.1:${PORT}/ws?code=${w.joinCode}&role=team&teamId=${wgB.teamId}`);
await wait(150);
const wAct = (p2) => wHost.send(JSON.stringify({ type: "host", payload: p2 }));
wAct({ action: "begin_round" }); await wait(60);
wAct({ action: "reveal_question" }); await wait(60);
wgsA.send(JSON.stringify({ type:"set_wager", amount: 5 }));
wgsB.send(JSON.stringify({ type:"set_wager", amount: 4 })); await wait(120);
wAct({ action: "start_timer" }); await wait(60);
wgsA.send(JSON.stringify({ type:"answer", questionId:"wq", value:"yes" }));
wgsB.send(JSON.stringify({ type:"answer", questionId:"wq", value:"no" })); await wait(150);
wAct({ action: "lock" }); await wait(150);
wAct({ action: "grade", questionId:"wq", teamIds:[wgA.teamId], points: 1 }); await wait(100);
wAct({ action: "grade", questionId:"wq", teamIds:[wgB.teamId], points: 0 }); await wait(150);
const wPtsA = last(wHost).session.answers[`${wgA.teamId}:wq`].points;
const wPtsB = last(wHost).session.answers[`${wgB.teamId}:wq`].points;
assert(wPtsA === 5, `a stake survives manual marking (expected 5, got ${wPtsA})`);
assert(wPtsB === -4, `a lost stake isn't also hit by the round penalty (expected -4, got ${wPtsB})`);

/* Removing a team shouldn't leave its answers behind. */
wAct({ action: "remove_team", teamId: wgB.teamId }); await wait(150);
const leftovers = Object.keys(last(wHost).session.answers).filter((k) => k.startsWith(`${wgB.teamId}:`));
assert(leftovers.length === 0, "removing a team clears its answers and stakes");

/* A dead phone must be recoverable without losing the score, and a bad
   question must cost nobody. */
const rQuiz = { id:"r", title:"R", updatedAt:0, tiebreakers:[], rounds:[
  {id:"rr",order:0,title:"R",answerFormat:"yes_no",mediaType:"none",timeLimit:30,
   defaultMaxPoints:1,wager:true,maxWager:5,
   questions:[{id:"rq",order:0,prompt:"P",correct:"Yes",accepted:[],maxPoints:1,mediaSource:"none"}]}]};
const rs = await post("/api/sessions", { quiz: rQuiz }, KEY);
const rHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${rs.joinCode}&role=host&key=${KEY}`);
const rT = await post("/api/join", { code: rs.joinCode, name: "Butterfingers" });
const rS = await open(`ws://127.0.0.1:${PORT}/ws?code=${rs.joinCode}&role=team&teamId=${rT.teamId}`);
await wait(150);
const rAct = (p2) => rHost.send(JSON.stringify({ type: "host", payload: p2 }));
rAct({ action: "begin_round" }); await wait(60);
rAct({ action: "reveal_question" }); await wait(60);
rS.send(JSON.stringify({ type: "set_wager", amount: 5 })); await wait(90);
rAct({ action: "start_timer" }); await wait(60);
rS.send(JSON.stringify({ type: "answer", questionId: "rq", value: "Yes" })); await wait(120);
rAct({ action: "lock" }); await wait(120);
assert(last(rHost).session.answers[`${rT.teamId}:rq`].points === 5, "the staked question scored first");

rAct({ action: "void_question", questionId: "rq" }); await wait(120);
assert(last(rHost).session.answers[`${rT.teamId}:rq`].points === 0, "voiding a question scores it zero");
assert(last(rHost).session.wagers[`${rT.teamId}:rq`] === undefined, "voiding returns the stake");

// Same name is normally refused...
const blocked = await post("/api/join", { code: rs.joinCode, name: "Butterfingers" }).catch(() => null);
assert(blocked === null, "a duplicate team name is refused while the team is live");
// ...until the host releases it for a replacement phone.
rAct({ action: "relink_team", teamId: rT.teamId }); await wait(120);
const replacement = await post("/api/join", { code: rs.joinCode, name: "Butterfingers" });
assert(replacement.teamId === rT.teamId, "a replacement phone takes over the same team, keeping its score");
assert(last(rHost).session.teams.length === 1, "re-linking doesn't create a second team");

/* Info pages interrupt and hand back, like a break. */
const infoQuiz = { ...secretQuiz, id:"info",
  infoSlides:[{id:"i1",title:"House rules",body:"No phones. Obviously ironic."}],
  theme:{ accent:"#B4472A", footer:"The Crown & Anchor" },
  rounds:[secretQuiz.rounds[0]] };
const inf = await post("/api/sessions", { quiz: infoQuiz }, KEY);
const infHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${inf.joinCode}&role=host&key=${KEY}`);
const infPres = await open(`ws://127.0.0.1:${PORT}/ws?code=${inf.joinCode}&role=presenter&token=${inf.presenterToken}`);
await wait(150);
const iAct = (p2) => infHost.send(JSON.stringify({ type: "host", payload: p2 }));
iAct({ action: "begin_round" }); await wait(70);
const wasShowing = last(infHost).session.state;
iAct({ action: "show_info", slideId: "i1" }); await wait(120);
assert(last(infHost).session.state === "info", "the host can put an info page on screen");
assert(last(infPres).session.state === "info", "the projector follows onto the info page");
assert(last(infPres).session.infoSlideId === "i1", "the projector knows which page");
iAct({ action: "show_info", slideId: "nope" }); await wait(100);
assert(last(infHost).session.infoSlideId === "i1", "an unknown page id is ignored");
iAct({ action: "hide_info" }); await wait(120);
assert(last(infHost).session.state === wasShowing, `dismissing hands back to where it interrupted (${wasShowing})`);
assert(last(infPres).session.quiz.theme?.footer === "The Crown & Anchor",
  "the theme reaches the projector");

/* Marking needs the answer key and the accepted spellings, so the host's
   snapshot must carry both. */
const markQuiz = { ...secretQuiz, id:"mark", infoSlides:[], theme:{}, rounds:[
  { id:"mr", order:0, title:"Marking", answerFormat:"text", mediaType:"none",
    timeLimit:30, defaultMaxPoints:1,
    questions:[{ id:"mq", order:0, prompt:"Symbol W?", correct:"Tungsten",
                 accepted:["wolfram","tungstene"], maxPoints:null, mediaSource:"none" }] }]};
const mk = await post("/api/sessions", { quiz: markQuiz }, KEY);
const mkHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${mk.joinCode}&role=host&key=${KEY}`);
await wait(150);
const mkQ = last(mkHost).session.quiz.rounds[0].questions[0];
assert(mkQ.correct === "Tungsten", "the marking screen has the configured answer");
assert(mkQ.accepted.join() === "wolfram,tungstene", "and the accepted spellings alongside it");

/* Paper mode: no team devices at all. The host owns the team list and the
   scoreboard, and the projector still runs the quiz. */
const paperQuiz = { ...secretQuiz, id:"paper", infoSlides:[], theme:{}, rounds:[
  { id:"pr1", order:0, title:"One", answerFormat:"text", mediaType:"none",
    timeLimit:30, defaultMaxPoints:1,
    questions:[{ id:"pq1", order:0, prompt:"P", correct:"A", accepted:[], maxPoints:null, mediaSource:"none" }] },
  { id:"pr2", order:1, title:"Two", answerFormat:"text", mediaType:"none",
    timeLimit:30, defaultMaxPoints:1,
    questions:[{ id:"pq2", order:0, prompt:"P", correct:"B", accepted:[], maxPoints:null, mediaSource:"none" }] }]};
const pap = await post("/api/sessions", { quiz: paperQuiz, scoring: "paper" }, KEY);
const papHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${pap.joinCode}&role=host&key=${KEY}`);
const papPres = await open(`ws://127.0.0.1:${PORT}/ws?code=${pap.joinCode}&role=presenter&token=${pap.presenterToken}`);
await wait(150);
assert(last(papHost).session.scoring === "paper", "a room can be opened in paper mode");

/* Omitting the mode must fall back to devices — that's what a request from an
   older client looks like, and it shouldn't silently become paper. */
const defaulted = await post("/api/sessions", { quiz: paperQuiz }, KEY);
const defHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${defaulted.joinCode}&role=host&key=${KEY}`);
await wait(150);
assert(last(defHost).session.scoring === "devices",
  "a room defaults to phones when no mode is sent");

assert(await rejects("/api/join", { code: pap.joinCode, name: "Chancers" }),
  "a phone can't join a paper quiz");

const pAct = (p2) => papHost.send(JSON.stringify({ type: "host", payload: p2 }));
pAct({ action: "add_team", name: "The Regulars" });
pAct({ action: "add_team", name: "Bar Staff" });
pAct({ action: "add_team", name: "The Regulars" });   // duplicate
await wait(180);
const pTeams = last(papHost).session.teams;
assert(pTeams.length === 2, `the host adds teams by hand (got ${pTeams.length})`);
assert(last(papPres).session.teams.length === 2, "the projector shows the team list instead of a join code");

pAct({ action: "begin_round" }); await wait(70);
pAct({ action: "reveal_question" }); await wait(70);
pAct({ action: "start_timer" }); await wait(70);
pAct({ action: "lock" }); await wait(70);
pAct({ action: "next_question" }); await wait(90);
assert(last(papHost).ungradedCount === 0, "nothing sits waiting to be marked in paper mode");

pAct({ action: "set_manual_score", teamId: pTeams[0].id, roundIdx: 0, points: 7 });
pAct({ action: "set_manual_score", teamId: pTeams[1].id, roundIdx: 0, points: 4 });
await wait(160);
let board = last(papHost).standings;
assert(board[0].name === "The Regulars" && board[0].score === 7,
  `typed scores drive the leaderboard (got ${board[0].name} ${board[0].score})`);
assert(last(papPres).standings[0].score === 7, "the projector's leaderboard agrees");

pAct({ action: "set_manual_score", teamId: pTeams[1].id, roundIdx: 1, points: 9 });
await wait(160);
board = last(papHost).standings;
assert(board[0].name === "Bar Staff" && board[0].score === 13,
  `scores accumulate across rounds (got ${board[0].name} ${board[0].score})`);

pAct({ action: "set_manual_score", teamId: pTeams[0].id, roundIdx: 0, points: 2 });
await wait(140);
assert(last(papHost).standings.find((x) => x.name === "The Regulars").score === 2,
  "a mistyped score can be corrected");

/* ---- security ---- */

/* The password is exchanged once for an expiring token; that token is what
   travels afterwards, including in the WebSocket query string where a
   password would end up in proxy logs. */
const authRes = await post("/api/auth", {}, KEY);
assert(typeof authRes.token === "string" && authRes.token.includes("."),
  "signing in issues a session token");
assert(!authRes.token.includes(KEY), "the token doesn't contain the password");
assert(!(await rejects("/api/sessions", { quiz: secretQuiz }, authRes.token)),
  "the token works in place of the password");
assert(await rejects("/api/sessions", { quiz: secretQuiz }, authRes.token.slice(0, -4) + "aaaa"),
  "a tampered token is refused");
assert(await rejects("/api/sessions", { quiz: secretQuiz }, "not.atoken"),
  "a made-up token is refused");

/* A token from a different password must not work — the signing key is
   derived from the credential, so changing it invalidates old tokens. */
const foreign = "eyJleHAiOjk5OTk5OTk5OTk5OTl9.AAAA";
assert(await rejects("/api/sessions", { quiz: secretQuiz }, foreign),
  "a token signed with something else is refused");

/* Guessing is rate limited rather than unlimited. */
let limited = false;
for (let i = 0; i < 14; i++) {
  const r = await fetch(`${API}/api/auth`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-guess" },
    body: "{}" });
  if (r.status === 429) { limited = true; break; }
}
assert(limited, "repeated wrong passwords get rate limited");

/* A whole venue shares one wifi address, so correct joins must never be
   charged against the guessing budget. */
const busy = await post("/api/sessions", { quiz: secretQuiz }, KEY);
for (let i = 0; i < 25; i++) {
  const r = await post("/api/join", { code: busy.joinCode, name: `Team ${i}` });
  assert.ok = true;
  if (r.error) { note_fail = `join ${i} was refused: ${r.error}`; break; }
}
assert(typeof note_fail === "undefined" || note_fail === null,
  "twenty-five teams can join from one address without being rate limited");

/* Headers that close off whole categories of problem. */
const headRes = await fetch(`${API}/api/health`);
assert(headRes.headers.get("x-content-type-options") === "nosniff", "nosniff is set");
assert(headRes.headers.get("x-frame-options") === "DENY", "the app can't be framed");
assert((headRes.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"),
  "a content security policy is set");
const pageRes = await fetch(`${API}/`);
assert(pageRes.headers.get("content-security-policy"), "static pages carry the policy too");

/* A multi-select team must know how many to tick without knowing which. */
const cntQuiz = { ...secretQuiz, id:"cnt", infoSlides:[], theme:{}, rounds:[
  { id:"cr", order:0, title:"C", answerFormat:"choice", mediaType:"none",
    timeLimit:30, defaultMaxPoints:3,
    questions:[{ id:"cq", order:0, prompt:"Which?", correct:"", accepted:[], maxPoints:3,
                 mediaSource:"none", multi:true, options:["2","4","7","9"],
                 correctOptions:["2","7"] }] }]};
const cnt = await post("/api/sessions", { quiz: cntQuiz }, KEY);
const cntTeam = await post("/api/join", { code: cnt.joinCode, name: "Counters" });
const cntWs = await open(`ws://127.0.0.1:${PORT}/ws?code=${cnt.joinCode}&role=team&teamId=${cntTeam.teamId}`);
await wait(200);
const cntQ = last(cntWs).session.quiz.rounds[0].questions[0];
assert((cntQ.correctOptions ?? []).length === 2,
  `a team is told how many to tick (got ${(cntQ.correctOptions ?? []).length})`);
assert((cntQ.correctOptions ?? []).every((x) => x === ""),
  "but not which ones — the values are blanked");

/* Spotting a typo in round seven has to be fixable in round two. Marking a
   past round while a later one is live must work, and must stick. */
const backQuiz = { ...secretQuiz, id:"back", infoSlides:[], theme:{}, rounds:[
  { id:"b1", order:0, title:"First", answerFormat:"text", mediaType:"none",
    timeLimit:30, defaultMaxPoints:2,
    questions:[{ id:"bq1", order:0, prompt:"P", correct:"Bulgakov", accepted:[], maxPoints:2, mediaSource:"none" }] },
  { id:"b2", order:1, title:"Second", answerFormat:"text", mediaType:"none",
    timeLimit:30, defaultMaxPoints:2,
    questions:[{ id:"bq2", order:0, prompt:"P", correct:"X", accepted:[], maxPoints:2, mediaSource:"none" }] }]};
const bk = await post("/api/sessions", { quiz: backQuiz }, KEY);
const bkHost = await open(`ws://127.0.0.1:${PORT}/ws?code=${bk.joinCode}&role=host&key=${KEY}`);
const bkT = await post("/api/join", { code: bk.joinCode, name: "Typos" });
const bkWs = await open(`ws://127.0.0.1:${PORT}/ws?code=${bk.joinCode}&role=team&teamId=${bkT.teamId}`);
await wait(150);
const backAct = (p2) => bkHost.send(JSON.stringify({ type: "host", payload: p2 }));
backAct({ action: "begin_round" }); await wait(60);
backAct({ action: "reveal_question" }); await wait(60);
backAct({ action: "start_timer" }); await wait(60);
bkWs.send(JSON.stringify({ type:"answer", questionId:"bq1", value:"Bulgacov" })); await wait(130);
backAct({ action: "lock" }); await wait(80);
backAct({ action: "grade", questionId:"bq1", teamIds:[bkT.teamId], points: 0 }); await wait(110);
assert(last(bkHost).session.answers[`${bkT.teamId}:bq1`].points === 0, "a near-miss was marked wrong");

// Move on two states, then go back and correct it.
backAct({ action: "next_question" }); await wait(80);
backAct({ action: "next_round" }); await wait(80);
backAct({ action: "reveal_question" }); await wait(80);
backAct({ action: "start_timer" }); await wait(80);
assert(last(bkHost).session.roundIdx === 1, "we're now in a later round");
backAct({ action: "grade", questionId:"bq1", teamIds:[bkT.teamId], points: 2 }); await wait(130);
assert(last(bkHost).session.answers[`${bkT.teamId}:bq1`].points === 2,
  "an earlier round can be re-marked while a later one is running");
assert(last(bkHost).standings.find((x) => x.teamId === bkT.teamId).score === 2,
  "and the leaderboard picks the correction up");

console.log("\nALL E2E CHECKS PASSED");
[host, pres, wsA2, wgsB].forEach(w => w.close());
process.exit(0);
