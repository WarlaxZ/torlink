import { fetchWordpressRss } from "./rss";
import type { Source } from "./types";

// DODI Repacks: a long-standing, trusted games repacker (the usual companion to
// FitGirl). Games are the one category that can run code, so — like FitGirl —
// this stays limited to a reputable repacker rather than a general tracker.
// Same WordPress-RSS shape as FitGirl, so it reuses the shared feed reader.
const HOME = "https://dodi-repacks.site";

export const dodi: Source = {
  id: "dodi",
  label: "DODI",
  group: "Games",
  homepage: HOME,
  search: (query, opts) => fetchWordpressRss(HOME, "dodi", query, opts),
};
