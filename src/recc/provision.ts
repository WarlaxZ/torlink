import { promises as fs } from "node:fs";
import path from "node:path";
import {
  loadConfig,
  resolveReccConfig,
  saveConfig,
  withProfileReccAccount,
  type Config,
} from "../config/config";
import { reccProvisionLockFile, reccProvisionLockFileForProfile } from "../config/paths";
import { OWNER_PROFILE, isOwnerProfile } from "../core/profile";
import type { FetchImpl } from "../util/net";
import { log } from "../util/logger";

/**
 * The hosted reccd. Defined here and imported everywhere else — a second copy
 * of this string is the copy-then-drift bug this codebase already records four
 * of.
 */
export const DEFAULT_RECC_URL = "https://reccd.stream";

function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Whether to auto-provision an anonymous account. This is the whole policy for
 * "does torlink make an outbound request on first run", deliberately separated
 * from the doing of it so it is testable without a filesystem or a network.
 *
 * Three conditions, all of which must hold:
 *
 * 1. No token yet, from config OR env. A token means an account exists.
 * 2. No reccUrl, or one that is already the default host. Any OTHER URL is a
 *    self-hosted reccd: signing up against it guesses at an endpoint their
 *    deployment may not have, and signing up against the hosted one instead
 *    ignores what they configured. Both are wrong, so do nothing — the Accounts
 *    pane already reports "Unreachable" or "Token rejected", which names the
 *    problem. Equalling the default covers the user who typed the host in by
 *    hand and left the token blank.
 * 3. Not opted out. Absent means opted in: a fresh install has no config.json.
 */
export function shouldProvision(config: Config, profileId: string = OWNER_PROFILE): boolean {
  // `=== false` would be the obvious test and it is WRONG here. This is the
  // only boolean in Config whose absent state means ON, so it is the only one
  // where the usual `=== true` idiom inverts. config.json is hand-editable, and
  // a user who opts out by writing "no", "false", or 0 has written a value that
  // is not `=== false` — with the obvious test they would be signed up anyway,
  // having explicitly asked not to be. So: absent or exactly `true` is on;
  // anything else present is an opt-out. It fails safe in the direction of not
  // contacting a third-party host, which is the only safe direction here.
  //
  // reccAutoSignup is a single install-wide switch: opting out turns off signup
  // for the owner AND every friend. The token check, though, is per profile —
  // the owner having an account says nothing about whether a friend needs one.
  const auto = config.reccAutoSignup;
  if (auto !== undefined && auto !== true) return false;
  const { reccUrl, reccToken } = resolveReccConfig(config, profileId);
  if (reccToken) return false;
  if (reccUrl && normaliseUrl(reccUrl) !== DEFAULT_RECC_URL) return false;
  return true;
}

/** What provisioning wrote. Handed to `onProvisioned` and applied to config. */
export interface ProvisionedPatch {
  reccUrl: string;
  reccToken: string;
  reccAccountName: string;
  reccAccountClaimed: false;
}

export interface EnsureReccAccountOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  lockFile?: string;
  loadConfigImpl?: () => Promise<Config>;
  saveConfigImpl?: (config: Config) => Promise<void>;
  /**
   * Called after a successful write, with what was written.
   *
   * The TUI MUST pass this. `App.tsx`'s persistConfig writes the whole config
   * object from React state, so a config.json written behind that state's back
   * is reverted by the next unrelated setting change — the user's brand-new
   * account, silently deleted when they change the sort. The callback applies
   * the patch to React state WITHOUT re-saving, so the two agree.
   *
   * `runServe` passes nothing: it holds no equivalent snapshot, and routes.ts
   * calls loadConfig() per request.
   */
  onProvisioned?: (patch: ProvisionedPatch) => void;
  /** Which profile to provision. Defaults to the owner (top-level fields). */
  profileId?: string;
}

const LOCK_STALE_MS = 60_000;

