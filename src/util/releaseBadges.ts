// The quality facts a result row can show, as short labels.
//
// The labels come from FEATURES in releasePick.ts rather than being written
// again here, so a badge on a row means precisely what the same word means in
// the quality preference the user set with `P`. Two vocabularies for one concept
// is how "HEVC" ends up meaning something subtly different in two places — the
// copy-then-drift bug this codebase has recorded four times.
import { parseRelease } from "./release";
import { FEATURES, hasFeature, type FeatureId } from "./releasePick";
import type { OmdbType } from "../recc/omdb";

/**
 * Badge order, and it is a decision rather than the table's order.
 *
 * A stacked 4K release carries nine of these, which is a spec sheet and not the
 * scan aid a list row needs — so both front ends slice this list (the terminal
 * shows fewer at 80 columns). That only works if what survives a slice is the
 * part worth keeping: picture facts, which change how a release looks and how
 * big it is, ahead of audio ones.
 *
 * Exported so a test can assert it covers every FEATURE_IDS entry: a feature
 * added to FEATURES and forgotten here would silently never render.
 */
export const BADGE_ORDER: readonly FeatureId[] = [
  "remux",
  "dv",
  "hdr",
  "tenbit",
  "hevc",
  "atmos",
  "truehd",
  "dts",
  "dd",
];

/**
 * Short labels for what a release name says about its quality.
 *
 * Empty when the name carries no quality facts, or when the parser cannot read
 * it at all — an honest absence. Inventing a "SD" or "unknown" badge would be
 * claiming something the release name does not say, the same principle
 * `cachedTag` follows in refusing to render an "unknown" cached marker.
 */
export function releaseBadges(name: string, hint?: OmdbType): string[] {
  const parsed = parseRelease(name, hint);
  if (!parsed) return [];
  const badges: string[] = [];
  // Resolution first: it is the fact a viewer scans for. Printed as the parser
  // read it — that vocabulary includes "1080i" and "4k", and rewriting it here
  // would be a second opinion about what the release says. Ranking is what
  // resolutionHeight() is for, and this is not ranking.
  if (parsed.resolution) badges.push(parsed.resolution);
  for (const id of BADGE_ORDER) {
    if (hasFeature(parsed, id)) badges.push(FEATURES[id].label);
  }
  return [...new Set(badges)];
}
