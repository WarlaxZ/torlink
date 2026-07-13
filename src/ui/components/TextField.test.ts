import { describe, it, expect } from "vitest";
import {
  deleteBefore,
  deleteAt,
  deleteWordBefore,
  deleteWordAfter,
  killToEnd,
  insertAt,
  wordLeft,
  wordRight,
} from "./TextField";

describe("deleteBefore", () => {
  it("removes the character to the left of the cursor", () => {
    expect(deleteBefore("abc", 2)).toEqual({ value: "ac", cursor: 1 });
  });
  it("is a no-op at the start of the line", () => {
    expect(deleteBefore("abc", 0)).toEqual({ value: "abc", cursor: 0 });
  });
});

describe("deleteWordBefore", () => {
  it("removes the word to the left of the cursor", () => {
    expect(deleteWordBefore("one two", 7)).toEqual({ value: "one ", cursor: 4 });
  });
});

describe("killToEnd", () => {
  it("removes everything from the cursor to the end", () => {
    expect(killToEnd("one two", 3)).toEqual({ value: "one", cursor: 3 });
  });
});

describe("insertAt", () => {
  it("inserts text at the cursor and advances it", () => {
    expect(insertAt("ac", 1, "b")).toEqual({ value: "abc", cursor: 2 });
  });
});

describe("wordLeft", () => {
  it("jumps to the start of the previous word, crossing runs of spaces", () => {
    expect(wordLeft("one two", 7)).toBe(4);
    expect(wordLeft("one two", 4)).toBe(0);
    expect(wordLeft("one   two", 6)).toBe(0);
    expect(wordLeft("one two", 5)).toBe(4);
  });

  it("stays put at the start of the line", () => {
    expect(wordLeft("one", 0)).toBe(0);
    expect(wordLeft("", 0)).toBe(0);
  });
});

describe("wordRight", () => {
  it("jumps past the end of the next word, crossing runs of spaces", () => {
    expect(wordRight("one two", 0)).toBe(3);
    expect(wordRight("one two", 3)).toBe(7);
    expect(wordRight("one   two", 3)).toBe(9);
    expect(wordRight("one two", 5)).toBe(7);
  });

  it("stays put at the end of the line", () => {
    expect(wordRight("one", 3)).toBe(3);
    expect(wordRight("", 0)).toBe(0);
  });
});

describe("deleteWordAfter", () => {
  it("removes through the end of the next word, keeping the cursor in place", () => {
    expect(deleteWordAfter("one two", 3)).toEqual({ value: "one", cursor: 3 });
    expect(deleteWordAfter("one two three", 4)).toEqual({ value: "one  three", cursor: 4 });
    expect(deleteWordAfter("one   two", 3)).toEqual({ value: "one", cursor: 3 });
  });

  it("no-ops at the end of the line", () => {
    expect(deleteWordAfter("one", 3)).toEqual({ value: "one", cursor: 3 });
    expect(deleteWordAfter("", 0)).toEqual({ value: "", cursor: 0 });
  });
});

describe("deleteAt", () => {
  it("removes the character under the cursor without moving it", () => {
    expect(deleteAt("abc", 0)).toEqual({ value: "bc", cursor: 0 });
    expect(deleteAt("abc", 1)).toEqual({ value: "ac", cursor: 1 });
  });

  it("no-ops at the end of the line", () => {
    expect(deleteAt("abc", 3)).toEqual({ value: "abc", cursor: 3 });
    expect(deleteAt("", 0)).toEqual({ value: "", cursor: 0 });
  });
});
