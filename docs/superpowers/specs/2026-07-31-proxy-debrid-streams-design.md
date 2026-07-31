# Proxying debrid streams through the box

Date: 2026-07-31
Status: design, approved for planning

## The problem

When a session is debrid-backed, `GET /stream/:sid/:idx` answers `302` with the
provider's unrestricted link and the viewer's browser talks straight to their CDN
(`src/web/stream.ts:407`). That is excellent for bandwidth — zero bytes through
this process — and it has two consequences worth changing under some
circumstances:

1. **The viewer is handed a credential.** An unrestricted link is a bearer URL
   against the account: anyone who obtains it can pull the file until it expires,
   with no token and no further authentication. The code already treats it as a
   secret everywhere else — it is never logged, never put in a session body, and
   `wire.ts` says so at length — and then the redirect hands it to the client.
2. **Every viewer reaches the provider from their own IP.** For one person that is
   simply how it works. For a household or a few people sharing one account it
   means many source addresses against one account.

This adds an opt-in mode where the bytes come from this machine instead: one
egress IP, and the unrestricted link never leaves the server.

**The first reason is the stronger one and should lead the documentation.** It is
a straightforward reduction in credential exposure that applies to a single user
with no sharing involved.

### Stated plainly, once

Sharing a debrid account is against Real-Debrid's terms of service, and they
enforce on more than IP diversity — concurrent-connection and device limits apply
regardless of where the traffic originates. Whether to run this mode is the
operator's decision; this document records the constraint rather than arguing
about it. TorBox's position was not researched for this spec and should not be
assumed to be more permissive.

## What this costs

Not just "bandwidth" — **doubled bandwidth, landing on the upstream side**, which
is the half most connections have least of. Every byte is pulled down from the
provider and pushed back up to the viewer.

| Viewers | 1080p remux ≈ 25 Mbps | 4K remux ≈ 80 Mbps |
| --- | --- | --- |
| 1 | 25 Mbps down + 25 up | 80 down + 80 up |
| 3 | 75 down + 75 up | 240 down + 240 up |

A LAN viewer costs upstream nothing — that leg never leaves the switch — so the
number that matters is remote viewers. Three remote viewers of a 1080p remux need
~75 Mbps of *upload*, which most domestic lines do not have.

CPU is not a factor. The existing proxy is `up.pipe(res)` — socket to socket,
backpressure handled by Node, no decode and no re-encode. A stream is a few
percent of a core.

Two smaller costs: the provider's CDN edge is no longer adjacent to the viewer, so
every seek is a round trip through this box; and each viewer holds an upstream
socket open for the duration.

## Scope

**In scope.** One config flag that makes debrid media *and* the provider HLS path
flow through this server.

**Out of scope, deliberately.** Any automatic per-client decision — proxy remote
viewers, redirect LAN ones. It is the more efficient design and it was considered
and rejected for now: it needs private-range detection on the socket address,
which is wrong behind a reverse proxy and therefore interacts with `trustProxy`,
and the all-or-nothing flag is nearly as good because the wasted case (a LAN
viewer being proxied) costs only doubled *downstream*. Revisit if the upstream
bill becomes the complaint.

**Depends on** the provider-transcode work (rung 2). Section "The HLS half" below
is meaningless without it.

## Design

### The flag

`Config.proxyDebridStreams?: boolean`, absent/false meaning today's behaviour.

**TUI-only**, and this is the *configuration* exemption `CLAUDE.md` names: tokens,
sources, limits, folders and DNS are all TUI-only on purpose because the web is a
client of that config rather than an editor of it. Nothing in the browser needs to
know the flag's value either — see "No new capability flag" below.

### The media half

`proxyUpstream` (`src/web/stream.ts:441`) currently refuses any scheme that is not
`http:`, with a comment saying it exists only for the loopback WebTorrent server.
Debrid links are `https:`.

**Do not loosen that globally.** It takes an explicit allow-list per call:

- the WebTorrent path passes `["http:"]` — its invariant is unchanged, and the
  existing tests keep proving it;
- the debrid path passes `["http:", "https:"]`.

It also needs **bounded redirect following**. `http.request` does not follow
redirects and a provider's `download` URL can `302` to a specific CDN node. Three
hops, `http:`/`https:` only, with the `Range` header re-sent on each hop —
dropping it there would silently restart a seek from byte zero.

Everything else about the proxy stays: `Range` and `If-Range` forwarded, the
`PASS_THROUGH` response headers, `up.pipe(res)` for backpressure.

### The HLS half

Rung 2 hands the browser the *provider's* manifest, and hls.js then fetches
~2000 segments from the provider. Proxying only the media would leave that path
untouched and every viewer's IP would still reach the provider for exactly the
MKV files most likely to be watched — the feature would half-work.

So a new route family, `/hls/provider/:sid/:idx/…`, behind the same capability:

| Route | Behaviour |
| --- | --- |
| `index.m3u8?k=` | fetch the provider manifest, parse it, **cache the resolved absolute segment URLs**, return a manifest whose lines are `seg/0` … `seg/N` |
| `seg/:n?k=` | `:n` is an **index into that cached list**; proxy that URL |

