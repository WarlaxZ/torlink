import { describe, expect, it } from "vitest";
import {
  historyItemFor,
  nextEpisode,
  recordStream,
  removeStreamHistory,
  STREAM_HISTORY_CAP,
  type StreamHistoryItem,
} from "./streamHistory";

const HASH = "a".repeat(40);

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
