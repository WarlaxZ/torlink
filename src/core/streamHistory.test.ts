import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  historyItemFor,
  nextEpisode,
  recordStream,
  removeStreamHistory,
  STREAM_HISTORY_CAP,
  type StreamHistoryItem,
} from "./streamHistory";

const HASH = "a".repeat(40);

// loadStreamHistory/saveStreamHistory resolve their file path from
// TORLINK_STATE_DIR at module load (via src/config/paths.ts), so exercising
// them for real means giving each test a private state dir and a fresh module
// instance — the same seam src/download/bootguard.test.ts uses — rather than
// writing to the developer's real data directory.
async function isolated() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-streamhistory-"));
  vi.stubEnv("TORLINK_STATE_DIR", dir);
  vi.resetModules();
  const paths = await import("../config/paths");
  const mod = await import("./streamHistory");
  return { dir, paths, mod };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function item(over: Partial<StreamHistoryItem> = {}): StreamHistoryItem {
  return {
    key: "kepler||series",
    title: "Kepler",
    type: "series",
    season: 2,
    episode: 4,
    rawName: "Kepler.S02E04.1080p.WEB-DL",
    infoHash: HASH,
    magnet: `magnet:?xt=urn:btih:${HASH}`,
    startedAt: 1_700_000_000_000,
    ...over,
  };
}

describe("historyItemFor", () => {
  it("builds an entry from a stream input, parsing the release name", () => {
    const built = historyItemFor(
      { id: HASH, name: "Kepler.S02E04.1080p.WEB-DL.x265-GROUP", magnet: "magnet:?x", source: "eztv" },
      1_700_000_000_000,
    );
    expect(built?.title).toBe("Kepler");
    expect(built?.season).toBe(2);
    expect(built?.episode).toBe(4);
    expect(built?.type).toBe("series");
    expect(built?.infoHash).toBe(HASH);
    expect(built?.rawName).toBe("Kepler.S02E04.1080p.WEB-DL.x265-GROUP");
    expect(built?.startedAt).toBe(1_700_000_000_000);
    expect(built?.source).toBe("eztv");
  });

  it("returns null when the release name has no title in it", () => {
    // A name that is only quality noise gives no row to draw, and a list of
    // unparseable release names is what this feature exists to avoid.
    expect(historyItemFor({ id: HASH, name: "1080p.WEB-DL.x265", magnet: "m" }, 1)).toBeNull();
  });

  it("omits source when the caller had none", () => {
    const built = historyItemFor({ id: HASH, name: "Tin.Rivers.2024.2160p", magnet: "m" }, 1);
    expect(built).not.toBeNull();
    expect("source" in (built as object)).toBe(false);
  });
});

describe("recordStream", () => {
  it("prepends a new title", () => {
    const out = recordStream([item({ key: "other", title: "Harrowgate" })], item());
    expect(out).toHaveLength(2);
    expect(out[0]?.title).toBe("Kepler");
  });

  it("dedupes on key and moves the entry to the front", () => {
    const current = [item({ key: "a", title: "A" }), item({ key: "b", title: "B" })];
    const out = recordStream(current, item({ key: "b", title: "B", episode: 5 }));
    expect(out).toHaveLength(2);
    expect(out[0]?.key).toBe("b");
    expect(out[0]?.episode).toBe(5);
  });

  it("keeps the HIGHEST episode seen, so rewatching does not move next backwards", () => {
    // Watch S02E05, then rewatch S02E02. "next" must still be S02E06.
    const current = [item({ season: 2, episode: 5 })];
    const out = recordStream(current, item({ season: 2, episode: 2 }));
    expect(out[0]?.season).toBe(2);
    expect(out[0]?.episode).toBe(5);
  });

  it("advances across a season boundary", () => {
    const current = [item({ season: 1, episode: 9 })];
    const out = recordStream(current, item({ season: 2, episode: 1 }));
    expect(out[0]?.season).toBe(2);
    expect(out[0]?.episode).toBe(1);
  });

  it("still refreshes startedAt and the torrent when the episode is older", () => {
    // The user watched something, so the row must rise to the top and point at
    // the torrent they actually used, even though the episode marker does not move.
    const current = [item({ season: 2, episode: 5, startedAt: 1000, infoHash: "b".repeat(40) })];
    const out = recordStream(current, item({ season: 2, episode: 2, startedAt: 2000 }));
    expect(out[0]?.startedAt).toBe(2000);
    expect(out[0]?.infoHash).toBe(HASH);
  });

  it("caps the list, dropping the oldest", () => {
    const current = Array.from({ length: STREAM_HISTORY_CAP }, (_, i) =>
      item({ key: `k${i}`, title: `T${i}` }),
    );
    const out = recordStream(current, item({ key: "new", title: "New" }));
    expect(out).toHaveLength(STREAM_HISTORY_CAP);
    expect(out[0]?.key).toBe("new");
    expect(out.some((e) => e.key === `k${STREAM_HISTORY_CAP - 1}`)).toBe(false);
  });
});

