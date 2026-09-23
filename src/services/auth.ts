import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

/** Format: scrypt$<salt base64>$<hash base64>. Uses Node's built-in scrypt, so no native dependencies. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, PARAMS);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length, PARAMS);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const SESSION_COOKIE = "sr_admin";
export const SESSION_HOURS = 12;

/** Session cookie value: "<issuedAtMs>.<random>". The cookie itself is signed by @fastify/cookie. */
export function newSessionValue(now = Date.now()): string {
  return `${now}.${randomBytes(12).toString("base64url")}`;
}

export function isSessionFresh(value: string, now = Date.now()): boolean {
  const issued = Number(value.split(".")[0]);
  return Number.isFinite(issued) && issued <= now && now - issued < SESSION_HOURS * 3_600_000;
}

/** CSRF token bound to the session, so it can't be reused across logins. */
export function csrfToken(secret: string, sessionValue: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionValue}`).digest("base64url");
}

export function csrfMatches(secret: string, sessionValue: string, submitted: unknown): boolean {
  if (typeof submitted !== "string") return false;
  const expected = Buffer.from(csrfToken(secret, sessionValue));
  const actual = Buffer.from(submitted);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
