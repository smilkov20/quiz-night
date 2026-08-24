import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

/* Everything here uses node:crypto — no dependencies, nothing to keep patched.
   This protects a shared password for a pub quiz, not a bank: the threat is a
   bored guest with devtools, not a determined attacker. The measures are sized
   accordingly, and the README says so plainly. */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** `scrypt$<salt hex>$<hash hex>` — salt and parameters travel with the hash. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(plain.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function isHash(value: string): boolean {
  return /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(value.trim());
}

/** Constant-time throughout: a wrong password must take the same time to
    reject whether the first character matched or the last. */
export function verifyPassword(plain: string, stored: string): boolean {
  const supplied = (plain ?? "").normalize("NFKC");
  if (!supplied) return false;

  if (isHash(stored)) {
    const [, saltHex, hashHex] = stored.trim().split("$");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(supplied, Buffer.from(saltHex, "hex"), expected.length, SCRYPT);
    return timingSafeEqual(expected, actual);
  }

  // Plaintext fallback, so an existing deployment doesn't lock itself out.
  const expected = Buffer.from(stored.trim(), "utf8");
  const actual = Buffer.from(supplied, "utf8");
  if (expected.length !== actual.length) {
    // Still do the work, so length isn't leaked by timing.
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/* ---------- session tokens ----------
   The password shouldn't travel on every request, and it certainly shouldn't
   sit in a WebSocket query string, which lands in proxy and access logs. So
   it's exchanged once for a signed, expiring token. */

const b64url = (b: Buffer) => b.toString("base64url");

/** Derived from the stored credential, so changing the password invalidates
    every token that was issued under the old one. */
function signingKey(stored: string): Buffer {
  return createHash("sha256").update(`quiz-night-token:${stored}`).digest();
}

export function issueToken(stored: string, ttlMs: number): string {
  const payload = b64url(Buffer.from(JSON.stringify({
    exp: Date.now() + ttlMs,
    jti: randomBytes(9).toString("hex"),
  })));
  const sig = b64url(createHmac("sha256", signingKey(stored)).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyToken(token: string, stored: string): boolean {
  const parts = (token ?? "").split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;

  const expected = createHmac("sha256", signingKey(stored)).update(payload).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, "base64url"); } catch { return false; }
  if (given.length !== expected.length) return false;
  if (!timingSafeEqual(expected, given)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof exp === "number" && Date.now() < exp;
  } catch {
    return false;
  }
}

/* ---------- rate limiting ----------
   A five-character join code and a shared password are both guessable given
   enough attempts. This makes "enough attempts" take longer than a quiz. */

interface Bucket { hits: number[]; }
const buckets = new Map<string, Bucket>();

/* Only failures count. In a pub every team shares one wifi address, so
   charging successful joins against the same budget would lock out the back
   half of the room — and the thing worth limiting is guessing, which fails by
   definition. */
export function tooManyFailures(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket) return false;
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  return bucket.hits.length >= limit;
}

export function recordFailure(key: string, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  bucket.hits.push(now);
  buckets.set(key, bucket);
}

// Keeps the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.hits.every((t) => now - t > 3_600_000)) buckets.delete(key);
  }
}, 600_000).unref();

/** Render and most proxies put the real client address here. */
export function clientIp(headers: Record<string, string | string[] | undefined>, fallback?: string): string {
  const fwd = headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw?.split(",")[0] ?? fallback ?? "unknown").trim();
}