describe("nextEpisode", () => {
  it("returns the following episode in the same season", () => {
    expect(nextEpisode(item({ season: 2, episode: 4 }))).toEqual({ season: 2, episode: 5 });
  });

  it("returns null for a film", () => {
    expect(nextEpisode(item({ type: "movie", season: undefined, episode: undefined }))).toBeNull();
  });

  it("returns null for a SEASON PACK, which names no episode", () => {
    // "Harrowgate.S03" parses to season 3 with no episode. Guessing episode 1
    // would tell the user to watch something they may already have seen.
    expect(nextEpisode(item({ season: 3, episode: undefined }))).toBeNull();
  });
});

describe("removeStreamHistory", () => {
  it("drops the entry with that key and is idempotent", () => {
    const current = [item({ key: "a" }), item({ key: "b" })];
    expect(removeStreamHistory(current, "a")).toHaveLength(1);
    expect(removeStreamHistory(current, "nope")).toHaveLength(2);
  });
});

describe("loadStreamHistory / saveStreamHistory", () => {
  it("returns [] when the file does not exist", async () => {
    const { dir, mod } = await isolated();
    try {
      expect(await mod.loadStreamHistory()).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] for corrupt JSON", async () => {
    const { dir, paths, mod } = await isolated();
    try {
      await fs.mkdir(path.dirname(paths.streamHistoryFile), { recursive: true });
      await fs.writeFile(paths.streamHistoryFile, "{not json", "utf8");
      expect(await mod.loadStreamHistory()).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the JSON is valid but not an array", async () => {
    const { dir, paths, mod } = await isolated();
    try {
      await fs.mkdir(path.dirname(paths.streamHistoryFile), { recursive: true });
      await fs.writeFile(paths.streamHistoryFile, JSON.stringify({ not: "an array" }), "utf8");
      expect(await mod.loadStreamHistory()).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("drops hand-edited junk entries and keeps the good one", async () => {
    const { dir, paths, mod } = await isolated();
    try {
      const good = item();
      const junk = [
        good,
        { title: "no key or infoHash" },
        { key: "b", title: "", infoHash: HASH, startedAt: 1 }, // empty title
        { key: "c", title: "C", infoHash: "", startedAt: 1 }, // empty infoHash
        { key: "d", title: "D", infoHash: HASH, startedAt: "not a number" },
      ];
      await fs.mkdir(path.dirname(paths.streamHistoryFile), { recursive: true });
      await fs.writeFile(paths.streamHistoryFile, JSON.stringify(junk), "utf8");
      const loaded = await mod.loadStreamHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.key).toBe(good.key);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips through save and load", async () => {
    const { dir, mod } = await isolated();
    try {
      await mod.saveStreamHistory([item()]);
      const loaded = await mod.loadStreamHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.title).toBe("Kepler");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
