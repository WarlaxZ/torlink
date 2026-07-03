import { describe, it, expect } from "vitest";
import { addToHistory, historyStep } from "./searchHistory";

describe("addToHistory", () => {
  it("prepends the newest query", () => {
    expect(addToHistory(["a"], "b")).toEqual(["b", "a"]);
  });

  it("ignores empty/whitespace queries", () => {
    expect(addToHistory(["a"], "")).toEqual(["a"]);
    expect(addToHistory(["a"], "   ")).toEqual(["a"]);
  });

  it("trims the stored query", () => {
    expect(addToHistory([], "  hi  ")).toEqual(["hi"]);
  });

  it("de-duplicates, moving an existing query to the front", () => {
    expect(addToHistory(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("caps the list length, dropping the oldest", () => {
    expect(addToHistory(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("historyStep", () => {
  // history is newest-first; index -1 means "editing the draft, not navigating".
  it("prev walks toward older entries and stops at the end", () => {
    expect(historyStep("prev", -1, 3)).toBe(0);
    expect(historyStep("prev", 0, 3)).toBe(1);
    expect(historyStep("prev", 2, 3)).toBe(2); // already oldest
  });

  it("prev is a no-op with empty history", () => {
    expect(historyStep("prev", -1, 0)).toBe(-1);
  });

  it("next walks back toward the draft", () => {
    expect(historyStep("next", 2, 3)).toBe(1);
    expect(historyStep("next", 0, 3)).toBe(-1); // back to the draft
  });

  it("next from the draft signals exit (leave the field)", () => {
    expect(historyStep("next", -1, 3)).toBe("exit");
    expect(historyStep("next", -1, 0)).toBe("exit");
  });
});
