#!/usr/bin/env node
/* The end-to-end suite drives the server directly, so it passes happily while
   a feature is unreachable from the interface — which is exactly how paper
   mode shipped with no way to turn it on. This checks the wiring instead:
   every action the protocol defines is sent from somewhere in the web app,
   every answer format is offered in the editor, and every user-facing control
   survives into the built bundle. */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const problems = [];
const fail = (m) => problems.push(m);

function readAll(dir) {
  let out = "";
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out += readAll(p);
    else if (/\.(ts|tsx)$/.test(entry)) out += readFileSync(p, "utf8");
  }
  return out;
}

const web = readAll(join(root, "apps/web/src"));
const server = readFileSync(join(root, "apps/server/src/session.ts"), "utf8")
  + readFileSync(join(root, "apps/server/src/index.ts"), "utf8");
const protocol = readFileSync(join(root, "packages/shared/src/protocol.ts"), "utf8");
const types = readFileSync(join(root, "packages/shared/src/types.ts"), "utf8");

/* ---- 1. every host action is both handled and reachable ---- */
const actions = [...protocol.matchAll(/action: z\.literal\("(\w+)"\)/g)].map((m) => m[1]);
for (const a of actions) {
  if (!server.includes(`case "${a}"`)) fail(`host action "${a}" is defined but the server never handles it`);
  if (!web.includes(`"${a}"`)) fail(`host action "${a}" is defined but nothing in the UI sends it`);
}

/* ---- 2. every client message is handled and sent ---- */
const messages = [...protocol.matchAll(/type: z\.literal\("(\w+)"\)/g)].map((m) => m[1]);
for (const t of messages) {
  if (!server.includes(`msg.type === "${t}"`)) fail(`client message "${t}" is never handled by the server`);
  if (!web.includes(`type: "${t}"`)) fail(`client message "${t}" is never sent by the UI`);
}

/* ---- 3. every answer format can be chosen and is marked ---- */
const formats = [...types.matchAll(/^\s*\| "(\w+)"(?=\s*$|\s*\/)/gm)]
  .map((m) => m[1])
  .filter((f) => ["yes_no", "text", "choice", "fastest", "sort", "order", "list", "match", "nominee", "clues"].includes(f));
const editor = readFileSync(join(root, "apps/web/src/surfaces/Editor.tsx"), "utf8");
for (const f of new Set(formats)) {
  if (!editor.includes(`value="${f}"`)) fail(`answer format "${f}" has no option in the editor`);
  if (!server.includes(`answerFormat === "${f}"`) && f !== "text") {
    fail(`answer format "${f}" is never scored by the server`);
  }
}

/* ---- 4. every route the client calls exists ---- */
for (const [, path] of web.matchAll(/apiFetch<[^>]*>\(\s*`?["`](\/api\/[\w/]+)/g)) {
  const route = path.replace(/\/$/, "");
  if (!server.includes(`"${route}"`)) fail(`the UI calls ${route}, which the server doesn't serve`);
}

/* ---- 5. controls that must survive into the built bundle ----
   A string here means a real control a host or team can actually reach. */
const MUST_REACH = {
  "paper scoring toggle": "On paper",
  "presenter link": "Open presenter",
  "break control": "Take a break",
  "info pages": "Show a page",
  "score backup": "Scores",
  "close the room": "Close the room",
  "team rename": "Rename team",
  "team re-link": "Re-link a dead phone",
  "power-ups": "Power-ups",
  "speed round commit": "Lock it in",
  "wager stake": "Place your stake",
  "ordering round": "Tap in order",
  "sorting round": "tap a word to pick it up",
  "list round": "named",
  "nominee join": "I'm my team's nominee",
  "leave escape hatch": "Join a different quiz",
  "marking answer key": "Also accept",
  "round explainer": "Explain how this round works",
  "theme editor": "Look and feel",
  "tiebreaker editor": "Tiebreaker",
};
const distDir = join(root, "apps/web/dist/assets");
if (!existsSync(distDir)) {
  fail("no built bundle found — run `pnpm --filter @quiz/web build` first");
} else {
  const bundle = readdirSync(distDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(distDir, f), "utf8"))
    .join("");
  for (const [feature, marker] of Object.entries(MUST_REACH)) {
    if (!bundle.includes(marker)) fail(`${feature}: "${marker}" never made it into the built app`);
  }
}

/* ---- 6. things that must never reach a team ----
   Redaction keeps the *count* of correct options so a team knows it's looking
   for three, and blanks the values. So reading `.length` is fine and reading
   a value is not. Anything else touching an answer is a leak. */
const teamSurface = readFileSync(join(root, "apps/web/src/surfaces/Team.tsx"), "utf8");
const answerReads = teamSurface
  .split("\n")
  .map((line, i) => ({ line: line.trim(), n: i + 1 }))
  .filter(({ line }) => /\bq\.correct\b|\bquestion\.correct\b|correctOptions/.test(line))
  .filter(({ line }) =>
    // The count, and the type annotation that declares it, are both allowed.
    !/\(question\.correctOptions \?\? \[\]\)\.length/.test(line) &&
    !/correctOptions\?: string\[\]/.test(line) &&
    !/describeAnswer\(/.test(line));
for (const { line, n } of answerReads) {
  fail(`Team.tsx:${n} reads an answer directly — teams only ever get redacted data: ${line.slice(0, 70)}`);
}

console.log(`Checked ${actions.length} host actions, ${messages.length} client messages, ` +
  `${new Set(formats).size} answer formats, ${Object.keys(MUST_REACH).length} controls.`);
console.log(problems.length
  ? `\n${problems.length} WIRING PROBLEM(S):\n  - ` + problems.join("\n  - ")
  : "\nEverything defined is reachable.");
process.exit(problems.length ? 1 : 0);
