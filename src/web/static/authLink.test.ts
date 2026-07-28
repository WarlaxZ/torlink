// The magic-link half of the token flow. A pure function because app.ts is the
// untested imperative shell of this layer — every piece of client logic worth a
// test lives in a module like this one (searchModel, dashboard, previewModel).
import { describe, it, expect } from "vitest";
import { tokenFromHash } from "./authLink";

describe("tokenFromHash", () => {
  it("reads the token out of a magic link", () => {
    expect(tokenFromHash("#k=deadbeef")).toBe("deadbeef");
  });
  it("works without the leading hash", () => {
    expect(tokenFromHash("k=deadbeef")).toBe("deadbeef");
  });
  it("decodes a percent-encoded token", () => {
    expect(tokenFromHash("#k=a%20b%26c")).toBe("a b&c");
  });
  it("finds k among other fragment params", () => {
    expect(tokenFromHash("#view=queue&k=deadbeef")).toBe("deadbeef");
  });
  it("returns empty for an empty hash", () => {
    expect(tokenFromHash("")).toBe("");
    expect(tokenFromHash("#")).toBe("");
  });
  it("returns empty when the fragment carries no token", () => {
    expect(tokenFromHash("#view=queue")).toBe("");
  });
  it("returns empty for a present but blank token", () => {
    expect(tokenFromHash("#k=")).toBe("");
    expect(tokenFromHash("#k=%20%20")).toBe("");
  });
});
