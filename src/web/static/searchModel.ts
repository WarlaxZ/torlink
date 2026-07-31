// Pure view state for the browser's search pane. Everything with a decision in
// it lives here; `app.ts` is DOM binding only. There is no jsdom in this repo
// and adding one for this would be disproportionate, so pure modules are how
// this gets tested — the same split dashboard.ts, streamFlow.ts and
// playerModel.ts already use.
//
// Bundled for the browser: no node:* imports, direct or transitive.
//
// FOUR IMPORTS LEAVE THIS DIRECTORY, all deliberate. `../wire` is types-only
// and erased at build time. `../../util/resultSort` and
// `../../util/resultFilter` are *value* imports of the TUI's own sort and
// filter — they were `src/ui/sort.ts` and `src/ui/filter.ts` until this file
// needed them, and reimplementing either here is the copy-then-drift bug this
// codebase has hit four times (uploadSpeed, the byte formatter, the progress
// unit, the API path table). `../../util/resultGroup` is the same arrangement
// for title grouping, and the TUI's results list renders the same rows from the
// same `groupRowPlan`. All three are dependency-light and `platform: "browser"`
// in tsup.web.config.ts fails the build if that ever stops being true —
// resultGroup reaches `parse-torrent-title` through util/release.ts, which the
// bundle already carries for streamFlow.ts.
import { hintForGroup } from "../../util/release";
import { filterResults } from "../../util/resultFilter";
import {
  groupResults,
  groupRowPlan,
  type GroupRow,
  type ResultGroup,
} from "../../util/resultGroup";
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
export {
  groupCountLabel,
  resultAtRow,
  type GroupRow,
  type ResultGroup,
} from "../../util/resultGroup";

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
  /** The submitted query. Only meaningful in `"search"` mode. */
  query: string;
  /**
   * Which of three states the pane is in. This is NOT derivable from `query`:
   * browse mode submits the empty string, so `!query` alone cannot tell "the
   * user asked for the top lists" from "nothing has been submitted yet", and
   * conflating them makes a browse render as a fresh page.
   */
  mode: "idle" | "search" | "browse";
  /** `ALL_TAB` or one of the server's group names. */
  group: string;
  /** The latest frame, or null before one arrives. */
  snapshot: PublicSearchSnapshot | null;
  /** True between submitting and the `done` frame (or an error). */
  running: boolean;
  sort: Sort;
  hideDead: boolean;
  textFilter: string;
  /**
   * Whether many releases of one title collapse to one row.
   *
   * A view preference, not a search parameter: it changes how the rows already
   * fetched are presented, so toggling it never re-runs a 23-source fan-out.
   */
  grouped: boolean;
}

