import { QuizSession } from "./session";
import { QuizLibrary } from "./library";
import { seedQuiz } from "./seed";
import type { Quiz } from "@quiz/shared";

export interface Env {
  QUIZ_SESSION: DurableObjectNamespace<QuizSession>;
  QUIZ_LIBRARY: DurableObjectNamespace<QuizLibrary>;
  /** `wrangler secret put HOST_PASSWORD` */
  HOST_PASSWORD: string;
  /** Comma-separated origins allowed to call the API. */
  ALLOWED_ORIGINS: string;
}

export { QuizSession, QuizLibrary };

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

function cors(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes("*") || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin || "*" : allowed[0] ?? "",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

/** Shared password, per the plan — nothing fancy, but constant-time
    compared so the check can't be probed a character at a time. */
function isHost(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const supplied = header.replace(/^Bearer\s+/i, "");
  const expected = env.HOST_PASSWORD ?? "";
  if (supplied.length !== expected.length || !expected) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const library = (env: Env) => env.QUIZ_LIBRARY.get(env.QUIZ_LIBRARY.idFromName("library"));

/** Join codes map to session ids in KV-free fashion: the code *is* the
    object name, so a team typing K7QP2 lands on the right object. */
const sessionByCode = (env: Env, code: string) =>
  env.QUIZ_SESSION.get(env.QUIZ_SESSION.idFromName(`code:${code.toUpperCase()}`));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = cors(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    /* ---- websocket: /ws?code=XXXXX&role=team&teamId=... ---- */
    if (path === "/ws") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });
      if (url.searchParams.get("role") === "host" && !isHost(request, env)) {
        // Browsers can't set headers on a WebSocket handshake, so the host
        // key rides in the query string for this one route.
        if (url.searchParams.get("key") !== env.HOST_PASSWORD) {
          return new Response("Unauthorised", { status: 403 });
        }
      }
      return sessionByCode(env, code).fetch(request);
    }

    /* ---- quiz library (host only) ---- */
    if (path === "/api/quizzes") {
      if (!isHost(request, env)) return json({ error: "Unauthorised" }, { status: 403, headers });
      const lib = library(env);
      if (request.method === "GET") {
        let all = await lib.list();
        if (all.length === 0) all = [await lib.save(seedQuiz)];
        return json(all, { headers });
      }
      if (request.method === "POST") {
        const quiz = (await request.json()) as Quiz;
        return json(await lib.save(quiz), { headers });
      }
    }

    const quizMatch = path.match(/^\/api\/quizzes\/([\w-]+)$/);
    if (quizMatch) {
      if (!isHost(request, env)) return json({ error: "Unauthorised" }, { status: 403, headers });
      const lib = library(env);
      const id = quizMatch[1];
      if (request.method === "GET") {
        const q = await lib.get(id);
        return q ? json(q, { headers }) : json({ error: "Not found" }, { status: 404, headers });
      }
      if (request.method === "DELETE") {
        await lib.remove(id);
        return json({ ok: true }, { headers });
      }
    }

    /* ---- open a room (host only) ---- */
    if (path === "/api/sessions" && request.method === "POST") {
      if (!isHost(request, env)) return json({ error: "Unauthorised" }, { status: 403, headers });
      const { quizId } = (await request.json()) as { quizId: string };
      const quiz = await library(env).get(quizId);
      if (!quiz) return json({ error: "No such quiz" }, { status: 404, headers });

      // Retry until an unused code turns up. At this scale, first try.
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = randomCode();
        const stub = sessionByCode(env, code);
        if (await stub.info()) continue;
        const created = await stub.create(quiz, code);
        return json(created, { headers });
      }
      return json({ error: "Could not allocate a code" }, { status: 503, headers });
    }

    /* ---- join a room (open) ---- */
    if (path === "/api/join" && request.method === "POST") {
      const { code, name, token } = (await request.json()) as {
        code: string; name: string; token?: string;
      };
      if (!code) return json({ error: "Missing code" }, { status: 400, headers });
      const result = await sessionByCode(env, code).joinTeam(name ?? "", token ?? null);
      if ("error" in result) return json(result, { status: 400, headers });
      return json(result, { headers });
    }

    if (path === "/api/health") return json({ ok: true }, { headers });

    return json({ error: "Not found" }, { status: 404, headers });
  },
};

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomCode(len = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
