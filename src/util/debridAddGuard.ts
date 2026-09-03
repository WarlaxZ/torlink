// Shared by the TUI and the browser (same reason as resultFilter.ts / resultSort.ts:
// `src/web/static/` cannot import `src/ui/**`, so the one place both front ends can
// reach is `src/util`). IMPORTS NOTHING.
//
// A debrid add of a torrent with no seeders and no existing cache entry never
// completes: the provider can't fetch a swarm-less torrent, so it just sits in the
// "active" state forever. TorBox's own progress loop only notices this after a
// multi-minute stall (see DEFAULT_STALL_MS in src/integrations/debrid/torbox.ts),
// by which point the add has already spent one of the account's few concurrent
// slots — for a plan capped at three, three such stuck adds block every future
// download until the user finds and cancels them.
//
// Seeders and cache status are both known before the user clicks "add" (search
// results carry seeders; cachedHashes is refreshed right after search settles), so
// this guard runs there instead of waiting for the provider to time out.

/**
 * Whether adding this result via a debrid provider should be blocked because it
 * would just sit stuck: not already cached, and reported as having zero seeders
 * by a source whose feed actually carries swarm data.
 *
 * `sourceReportsHealth` must be false for a source with no swarm data — those
 * report `seeders: 0` for everything (unknown, not dead), the same convention
 * `resultFilter.ts`'s alive-only filter uses.
 */
export function shouldBlockDebridAdd(
  seeders: number,
  isCached: boolean,
  sourceReportsHealth: boolean,
): boolean {
  return !isCached && sourceReportsHealth && seeders === 0;
}
