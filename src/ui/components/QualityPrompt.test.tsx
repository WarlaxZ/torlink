import { describe, it, expect } from "vitest";
import { cycleResolution } from "./QualityPrompt";

describe("cycleResolution", () => {
  it("cycles none -> 2160p -> 1080p -> 720p -> 480p -> none", () => {
    const seq: (string | undefined)[] = [];
    let r = cycleResolution(undefined);
    for (let i = 0; i < 5; i++) { seq.push(r); r = cycleResolution(r); }
    expect(seq).toEqual(["2160p", "1080p", "720p", "480p", undefined]);
  });
});
