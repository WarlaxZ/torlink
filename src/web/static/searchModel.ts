// Pure view state for the browser's search pane. Everything with a decision in
// it lives here; `app.ts` is DOM binding only. There is no jsdom in this repo
// and adding one for this would be disproportionate, so pure modules are how
// this gets tested — the same split dashboard.ts, streamFlow.ts and
// playerModel.ts already use.
//
// Bundled for the browser: no node:* imports, direct or transitive.
//
// THREE IMPORTS LEAVE THIS DIRECTORY, all deliberate. `../wire` is types-only
// and erased at build time. `../../util/resultSort` and
// `../../util/resultFilter` are *value* imports of the TUI's own sort and
// filter — they were `src/ui/sort.ts` and `src/ui/filter.ts` until this file
// needed them, and reimplementing either here is the copy-then-drift bug this
// codebase has hit four times (uploadSpeed, the byte formatter, the progress
// unit, the API path table). Both are dependency-free and `platform: "browser"`
// in tsup.web.config.ts fails the build if that ever stops being true.
import { filterResults } from "../../util/resultFilter";
import { sortResults, type Sort } from "../../util/resultSort";
import { formatBytes, type DashRow } from "./dashboard";
import type { PublicSearchResult, PublicSearchSnapshot, SourcesResponse } from "../wire";

// Re-exported for the same reason dashboard.ts re-exports the status types: one
// import site for app.ts, and no opportunity for anyone to *redeclare* a
// producer's payload shape in the browser bundle.
export type {
  PublicSearchResult,
  PublicSearchSnapshot,
  PublicSource,
  PublicSourceGroup,
  PublicSourceState,
  PublicTitleMeta,
  PublicTitleParse,
  SourcesResponse,
} from "../wire";
export {
  formatSort,
  nextSort,
  parseSort,
  sortLabel,
  SORT_CYCLE,
  type Sort,
  type SortDir,
  type SortField,
} from "../../util/resultSort";

/** The pseudo-tab that searches every enabled source, as `parseSearchParams` names it. */
export const ALL_TAB = "All";

/**
 * The category tabs, straight from `GET /api/sources`.
 *
 * THE ADULT CATEGORY IS NOT FILTERED HERE, and that is the point: the server's
 * `sourcesByGroup(adultEnabled)` already omits the "Porn" group when the
 * category is off, so a tab for it cannot be built from this response. A second
 * check in the browser would be a second place for the rule to live, and the
 * one that mattered — the one that decides which trackers are actually queried
 * — is `enabledSources` on the server either way. If this list ever grew a
 * group the server did not send, that would be the bug.
 */
export function categoryTabs(sources: SourcesResponse | null): string[] {
  return [ALL_TAB, ...(sources?.groups ?? []).map((g) => g.group)];
}

/**
 * `reportsHealth` per source id, for the shared hide-dead filter.
 *
 * Unknown ids answer **false** — "this source does not report swarm counts", so
 * its rows are never hidden for having `seeders: 0`. That is the safe direction:
 * the alternative silently empties a tab whose source list the browser happens
 * not to have (a stale `/api/sources`, a source added since the page loaded),
 * and an empty list with no explanation is indistinguishable from a broken
 * search.
 */
export function reportsHealthLookup(sources: SourcesResponse | null): (source: string) => boolean {
  const byId = new Map((sources?.sources ?? []).map((s) => [s.id, s.reportsHealth]));
  return (source) => byId.get(source) === true;
}

/** A source's human label for the row badge, falling back to its raw id. */
export function sourceLabel(sources: SourcesResponse | null, id: string): string {
  return (sources?.sources ?? []).find((s) => s.id === id)?.label ?? id;
}

/** Everything the results list is rendered from. */
export interface SearchView {
  /** The submitted query. Empty before the first search. */
  query: string;
  /** `ALL_TAB` or one of the server's group names. */
  group: string;
  /** The latest frame, or null before one arrives. */
  snapshot: PublicSearchSnapshot | null;
  /** True between submitting and the `done` frame (or an error). */
  running: boolean;
  sort: Sort;
  hideDead: boolean;
  textFilter: string;
}

