// A human-readable breakdown of a torrent release name, for surfaces that have
// no richer metadata than the name itself — chiefly the adult ("Porn") group,
// which OMDb cannot describe. Reuses parseRelease (the one wrapper over
// parse-torrent-title) so "source"/"codec"/"group" mean exactly what they mean
// on a result-row badge, and adds a best-effort studio the parser can't give.
//
// Bundled for the browser: no node:* imports.
import { parseRelease } from "./release";

export interface BreakdownField {
  label: string;
  value: string;
}

/**
 * The studio/site, guessed from the first `[bracket]` — the shape adult
 * releases use ("[Meridian Studios 2026]"). Best-effort by design: a trailing
 * year is stripped, and a name with no bracket yields `undefined` rather than a
 * wrong guess from, say, a leading word that might be the title.
 */
export function studioFromName(name: string): string | undefined {
  const m = name.match(/\[([^\]]+)\]/);
  if (!m?.[1]) return undefined;
  const studio = m[1].replace(/\s*\b(?:19|20)\d{2}\b\s*$/, "").trim();
  return studio === "" ? undefined : studio;
}

/**
 * Ordered breakdown fields. Empty fields are dropped, so the pane never renders
 * a blank row. Order is fixed: identity (studio, year) before quality
 * (resolution, source, codec) before provenance (group).
 */
export function releaseBreakdown(name: string): BreakdownField[] {
  const parsed = parseRelease(name);
  const fields: BreakdownField[] = [];
  const studio = studioFromName(name);
  if (studio) fields.push({ label: "Studio", value: studio });
  if (parsed?.year) fields.push({ label: "Year", value: String(parsed.year) });
  if (parsed?.resolution) fields.push({ label: "Resolution", value: parsed.resolution });
  if (parsed?.source) fields.push({ label: "Source", value: parsed.source.toUpperCase() });
  if (parsed?.codec) fields.push({ label: "Codec", value: parsed.codec });
  if (parsed?.group) fields.push({ label: "Group", value: parsed.group });
  return fields;
}

/** The breakdown as one line, or an honest sentence when the name says nothing. */
export function breakdownSummary(name: string): string {
  const text = releaseBreakdown(name)
    .map((f) => `${f.label}: ${f.value}`)
    .join(" · ");
  return text || "No further details in the release name.";
}
