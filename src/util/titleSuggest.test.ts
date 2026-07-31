import { describe, it, expect } from "vitest";
import {
  emptySuggestState,
  shouldQuery,
  shouldQueryFor,
  shouldSuggestFor,
  applyReply,
  isSuggestOpen,
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

describe("shouldSuggestFor", () => {
  // The whole reason this is a derived predicate rather than a latch set when the
  // search box is entered: a latch holds only while every path into the box
  // remembers to set it, and a path that forgets fails silently and invisibly.
  // Everything below is a property of the two strings and nothing else, so it
  // holds however — and whether or not — the box was entered.
  it("refuses a draft that still equals the submitted search", () => {
    expect(shouldSuggestFor("Kestrel 2010", "Kestrel 2010")).toBe(false);
  });

  it("allows a draft the user has actually changed", () => {
    expect(shouldSuggestFor("Kestrel 2010 1080p", "Kestrel 2010")).toBe(true);
    expect(shouldSuggestFor("Kestrel 201", "Kestrel 2010")).toBe(true);
  });

  it("ignores surrounding whitespace on either side", () => {
    // Whichever side it lands on, this is the same text and must not re-ask.
    expect(shouldSuggestFor("  Kestrel 2010  ", "Kestrel 2010")).toBe(false);
    expect(shouldSuggestFor("Kestrel 2010", "  Kestrel 2010  ")).toBe(false);
  });

  it("refuses an empty box that has never been searched", () => {
    // The state at mount on a fresh browse: nothing typed, nothing submitted.
    expect(shouldSuggestFor("", "")).toBe(false);
  });

  it("allows the first thing typed into a box with no submitted search", () => {
    expect(shouldSuggestFor("ke", "")).toBe(true);
  });

  it("allows an emptied box after a search, so the rows can be cleared", () => {
    // The length gate downstream is what stops a request here; this predicate's
    // job is only "has the text moved on", and it has.
    expect(shouldSuggestFor("", "Kestrel 2010")).toBe(true);
  });

  it("is case sensitive, matching the text the box actually holds", () => {
    // reccd's results differ by query, and "kestrel" is a different question from
    // "Kestrel" as far as the box is concerned — so this must not fold case and
    // silently withhold suggestions for a retyped title.
    expect(shouldSuggestFor("kestrel 2010", "Kestrel 2010")).toBe(true);
  });
});

describe("suppressFor", () => {
  it("clears the list so nothing is left on screen", () => {
    const some = applyReply(emptySuggestState(), 1, [KESTREL, KEPLER]);
    expect(suppressFor(some, "ke", 1).items).toEqual([]);
  });

  /**
   * THE DISMISS-THEN-REOPEN BUG, and the reason `throughSeq` exists.
   *
   * The shape on all three paths (terminal Escape, browser Escape, browser
   * blur): a reply lands and rows appear (seq 4), the user types one more
   * character so a request numbered 5 goes out, then dismisses. The request is
   * still in flight and 5 > 4, so before this parameter existed its reply
   * applied and the list the user had just closed came back — costing a THIRD
   * keypress to leave the terminal's search box, against help text promising
   * one.
   *
   * The previous version of this test asserted `appliedSeq` merely survived and
   * then probed with seq 3 — the one seq that was already discarded. It passed
   * against the bug.
   */
  it("discards the reply to a request that was in flight when it was called", () => {
    const some = applyReply(emptySuggestState(), 4, [KESTREL]);
    const inFlight = 5; // ++seq for the keystroke after the visible reply
    const dismissed = suppressFor(some, "kestr", inFlight);
    expect(dismissed.appliedSeq).toBe(5);
    expect(applyReply(dismissed, inFlight, [KEPLER]).items).toEqual([]);
  });

  it("still discards a reply older than the one already applied", () => {
    const some = applyReply(emptySuggestState(), 4, [KESTREL]);
    const dismissed = suppressFor(some, "ke", 4);
    expect(applyReply(dismissed, 3, [KEPLER]).items).toEqual([]);
  });

  // A stale counter must not lower the bar and let an outstanding reply back in.
  it("never lowers the high-water mark", () => {
    const some = applyReply(emptySuggestState(), 7, [KESTREL]);
    const dismissed = suppressFor(some, "ke", 2);
    expect(dismissed.appliedSeq).toBe(7);
  });

  // The latch and the seq guard are separate jobs: text the user changes must be
  // askable again, and the next request's seq is higher still.
  it("leaves a later request free to open the list again", () => {
    const some = applyReply(emptySuggestState(), 4, [KESTREL]);
    const dismissed = suppressFor(some, "kestr", 5);
    expect(shouldQueryFor(dismissed, "kestre")).toBe(true);
    expect(applyReply(dismissed, 6, [KEPLER]).items).toEqual([KEPLER]);
  });
});

describe("isSuggestOpen", () => {
  it("is false with nothing to show", () => {
    expect(isSuggestOpen(emptySuggestState())).toBe(false);
  });

  it("is true once a reply has landed", () => {
    expect(isSuggestOpen(applyReply(emptySuggestState(), 1, [KESTREL]))).toBe(true);
  });

  it("is false again after a dismiss", () => {
    const some = applyReply(emptySuggestState(), 1, [KESTREL]);
    expect(isSuggestOpen(suppressFor(some, "ke", 1))).toBe(false);
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
