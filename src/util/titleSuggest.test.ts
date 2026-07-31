import { describe, it, expect } from "vitest";
import {
  emptySuggestState,
  shouldQuery,
  shouldQueryFor,
  applyReply,
  suppressFor,
  topSuggestion,
  suggestionLabel,
  akaNote,
  submitTextFor,
  tabHintLabel,
  SUGGEST_MIN_QUERY_LENGTH,
  type TitleSuggestion,
} from "./titleSuggest";

const KESTREL: TitleSuggestion = {
  imdbId: "tt0000001",
  title: "Kestrel",
  year: 2010,
  type: "movie",
  matchedAka: null,
};
const KEPLER: TitleSuggestion = {
  imdbId: "tt0000002",
  title: "Kepler",
  year: 2019,
  type: "tv",
  matchedAka: null,
};
const ASHFALL_AKA: TitleSuggestion = {
  imdbId: "tt0000003",
  title: "Ashfall",
  year: 1999,
  type: "movie",
  matchedAka: "Ashfall Rising",
};

describe("shouldQuery", () => {
  // Must agree with reccd's SEARCH_MIN_QUERY_LENGTH exactly: a lower number
  // fires requests guaranteed to return [], a higher one hides results reccd
  // would have given.
  it("matches reccd's minimum query length", () => {
    expect(SUGGEST_MIN_QUERY_LENGTH).toBe(2);
  });

  it("refuses anything shorter than two characters after trimming", () => {
    expect(shouldQuery("")).toBe(false);
    expect(shouldQuery(" ")).toBe(false);
    expect(shouldQuery("k")).toBe(false);
    expect(shouldQuery("  k  ")).toBe(false);
  });

  it("accepts two or more characters", () => {
    expect(shouldQuery("ke")).toBe(true);
    expect(shouldQuery("kestrel")).toBe(true);
    expect(shouldQuery("  ke  ")).toBe(true);
  });
});

describe("suggestionLabel", () => {
  // reccd's vocabulary is movie/tv; torlink says film/show everywhere else.
  it("renders a film with its year", () => {
    expect(suggestionLabel(KESTREL)).toBe("Kestrel (2010) · film");
  });

  it("renders a series as a show", () => {
    expect(suggestionLabel(KEPLER)).toBe("Kepler (2019) · show");
  });
});

describe("akaNote", () => {
  it("is null for a primary-title hit", () => {
    expect(akaNote(KESTREL)).toBeNull();
  });

  it("names the alternate title that caused the hit", () => {
    expect(akaNote(ASHFALL_AKA)).toBe('also known as "Ashfall Rising"');
  });
});

describe("submitTextFor", () => {
  // THE YEAR IS THE POINT. Canonicalising through a catalog is only worth
  // doing if it separates a remake from its original, and torrent release
  // names carry the year.
  it("includes the year", () => {
    expect(submitTextFor(KESTREL)).toBe("Kestrel 2010");
  });

  it("uses the primary title even when the hit came via an AKA", () => {
    expect(submitTextFor(ASHFALL_AKA)).toBe("Ashfall 1999");
  });
});

describe("applyReply", () => {
  it("applies a reply newer than the last one applied", () => {
    const next = applyReply(emptySuggestState(), 1, [KESTREL]);
    expect(next.items).toEqual([KESTREL]);
    expect(next.appliedSeq).toBe(1);
  });

  /**
   * MUTATION GUARD — the stale-response bug, which is real here rather than
   * hypothetical. reccd answers q="th" in ~311ms and q="dark kni" in ~71ms
   * (its own measured numbers), so the broad, stale reply lands AFTER the
   * narrow fresh one and would overwrite it: the list would disagree with the
   * input box. Debouncing does not fix this — two keystroke bursts separated
   * by more than the debounce window both fire, and nothing orders the replies.
   */
  it("discards a reply older than the newest one applied", () => {
    const fresh = applyReply(emptySuggestState(), 2, [KEPLER]);
    const stale = applyReply(fresh, 1, [KESTREL]);
    expect(stale.items).toEqual([KEPLER]);
    expect(stale.appliedSeq).toBe(2);
    expect(stale).toBe(fresh);
  });

  it("discards a reply whose seq equals the one already applied", () => {
    const first = applyReply(emptySuggestState(), 3, [KEPLER]);
    expect(applyReply(first, 3, [KESTREL]).items).toEqual([KEPLER]);
  });

  it("applies an empty reply, clearing what was there", () => {
    const some = applyReply(emptySuggestState(), 1, [KESTREL]);
    expect(applyReply(some, 2, []).items).toEqual([]);
  });
});

describe("shouldQueryFor", () => {
  it("defers to shouldQuery when nothing is suppressed", () => {
    expect(shouldQueryFor(emptySuggestState(), "ke")).toBe(true);
    expect(shouldQueryFor(emptySuggestState(), "k")).toBe(false);
  });

  // Accepting a suggestion writes its text into the box, which fires the
  // change handler again — without this the list would immediately reopen on
  // the text the user just picked. Escape reuses the same latch.
  it("refuses the exact text that was suppressed", () => {
    const s = suppressFor(emptySuggestState(), "Kestrel 2010");
    expect(shouldQueryFor(s, "Kestrel 2010")).toBe(false);
    expect(shouldQueryFor(s, "  Kestrel 2010  ")).toBe(false);
  });

  it("queries again as soon as the text changes", () => {
    const s = suppressFor(emptySuggestState(), "Kestrel 2010");
    expect(shouldQueryFor(s, "Kestrel 2010 1080p")).toBe(true);
  });
});

describe("suppressFor", () => {
  it("clears the list so nothing is left on screen", () => {
    const some = applyReply(emptySuggestState(), 1, [KESTREL, KEPLER]);
    expect(suppressFor(some, "ke").items).toEqual([]);
  });

  // The seq must survive: a request fired before Escape is still in flight,
  // and resetting the counter would let its reply reopen the dismissed list.
  it("keeps the applied seq so an in-flight reply cannot reopen the list", () => {
    const some = applyReply(emptySuggestState(), 4, [KESTREL]);
    const dismissed = suppressFor(some, "ke");
    expect(dismissed.appliedSeq).toBe(4);
    expect(applyReply(dismissed, 3, [KEPLER]).items).toEqual([]);
  });
});

describe("topSuggestion", () => {
  it("is null with no items", () => {
    expect(topSuggestion(emptySuggestState())).toBeNull();
  });

  it("is reccd's best-first first item", () => {
    const s = applyReply(emptySuggestState(), 1, [KESTREL, KEPLER]);
    expect(topSuggestion(s)).toEqual(KESTREL);
  });
});

describe("tabHintLabel", () => {
  it("offers completion while a list is open and browse otherwise", () => {
    expect(tabHintLabel(true)).toBe("complete");
    expect(tabHintLabel(false)).toBe("browse");
  });
});
