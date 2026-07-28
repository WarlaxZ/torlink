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

// One decoding quirk, worth knowing before someone rediscovers it with `node -e`:
// URLSearchParams is form-decoding, so a *raw* `+` in the fragment becomes a
// space. Links this codebase prints cannot hit that — webUrl builds them with
// encodeURIComponent, which writes `%2B`, and that decodes back to a literal `+`
// — so it takes a hand-edited address bar to corrupt a token containing one. The
// existing EventSource `?k=` param has always behaved the same way.

/** The token in `#k=<token>`, or "" when the fragment carries none. */
export function tokenFromHash(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return "";
  return (new URLSearchParams(raw).get("k") ?? "").trim();
}
