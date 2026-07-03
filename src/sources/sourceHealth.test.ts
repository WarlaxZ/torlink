import { describe, it, expect } from "vitest";
import {
  recordFailure,
  recordSuccess,
  isSkipped,
  FAIL_THRESHOLD,
  COOLDOWN_MS,
  type Health,
} from "./sourceHealth";
import type { SourceId } from "./types";

const ID: SourceId = "yts";
const fresh = (): Map<SourceId, Health> => new Map();

describe("source health", () => {
  it("does not skip a source below the failure threshold", () => {
    const m = fresh();
    for (let i = 0; i < FAIL_THRESHOLD - 1; i++) recordFailure(m, ID, 1000);
    expect(isSkipped(m, ID, 1000)).toBe(false);
  });

  it("skips a source once it hits the threshold, for the cooldown window", () => {
    const m = fresh();
    for (let i = 0; i < FAIL_THRESHOLD; i++) recordFailure(m, ID, 1000);
    expect(isSkipped(m, ID, 1000)).toBe(true);
    expect(isSkipped(m, ID, 1000 + COOLDOWN_MS - 1)).toBe(true);
    // After the cooldown lapses it's retried again.
    expect(isSkipped(m, ID, 1000 + COOLDOWN_MS + 1)).toBe(false);
  });

  it("a success clears the failure state entirely", () => {
    const m = fresh();
    for (let i = 0; i < FAIL_THRESHOLD; i++) recordFailure(m, ID, 1000);
    recordSuccess(m, ID);
    expect(isSkipped(m, ID, 1000)).toBe(false);
    expect(m.has(ID)).toBe(false);
  });

  it("a failure after the cooldown re-benches the source", () => {
    const m = fresh();
    for (let i = 0; i < FAIL_THRESHOLD; i++) recordFailure(m, ID, 1000);
    const later = 1000 + COOLDOWN_MS + 1;
    expect(isSkipped(m, ID, later)).toBe(false); // eligible for retry
    recordFailure(m, ID, later); // retry failed
    expect(isSkipped(m, ID, later)).toBe(true); // benched again
  });

  it("is unknown sources are never skipped", () => {
    expect(isSkipped(fresh(), "nyaa", 1000)).toBe(false);
  });
});
