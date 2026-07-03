import { describe, expect, it } from "vitest";
import { shouldBench } from "./useConcurrentSearch";
import { AuthRequiredError } from "../../sources/rutracker/session";
import { HttpError } from "../../util/net";

describe("shouldBench", () => {
  it("does not bench on AuthRequiredError", () => {
    expect(shouldBench(new AuthRequiredError())).toBe(false);
  });

  it("benches on a generic error", () => {
    expect(shouldBench(new Error("boom"))).toBe(true);
  });

  it("benches on an HttpError", () => {
    expect(shouldBench(new HttpError(500, "server error"))).toBe(true);
  });

  it("benches on a non-Error thrown value", () => {
    expect(shouldBench("timed out")).toBe(true);
  });
});
