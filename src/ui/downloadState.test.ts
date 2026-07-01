import { describe, it, expect } from "vitest";
import { downloadStateFor, deliveryMethod } from "./downloadState";

const item = (id: string, status: string) => ({ id, status });
const hist = (id: string) => ({ id });

describe("downloadStateFor", () => {
  it("returns the active state when the hash is in the queue", () => {
    const items = [item("a", "downloading"), item("b", "paused"), item("c", "failed")];
    expect(downloadStateFor("a", items, [])).toBe("downloading");
    expect(downloadStateFor("b", items, [])).toBe("paused");
    expect(downloadStateFor("c", items, [])).toBe("failed");
  });

  it("treats any other active status as downloading (in-progress)", () => {
    expect(downloadStateFor("a", [item("a", "resolving")], [])).toBe("downloading");
  });

  it("returns done when only in history", () => {
    expect(downloadStateFor("h", [], [hist("h")])).toBe("done");
  });

  it("prefers an active queue item over history (re-download in progress)", () => {
    expect(downloadStateFor("x", [item("x", "downloading")], [hist("x")])).toBe("downloading");
  });

  it("returns null when the hash is untouched", () => {
    expect(downloadStateFor("z", [item("a", "downloading")], [hist("h")])).toBeNull();
  });
});

describe("deliveryMethod", () => {
  it("labels realdebrid as RD and everything else as P2P", () => {
    expect(deliveryMethod("realdebrid")).toBe("RD");
    expect(deliveryMethod("p2p")).toBe("P2P");
    expect(deliveryMethod(undefined)).toBe("P2P");
  });
});
