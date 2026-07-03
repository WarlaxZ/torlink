import { promises as fs } from "node:fs";
import { rutrackerFile } from "../../config/paths";
import { serializeWrites, writeJsonAtomic } from "../../util/atomic";
import { fetchResilient, HttpError, USER_AGENT } from "../../util/net";

export class AuthRequiredError extends Error {
  constructor(message = "Rutracker needs login") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export const RUTRACKER_HOSTS = ["rutracker.org", "rutracker.net", "rutracker.nl"];

export interface RutrackerSession {
  cookie: string;
  username?: string;
  savedAt: number;
}

const decoder = new TextDecoder("windows-1251");

export function decodeCp1251(buf: ArrayBuffer): string {
  return decoder.decode(buf);
}

const HIGH_BYTE = new Map<string, number>();
for (let b = 0x80; b <= 0xff; b++) {
  const ch = decoder.decode(new Uint8Array([b]));
  if (ch && ch !== "�") HIGH_BYTE.set(ch, b);
}

function encodeCp1251Form(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out += encodeURIComponent(ch);
    } else {
      const byte = HIGH_BYTE.get(ch);
      out += byte === undefined ? "%3F" : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

let current: RutrackerSession | null = null;
let loaded = false;
const write = serializeWrites();

export async function loadSession(): Promise<RutrackerSession | null> {
  if (loaded) return current;
  loaded = true;
  try {
    const raw = await fs.readFile(rutrackerFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<RutrackerSession>;
    if (parsed && typeof parsed.cookie === "string" && parsed.cookie) {
      current = {
        cookie: parsed.cookie,
        username: typeof parsed.username === "string" ? parsed.username : undefined,
        savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
      };
    }
  } catch {
    current = null;
  }
  return current;
}

export function getSession(): RutrackerSession | null {
  return current;
}

async function saveSession(session: RutrackerSession): Promise<void> {
  current = session;
  loaded = true;
  await write(() => writeJsonAtomic(rutrackerFile, session));
}

export async function clearSession(): Promise<void> {
  current = null;
  loaded = true;
  await write(() => fs.rm(rutrackerFile, { force: true }));
}

// CP1251 bytes for the RuTracker login submit button value ("вход").
const LOGIN_SUBMIT = "%E2%F5%EE%E4";

export function pickCookies(setCookie: string[]): string | null {
  const wanted = new Map<string, string>();
  for (const line of setCookie) {
    const pair = line.split(";", 1)[0]!.trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;

    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);

    if (name === "bb_session" && (!value || value === "deleted")) return null;
    if (name.startsWith("bb_")) wanted.set(name, value);
  }
  if (!wanted.has("bb_session")) return null;
  return [...wanted].map(([k, v]) => `${k}=${v}`).join("; ");
}

export interface Captcha {
  sid: string;
  field: string;
  imageUrl: string;
}

export type LoginOutcome =
  | { kind: "ok"; session: RutrackerSession }
  | { kind: "captcha"; captcha: Captcha }
  | { kind: "failed"; message: string };

export function parseCaptcha(html: string): Captcha | null {
  const sid = html.match(/name="cap_sid"\s+value="([^"]+)"/i)?.[1];
  const field = html.match(/name="(cap_code_[^"]+)"/i)?.[1];
  const img = html.match(/<img[^>]+src="([^"]*captcha[^"]*)"/i)?.[1];
  if (!sid || !field || !img) return null;
  const imageUrl = img.startsWith("//") ? `https:${img}` : img;
  return { sid, field, imageUrl };
}

export interface LoginCaptchaAnswer {
  sid: string;
  field: string;
  code: string;
}

export async function login(
  username: string,
  password: string,
  opts: { signal?: AbortSignal; captcha?: LoginCaptchaAnswer } = {},
): Promise<LoginOutcome> {
  const u = username.trim();
  if (!u || !password) return { kind: "failed", message: "Enter a username and password." };

  let body =
    `login_username=${encodeCp1251Form(u)}` +
    `&login_password=${encodeCp1251Form(password)}` +
    `&login=${LOGIN_SUBMIT}`;
  if (opts.captcha) {
    body +=
      `&cap_sid=${encodeURIComponent(opts.captcha.sid)}` +
      `&${encodeURIComponent(opts.captcha.field)}=${encodeCp1251Form(opts.captcha.code)}`;
  }

  let lastError: unknown;
  for (const host of RUTRACKER_HOSTS) {
    try {
      const res = await fetchResilient(`https://${host}/forum/login.php`, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        redirect: "manual",
        signal: opts.signal,
        retries: 1,
      });

      const cookie = pickCookies(res.headers.getSetCookie());
      if (cookie) {
        const session: RutrackerSession = { cookie, username: u, savedAt: Date.now() };
        await saveSession(session);
        return { kind: "ok", session };
      }

      const captcha = parseCaptcha(decodeCp1251(await res.arrayBuffer()));
      if (captcha) return { kind: "captcha", captcha };
      return {
        kind: "failed",
        message: opts.captcha
          ? "Incorrect captcha or credentials."
          : "Login failed — check your username and password.",
      };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastError = e;
    }
  }

  throw lastError instanceof Error ? lastError : new HttpError(0, "Rutracker unreachable");
}