export function emptyView(): SearchView {
  return {
    query: "",
    mode: "idle",
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
    // ON. A browse of one category routinely returns four uploads of every film,
    // and one measured search returned 129 results that were 21 actual things.
    // The list is the product; showing it duplicated by default is the bug.
    grouped: true,
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

/**
 * The groups to render: {@link visibleResults}, grouped.
 *
 * Grouping runs AFTER filter and sort, for two reasons. A filter must narrow the
 * list rather than narrow within groups — typing "ashfall" should leave one row,
 * not one group per title with the misses hidden inside. And group order then
 * follows whatever sort is selected, so "seeders ▾" still means seeders ▾.
 */
export function visibleGroups(
  view: SearchView,
  reportsHealth: (source: string) => boolean,
): ResultGroup<PublicSearchResult>[] {
  // THE HINT IS NOT OPTIONAL for cross-surface agreement. The TUI groups with
  // hintForSection(section); passing nothing here would let the same feed group
  // differently in the two front ends, because the hint changes whether
  // parseRelease reads a name as a film or a series — and that changes the shape
  // of the key. hintForGroup is the "Movies"/"TV" → movie/series translation the
  // browser's tab names need, and it already exists for the badges.
  return groupResults(visibleResults(view, reportsHealth), hintForGroup(view.group));
}

/**
 * The flat row list `app.ts` renders — group headings and release rows in order.
 *
 * The same `groupRowPlan` the TUI's results list renders, which is the point of
 * it living in `src/util`: "which rows are there" is one decision with two
 * renderers, not two implementations.
 *
 * Grouping off yields one release row per result, so the toggle is genuinely a
 * view option rather than a second code path — and the row shape `app.ts` binds
 * to is identical either way.
 */
export function resultRowPlan(
  view: SearchView,
  reportsHealth: (source: string) => boolean,
  expanded: ReadonlySet<string>,
): GroupRow<PublicSearchResult>[] {
  const shown = visibleResults(view, reportsHealth);
  if (!view.grouped) {
    // Keyed on the info hash rather than a group key: this is the identity
    // selection, focus restoration and the cached-marker lookup already use.
    return shown.map((result) => ({
      kind: "release" as const,
      key: result.infoHash,
      result,
      inGroup: false,
    }));
  }
  // Same hint as visibleGroups, and for the same reason.
  return groupRowPlan(groupResults(shown, hintForGroup(view.group)), expanded);
}

// NOT GATED BY TAB, unlike previewApplies. Grouping is offered everywhere: on
// Games, Music and Books the release names are not film or show names, so the
// parser finds little to merge and the list is left almost as it was — which is
// the safe direction. There is deliberately no `groupingApplies()` here: a
// predicate that always returns true is a placeholder pretending to be a rule.

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
  if (view.mode === "idle")
    return {
      text: "Search across every enabled source — or submit a blank box to browse.",
      tone: "dim",
    };
  const browse = view.mode === "browse";
  const progress = progressLabel(view.snapshot);
  if (view.running) {
    // "Loading" not "Searching" while browsing: nothing was searched for. Both
    // casings are spelled out rather than capitalized at runtime — the literal
    // strings are what you grep for when a status line looks wrong.
    // The TUI's lowercase line (Results.tsx:510) says "searching…" even while
    // browsing; that reads wrong and is not worth copying.
    const head =
      shown > 0
        ? `${browse ? "loading" : "searching"}… ${progress}`
        : `${browse ? "Loading" : "Searching"} ${progress}`;
    return { text: head, tone: "dim" };
  }
  const down = erroredSources(view.snapshot);
  const total = view.snapshot?.total ?? 0;
  if (shown === 0) {
    // The outage branch outranks the mode: "every source is down" is true
    // whether or not the user typed anything. The filter branch below is NOT
    // mode-independent in the same way — see its own comment.
    if (total > 0 && down.length >= total) {
      return { text: "Couldn't reach any source. They may be down.", tone: "error" };
    }
    // A filter can only be to blame if something arrived and was then removed.
    // Without this check an empty upstream reads as the user's fault — and the
    // TUI doesn't make that mistake (Results.tsx:538 gates the same message on
    // having rows to filter).
    const fetched = view.snapshot?.results.length ?? 0;
    if (fetched > 0 && (view.hideDead || view.textFilter.trim())) {
      return { text: "Nothing matches those filters.", tone: "dim" };
    }
    if (browse) return { text: "Nothing new right now.", tone: "dim" };
    return { text: `No results for “${view.query}”.`, tone: "dim" };
  }
  const note = down.length > 0 ? ` · ${down.length} source${down.length === 1 ? "" : "s"} down` : "";
  // The TUI drops the count while browsing because its panel title already says
  // "latest". The web has no such title, so keep the count and append the
  // phrase rather than replacing one true thing with another.
  const tail = browse ? " · newest across all sources" : "";
  return { text: `${shown} result${shown === 1 ? "" : "s"}${note}${tail}`, tone: "dim" };
}

/**
 * Whether the status line should be hidden once results are on screen.
 *
 * A settled search's status line is just a result count, and that count is
 * redundant with the rows the user is already looking at — hide it. Browse
 * mode's line is not a count, or not only one: `searchStatus`'s "· newest
 * across all sources" tail is the only thing on the page saying these rows
 * are a curated top list rather than a match for something typed, so it must
 * stay up exactly when there are rows to explain. Anything still `running` or
 * with nothing to show keeps the line for the same reason `searchStatus` still
 * has something to say then — the progress text and the empty-state messages
 * ("Nothing new right now.", "Couldn't reach any source.", …) are the only
 * content on the page in those cases.
 */
export function statusLineHidden(view: SearchView, shown: number): boolean {
  return shown > 0 && !view.running && view.mode !== "browse";
}

/**
 * Which mode a submitted query puts the view into.
 *
 * Trims before deciding because the server does: `parseSearchParams` trims
 * `raw` before checking for blank. A caller that used truthiness on the
 * untrimmed string would label a whitespace-only submit `"search"` while the
 * server treats it as a browse — the exact query/mode split this field exists
 * to prevent, one layer up. Never returns `"idle"`; that is `emptyView()`'s
 * business only.
 */
export function modeForQuery(query: string): SearchView["mode"] {
  return query.trim() ? "search" : "browse";
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
 * A `DashRow` for `runPlay`, from just the two fields it actually needs.
 *
 * THE NAME IS LOAD-BEARING AND IS NOT DERIVABLE. `runPlay` puts `name` in the
 * Real-Debrid confirmation prompt, in the "preparing…" progress line, in the
 * file-picker heading, and — through `POST /api/stream` — in the session,
 * which is what the player page and the queue display. A row built with the
 * info hash in the name field works end to end and shows the user forty hex
 * characters at every one of those points.
 *
 * `status: "queued"` because nothing is downloading: neither a search hit nor
 * a library favourite is a queue item. It only has to satisfy `isPlayable`,
 * which refuses "failed" downloads and "missing" seeds and nothing else.
 *
 * One definition, two callers (a search result and a library row) — so this
 * docstring and the "queued" choice it explains do not have to be copied, or
 * silently drift, into a second place that builds the same shape.
 */
export function dashRowForPlay(id: string, name: string): DashRow {
  return {
    id,
    name,
    kind: "download",
    status: "queued",
    percent: 0,
    peers: 0,
    rate: 0,
    uploaded: 0,
  };
}

/** A search hit as `runPlay` wants it. See {@link dashRowForPlay}. */
export function rowForPlay(result: PublicSearchResult): DashRow {
  return dashRowForPlay(result.infoHash, result.name);
}

/** Which network an add should use. Mirrors the TUI's `d` and `r` keys. */
export type AddVia = "p2p" | "debrid";

/** What pressing an add button should actually do. */
export type AddPlan =
  /** Go ahead. */
  | { kind: "add"; via: AddVia }
  /**
   * Ask first. A debrid provider is configured and the user pressed the plain
   * add, so this is about to put their IP in a public swarm when they are
   * paying for something that keeps it out of one — the same prompt the TUI
   * shows.
   */
  | { kind: "confirm"; via: AddVia; message: string };

/**
 * A debrid provider id as it crosses the wire. Mirrors `DebridProviderId`.
 *
 * Repeated here rather than imported from `src/integrations/debrid` (or even
 * `SourcesResponse`'s field) because this module is bundled for the browser
 * and must import nothing from `node:*` — the literal union below is the same
 * guard `wire.ts` uses for the same reason.
 */
export type WireDebridProvider = "realdebrid" | "torbox";

/** Display copy per provider. */
const DEBRID_LABELS: Record<WireDebridProvider, { label: string; short: string }> = {
  realdebrid: { label: "Real-Debrid", short: "RD" },
  torbox: { label: "TorBox", short: "TorBox" },
};

/** The full provider name, for prose ("Real-Debrid is configured…"). */
export function debridProviderLabel(provider: WireDebridProvider): string {
  return DEBRID_LABELS[provider].label;
}

/** The add button's own text, e.g. "add via RD" or "add via TorBox". */
export function debridAddLabel(provider: WireDebridProvider): string {
  return `add via ${DEBRID_LABELS[provider].short}`;
}

/** The post-add notice, e.g. "Added via TorBox." */
export function debridAddedNotice(provider: WireDebridProvider): string {
  return `Added via ${DEBRID_LABELS[provider].label}.`;
}

/**
 * The TUI's `requestP2PDownload` decision, and it is a decision about the
 * user's IP address rather than a convenience.
 *
 * A plain add with a debrid provider configured PROMPTS; it does not silently
 * switch to debrid (which would spend the user's account without asking) and
 * it does not silently proceed over P2P (which is the exposure debrid is
 * configured to avoid). An explicit debrid add never prompts — the user
 * already said which network they wanted.
 *
 * Takes the provider id, not a caller-derived label — both strings in the
 * message come from the same {@link DEBRID_LABELS} table the button itself
 * reads, via {@link debridProviderLabel} and {@link debridAddLabel}, so the
 * prompt can never name a button label that is not the one on screen.
 */
export function addPlan(
  via: AddVia,
  debridConfigured: boolean,
  name: string,
  provider: WireDebridProvider | undefined,
): AddPlan {
  if (via === "debrid" || !debridConfigured) return { kind: "add", via };
  const label = provider ? debridProviderLabel(provider) : "your debrid provider";
  const addLabel = provider ? debridAddLabel(provider) : "the debrid add button";
  return {
    kind: "confirm",
    via: "p2p",
    message:
      `Download “${clip(name)}” peer-to-peer?\n\n` +
      `Your IP address will be visible to everyone in the swarm. ${label} is ` +
      `configured and keeps it private — cancel and use “${addLabel}” instead.`,
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

/** What clicking a category tab should do. */
export type TabClickPlan =
  | { action: "ignore" }
  | { action: "run"; query: string };

/**
 * Decides a tab click: what to do and what query to search.
 *
 * `{ action: "ignore" }` for the tab already selected, so a stray tap does not
 * restart a 23-source fan-out.
 *
 * `{ action: "run", query }` for every real group change, INCLUDING from
 * `mode: "idle"`. Clicking a category is a request to see it; the query is
 * taken from the search box, so a blank query browses (which is exactly what
 * the server does). This is the bug that was fixed: the old code called
 * `renderResults()` while idle, so opening the page and clicking "Movies"
 * re-rendered an empty list. Passing the box — not "" — preserves text the
 * user typed but did not yet submit.
 *
 * A re-run rather than a filter, because the server searches only the selected
 * group's sources — the other tabs' hits were never fetched. Same as the TUI,
 * where each tab is its own slice of one fan-out.
 */
export function tabClickPlan(view: SearchView, group: string, boxValue: string): TabClickPlan {
  return view.group === group
    ? { action: "ignore" }
    : { action: "run", query: boxValue };
}

// A release name in a confirm() has to leave room for the question and the
// buttons on a phone. Same job as dashboard.ts's shortName, at the shorter
// limit a two-line prompt can carry.
function clip(name: string): string {
  return name.length > 60 ? `${name.slice(0, 59)}…` : name;
}

/**
 * The cached marker for one result, or null for no marker.
 *
 * `canCheck` false means the active provider cannot answer — Real-Debrid
 * withdrew its instant-availability endpoint in 2024 — so nothing is rendered.
 * An "unknown" badge would read as "not cached", which is a claim torlink is
 * not in a position to make. Absence of a marker on an uncached result is the
 * same principle at result level.
 */
export function cachedTag(infoHash: string, cached: ReadonlySet<string>, canCheck: boolean): "cached" | null {
  if (!canCheck) return null;
  return cached.has(infoHash.toLowerCase()) ? "cached" : null;
}

/** How the results are laid out. */
export type ResultLayout = "list" | "grid";

/**
 * A remembered layout, or the default.
 *
 * Parsed rather than cast because the value comes from `localStorage`: it is
 * user-writable, it survives upgrades, and a stale entry must fall back rather
 * than render nothing. `"list"` is the default deliberately — it is the layout
 * that works with no OMDb key, which is the common install.
 */
export function parseLayout(raw: string | null): ResultLayout {
  return raw === "grid" ? "grid" : "list";
}

/**
 * A remembered grouping preference, or the default.
 *
 * Parsed rather than cast for the reason {@link parseLayout} is: the value comes
 * from `localStorage`, which is user-writable and survives upgrades, so a stale
 * or hand-edited entry must fall back rather than render nothing.
 *
 * Anything that is not the explicit opt-out means ON — see {@link emptyView} for
 * why that is the default rather than the cautious one.
 */
export function parseGrouping(raw: string | null): boolean {
  return raw !== "off";
}
