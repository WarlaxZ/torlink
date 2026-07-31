// Whether a debrid provider's HLS manifest is one the browser can actually
// finish watching — asked before the player page is told the manifest exists.
//
// WHY THIS FILE EXISTS, measured against Real-Debrid on 2026-07-31:
//
// The provider transcodes linearly and on demand, and for a 1080p HEVC file its
// transcoder cannot sustain realtime. Pulling segments patiently and
// sequentially — one request at a time, no aborts — produced **60 seconds of
// video in 92.9 seconds of wall clock (0.65x)** and then stopped answering
// altogether. That is not a timing problem with a client-side fix: below 1.0x
// nothing the browser or this server does can win, because a 59-minute episode
// outruns any buffer either could build.
//
// What the browser sees on the way down is worse than a plain failure. A segment
// the transcoder has not finished is served as a **complete HTTP 200 whose
// Content-Length matches a truncated body** — not a hang, not a chunked early
// close, not a partial-transfer error. So hls.js cannot tell it from a real
// fragment: it appends it, gets a buffer hole, and playback freezes with no
// error event at all. Retry and timeout tuning cannot help, because there is
// nothing to retry on.
//
// Hence a probe rather than a repair. The transcode is still genuinely useful
// for files the provider CAN keep up with (H.264, smaller files), so the rung
// stays — it is offered only when a segment past the transcoder's opening burst
// comes back whole.
//
// Nothing here throws. Every "no" is the same `false`, because the caller's next
// move is identical for all of them: fall to the next rung.

/**
 * The boundary the provider rounds a partial segment to.
 *
 * Measured: truncated bodies were 262144, 524288, 786432, 1048576, 2097152,
 * 2621440, 3145728 and 3407872 bytes — every one an exact multiple of 256 KiB.
 * Genuine finished segments in the same playlist were 4639088, 3216116, 3135464,
 * 5193124 and 3390016, none of which is.
 */
export const SEGMENT_QUANTUM = 262144;

/**
 * Which segment to probe.
 *
 * NOT the first, and that is the whole subtlety. The transcoder's opening burst
 * is fast — segments 0 to 4 measured 3.4x to 8.1x realtime — so probing the head
 * of the file says "healthy" about a transcode that collapses moments later. The
 * decline began at segment 5 and every segment from there was truncated, so the
 * probe sits just past the burst.
 *
 * NOT deep into the file either. The provider transcodes from the start, so a
 * request for segment 300 has to seek and re-transcode and will look broken even
 * for a file it could stream perfectly in order — a far seek measured 90 seconds
 * with no response headers at all.
 *
 * Ordinal 6 against `PROBE_TIMEOUT_MS` sets the bar this actually enforces: 35
 * seconds of video that must materialise inside 8 seconds, so a transcoder
 * sustaining roughly 4x realtime or better passes. That is the threshold worth
 * having — playback needs better than 1x, and the margin covers the decline
 * measured on the way down (8.1x at segment 4, 1.8x by segment 11).
 *
 * WHAT THIS CANNOT DO, measured rather than assumed: if the provider has ALREADY
 * transcoded the head of this file — a previous process, a previous playback
 * attempt — those segments are cached and answer instantly, and the probe passes
 * a file whose transcoder will still stall further in. Verified: a job whose
 * first twelve segments had been pulled returned a whole segment 6 in 268ms and
 * this check said yes.
 *
 * There is no cheap fix for that, and it is worth writing down why rather than
 * leaving the next person to rediscover it. The transcoder does no work until
 * asked, so "is segment 100 ready?" is no for a fast provider and a slow one
 * alike; and the provider ignores `Range` on a segment (a `bytes=0-1` request
 * returns 200 and the entire body), so the frontier cannot be located cheaply
 * either. The only honest measure is pulling consecutive segments and timing
 * them, which takes the better part of a minute and is not a page load.
 *
 * What limits the damage is the mid-playback stall notice in `player.ts`: a false
 * pass degrades to playback that runs and then explains itself, rather than to
 * the silent freeze this all started as.
 *
 * `HlsVerdictCache` holds a verdict for the life of ONE server process, so a
 * reload cannot re-probe and flip the answer. It is not durable, and a restart
 * therefore can: a failed attempt is itself what warms the provider's head, so
 * the sequence "play, freeze, restart `serve --web`, play again" can be offered a
 * manifest that was refused the first time. Making that impossible would mean
 * persisting verdicts across restarts, which is more machinery than this is
 * worth while the notice covers the outcome.
 */
export const PROBE_ORDINAL = 6;

/**
 * How long the probe segment gets. Deliberately short: this runs inside a
 * `.info` request that a player page is blocked on, and a provider that needs
 * longer than this for a segment six is already failing the test.
 */
export const PROBE_TIMEOUT_MS = 8000;

/** How long the manifest itself gets. It is 19 KB of text; this is generous. */
export const MANIFEST_TIMEOUT_MS = 5000;

/**
 * The URI lines of a media playlist, in order.
 *
 * Everything that is blank or starts with `#` is a tag or a comment; per RFC
 * 8216 every other line is a URI. No validation here — `probeTarget` is where a
 * URI has to earn being fetched.
 */
