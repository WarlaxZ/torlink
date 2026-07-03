import { describe, it, expect } from "vitest";
import { parseCategory } from "./store";

describe("parseCategory", () => {
  it("accepts the known category keys", () => {
    expect(parseCategory("all")).toBe("all");
    expect(parseCategory("games")).toBe("games");
    expect(parseCategory("movies")).toBe("movies");
    expect(parseCategory("tv")).toBe("tv");
    expect(parseCategory("anime")).toBe("anime");
  });

  it("falls back to 'all' for missing, unknown, or non-category values", () => {
    expect(parseCategory(undefined)).toBe("all");
    expect(parseCategory("")).toBe("all");
    expect(parseCategory("garbage")).toBe("all");
    // downloads/seeding are sections but not result categories
    expect(parseCategory("downloads")).toBe("all");
    expect(parseCategory("seeding")).toBe("all");
  });
});
