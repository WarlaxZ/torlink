// Choosing a release for a title, shared by the TUI and the browser.
//
// IMPORTS ONLY `./release`, and must stay that way. `src/web/static/` is
// bundled with `platform: "browser"` (tsup.web.config.ts), so any `node:*`
// import — direct or transitive — fails `npm run build`. `parseRelease` is
// already in that bundle via `src/web/static/streamFlow.ts`, which is what
// makes it the one safe dependency. The sibling modules `resultSort.ts` and
// `resultFilter.ts` import nothing at all for the same reason.

import type { ParsedRelease } from "./release";

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
  hevc: { label: "HEVC / x265", test: (p) => p.codec === "x265" || p.codec === "hevc" },
  tenbit: { label: "10-bit", test: (p) => p.bitdepth === 10 },
};

export const FEATURE_IDS: readonly FeatureId[] = Object.keys(FEATURES) as FeatureId[];

export function hasFeature(p: ParsedRelease, id: FeatureId): boolean {
  return FEATURES[id].test(p);
}

export function isFeatureId(v: unknown): v is FeatureId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FEATURES, v);
}

export function isMaxResolution(v: unknown): v is MaxResolution {
  return typeof v === "string" && (MAX_RESOLUTIONS as readonly string[]).includes(v);
}
