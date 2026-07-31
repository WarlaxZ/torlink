import { resolveReccConfig, type Config } from "../config/config";

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
export function shouldProvision(config: Config): boolean {
  // `=== false` would be the obvious test and it is WRONG here. This is the
  // only boolean in Config whose absent state means ON, so it is the only one
  // where the usual `=== true` idiom inverts. config.json is hand-editable, and
  // a user who opts out by writing "no", "false", or 0 has written a value that
  // is not `=== false` — with the obvious test they would be signed up anyway,
  // having explicitly asked not to be. So: absent or exactly `true` is on;
  // anything else present is an opt-out. It fails safe in the direction of not
  // contacting a third-party host, which is the only safe direction here.
  const auto = config.reccAutoSignup;
  if (auto !== undefined && auto !== true) return false;
  const { reccUrl, reccToken } = resolveReccConfig(config);
  if (reccToken) return false;
  if (reccUrl && normaliseUrl(reccUrl) !== DEFAULT_RECC_URL) return false;
  return true;
}
