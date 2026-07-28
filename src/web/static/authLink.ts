// The token a magic link carries.
//
// The fragment, not the query string, and that is the point: a fragment is never
// sent to the server, so a link printed in a startup log and pasted into a
// browser does not put the secret into the server's own access log, nor into the
// `Referer` of anything the page later requests.
//
// `k` matches the name the EventSource URL already uses (searchModel.ts), which
// has to pass the token in a query string because browsers cannot attach headers
// to an EventSource.

/** The token in `#k=<token>`, or "" when the fragment carries none. */
export function tokenFromHash(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return "";
  return (new URLSearchParams(raw).get("k") ?? "").trim();
}
