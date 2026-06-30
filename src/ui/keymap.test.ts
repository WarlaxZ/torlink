import { describe, it, expect } from "vitest";
import { footerHints } from "./keymap";

describe("footerHints results view", () => {
  it("offers the Real-Debrid shortcut only when a token is configured", () => {
    const without = footerHints("content", "all", null, null, false);
    expect(without.some((h) => h.label === "Real-Debrid")).toBe(false);

    const withToken = footerHints("content", "all", null, null, true);
    const labels = withToken.map((h) => h.label);
    expect(labels).toContain("Real-Debrid");
    expect(labels).toContain("Stream");
    // The plain P2P download stays available alongside it.
    expect(labels).toContain("Download");
  });
});

describe("footerHints Real-Debrid discoverability", () => {
  it("shows a k hint on results when RD is not configured", () => {
    const hints = footerHints("content", "all", null, null, false);
    expect(hints.some((h) => h.keys === "k" && /real-debrid/i.test(h.label))).toBe(true);
    expect(hints.some((h) => h.keys === "r")).toBe(false);
  });

  it("shows r and v instead of the k hint when configured", () => {
    const hints = footerHints("content", "all", null, null, true);
    expect(hints.some((h) => h.keys === "r")).toBe(true);
    expect(hints.some((h) => h.keys === "k" && /real-debrid/i.test(h.label))).toBe(false);
  });
});
