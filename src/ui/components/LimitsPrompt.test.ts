import { describe, expect, it } from "vitest";
import { parseLimits } from "./LimitsPrompt";

describe("parseLimits", () => {
  it("parses bandwidth and seed policy values", () => {
    expect(parseLimits("5000,1000,2,60")).toEqual({
      downloadLimitKbps: 5000, uploadLimitKbps: 1000, seedRatio: 2, seedMinutes: 60,
    });
  });
  it("allows empty unlimited values and rejects invalid input", () => {
    expect(parseLimits(",,1.5,")?.seedRatio).toBe(1.5);
    expect(parseLimits("fast,1,2,3")).toBeNull();
    expect(parseLimits("1,2,-1,3")).toBeNull();
  });
});
