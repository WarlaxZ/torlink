import { describe, expect, it } from "vitest";
import { NYAA_LITERATURE_CATEGORY, nyaaLiterature } from "./nyaa";
import { TPB_BOOK_CATEGORIES, tpbBooks } from "./piratebay";

describe("Books sources", () => {
  it("uses TPB's audiobook, ebook, and comics categories", () => {
    expect([...TPB_BOOK_CATEGORIES]).toEqual([102, 601, 602]);
    expect(tpbBooks).toMatchObject({ id: "tpb-books", group: "Books" });
  });

  it("uses Nyaa's Literature category", () => {
    expect(NYAA_LITERATURE_CATEGORY).toBe("3_0");
    expect(nyaaLiterature).toMatchObject({ id: "nyaa-literature", group: "Books" });
  });
});
