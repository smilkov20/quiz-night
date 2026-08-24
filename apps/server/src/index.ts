import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { timingSafeEqual } from "node:crypto";
import type { ConnectionRole, Quiz } from "@quiz/shared";
import { CLOSE_NO_ROOM, CLOSE_UNAUTHORISED } from "@quiz/shared";
import { LiveSession } from "./session";

const PORT = Number(process.env.PORT ?? 8787);
import { hashPassword, isHash, verifyPassword, issueToken, verifyToken,
  tooManyFailures, recordFailure, clientIp } from "./auth";

const RAW_HOST_PASSWORD = process.env.HOST_PASSWORD ?? "";
const HOST_PASSWORD = RAW_HOST_PASSWORD.trim();
if (RAW_HOST_PASSWORD !== HOST_PASSWORD) {
  console.warn("HOST_PASSWORD had surrounding whitespace; using the trimmed value.");
}
if (HOST_PASSWORD && !isHash(HOST_PASSWORD)) {
  console.warn(
    "HOST_PASSWORD is stored in plain text. Run `pnpm hash-password` and put the\n" +
    "  result in HOST_PASSWORD instead, so the password itself isn't readable in\n" +
    "  your hosting dashboard. Both forms work."
  );
}
void hashPassword;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "*").split(",").map((s) => s.trim());

if (!HOST_PASSWORD) {
  console.error("HOST_PASSWORD is not set. Refusing to start — the host console would be open to anyone.");
  process.exit(1);
}

/** Live rooms, keyed by join code. In memory: sessions are disposable. */
const rooms = new Map<string, LiveSession>();

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
function newCode(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error("Could not allocate a join code");
}

/** Accepts either a scrypt hash (preferred) or plaintext (so an existing
    deployment keeps working). Both paths are constant-time. */
function checkPassword(supplied: string): boolean {
  return verifyPassword(supplied, HOST_PASSWORD);
}

/** Requests carry a short-lived token rather than the password itself. The
    password is only ever sent once, to /api/auth. */
function checkCredential(supplied: string): boolean {
  return verifyToken(supplied, HOST_PASSWORD) || checkPassword(supplied);
}

/** Twelve hours: longer than any quiz, shorter than a leaked token is useful. */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;


/** Applied to every response, JSON and static alike. `img-src https:` is
    deliberate — hosts paste their own picture and logo URLs — but scripts and
    frames are locked to this origin plus YouTube. */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com https://s.ytimg.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' https:",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

function corsHeaders(origin: string | undefined): Record<string, string> {
  const ok = ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin ?? "*" : ALLOWED_ORIGINS[0] ?? "",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

const send = (res: ServerResponse, status: number, body: unknown, origin?: string) => {
  res.writeHead(status, { "Content-Type": "application/json", ...SECURITY_HEADERS, ...corsHeaders(origin) });
  res.end(JSON.stringify(body));
};

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}") as T;
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  // Render pings this to know the service is up; it also serves as a way to
  // wake a sleeping instance before guests arrive.
  if (url.pathname === "/api/health") {
    return send(res, 200, { ok: true, rooms: rooms.size }, origin);
  }

  /* Lets the sign-in screen check the password up front. Without this the
     first failure happens at "Open the room", long after the mistake. */
  if (url.pathname === "/api/auth" && req.method === "POST") {
    const ip = clientIp(req.headers, req.socket.remoteAddress);
    const AUTH_WINDOW = 15 * 60 * 1000;
    // Ten wrong guesses a quarter-hour. Signing in correctly costs nothing,
    // so a host refreshing their console is never locked out.
    if (tooManyFailures(`auth:${ip}`, 10, AUTH_WINDOW)) {
      return send(res, 429, { error: "Too many attempts — wait a few minutes" }, origin);
    }
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!checkPassword(auth)) {
      recordFailure(`auth:${ip}`, AUTH_WINDOW);
      return send(res, 403, { error: "Wrong password" }, origin);
    }
    return send(res, 200, { ok: true, token: issueToken(HOST_PASSWORD, TOKEN_TTL_MS), expiresIn: TOKEN_TTL_MS }, origin);
  }

  /* Open a room. The quiz travels in the request body because quiz content
     lives in the host's browser — there is no server-side quiz store. */
  if (url.pathname === "/api/sessions" && req.method === "POST") {
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!checkCredential(auth)) return send(res, 403, { error: "Unauthorised" }, origin);
    try {
      const { quiz, scoring } = await readJson<{ quiz: Quiz; scoring?: "devices" | "paper" }>(req);
      if (!quiz?.rounds?.length) return send(res, 400, { error: "Quiz has no rounds" }, origin);
      const code = newCode();
      const room = new LiveSession(quiz, code, scoring === "paper" ? "paper" : "devices");
      room.onClosed = () => { rooms.delete(code); console.log(`[room] closed ${code}`); };
      rooms.set(code, room);
      console.log(`[room] opened ${code} — "${quiz.title}"`);
      return send(res, 200, { joinCode: code, presenterToken: room.session.presenterToken }, origin);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message }, origin);
    }
  }

  /* Open, because the join code is the only secret and the nominee needs to
     pick which team they belong to. */
  if (url.pathname === "/api/teams" && req.method === "GET") {
    const room = rooms.get((url.searchParams.get("code") ?? "").toUpperCase());
    if (!room) return send(res, 404, { error: "No such room" }, origin);
    return send(res, 200, room.session.teams.map((t) => ({
      id: t.id, name: t.name, hasNominee: Boolean(t.nomineeName),
    })), origin);
  }

  if (url.pathname === "/api/join" && req.method === "POST") {
    const joinIp = clientIp(req.headers, req.socket.remoteAddress);
    const JOIN_WINDOW = 10 * 60 * 1000;
    // Only wrong codes count, so a whole venue behind one wifi address can
    // join freely while code-guessing still gets shut down.
    if (tooManyFailures(`join:${joinIp}`, 20, JOIN_WINDOW)) {
      return send(res, 429, { error: "Too many attempts — wait a few minutes" }, origin);
    }
    try {
      const { code, name, token, asNomineeFor } = await readJson<{ code: string; name: string; token?: string; asNomineeFor?: string }>(req);
      const room = rooms.get((code ?? "").toUpperCase());
      if (!room) {
        recordFailure(`join:${joinIp}`, JOIN_WINDOW);
        return send(res, 404, { error: "No room with that code" }, origin);
      }
      const result = asNomineeFor
        ? room.joinAsNominee(asNomineeFor, name ?? "")
        : room.join(name ?? "", token ?? null);
      return "error" in result ? send(res, 400, result, origin) : send(res, 200, result, origin);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message }, origin);
    }
  }

  if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" }, origin);

  // Everything else is the frontend. Serving it from the same process means
  // one deploy, one origin, and no CORS to configure on a free tier.
  return serveStatic(url.pathname, res);
});