**`:n` is an index and never a URL or a filename, and that is the security crux of
this design.** A client-supplied path component that becomes an upstream request
is SSRF; an integer index into a list the server built from a manifest it fetched
itself cannot be. Out of range → 404. Cache miss (a segment asked for before the
manifest) → 404: hls.js always fetches the manifest first, so that is a malformed
client rather than a real case.

The cache is a bounded map keyed by `(sid, index)`, exactly like `ProbeCache` and
for the same reasons — a bound needs no teardown hook, and a stale entry is
harmless because session ids are never reused.

**The manifest is fetched lazily by its own route**, not during `.info`. A player
page load already pays one provider round trip (the transcode endpoint) and should
not pay two. The consequence, accepted: `.info` can promise an HLS URL that later
turns out to 502, because a file with `streamable: 0` yields manifest URLs that
fail with `invalid_duration` when actually fetched. That failure lands on the
player's existing fallback card, which is where it would have landed anyway.

### What the browser sees

`.info`'s `hls` field carries the box's own relative path when the flag is on and
the provider's URL when it is off. (Between the two increments in "Sequencing"
below there is a third state — flag on, HLS half not built — where it must be
`null`; the reason is given there.)

**The browser needs no changes at all.** `chooseSource` and `mountHls` receive a
URL either way; the client appends `?k=` to a relative path exactly as it already
does for `/stream/` and `.m3u`. That the same field means "someone else's absolute
URL" or "our path" is worth one comment in `wire.ts`.

### No new capability flag

`/api/sources` does not learn about this. Nothing in the browser branches on it,
because `.info` hands over the correct URL regardless — and an unused wire field is
a thing to keep in sync for nothing. Same call as the `debridTranscode` flag in
the rung-2 design, for the same reason.

## Error handling

| Failure | Result |
| --- | --- |
| Flag off | today's `302`, byte-for-byte unchanged |
| Upstream scheme not in the allow-list | `502`, scheme logged, never the URL |
| More than 3 redirects | `502` |
| Provider manifest fetch fails or 404s | `502` from the manifest route → hls.js error → fallback card |
| Segment index out of range, or no cached manifest | `404` |
| Upstream dies mid-body | existing proxy behaviour; the socket closes |
| Upstream ignores `Range` | existing behaviour — the response says so and the player decides |

Nothing here may log an unrestricted link or a capability. `handleStreamRequest`'s
contract is that the caller logs the path only, and these routes inherit it.

## Testing

- **Pure, so properly tested:** `resolveProxyTarget(target, allowedProtocols, hopsRemaining)`
  — the scheme and redirect-budget decision; and `rewriteManifest(text, baseUrl, pathPrefix)`
  → `{ body, segments }` — the manifest rewrite and the absolute-URL resolution.
- **Routes against a real `http.Server`**, as `src/web/stream.test.ts` already does
  and for the reason its own comment gives: a fake HTTP client cannot show that a
  `Range` survived a socket.
- **One test that exists to stop SSRF**: assert no client-supplied string reaches
  an upstream request — drive `seg/…` with traversal, an absolute URL and a
  hostname, and assert each is a 404 and that the injected requester was never
  called.
- **A regression test that the flag off changes nothing**: the debrid branch still
  answers `302` with the same `Location` and `Cache-Control`.
- **Known gap, stated rather than papered over:** a real **https** upstream needs a
  local TLS server and a self-signed certificate, which means a cert fixture and
  `rejectUnauthorized: false` in the test. That is disproportionate here, so the
  https socket behaviour is verified manually against a live provider and only the
  *decision* is unit-tested. This is the same trade `stream.test.ts` documents when
  it refuses to fake its HTTP client.
- Fixtures use the invented cast — `Kestrel.2010.1080p.BluRay.x264`,
  `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP` — never real titles.

## Documentation

`README.md` gains a short section under the debrid material covering, in this
order:

1. The unrestricted link never reaching the client — the reason that applies to
   everyone.
2. The upstream arithmetic from the table above, in plain numbers. A reader must
   not turn this on without knowing three remote viewers can saturate a domestic
   upload.
3. That it is TUI-configured, and that the browser adapts on its own.
4. The Real-Debrid terms note, once, factually.

## Sequencing

1. **The media half** — `proxyUpstream`'s allow-list and redirect following, plus
   the flag. Direct-play files and the `.m3u`/VLC path flow through the box, and
   the credential stops reaching clients.

   **Shippable alone, but only with one extra line:** while the flag is on and the
   HLS half does not exist yet, `.info` must report `hls: null`. Without that, a
   half-proxied build hands out a provider manifest whose ~2000 segments each go
   direct — one egress IP for mp4s and every viewer's IP for MKVs, which is worse
   than either end state because it looks like it is working. The cost of the
   extra line is that an MKV falls to the fallback card while proxying, which is
   honest and is where it sat before rung 2 existed.

2. **The HLS half** — the `/hls/provider/…` family, which replaces that `null` with
   a real proxied manifest. Needs rung 2 merged.

3. **Docs**, with the numbers.