/** True if the lock was taken. Never throws. */
async function takeLock(lockFile: string): Promise<boolean> {
  // configDir does not exist on a fresh install: nothing creates it until the
  // first saveConfig, and provisioning runs BEFORE any config write. Without
  // this, `wx` fails ENOENT, takeLock reports "someone holds the lock", and the
  // one run this feature exists for is the one run it skips.
  await fs.mkdir(path.dirname(lockFile), { recursive: true }).catch(() => {});

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lockFile, "wx");
      await handle.close();
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") return false; // unwritable dir, permissions — give up quietly
      let ageMs = 0;
      try {
        ageMs = Date.now() - (await fs.stat(lockFile)).mtimeMs;
      } catch {
        continue; // vanished between open and stat — try to take it
      }
      if (ageMs < LOCK_STALE_MS) return false; // another process is mid-signup
      // Stale: a process died holding it. Clear it and try once more.
      //
      // Known bounded race: two processes can both observe the same >60s-old
      // lock, both unlink and retry — A re-creates it, then B's unlink removes
      // A's fresh lock, and B's `wx` succeeds too. Reaching this needs a
      // laptop-sleep or a crash mid-signup. The read-modify-write bounds the
      // cost to one extra orphan account on reccd: whichever of A/B finishes
      // second re-reads config, sees the other's token, and discards its own.
      // The same unconditional `unlink` in the outer `finally` can, after such
      // a takeover, remove a lock that is not the caller's own — same family,
      // same bounded cost.
      try {
        await fs.unlink(lockFile);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function isAnonSignupBody(v: unknown): v is { name: string; token: string } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.name === "string" && typeof r.token === "string" && r.token.trim().length > 0;
}

/**
 * Create an anonymous reccd account on the hosted service, once, if the user
 * has nothing configured. Fire-and-forget: resolves to nothing, never rejects,
 * and a failure means recommendations stay unavailable and nothing else.
 *
 * Call it as `void ensureReccAccount({...}).catch(() => {})` — the explicit
 * catch is what stops an unhandled rejection taking the process down, which is
 * the exact hazard routes.ts documents for reccd's other fire-and-forget calls.
 *
 * Single attempt, deliberately, and NOT fetchResilient: retrying into a rate
 * limit or an outage piles up concurrent requests at the worst possible moment.
 * The next launch tries again, which is one request per launch and
 * self-limiting.
 */
export async function ensureReccAccount(opts: EnsureReccAccountOptions = {}): Promise<void> {
  const profileId = opts.profileId ?? OWNER_PROFILE;
  const load = opts.loadConfigImpl ?? loadConfig;
  const save = opts.saveConfigImpl ?? saveConfig;
  const lockFile = opts.lockFile
    ?? (isOwnerProfile(profileId) ? reccProvisionLockFile : reccProvisionLockFileForProfile(profileId));
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);

  try {
    if (!shouldProvision(await load(), profileId)) return;
    if (!(await takeLock(lockFile))) {
      log.debug("recc provision: another process holds the lock, skipping");
      return;
    }
    try {
      const res = await fetchImpl(`${DEFAULT_RECC_URL}/signup/anonymous`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
      if (!res.ok) {
        log.debug(`recc provision: signup returned ${res.status}`);
        return;
      }
      const body: unknown = await res.json();
      if (!isAnonSignupBody(body)) {
        log.debug("recc provision: unexpected signup response shape");
        return;
      }

      // Read-modify-write, per CLAUDE.md: never a snapshot held across the
      // network call. Re-check the WHOLE gate against fresh state, not just
      // the token: the user may have pointed reccUrl at their own reccd while
      // we were waiting, and clobbering that is precisely what shouldProvision
      // exists to prevent. If anything in the gate no longer holds, the new
      // account is discarded — an orphan account on reccd is a far smaller
      // problem than overwriting what the user configured.
      const fresh = await load();
      if (!shouldProvision(fresh, profileId)) {
        log.debug("recc provision: config changed under us, discarding the new account");
        return;
      }
      const patch: ProvisionedPatch = {
        reccUrl: DEFAULT_RECC_URL,
        reccToken: body.token,
        reccAccountName: body.name,
        reccAccountClaimed: false,
      };
      // withProfileReccAccount routes the write: owner → top-level (exactly the old
      // `{ ...fresh, ...patch }` minus reccUrl, which the owner already has by now),
      // friend → profiles[id]. reccUrl stays as the caller's; the owner keeps its
      // existing one and a friend shares the same host.
      await save(withProfileReccAccount(fresh, profileId, {
        reccToken: patch.reccToken,
        reccAccountName: patch.reccAccountName,
        reccAccountClaimed: patch.reccAccountClaimed,
        reccUrl: patch.reccUrl,
      }));
      opts.onProvisioned?.(patch);
      log.debug(`recc provision: created anonymous account ${body.name} for profile ${profileId}`);
    } finally {
      await fs.unlink(lockFile).catch(() => {});
    }
  } catch (err) {
    // Spec §0. Everything — a filesystem error, a malformed body, an aborted
    // request, a failed save — ends here, and torlink carries on unchanged.
    log.debug(`recc provision: ${err instanceof Error ? err.message : String(err)}`);
  }
}
