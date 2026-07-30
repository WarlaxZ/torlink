// Choosing a release for a title, shared by the TUI and the browser.
//
// IMPORTS ONLY `./release`, and must stay that way. `src/web/static/` is
// bundled with `platform: "browser"` (tsup.web.config.ts), so any `node:*`
// import — direct or transitive — fails `npm run build`. `parseRelease` is
// already in that bundle via `src/web/static/streamFlow.ts`, which is what
// makes it the one safe dependency. The sibling modules `resultSort.ts` and
// `resultFilter.ts` import nothing at all for the same reason.

import { parseRelease, type ParsedRelease } from "./release";

/** The ceilings a user can choose. A closed set because it is a UI choice. */
export type MaxResolution = "2160p" | "1080p" | "720p" | "480p";
export const MAX_RESOLUTIONS: readonly MaxResolution[] = ["2160p", "1080p", "720p", "480p"];

/**
 * A comparable height for a parser resolution token, or null when the name
 * said nothing usable.
 *
 * NOT AN ENUM LOOKUP, deliberately. parse-torrent-title emits "1080p" but also
 * "1080i", "576p" and "4k" (for both "4K" and "UHD"), and does not recognise
 * "8K" or "2K" at all. A union type over the tidy values would silently
 * mis-rank the untidy ones, which are common in real release names.
 */
export function resolutionHeight(token: string | undefined): number | null {
  const t = (token ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t === "4k") return 2160;
  const m = /^(\d{3,4})[pi]$/.exec(t);
  return m ? Number(m[1]) : null;
}

export type FeatureId =
  | "hdr" | "dv" | "atmos" | "dd" | "dts" | "truehd" | "remux" | "hevc" | "tenbit";

const inList = (list: string[] | undefined, want: string): boolean =>
  (list ?? []).some((v) => v.toLowerCase() === want);

/**
 * The features a user can require or exclude.
 *
 * A FIXED TABLE RATHER THAN FREE TEXT. A typed token cannot fail loudly: "4k"
 * or "DD+" would match nothing and look like a broken preference, and a bare
 * substring test for "dd" also matches "DDP", and any release group with those
 * letters in its name. Every test below reads the parser's own classified
 * fields, never the raw release name.
 */
export const FEATURES: Record<FeatureId, { label: string; test: (p: ParsedRelease) => boolean }> = {
  hdr: { label: "HDR", test: (p) => inList(p.colorList, "hdr") },
  dv: { label: "Dolby Vision", test: (p) => inList(p.colorList, "dv") },
  atmos: { label: "Atmos", test: (p) => inList(p.audioList, "atmos") },
  dd: { label: "Dolby Digital", test: (p) => inList(p.audioList, "dd") || inList(p.audioList, "ddp") },
  // Prefix rather than an enumeration: the parser reports the specific variant
  // ("dts", "dts-hd-ma", "dts-x") and new ones appear. Safe here only because
  // no other audio codec's name starts with "dts".
  dts: { label: "DTS", test: (p) => (p.audioList ?? []).some((a) => a.toLowerCase().startsWith("dts")) },
  truehd: { label: "TrueHD", test: (p) => inList(p.audioList, "truehd") },
  remux: { label: "Remux", test: (p) => p.remux === true },
  // "hevc" is NOT a value the parser produces: it normalises HEVC, h265 and
  // H.265 all to "h265", and leaves x265 as "x265". Testing for "hevc" would
  // be dead code that silently missed the commonest spelling.
  hevc: { label: "HEVC / x265", test: (p) => p.codec === "x265" || p.codec === "h265" },
  tenbit: { label: "10-bit", test: (p) => p.bitdepth === 10 },
};

export const FEATURE_IDS: readonly FeatureId[] = Object.keys(FEATURES) as FeatureId[];

/**
 * The three-state feature cell — off → require → exclude → off — and its mark,
 * shared so the terminal's `QualityPrompt` and the browser's preferences
 * disclosure render and cycle the same states. Copy-then-drift has bitten this
 * codebase four times (see the module doc comments this one echoes), so this
 * one lives here rather than in either front end.
 */
export type FeatureState = "off" | "require" | "exclude";
export const NEXT_FEATURE_STATE: Record<FeatureState, FeatureState> = {
  off: "require",
  require: "exclude",
  exclude: "off",
};
export const FEATURE_STATE_MARK: Record<FeatureState, string> = {
  off: "·",
  require: "✓",
  exclude: "✗",
};

