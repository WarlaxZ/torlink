import { describe, it, expect } from "vitest";
import { parseRepoSlug } from "./github";

describe("parseRepoSlug", () => {
  it("parses git+https with a .git suffix", () => {
    expect(parseRepoSlug("git+https://github.com/WarlaxZ/torlink.git")).toEqual({
      owner: "WarlaxZ",
      repo: "torlink",
    });
  });
  it("parses a plain https url", () => {
    expect(parseRepoSlug("https://github.com/WarlaxZ/torlink")).toEqual({
      owner: "WarlaxZ",
      repo: "torlink",
    });
  });
  it("parses an ssh url", () => {
    expect(parseRepoSlug("git@github.com:WarlaxZ/torlink.git")).toEqual({
      owner: "WarlaxZ",
      repo: "torlink",
    });
  });
  it("returns null for a non-github url or garbage", () => {
    expect(parseRepoSlug("https://gitlab.com/o/r")).toBeNull();
    expect(parseRepoSlug("not a url")).toBeNull();
    expect(parseRepoSlug(null)).toBeNull();
  });
});