export function emptyView(): SearchView {
  return {
    query: "",
    group: ALL_TAB,
    snapshot: null,
    running: false,
    // "none", NOT a seeders sort. `core/search.ts` has already ordered every
    // snapshot by seeders then recency and the TUI leaves that alone, so a
    // browser that applied its own default would put a different hit at the top
    // of the same query. See sortResults: "none" returns the list as given.
    sort: "none",
    hideDead: false,
    textFilter: "",
  };
}

/**
 * The rows to render: the server's list, filtered and sorted by the user's
 * controls and by nothing else.
 *
 * With the default view (`sort: "none"`, no filters) this is the server's order
 * unchanged, hit for hit. That is the invariant worth protecting — `runSearch`
 * orders by seeders then recency, the TUI shows that order, and a browser with
 * a different idea of "best first" for the same query is exactly the drift this
 * project keeps getting bitten by.
 */
export function visibleResults(
  view: SearchView,
  reportsHealth: (source: string) => boolean,
): PublicSearchResult[] {
  const all = view.snapshot?.results ?? [];
  return sortResults(filterResults(all, view.hideDead, view.textFilter, reportsHealth), view.sort);
}

/** "12/23 sources", the same fraction the TUI's spinner shows. */
export function progressLabel(snapshot: PublicSearchSnapshot | null): string {
  if (!snapshot) return "";
  return `${snapshot.done}/${snapshot.total} sources`;
}

/** How many of this search's sources failed. Non-null `error` is the flag. */
export function erroredSources(snapshot: PublicSearchSnapshot | null): string[] {
  return Object.entries(snapshot?.perSource ?? {})
    .filter(([, state]) => state.error !== null)
    .map(([id]) => id);
}

/** A status line, and whether it is bad news. Mirrors the TUI's `status()`. */
export interface SearchStatus {
  text: string;
  tone: "dim" | "error";
}

export function searchStatus(view: SearchView, shown: number): SearchStatus {
  if (!view.query) return { text: "Search across every enabled source.", tone: "dim" };
  const progress = progressLabel(view.snapshot);
  if (view.running) {
    const head = shown > 0 ? `searching… ${progress}` : `Searching ${progress}`;
    return { text: head, tone: "dim" };
  }
  const down = erroredSources(view.snapshot);
  const total = view.snapshot?.total ?? 0;
  if (shown === 0) {
    // Every source failing and every source finding nothing look identical in a
    // results list, so they must not read the same. This is the whole reason
    // `perSource.error` is on the wire.
    if (total > 0 && down.length >= total) {
      return { text: "Couldn't reach any source. They may be down.", tone: "error" };
    }
    if (view.hideDead || view.textFilter.trim()) {
      return { text: "Nothing matches those filters.", tone: "dim" };
    }
    return { text: `No results for “${view.query}”.`, tone: "dim" };
  }
  const note = down.length > 0 ? ` · ${down.length} source${down.length === 1 ? "" : "s"} down` : "";
  return { text: `${shown} result${shown === 1 ? "" : "s"}${note}`, tone: "dim" };
}

/** The `GET /api/search` URL for a query. `token` empty means a tokenless server. */
export function searchUrl(query: string, group: string, token: string): string {
  const params = new URLSearchParams({ q: query, group });
  // EventSource cannot set headers, so the bearer token rides as ?k= exactly as
  // /api/events already does. This is NOT the per-session stream capability.
  if (token) params.set("k", token);
  return `/api/search?${params.toString()}`;
}

/** One row's meta line: size, swarm, source. `formatBytes` is dashboard.ts's, not a second copy. */
export function resultMeta(result: PublicSearchResult, sources: SourcesResponse | null): string {
  const size = result.sizeBytes > 0 ? formatBytes(result.sizeBytes) : "size unknown";
  // Zero-and-zero means the source reports no swarm data at all, which is not
  // the same claim as "nobody is seeding this" — say so rather than print 0:0.
  const swarm =
    result.seeders > 0 || result.leechers > 0
      ? `${result.seeders} seeders · ${result.leechers} leechers`
      : "swarm unknown";
  return `${size} · ${swarm} · ${sourceLabel(sources, result.source)}`;
}

