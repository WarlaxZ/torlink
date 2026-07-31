import { describe, expect, it } from "vitest";
import { footerHints, HELP_GROUPS, type Hint } from "./keymap";

// Footer.tsx renders hints as "keys label" joined by a 3-space separator, and
// the app pads one column each side, so a row must fit 80 - 2 at 80 cols.
const rowWidth = (hints: Hint[]): number =>
  hints.reduce((n, h) => n + h.keys.length + 1 + h.label.length, 0) + (hints.length - 1) * 3;

describe("footerHints results view", () => {
  it("offers the debrid shortcut only when a provider is configured, but Stream always", () => {
    const without = footerHints("content", "all", null, null, undefined);
    expect(without.some((h) => h.keys === "r")).toBe(false);
    // Torrent streaming needs no debrid token, so its hint must be
    // visible for exactly the users who don't have one configured.
    expect(without.some((h) => h.keys === "v")).toBe(true);

    const withToken = footerHints("content", "all", null, null, "Real-Debrid");
    const labels = withToken.map((h) => h.label);
    expect(labels).toContain("Real-Debrid");
    expect(labels).toContain("Stream");
    // The plain P2P download stays available alongside it.
    expect(labels).toContain("Download");
  });

  it("names the active provider in the footer hint", () => {
    const hints = footerHints("content", "all", null, null, "TorBox");
    expect(hints.find((h) => h.keys === "r")?.label).toBe("TorBox");
  });

  it("offers no debrid hint when none is configured", () => {
    expect(footerHints("content", "all", null, null, undefined).some((h) => h.keys === "r")).toBe(false);
  });
});

describe("footerHints debrid discoverability", () => {
  it("no longer shows a k hint on results (debrid moved to the Accounts pane)", () => {
    const hints = footerHints("content", "all", null, null, undefined);
    expect(hints.some((h) => h.keys === "k")).toBe(false);
  });

  it("shows r and v instead of the k hint when configured", () => {
    const hints = footerHints("content", "all", null, null, "Real-Debrid");
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

  it("shows the make-active footer hint on the accounts section", () => {
    const keys = footerHints("content", "accounts").map((h) => h.keys);
    expect(keys).toContain("a");
  });

  it("keeps the r help entry provider-neutral", () => {
    const entries = HELP_GROUPS.flatMap((g) => g.hints);
    expect(entries.find((h) => h.keys === "r")?.label).toBe("Download via debrid (Real-Debrid / TorBox)");
  });

  it("documents the accounts make-active key", () => {
    const entries = HELP_GROUPS.flatMap((g) => g.hints);
    expect(entries.some((h) => h.keys === "a")).toBe(true);
  });

  it("no longer advertises the k or R credential hotkeys", () => {
    const allKeys = HELP_GROUPS.flatMap((g) => g.hints.map((h) => h.keys));
    expect(allKeys).not.toContain("k");
    expect(allKeys).not.toContain("R");
  });
});

describe("downloads/seeding key vocabulary", () => {
  it("folds clear-all into shift+c on the c row and drops x", () => {
    const downloads = HELP_GROUPS.find((g) => g.title === "Downloads")!;
    expect(downloads.hints.some((h) => h.keys === "x")).toBe(false);
    expect(downloads.hints.some((h) => h.keys === "shift+c")).toBe(false);
    expect(downloads.hints.find((h) => h.keys === "c")?.label).toContain("(shift+c");
  });

  it("labels one-entry removal as list bookkeeping in the footers", () => {
    const recent = footerHints("content", "downloads", "recent", null);
    expect(recent.some((h) => h.keys === "x")).toBe(false);
    expect(recent.find((h) => h.keys === "c")?.label).toBe("Remove from list");

    const seeding = footerHints("content", "seeding", null, "seeding");
    expect(seeding.find((h) => h.keys === "c")?.label).toBe("Remove from list");
  });

  // The results row carries a known pre-existing overflow (f Filter), so the
  // budget is pinned only for the rows this vocabulary owns.
  it("keeps the downloads and seeding footer rows inside the 80-col budget", () => {
    const rows = [
      footerHints("sidebar", "downloads", null, null),
      footerHints("content", "downloads", "downloading", null),
      footerHints("content", "downloads", "paused", null),
      footerHints("content", "downloads", "failed", null),
      footerHints("content", "downloads", "recent", null),
      footerHints("content", "seeding", null, "seeding"),
      footerHints("content", "seeding", null, "missing"),
      footerHints("content", "seeding", null, null),
    ];
    for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(78);
  });
});

// The footer is a promise about the next keypress. While a stream is running,
// App.tsx intercepts "x" to stop it and the three list panes deliberately skip
// their own handler, so "x Remove" was a promise the app would not keep. The
// key still does something, so the label changes rather than disappearing.
describe("footerHints while a stream is active", () => {
  const LIST_SECTIONS = ["continueWatching", "savedSearches", "library"] as const;

  it("offers x as Remove in the list panes when no stream is running", () => {
    for (const section of LIST_SECTIONS) {
      const hints = footerHints("content", section, null, null, undefined, false);
      expect(hints.find((h) => h.keys === "x")?.label).toBe("Remove");
    }
  });

  it("relabels x as stopping the stream in the list panes while one is running", () => {
    for (const section of LIST_SECTIONS) {
      const hints = footerHints("content", section, null, null, undefined, true);
      expect(hints.find((h) => h.keys === "x")?.label).toBe("Stop stream");
    }
  });

  it("keeps both variants of those rows inside the 80-col budget", () => {
    for (const section of LIST_SECTIONS) {
      expect(rowWidth(footerHints("content", section, null, null, undefined, false))).toBeLessThanOrEqual(78);
      expect(rowWidth(footerHints("content", section, null, null, undefined, true))).toBeLessThanOrEqual(78);
    }
  });
});

describe("play and search keys", () => {
  it("documents s in the For You help group", () => {
    const group = HELP_GROUPS.find((g) => g.title === "For You")!;
    expect(group.hints.map((h) => h.keys)).toContain("s");
  });

  it("has a Continue Watching help group covering play and search", () => {
    const group = HELP_GROUPS.find((g) => g.title === "Continue watching");
    expect(group).toBeDefined();
    expect(group!.hints.map((h) => h.keys)).toEqual(expect.arrayContaining(["↵", "s", "x"]));
  });

  it("offers s in both footers", () => {
    expect(footerHints("content", "forYou").map((h) => h.keys)).toContain("s");
    expect(footerHints("content", "continueWatching").map((h) => h.keys)).toContain("s");
  });
});
