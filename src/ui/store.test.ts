import { describe, it, expect } from "vitest";
import { isCategory, parseCategory } from "./store";

describe("parseCategory", () => {
  it("accepts the known category keys", () => {
    expect(parseCategory("all")).toBe("all");
    expect(parseCategory("games")).toBe("games");
    expect(parseCategory("movies")).toBe("movies");
    expect(parseCategory("tv")).toBe("tv");
    expect(parseCategory("anime")).toBe("anime");
    expect(parseCategory("books")).toBe("books");
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

describe("isCategory", () => {
  it("excludes the downloads/seeding/accounts sections", () => {
    expect(isCategory("accounts")).toBe(false);
    expect(isCategory("downloads")).toBe(false);
    expect(isCategory("seeding")).toBe(false);
  });

  it("includes the result categories", () => {
    expect(isCategory("all")).toBe(true);
    expect(isCategory("games")).toBe(true);
    expect(isCategory("movies")).toBe(true);
    expect(isCategory("tv")).toBe(true);
    expect(isCategory("anime")).toBe(true);
    expect(isCategory("books")).toBe(true);
  });
});
