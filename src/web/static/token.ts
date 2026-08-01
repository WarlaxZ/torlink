/**
 * The bearer token, as the two pages of this bundle share it.
 *
 * The token is held in sessionStorage and sent as an Authorization header on
 * every API call. No cookie authenticates the API — but that does NOT mean there
 * is no CSRF vector, which is what this comment used to claim in app.ts: the
 * usual way to run the dashboard is with no token at all, and then there is no
 * credential to forge in the first place. A cross-origin page's POST would
 * simply have been authorized. The server rejects state-changing requests whose
 * Origin / Sec-Fetch-Site say cross-site (`daemon/auth.ts`,
 * `isCrossSiteRequest`); this page's own fetches are same-origin and unaffected.
 *
 * WHY IT LEFT app.ts. The player page is a separate document, and it now records
 * the episode it opened so Continue-watching keeps advancing when you jump
 * episode to episode without going back. That is a `POST /api/library`, which
 * needs the same token. `openPlayer` navigates the SAME TAB (`app.ts`), and
 * sessionStorage is per tab, so the token is simply there — but only if both
 * pages read the same key, which is exactly the copy-then-drift this codebase
 * has four recorded bugs from. Moved down rather than copied.
 */
const TOKEN_KEY = "torlnk.token";

/**
 * The stored token, or "".
 *
 * sessionStorage THROWS, rather than returning null, when storage is blocked
 * (Safari private mode, a hardened profile). Losing the remembered token is a
 * re-prompt on the dashboard and a skipped bookkeeping call on the player page;
 * letting it throw here would leave either page dead before it rendered.
 */
export function readStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeToken(value: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, value);
  } catch {
    /* not remembering the token is survivable; failing the unlock is not */
  }
}

/** The Authorization header for a token, or nothing when there is none. */
export function authHeadersFor(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
