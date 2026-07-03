import { describe, it, expect } from "vitest";
import { footerHints, HELP_GROUPS } from "./keymap";

describe("footerHints results view", () => {
  it("offers the Real-Debrid shortcut only when a token is configured, but Stream always", () => {
    const without = footerHints("content", "all", null, null, false);
    expect(without.some((h) => h.keys === "r")).toBe(false);
    // Torrent streaming needs no Real-Debrid token, so its hint must be
    // visible for exactly the users who don't have one configured.
    expect(without.some((h) => h.keys === "v")).toBe(true);

    const withToken = footerHints("content", "all", null, null, true);
    const labels = withToken.map((h) => h.label);
    expect(labels).toContain("Real-Debrid");
    expect(labels).toContain("Stream");
    // The plain P2P download stays available alongside it.
    expect(labels).toContain("Download");
  });
});

describe("footerHints Real-Debrid discoverability", () => {
  it("no longer shows a k hint on results (Real-Debrid moved to the Accounts pane)", () => {
    const hints = footerHints("content", "all", null, null, false);
    expect(hints.some((h) => h.keys === "k")).toBe(false);
  });

  it("shows r and v instead of the k hint when configured", () => {
    const hints = footerHints("content", "all", null, null, true);
    expect(hints.some((h) => h.keys === "r")).toBe(true);
    expect(hints.some((h) => h.keys === "k" && /real-debrid/i.test(h.label))).toBe(false);
  });
});

describe("accounts keymap", () => {
  it("shows sign-in/out hints on the accounts section", () => {
    const keys = footerHints("content", "accounts").map((h) => h.keys);
    expect(keys).toContain("↵");
    expect(keys).toContain("x");
  });

  it("no longer advertises the k or R credential hotkeys", () => {
    const allKeys = HELP_GROUPS.flatMap((g) => g.hints.map((h) => h.keys));
    expect(allKeys).not.toContain("k");
    expect(allKeys).not.toContain("R");
  });
});
