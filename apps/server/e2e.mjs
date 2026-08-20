import WebSocket from "ws";
const PORT = process.env.PORT ?? "8899";
const API = `http://127.0.0.1:${PORT}`;
const KEY = "test-password";
const post = async (p, body, auth) => {
  const r = await fetch(API + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${KEY}` } : {}) },
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

const { joinCode, presenterToken } = await post("/api/sessions", { quiz }, true);
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

let badHost = false;
try { await open(`ws://127.0.0.1:${PORT}/ws?code=${joinCode}&role=host&key=wrong`); } catch { badHost = true; }
assert(badHost, "wrong host password refused at upgrade");

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

console.log("\nALL E2E CHECKS PASSED");
[host, pres, wsA2, wsB].forEach(w => w.close());
process.exit(0);
