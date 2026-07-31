import { describe, it, expect } from "vitest";
import {
  emptyListState,
  isOpen,
  withReply,
  moveHighlight,
  highlightAt,
  closedFor,
  acceptPlan,
  rowPlan,
} from "./suggestModel";
import { shouldQueryFor, type TitleSuggestion } from "../../util/titleSuggest";

const KESTREL: TitleSuggestion = {
  imdbId: "tt0000001", title: "Kestrel", year: 2010, type: "movie", matchedAka: null,
};
const KEPLER: TitleSuggestion = {
  imdbId: "tt0000002", title: "Kepler", year: 2019, type: "tv", matchedAka: null,
};
const ASHFALL_AKA: TitleSuggestion = {
  imdbId: "tt0000003", title: "Ashfall", year: 1999, type: "movie", matchedAka: "Ashfall Rising",
};

const THREE = [KESTREL, KEPLER, ASHFALL_AKA];

describe("isOpen", () => {
  it("is closed with nothing to show", () => {
    expect(isOpen(emptyListState())).toBe(false);
  });

  it("is open once there are hits", () => {
    expect(isOpen(withReply(emptyListState(), 1, [KESTREL]))).toBe(true);
  });

  it("is closed again when a reply brings nothing", () => {
    const open = withReply(emptyListState(), 1, [KESTREL]);
    expect(isOpen(withReply(open, 2, []))).toBe(false);
  });
});

describe("withReply", () => {
  it("starts with nothing highlighted, so Enter still submits what was typed", () => {
    expect(withReply(emptyListState(), 1, THREE).highlight).toBe(-1);
  });

  it("drops a highlight that a new, shorter reply would put out of range", () => {
    const moved = moveHighlight(withReply(emptyListState(), 1, THREE), 1);
    expect(moved.highlight).toBe(0);
    expect(withReply(moved, 2, [KEPLER]).highlight).toBe(-1);
  });

  // The stale-reply guard belongs to the shared model; this proves the browser
  // wrapper actually routes through it rather than assigning items directly.
  it("ignores a reply older than the newest applied", () => {
    const fresh = withReply(emptyListState(), 2, [KEPLER]);
    expect(withReply(fresh, 1, [KESTREL]).suggest.items).toEqual([KEPLER]);
  });
});

describe("moveHighlight", () => {
  it("enters the list from nothing on down", () => {
    expect(moveHighlight(withReply(emptyListState(), 1, THREE), 1).highlight).toBe(0);
  });

  it("enters at the last row from nothing on up", () => {
    expect(moveHighlight(withReply(emptyListState(), 1, THREE), -1).highlight).toBe(2);
  });

  it("wraps past the end", () => {
    let s = withReply(emptyListState(), 1, THREE);
    s = moveHighlight(s, 1);
    s = moveHighlight(s, 1);
    s = moveHighlight(s, 1);
    expect(s.highlight).toBe(2);
    expect(moveHighlight(s, 1).highlight).toBe(0);
  });

  it("wraps past the start", () => {
    const first = moveHighlight(withReply(emptyListState(), 1, THREE), 1);
    expect(moveHighlight(first, -1).highlight).toBe(2);
  });

  it("does nothing with a closed list", () => {
    expect(moveHighlight(emptyListState(), 1).highlight).toBe(-1);
  });
});

describe("highlightAt", () => {
  it("highlights the clicked row", () => {
    const s = highlightAt(withReply(emptyListState(), 1, THREE), 2);
    expect(s.highlight).toBe(2);
    expect(acceptPlan(s, "ash")).toEqual({ kind: "suggestion", text: "Ashfall 1999" });
  });

  // Ignored, not clamped: the only caller is a row's own listener, so an
  // out-of-range index means the rows changed under the click — and searching a
  // DIFFERENT title than the one clicked is worse than doing nothing.
  it("ignores an index the list no longer has", () => {
    const s = withReply(emptyListState(), 1, [KESTREL]);
    expect(highlightAt(s, 3).highlight).toBe(-1);
    expect(highlightAt(s, -1).highlight).toBe(-1);
  });
});

describe("acceptPlan", () => {
  // Enter with nothing highlighted must submit what the user typed. Silently
  // substituting a suggestion for their own words is the one thing autocomplete
  // must never do.
  it("submits the raw text when nothing is highlighted", () => {
    const s = withReply(emptyListState(), 1, THREE);
    expect(acceptPlan(s, "kes")).toEqual({ kind: "raw", text: "kes" });
  });

  it("submits the highlighted suggestion's title and year", () => {
    const s = moveHighlight(withReply(emptyListState(), 1, THREE), 1);
    expect(acceptPlan(s, "kes")).toEqual({ kind: "suggestion", text: "Kestrel 2010" });
  });

  it("uses the primary title when the highlight matched via an AKA", () => {
    let s = withReply(emptyListState(), 1, THREE);
    s = moveHighlight(s, -1);
    expect(acceptPlan(s, "ashfall ris")).toEqual({ kind: "suggestion", text: "Ashfall 1999" });
  });

  it("submits the raw text when the list is closed", () => {
    expect(acceptPlan(emptyListState(), "kes")).toEqual({ kind: "raw", text: "kes" });
  });
});

describe("closedFor", () => {
  it("closes the list and clears the highlight", () => {
    const s = moveHighlight(withReply(emptyListState(), 1, THREE), 1);
    const shut = closedFor(s, "kes");
    expect(isOpen(shut)).toBe(false);
    expect(shut.highlight).toBe(-1);
  });

  // Escape must stick. Without the suppression latch the next debounce tick
  // would re-fire the same query and reopen what the user just dismissed.
  it("stops the same text being queried again", () => {
    const shut = closedFor(withReply(emptyListState(), 1, THREE), "kes");
    expect(shouldQueryFor(shut.suggest, "kes")).toBe(false);
    expect(shouldQueryFor(shut.suggest, "kest")).toBe(true);
  });
});

describe("rowPlan", () => {
  it("is empty for a closed list", () => {
    expect(rowPlan(emptyListState())).toEqual([]);
  });

  it("labels every row and marks the highlighted one", () => {
    const s = moveHighlight(withReply(emptyListState(), 1, THREE), 1);
    expect(rowPlan(s)).toEqual([
      { label: "Kestrel (2010) · film", aka: null, highlighted: true },
      { label: "Kepler (2019) · show", aka: null, highlighted: false },
      { label: 'Ashfall (1999) · film', aka: 'also known as "Ashfall Rising"', highlighted: false },
    ]);
  });
});