export function segmentUris(manifest: string): string[] {
  const out: string[] = [];
  for (const raw of manifest.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

/**
 * Whether a segment body is one the provider flushed early rather than finished.
 *
 * A genuine segment landing exactly on the quantum is possible and costs
 * nothing: roughly one chance in 262144 per segment, and the only consequence is
 * that a perfectly good manifest is not offered and the user gets the card and
 * the `.m3u` — the same place they end up today for every mkv.
 *
 * Zero is excluded explicitly. It IS a multiple of the quantum, but an empty
 * body is a different failure and the caller reports it as one.
 */
export function looksTruncated(bytes: number): boolean {
  return bytes > 0 && bytes % SEGMENT_QUANTUM === 0;
}

/**
 * The absolute URL of the segment to probe, or null.
 *
 * The segment URI comes out of a provider's HTTP response, so it is not trusted
 * to be the bare `00006.ts` that Real-Debrid happens to send. It is resolved
 * against the manifest and then required to still be **inside the manifest's own
 * directory on the manifest's own origin** — which refuses an absolute URL to
 * another host, a scheme-relative `//host/…`, a downgrade to http, and a
 * `../` climb, without this module needing to guess which of those a provider
 * might one day emit.
 */
export function probeTarget(manifestUrl: string, manifest: string): string | null {
  const uris = segmentUris(manifest);
  if (uris.length === 0) return null;
  // The chosen ordinal when the playlist is long enough, otherwise the last
  // segment there is — still past the opening burst for anything long enough to
  // be worth watching, and for a two-segment playlist the question is moot.
  const uri = uris[Math.min(PROBE_ORDINAL, uris.length - 1)];
  if (uri === undefined) return null;

  let base: URL;
  let target: URL;
  try {
    base = new URL(manifestUrl);
    target = new URL(uri, base);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  if (target.protocol !== base.protocol) return null;
  // The directory the manifest itself lives in, e.g. `/t/ID/eng1/none/aac/`.
  const dir = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
  // `new URL` has already normalised any `..`, so a climb shows up here as a
  // pathname that no longer starts with the manifest's directory.
  if (!target.pathname.startsWith(dir)) return null;
  return target.toString();
}

/** What one fetch told us. `null` for a timeout, a socket error, anything. */
export interface ProbeResponse {
  status: number;
  /** Bytes actually received, counted — never the Content-Length header. */
  bytes: number;
  body: string;
}

export interface CheckHlsDeps {
  /**
   * Fetch one URL and report status and byte count, or null for any failure.
   * Injected so the suite never reaches the network, and so the timeouts below
   * are the production policy rather than something a test has to wait out.
   */
  fetchImpl: (url: string, timeoutMs: number) => Promise<ProbeResponse | null>;
}

/**
 * Build the check: manifest URL in, "is this worth offering" out.
 *
 * Exactly two requests, and never more. This runs while a player page waits, and
 * the cost is already a segment's worth of bytes through this machine; a
 * multi-segment throughput measurement would be the honest test but would take
 * the better part of a minute, which is not a page load.
 *
 * NOTE the byte count comes from counting the body, not from Content-Length.
 * Content-Length is exactly what the provider gets right while getting the body
 * wrong — it reports the truncated length faithfully — so trusting the header
 * here would still be measuring the right number, but counting is what makes
 * that independent of the provider's honesty rather than dependent on it.
 */
/**
 * How much of a body to keep as text.
 *
 * The manifest is ~19 KB and is needed in full; a segment's bytes need counting
 * but its contents are never read, and holding 5 MB of binary decoded as UTF-8
 * would be pure waste. One cap covers both without the caller having to say
 * which kind of response it expects.
 */
const MAX_TEXT_BYTES = 1024 * 1024;

/**
 * The production `fetchImpl`: count the bytes, keep the first megabyte as text.
 *
 * Redirects are followed — a provider CDN answering a manifest URL with a 302 to
 * a regional node is normal and is not what this module is testing for.
 *
 * The byte count is the length of what actually arrived, deliberately not the
 * Content-Length header, because the header is precisely what the provider
 * reports correctly while the body is wrong.
 */
export async function probeFetch(url: string, timeoutMs: number): Promise<ProbeResponse | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    let bytes = 0;
    // Budgeted in BYTES read, not in string length: the two differ for anything
    // non-ASCII, and the point of the cap is to avoid decoding megabytes of a
    // segment body that nothing ever reads.
    let decoded = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8");
    const body = res.body;
    if (body) {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (decoded < MAX_TEXT_BYTES) {
          text += decoder.decode(chunk, { stream: true });
          decoded += chunk.length;
        }
      }
    }
    return { status: res.status, bytes, body: text };
  } catch {
    // A timeout, a reset, a DNS failure and a body that died mid-flight are all
    // the same answer to the only question being asked.
    return null;
  }
}

export function makeCheckHls(deps: CheckHlsDeps): (manifestUrl: string) => Promise<boolean> {
  return async (manifestUrl) => {
    try {
      const manifest = await deps.fetchImpl(manifestUrl, MANIFEST_TIMEOUT_MS);
      if (!manifest || manifest.status !== 200) return false;
      const target = probeTarget(manifestUrl, manifest.body);
      if (!target) return false;
      const segment = await deps.fetchImpl(target, PROBE_TIMEOUT_MS);
      if (!segment || segment.status !== 200) return false;
      if (segment.bytes === 0) return false;
      return !looksTruncated(segment.bytes);
    } catch {
      return false;
    }
  };
}