export function hasFeature(p: ParsedRelease, id: FeatureId): boolean {
  return FEATURES[id].test(p);
}

export function isFeatureId(v: unknown): v is FeatureId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FEATURES, v);
}

export function isMaxResolution(v: unknown): v is MaxResolution {
  return typeof v === "string" && (MAX_RESOLUTIONS as readonly string[]).includes(v);
}

export interface QualityPrefs {
  maxResolution?: MaxResolution;
  require: readonly FeatureId[];
  exclude: readonly FeatureId[];
}

export const NO_PREFS: QualityPrefs = { require: [], exclude: [] };

/**
 * The fields a pick reads. Structural rather than `TorrentResult`, matching
 * `SortableResult` and `FilterableResult`, so the TUI's `TorrentResult` and the
 * browser's `PublicSearchResult` (which has no `magnet`) both satisfy it
 * without either layer importing the other's type.
 */
export interface PickableResult {
  name: string;
  sizeBytes: number;
  seeders: number;
}

export interface Survivor<T> {
  item: T;
  parsed: ParsedRelease;
}

export interface FilterOutcome<T> {
  survivors: Survivor<T>[];
  /** Requirements dropped to leave anything at all, in the order dropped. */
  relaxed: FeatureId[];
  /** True when no candidate was under the cap, so the cap was ignored. */
  overCap: boolean;
}

export function filterCandidates<T extends PickableResult>(
  candidates: readonly T[],
  prefs: QualityPrefs,
): FilterOutcome<T> {
  // 1. Parse, dropping names that are only quality/codec residue.
  let survivors: Survivor<T>[] = [];
  for (const item of candidates) {
    const parsed = parseRelease(item.name);
    if (parsed) survivors.push({ item, parsed });
  }

  // 2. Excluded features are HARD. Dropped even if that empties the list:
  //    "never play DV" has to mean never, and the caller reports the empty
  //    result rather than falling back to something the user ruled out.
  if (prefs.exclude.length) {
    survivors = survivors.filter((s) => !prefs.exclude.some((id) => hasFeature(s.parsed, id)));
  }

  // 3. The cap. A candidate whose resolution did not parse counts as UNDER it
  //    — the same trap `resultFilter.ts` documents for `seeders: 0`. Several
  //    sources emit names with no resolution token, and reading "unknown" as
  //    "too big" would empty those sources entirely.
  let overCap = false;
  const capHeight = prefs.maxResolution ? resolutionHeight(prefs.maxResolution) : null;
  if (capHeight !== null && survivors.length) {
    const under = survivors.filter((s) => {
      const h = resolutionHeight(s.parsed.resolution);
      return h === null || h <= capHeight;
    });
    if (under.length) survivors = under;
    else overCap = true; // nothing fits; keep everything and say so
  }

  // 4. Required features are SOFT. Drop the rarest unsatisfiable requirement
  //    and retry, so the commonest preference survives longest.
  const relaxed: FeatureId[] = [];
  let required = [...prefs.require];
  while (required.length && survivors.length) {
    const matching = survivors.filter((s) => required.every((id) => hasFeature(s.parsed, id)));
    if (matching.length) {
      survivors = matching;
      break;
    }
    // Rarest first: fewest survivors satisfy it.
    let rarest = required[0]!;
    let fewest = Infinity;
    for (const id of required) {
      const n = survivors.filter((s) => hasFeature(s.parsed, id)).length;
      if (n < fewest) {
        fewest = n;
        rarest = id;
      }
    }
    relaxed.push(rarest);
    required = required.filter((id) => id !== rarest);
  }

  return { survivors, relaxed, overCap };
}

/** What the caller is trying to watch. Decides how packs rank against episodes. */
export type PickIntent =
  | { kind: "film" }
  | { kind: "episode"; season: number; episode: number };

export interface Pick<T> {
  chosen: T;
  parsed: ParsedRelease;
  /** Requirements dropped to find a candidate. Empty when the preference was met. */
  relaxed: FeatureId[];
  /** True when no candidate was at or under the cap, so the cap was ignored. */
  overCap: boolean;
  /**
   * True when the intent named an episode but the chosen release does not name
   * that episode — a season pack, a series pack, or an unbanded release. The
   * caller must then select the file inside it (`nextEpisodeIndex`) rather than
   * playing the first one.
   */
  fromPack: boolean;
}

