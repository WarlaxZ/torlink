import { describe, it, expect } from "vitest";
import { prefsFromWire, prefsToWire, intentForHistoryRow, createPickController, type PickState } from "./pickModel";
import type { PublicStreamHistoryItem } from "../wire";
import type { PickableResult } from "../../util/releasePick";

const row = (over: Partial<PublicStreamHistoryItem>): PublicStreamHistoryItem => ({
  key: "k", title: "Kepler", rawName: "Kepler.S02E04.1080p.WEB-DL",
  infoHash: "abc", startedAt: 0, next: { season: 2, episode: 5 }, category: "Unknown", ...over,
});

describe("prefs round-trip", () => {
  it("maps null to absent and back", () => {
    expect(prefsFromWire({ maxResolution: null, require: [], exclude: [] }))
      .toEqual({ require: [], exclude: [] });
    expect(prefsToWire({ require: [], exclude: [] }))
      .toEqual({ maxResolution: null, require: [], exclude: [] });
  });

  it("carries a cap and features through unchanged", () => {
    const wire = { maxResolution: "1080p" as const, require: ["atmos" as const], exclude: ["dv" as const] };
    expect(prefsToWire(prefsFromWire(wire))).toEqual(wire);
  });
});

describe("intentForHistoryRow", () => {
  it("builds an episode intent from next", () => {
    expect(intentForHistoryRow(row({}))).toEqual({ kind: "episode", season: 2, episode: 5 });
  });

  it("returns null when there is no honest next episode", () => {
    // A film, and a series watched via a season pack, both send next: null.
    expect(intentForHistoryRow(row({ next: null }))).toBeNull();
  });
});

// `autoPlayableFilm` is NOT tested again here — it lives in
// `src/util/autoPlayableFilm.ts` and is covered by its own tests (Task 7c). This
// module only re-exports it so callers in this directory have one import site.

// A candidate shaped exactly like `PickableResult` needs, plus a name a test
// can recognise in assertions.
interface Candidate extends PickableResult {
  name: string;
}

const kepler1080 = (over: Partial<Candidate> = {}): Candidate => ({
  name: "Kepler.S02E05.1080p.WEB-DL",
  sizeBytes: 2_000_000_000,
  seeders: 20,
  ...over,
});

// A controller wired to a search whose answer the test resolves by hand, so
// the stale-response case can actually be produced — same technique as
// `reccModel.test.ts`'s `harness()`.
function harness(prefs: { maxResolution?: "2160p" | "1080p" | "720p" | "480p" } = {}): {
  ctl: ReturnType<typeof createPickController<Candidate>>;
  resolve: (results: Candidate[]) => void;
  pending: number;
  titles: string[];
  states: PickState[];
  last: () => PickState;
  played: { chosen: Candidate }[];
} {
  const titles: string[] = [];
  const states: PickState[] = [];
  const played: { chosen: Candidate }[] = [];
  const queue: ((results: Candidate[]) => void)[] = [];
  const ctl = createPickController<Candidate>({
    search(title) {
      titles.push(title);
      return new Promise((res) => queue.push(res));
    },
    prefs: () => ({ require: [], exclude: [], ...prefs }),
    play(pick) {
      played.push(pick);
    },
    render(state) {
      states.push(state);
    },
  });
  return {
    ctl,
    resolve(results) {
      const next = queue.shift();
      if (!next) throw new Error("no search in flight");
      next(results);
    },
    get pending() {
      return queue.length;
    },
    titles,
    states,
    last: () => states[states.length - 1]!,
    played,
  };
}

describe("createPickController", () => {
  it("starts idle", () => {
    const h = harness();
    expect(h.ctl.state().phase).toEqual({ kind: "idle" });
  });

  it("goes searching, then playing, on a result", async () => {
    const h = harness();
    h.ctl.start("Kepler", { kind: "episode", season: 2, episode: 5 });
    expect(h.ctl.state().phase).toEqual({ kind: "searching", title: "Kepler" });
    h.resolve([kepler1080()]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.ctl.state().phase.kind).toBe("playing");
    expect(h.played).toHaveLength(1);
    expect(h.played[0]!.chosen.name).toBe("Kepler.S02E05.1080p.WEB-DL");
  });

  it("goes to none when the search finds nothing, and calls onNone", async () => {
    const h = harness();
    let noned = 0;
    h.ctl.start("Harrowgate", { kind: "film" }, () => {
      noned += 1;
    });
    h.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.ctl.state().phase).toEqual({ kind: "none", title: "Harrowgate" });
    expect(h.played).toHaveLength(0);
    expect(noned).toBe(1);
  });

  it("drops a stale search that resolves after a newer one was started", async () => {
    const h = harness();
    h.ctl.start("Kestrel", { kind: "film" });
    h.ctl.start("Ashfall", { kind: "film" });
    expect(h.pending).toBe(2);

    // The FIRST (Kestrel) search answers after the second has already started.
    h.resolve([kepler1080({ name: "Kestrel.2010.1080p.BluRay.x264" })]);
    await Promise.resolve();
    await Promise.resolve();
    // Still searching for Ashfall — the stale Kestrel answer must not have painted.
    expect(h.ctl.state().phase).toEqual({ kind: "searching", title: "Ashfall" });
    expect(h.played).toHaveLength(0);

    h.resolve([kepler1080({ name: "Ashfall.1999.1080p" })]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.played).toHaveLength(1);
    expect(h.played[0]!.chosen.name).toBe("Ashfall.1999.1080p");
  });

  it("reads prefs once at start, not again after the await", async () => {
    // Regression guard: if the caller's mutable prefs object is read a second
    // time after the search resolves, a preference change made while the
    // search is in flight could describe a cap that was never applied to the
    // ranking that produced this pick.
    let calls = 0;
    const queue: ((results: Candidate[]) => void)[] = [];
    const played: { chosen: Candidate }[] = [];
    const ctl = createPickController<Candidate>({
      search: (title) =>
        new Promise((res) => {
          void title;
          queue.push(res);
        }),
      prefs: () => {
        calls += 1;
        return { require: [], exclude: [] };
      },
      play: (pick) => played.push(pick),
      render: () => {},
    });
    ctl.start("Tin.Rivers", { kind: "film" });
    expect(calls).toBe(1);
    queue[0]!([kepler1080({ name: "Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP" })]);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(played).toHaveLength(1);
  });
});