const WEB_ROOT = process.env.WEB_ROOT ?? join(process.cwd(), "../web/dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  // normalize() strips any ../ before it can escape the web root.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(WEB_ROOT, rel);

  // Belt and braces: whatever normalize() did, refuse to serve anything that
  // resolves outside the web root.
  const root = resolve(WEB_ROOT);
  if (!resolve(file).startsWith(root + sep) && resolve(file) !== root) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    // Unknown path: hand back index.html so /host and /present/... route
    // client-side rather than 404ing on a hard refresh.
    file = join(WEB_ROOT, "index.html");
  }
  try {
    const body = await readFile(file);
    const type = MIME[extname(file)] ?? "application/octet-stream";
    const immutable = file.includes("/assets/");
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      ...SECURITY_HEADERS,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found. Did you run `pnpm build`?");
  }
}

/* ---- websockets ---- */

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/ws") return socket.destroy();

  const code = (url.searchParams.get("code") ?? "").toUpperCase();
  const role = (url.searchParams.get("role") ?? "team") as ConnectionRole;
  const teamId = url.searchParams.get("teamId") ?? undefined;
  /* Close with an application code rather than destroying the socket. A
     destroyed socket looks identical to a dropped wifi connection, so the
     client can't tell "keep retrying" from "this room is gone" — which left
     phones from last week's quiz retrying a dead code forever. */
  const reject = (closeCode: number, reason: string) =>
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(closeCode, reason));

  const room = rooms.get(code);
  if (!room) return reject(CLOSE_NO_ROOM, "no-such-room");

  // A browser can't set headers on a WebSocket handshake, so the host key
  // and the presenter token ride in the query string.
  if (role === "host" && !checkCredential(url.searchParams.get("key") ?? "")) {
    return reject(CLOSE_UNAUTHORISED, "bad-host-key");
  }
  if (role === "presenter" && url.searchParams.get("token") !== room.session.presenterToken) {
    return reject(CLOSE_UNAUTHORISED, "bad-presenter-token");
  }

  wss.handleUpgrade(req, socket, head, (ws) => room.addSocket(ws, role, teamId));
});

/* Reap rooms nobody is connected to. Generous, because the host may be
   setting up well before anyone joins. */
const FOUR_HOURS = 4 * 60 * 60 * 1000;
setInterval(() => {
  for (const [code, room] of rooms) {
    const stale = Date.now() - room.session.createdAt > FOUR_HOURS;
    if (stale && room.connectionCount === 0) {
      room.dispose();
      rooms.delete(code);
      console.log(`[room] reaped ${code}`);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => console.log(`Quiz server listening on 0.0.0.0:${PORT}`));