/**
 * A search hit as `runPlay` wants it.
 *
 * THE NAME IS LOAD-BEARING AND IS NOT DERIVABLE. `runPlay` puts `row.name` in
 * the Real-Debrid confirmation prompt, in the "preparing…" progress line, in
 * the file-picker heading, and — through `POST /api/stream` — in the session,
 * which is what the player page and the queue display. A row built with the
 * info hash in the name field works end to end and shows the user forty hex
 * characters at every one of those points.
 *
 * `status: "queued"` because nothing is downloading: a search hit is not a
 * queue item. It only has to satisfy `isPlayable`, which refuses "failed"
 * downloads and "missing" seeds and nothing else.
 */
export function rowForPlay(result: PublicSearchResult): DashRow {
  return {
    id: result.infoHash,
    name: result.name,
    kind: "download",
    status: "queued",
    percent: 0,
    peers: 0,
    rate: 0,
    uploaded: 0,
  };
}

/** Which network an add should use. Mirrors the TUI's `d` and `r` keys. */
export type AddVia = "p2p" | "debrid";

/** What pressing an add button should actually do. */
export type AddPlan =
  /** Go ahead. */
  | { kind: "add"; via: AddVia }
  /**
   * Ask first. Real-Debrid is configured and the user pressed the plain add, so
   * this is about to put their IP in a public swarm when they are paying for
   * something that keeps it out of one — the same prompt the TUI shows.
   */
  | { kind: "confirm"; via: AddVia; message: string };

/**
 * The TUI's `requestP2PDownload` decision, and it is a decision about the
 * user's IP address rather than a convenience.
 *
 * A plain add with Real-Debrid configured PROMPTS; it does not silently switch
 * to Real-Debrid (which would spend their account without asking) and it does
 * not silently proceed over P2P (which is the exposure they configured
 * Real-Debrid to avoid). An explicit Real-Debrid add never prompts — the user
 * already said which network they wanted.
 */
export function addPlan(via: AddVia, debridConfigured: boolean, name: string): AddPlan {
  if (via === "debrid" || !debridConfigured) return { kind: "add", via };
  return {
    kind: "confirm",
    via: "p2p",
    message:
      `Download “${clip(name)}” peer-to-peer?\n\n` +
      "Your IP address will be visible to everyone in the swarm. Real-Debrid is " +
      "configured and keeps it private — cancel and use “add via RD” instead.",
  };
}

/**
 * The `POST /api/add` body for a search hit.
 *
 * `name` IS NOT OPTIONAL HERE even though the wire type marks it so. Search
 * results deliberately carry no magnet (see `PublicSearchResult`), so this add
 * is by bare info hash — and the server derives a name from the magnet's `dn`,
 * which a hash-only magnet has none of. Drop this field and every add from the
 * browser becomes a queue row named after forty hex characters.
 */
export function addBody(
  result: PublicSearchResult,
  via: AddVia,
): { infoHash: string; name: string; via: AddVia; sizeBytes?: number } {
  const body: { infoHash: string; name: string; via: AddVia; sizeBytes?: number } = {
    infoHash: result.infoHash,
    name: result.name,
    via,
  };
  if (result.sizeBytes > 0) body.sizeBytes = result.sizeBytes;
  return body;
}

/**
 * Whether a preview is worth asking OMDb about for this tab.
 *
 * The TUI gates its preview pane the same way (`previewSection` in
 * Results.tsx): OMDb knows films and television, so a Games or Music tab would
 * spend a lookup per row to render a placeholder every time. "All" is included
 * because it is mostly video and the user has no other way to see a poster.
 */
export function previewApplies(group: string): boolean {
  return group === ALL_TAB || group === "Movies" || group === "TV" || group === "Anime";
}

// A release name in a confirm() has to leave room for the question and the
// buttons on a phone. Same job as dashboard.ts's shortName, at the shorter
// limit a two-line prompt can carry.
function clip(name: string): string {
  return name.length > 60 ? `${name.slice(0, 59)}…` : name;
}