// 0 = names the exact episode, 1 = a pack covering it, 2 = everything else.
// A complete-series pack ("S01-S05") parses as `season: 1` — the parser takes
// the first number of a range rather than reporting the span. So such a pack
// bands as a genuine season-1 pack, and drops to the last band for any other
// season it in fact contains. That is conservative in the right direction: it
// is never promoted over a release that names the wanted season outright, and
// it is still chosen when it is all that exists.
function bandFor(parsed: ParsedRelease, intent: PickIntent): number {
  if (intent.kind === "film") return 0;
  if (parsed.season !== intent.season) return 2;
  if (parsed.episode === intent.episode) return 0;
  return parsed.episode === undefined ? 1 : 2;
}

export function rankReleases<T extends PickableResult>(
  candidates: readonly T[],
  prefs: QualityPrefs,
  intent: PickIntent,
): Pick<T>[] {
  const { survivors, relaxed, overCap } = filterCandidates(candidates, prefs);

  // An unknown resolution ranks LAST among known ones. Note the deliberate
  // asymmetry with the cap in `filterCandidates`, which treats unknown as
  // under: optimistic for inclusion, pessimistic for ranking, so such a release
  // is never excluded but is only chosen when nothing states a resolution.
  //
  // -1 is correct in BOTH directions, and the `overCap` case cannot arise:
  // `filterCandidates` counts an unknown resolution as under the cap, so a
  // single unknown-resolution survivor is enough to keep `overCap` false.
  // `overCap === true` therefore implies every survivor states a height.
  const heightRank = (p: ParsedRelease): number => resolutionHeight(p.resolution) ?? -1;

  const ranked = survivors.slice().sort((a, b) => {
    const ha = heightRank(a.parsed);
    const hb = heightRank(b.parsed);
    if (ha !== hb) return overCap ? ha - hb : hb - ha;
    const ba = bandFor(a.parsed, intent);
    const bb = bandFor(b.parsed, intent);
    if (ba !== bb) return ba - bb;
    if (a.item.sizeBytes !== b.item.sizeBytes) return b.item.sizeBytes - a.item.sizeBytes;
    if (a.item.seeders !== b.item.seeders) return b.item.seeders - a.item.seeders;
    return a.item.name.localeCompare(b.item.name);
  });

  return ranked.map((s) => ({
    chosen: s.item,
    parsed: s.parsed,
    relaxed,
    overCap,
    fromPack: intent.kind === "episode" && bandFor(s.parsed, intent) !== 0,
  }));
}

/**
 * The winner, or null. Exactly `rankReleases(...)[0] ?? null`.
 *
 * `rankReleases` is exported alongside it because spec C walks the ranking:
 * Real-Debrid has no cache-check endpoint, so neither "is it cached" nor "has
 * it been taken down" can be answered without trying a candidate. Returning
 * only a winner would force that loop to re-rank or reimplement the ordering.
 */
export function pickBestRelease<T extends PickableResult>(
  candidates: readonly T[],
  prefs: QualityPrefs,
  intent: PickIntent,
): Pick<T> | null {
  return rankReleases(candidates, prefs, intent)[0] ?? null;
}

/**
 * One line naming what was chosen and, when the preference was not met, what
 * gave way. Shared so the terminal and the browser say the same thing — the
 * copy-then-drift bug this codebase has hit four times.
 */
/**
 * The other two phase strings a one-click pick can show, shared for the same
 * reason `pickStatusLine` is: the terminal and the browser wrote their own
 * copies of these and drifted (no quotes vs. curly quotes, "Finding" vs.
 * "Searching"). One home for all three phase strings, here.
 */
export function pickSearchingLine(title: string): string {
  return `Searching for “${title}”…`;
}

export function pickNoneLine(title: string): string {
  return `No release found for “${title}”.`;
}

export function pickStatusLine<T extends PickableResult>(
  pick: Pick<T>,
  maxResolution?: MaxResolution,
): string {
  const notes: string[] = [];
  if (pick.overCap) {
    notes.push(
      maxResolution ? `nothing at ${maxResolution} or below` : "nothing under your resolution limit",
    );
  }
  for (const id of pick.relaxed) notes.push(`no ${FEATURES[id].label} release`);
  const head = `Playing ${pick.chosen.name}`;
  return notes.length ? `${head} — ${notes.join(", ")}` : head;
}
