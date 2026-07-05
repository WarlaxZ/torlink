import { describe, expect, it } from "vitest";
import { toggleSavedSearches } from "./savedSearches";

describe("toggleSavedSearches", () => {
  it("adds, removes, trims, and caps saved searches", () => {
    expect(toggleSavedSearches(["old"], " new ")).toEqual(["new", "old"]);
    expect(toggleSavedSearches(["new", "old"], "new")).toEqual(["old"]);
    expect(toggleSavedSearches(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });
});
