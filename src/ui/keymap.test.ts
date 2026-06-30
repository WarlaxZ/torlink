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
