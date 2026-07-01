import { describe, it, expect } from "vitest";
import {
  deleteBefore,
  deleteAfter,
  deleteWordBefore,
  killToEnd,
  insertAt,
} from "./TextField";

describe("deleteBefore", () => {
  it("removes the character to the left of the cursor", () => {
    expect(deleteBefore("abc", 2)).toEqual({ value: "ac", cursor: 1 });
  });
  it("is a no-op at the start of the line", () => {
    expect(deleteBefore("abc", 0)).toEqual({ value: "abc", cursor: 0 });
  });
});

describe("deleteAfter", () => {
  it("removes the character to the right of the cursor, keeping the cursor put", () => {
    expect(deleteAfter("abc", 1)).toEqual({ value: "ac", cursor: 1 });
  });
  it("deletes the first character when the cursor is at the start", () => {
    expect(deleteAfter("abc", 0)).toEqual({ value: "bc", cursor: 0 });
  });
  it("is a no-op at the end of the line", () => {
    expect(deleteAfter("abc", 3)).toEqual({ value: "abc", cursor: 3 });
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
