// Shared by the Netflix and Trakt importers. Both reccd import endpoints return
// the same imported/resolved/unresolved counts, so the summary line is formatted
// in one place. Structural typing means any result object with these three
// numeric fields (NetflixImportResult, TraktImportResult) is accepted.
export interface ImportSummaryFields {
  imported: number;
  resolved: number;
  unresolved: number;
}

// `unresolved` is an event-level count (a title watched twice counts twice),
// whereas any accompanying `unresolvedTitles` list is the distinct set — so the
// number here can legitimately exceed the length of that list.
export function formatImportSummary<T extends ImportSummaryFields>(r: T): string {
  return `Imported ${r.imported} · ${r.resolved} matched · ${r.unresolved} unmatched`;
}
