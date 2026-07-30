/**
 * The dedupe key for one title in the stream-history store.
 *
 * MOVED DOWN HERE FROM `src/core/streamHistory.ts`, WHICH STILL RE-EXPORTS IT,
 * so every existing caller is untouched. The move is what lets the browser use
 * it: `streamHistory.ts` reads and writes a file, so it imports `node:fs`, and
 * `src/web/static/**` is bundled with `platform: "browser"` and may not reach a
 * Node builtin even transitively. Copying the four lines into the browser would
 * have been the fifth recorded copy-then-drift bug in this codebase — and a
 * drifted key does not crash, it silently stops matching the row it is looking
 * for. This module imports nothing, so it is safe from either side.
 *
 * DELIBERATELY NOT `parseRelease`'s `key`. That one is an OMDb *cache* key: the
 * year belongs in it because two films can honestly share a title. But a release
 * name for a series is unreliable about carrying the year at all —
 * "Kepler.2024.S02E04" and "Kepler.S02E05" are the same show — so inheriting it
 * here put one series in two rows with two independent high-water marks, one
 * permanently stale.
 *
 * So: a series is keyed on title + type only; anything else keeps the year. The
 * lower-casing mirrors `parseRelease`'s own (src/util/release.ts) so the two
 * agree on what "same title" means.
 *
 * No migration needed — `removeStreamHistory` filters on the *stored* value, so
 * rows written under the old key keep working and merge into the new one the next
 * time that title is streamed. A consumer that re-derives a key to look a row up
 * must therefore treat a miss as ordinary.
 */
export function historyKeyFor(
  parsed: { title: string; year?: number; type?: string; key: string },
): string {
  if (parsed.type !== "series") return parsed.key;
  return `${parsed.title.toLowerCase()}|series`;
}
