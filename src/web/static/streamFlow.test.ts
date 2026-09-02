import { describe, expect, it } from "vitest";
import {
  POLL_MS,
  RESOLVE_TIMEOUT_MS,
  confirmFallbackMessage,
  fileLabel,
  isPlayable,
  playerPath,
  pollDecision,
  runPlay,
  pickerRows,
  streamOutcome,
  wantedEpisodeFor,
  type PlayEffects,
  type PublicStreamFile,
  type PublicStreamSession,
  type StartResult,
} from "./streamFlow";
import { parsePlayerLocation } from "./playerModel";
import type { DashRow } from "./dashboard";
import type { PublicStreamHistoryItem } from "../wire";

const file = (filename: string, index: number, bytes = 1024): PublicStreamFile => ({
  filename,
  bytes,
  index,
  handle: `/stream/s1/${index}`,
});

const session = (over: Partial<PublicStreamSession> = {}): PublicStreamSession => ({
  id: "s1",
  backend: "torrent",
  name: "A Release",
  state: "ready",
  progress: 100,
  files: [],
  ...over,
});

const row = (over: Partial<DashRow> = {}): DashRow => ({
  id: "abc",
  name: "A Release",
  kind: "download",
  status: "downloading",
  percent: 10,
  peers: 3,
  rate: 0,
  uploaded: 0,
  ...over,
});

describe("isPlayable", () => {
  // Streaming starts its own session from the info hash, so it does not need
  // the queue to have finished — or even started — fetching anything.
  it("offers play while a download is in progress, paused or queued", () => {
    for (const status of ["downloading", "queued", "paused", "selecting", "completed"]) {
      expect(isPlayable(row({ status })), status).toBe(true);
    }
  });

  it("offers play on a seeding torrent", () => {
    expect(isPlayable(row({ kind: "seed", status: "seeding" }))).toBe(true);
    expect(isPlayable(row({ kind: "seed", status: "paused" }))).toBe(true);
  });

  it("does not offer play on a failed download or a missing seed", () => {
    expect(isPlayable(row({ status: "failed" }))).toBe(false);
    expect(isPlayable(row({ kind: "seed", status: "missing" }))).toBe(false);
  });
});

describe("playerPath", () => {
  // MUTATION GUARD. Without ?k= the player page has no capability, so the
  // <video> and the .m3u both 401 and the page shows "this link is incomplete".
  it("carries the capability as ?k=", () => {
    const url = playerPath("s1", file("a.mp4", 0), "cap-123");
    expect(url).toContain("k=cap-123");
    expect(parsePlayerLocation("/play/s1/0", url.slice(url.indexOf("?")))?.capability).toBe(
      "cap-123",
    );
  });

  // MUTATION GUARD. The player page cannot ask the API for the filename — a
  // phone holding this link has the capability but not the bearer token — so
  // ?n= is the only source. Dropping it shows "Unnamed file" and, because
  // canDirectPlay("") is pessimistic, the fallback card for a playable mp4.
  it("carries the filename as ?n=", () => {
    const url = playerPath("s1", file("Copper Kettle Run.mp4", 3), "cap");
    const parsed = parsePlayerLocation("/play/s1/3", url.slice(url.indexOf("?")));
    expect(parsed?.filename).toBe("Copper Kettle Run.mp4");
  });

  it("addresses the file by its session index, not its position in a filtered list", () => {
    const picked = streamOutcome(
      session({ files: [file("readme.nfo", 0), file("movie.mkv", 1)] }),
    );
    expect(picked.kind).toBe("single");
    if (picked.kind !== "single") return;
    expect(playerPath("s1", picked.file, "cap")).toContain("/play/s1/1?");
  });

  it("round-trips through parsePlayerLocation, encoding and all", () => {
    const url = playerPath("s 1", file("a b&c.mp4", 2), "k/1=+2");
    expect(url.startsWith("/play/s%201/2?")).toBe(true);
    const target = parsePlayerLocation("/play/s 1/2", url.slice(url.indexOf("?")));
    // The path half of playerPath is not what parsePlayerLocation is given here
    // (it reads location.pathname, already decoded by the browser), so this
    // asserts the query half survives verbatim.
    expect(target?.filename).toBe("a b&c.mp4");
    expect(target?.capability).toBe("k/1=+2");
  });
});

describe("streamOutcome", () => {
  it("reports a single candidate for a one-video torrent", () => {
    const out = streamOutcome(session({ files: [file("movie.mkv", 0)] }));
    expect(out).toEqual({ kind: "single", file: file("movie.mkv", 0) });
  });

  // MUTATION GUARD for the picker: a scene release is a video plus junk, and a
  // picker listing the junk makes the user do the filtering by hand.
  it("hides non-video files from the picker when videos exist", () => {
    const out = streamOutcome(
      session({
        files: [
          file("sample.txt", 0),
          file("S01E01.mkv", 1),
          file("release.nfo", 2),
          file("S01E02.mkv", 3),
          file("cover.jpg", 4),
        ],
      }),
    );
    expect(out.kind).toBe("choose");
    if (out.kind !== "choose") return;
    expect(out.files.map((f) => f.filename)).toEqual(["S01E01.mkv", "S01E02.mkv"]);
  });

  it("falls back to every file when nothing looks like video", () => {
    const out = streamOutcome(session({ files: [file("a.bin", 0), file("b.iso", 1)] }));
    expect(out.kind).toBe("choose");
    if (out.kind !== "choose") return;
    expect(out.files).toHaveLength(2);
  });

  // The point of the preselection: a Continue-watching row that says "next
  // S03E05" opens the picker on S03E05. `next` is the SERVER's computation
  // (nextEpisode, over the row's high-water mark) arriving on the wire, so the
  // browser never adds a second "+1" of its own.
  it("preselects the file naming the wanted episode", () => {
    const out = streamOutcome(
      session({
        files: [file("Harrowgate.S03E04.1080p.mkv", 0), file("Harrowgate.S03E05.1080p.mkv", 1)],
      }),
      { season: 3, episode: 5 },
    );
    expect(out.kind).toBe("choose");
    if (out.kind !== "choose") return;
    expect(out.preselect).toBe(1);
  });

  // An index into the FILTERED list, because that is the list the picker draws.
  // The session's own indexes differ the moment a release ships a .nfo.
  it("counts the preselection over the candidates the picker shows", () => {
    const out = streamOutcome(
      session({
        files: [
          file("release.nfo", 0),
          file("Harrowgate.S03E04.1080p.mkv", 1),
          file("Harrowgate.S03E05.1080p.mkv", 2),
        ],
      }),
      { season: 3, episode: 5 },
    );
    expect(out.kind).toBe("choose");
    if (out.kind !== "choose") return;
    expect(out.preselect).toBe(1);
  });

  // THE REPORTED BUG: the browser listed the candidates in whatever order the
  // torrent named them, so a season pack showed E08 above E02 while the TUI's
  // picker showed the same pack in title order. One shared sort, both surfaces.
  it("lists the candidates in the same title order the TUI's picker uses", () => {
    const out = streamOutcome(
      session({
        files: [
          file("Harrowgate - S03E08 - The Long Way Down.mkv", 0),
          file("Harrowgate - S03E02 - Salt.mkv", 1),
          file("Season 3 Gag Reel.mkv", 2),
          file("Harrowgate - S03E01 - Low Tide.mkv", 3),
          file("Harrowgate - S03E10 - Last Light.mkv", 4),
        ],
      }),
    );
    expect(out.kind).toBe("choose");
    if (out.kind !== "choose") return;
    expect(out.files.map((f) => f.filename)).toEqual([
      "Harrowgate - S03E01 - Low Tide.mkv",
      "Harrowgate - S03E02 - Salt.mkv",
      "Harrowgate - S03E08 - The Long Way Down.mkv",
      "Harrowgate - S03E10 - Last Light.mkv",
      "Season 3 Gag Reel.mkv",
    ]);
  });

  // The preselection is an index into the list the picker DRAWS, so it has to be
  // counted after the sort — counting it before would badge, and focus, whatever
  // file happened to land in that row.
  it("counts the preselection over the sorted list, not the torrent's order", () => {
    const out = streamOutcome(
      session({
        files: [
          file("Harrowgate - S03E08 - The Long Way Down.mkv", 0),
          file("Harrowgate - S03E01 - Low Tide.mkv", 1),
          file("Harrowgate - S03E02 - Salt.mkv", 2),
        ],
      }),
      { season: 3, episode: 2 },
    );
    expect(out.kind).toBe("choose");
    if (out.kind !== "choose") return;
    expect(out.preselect).toBe(1);
    expect(out.files[out.preselect!]!.filename).toContain("S03E02");
  });

  it("has no preselection without a wanted episode, or when nothing matches", () => {
    const files = [file("Harrowgate.S03E04.1080p.mkv", 0), file("Harrowgate.S03E05.1080p.mkv", 1)];
    const noNext = streamOutcome(session({ files }));
    const noMatch = streamOutcome(session({ files }), { season: 4, episode: 1 });
    expect(noNext.kind === "choose" ? noNext.preselect : "not a picker").toBeNull();
    expect(noMatch.kind === "choose" ? noMatch.preselect : "not a picker").toBeNull();
  });

  it("reports the session's own error message", () => {
    const out = streamOutcome(session({ state: "error", error: "Real-Debrid said no." }));
    expect(out).toEqual({ kind: "error", message: "Real-Debrid said no." });
  });

  it("still has something to say when an errored session carries no message", () => {
    const out = streamOutcome(session({ state: "error" }));
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).not.toBe("");
  });

  it("reports empty for a ready session with no files", () => {
    expect(streamOutcome(session({ files: [] }))).toEqual({ kind: "empty" });
  });

  it("does not treat a still-resolving session as playable", () => {
    const out = streamOutcome(session({ state: "resolving", progress: 40 }));
    expect(out.kind).toBe("error");
  });
});

describe("pollDecision", () => {
  // MUTATION GUARD. This is the one that keeps a Real-Debrid cache — which sits
  // mid-percent for minutes — from being abandoned at the first tick.
  it("keeps polling while the session is resolving", () => {
    for (const elapsed of [0, POLL_MS, 30_000, RESOLVE_TIMEOUT_MS - 1]) {
      const d = pollDecision(session({ state: "resolving", progress: 42 }), elapsed, "A Release");
      expect(d.kind, `elapsed=${elapsed}`).toBe("poll");
    }
  });

  it("names the provider and the percent for a debrid resolve", () => {
    const d = pollDecision(
      session({ state: "resolving", backend: "debrid", progress: 42 }),
      12_000,
      "Harrowgate.S03.1080p.WEB-DL",
      "Real-Debrid",
    );
    expect(d.kind).toBe("poll");
    if (d.kind !== "poll") return;
    expect(d.label).toBe("Caching on Real-Debrid… 42% · 12s");
    expect(d.delayMs).toBe(POLL_MS);
  });

  it("names the release, not a percent, while finding peers in a swarm", () => {
    const d = pollDecision(
      session({ state: "resolving", backend: "torrent", progress: 42 }),
      3_000,
      "Kestrel.2010.1080p.BluRay.x264",
    );
    expect(d.kind).toBe("poll");
    if (d.kind !== "poll") return;
    expect(d.label).toBe("Finding peers… Kestrel.2010.1080p.BluRay.x264 · 3s");
  });

  // The elapsed seconds are what tell a user that a resolve sitting at one
  // percent for minutes is working rather than hung. Deleting them is the
  // mutation this guards.
  it("counts the seconds up, so a stalled percent still shows movement", () => {
    const at = (ms: number): string => {
      const d = pollDecision(
        session({ state: "resolving", backend: "debrid", progress: 7 }),
        ms,
        "n",
        "RD",
      );
      return d.kind === "poll" ? d.label : "";
    };
    expect(at(0)).toContain("· 0s");
    expect(at(1_000)).toContain("· 1s");
    expect(at(65_400)).toContain("· 65s");
  });

  it("clamps a nonsense percent rather than rendering it", () => {
    const at = (progress: number): string => {
      const d = pollDecision(
        session({ state: "resolving", backend: "debrid", progress }),
        0,
        "n",
        "RD",
      );
      return d.kind === "poll" ? d.label : "";
    };
    expect(at(140)).toContain("100%");
    expect(at(-3)).toContain("0%");
    expect(at(Number.NaN)).toContain("0%");
    expect(at(99.7)).toContain("99%");
  });

  it("stops once the session is ready or failed", () => {
    expect(pollDecision(session({ state: "ready" }), 0, "n").kind).toBe("settled");
    expect(pollDecision(session({ state: "error" }), 0, "n").kind).toBe("settled");
  });

  it("gives up eventually rather than polling a stuck session forever", () => {
    const d = pollDecision(session({ state: "resolving" }), RESOLVE_TIMEOUT_MS, "A Release");
    expect(d.kind).toBe("timeout");
    if (d.kind !== "timeout") return;
    expect(d.message).toContain("A Release");
  });

  // Asserts the TRUNCATED name is present, not merely that some "…" is: every
  // line prepareLine produces contains an ellipsis of its own ("Finding peers…"),
  // so `toContain("…")` would pass while the name went unclipped. That is the
  // vacuous-assertion trap CLAUDE.md records.
  it("clips a very long name for the waiting line", () => {
    const long = "x".repeat(300);
    const d = pollDecision(session({ state: "resolving", backend: "torrent" }), 0, long);
    expect(d.kind).toBe("poll");
    if (d.kind !== "poll") return;
    expect(d.label).not.toContain(long);
    expect(d.label).toContain(`${"x".repeat(79)}…`);
  });
});

describe("confirmFallbackMessage", () => {
  it("names the reason and the consequence, not just 'continue?'", () => {
    const msg = confirmFallbackMessage("your premium expired 3 days ago", "A Release");
    expect(msg).toContain("your premium expired 3 days ago");
    expect(msg).toContain("A Release");
    // The whole point of the prompt: the user has to be told what proceeding
    // costs them, which is their IP address in a public swarm.
    expect(msg).toContain("IP address");
  });
});

describe("wantedEpisodeFor", () => {
  // A row as GET /api/saved sends it. Only `key` and `next` are read; the rest is
  // here so the fixture is a real row rather than a shape invented for the test.
  const row = (
    key: string,
    next: { season: number; episode: number } | null,
  ): PublicStreamHistoryItem => ({
    key,
    title: "Harrowgate",
    type: "series",
    next,
    rawName: "Harrowgate.S03E04.1080p.WEB-DL",
    infoHash: "a".repeat(40),
    startedAt: 1,
    category: "Unknown",
  });

  // The divergence this closes: the terminal preselects from EVERY play path,
  // because every one of them funnels through the row `recordStreamHistory` just
  // merged. The browser has no such row in hand when the Play button is on a
  // search hit — so it finds one, by the store's own dedupe key.
  it("finds the row for a release the user is part-way through", () => {
    const rows = [row("harrowgate|series", { season: 3, episode: 5 })];
    expect(wantedEpisodeFor("Harrowgate.S03.1080p.WEB-DL", rows)).toEqual({
      season: 3,
      episode: 5,
    });
  });

  // The point of keying on title+type rather than on the info hash: the pack
  // being played is a DIFFERENT torrent from the single episode that was
  // recorded, which is the ordinary case for "carry on with this show".
  it("matches a different release of the same show", () => {
    const rows = [row("harrowgate|series", { season: 3, episode: 5 })];
    expect(wantedEpisodeFor("Harrowgate.S03E01.2160p.WEB-DL-OTHERGROUP", rows)).toEqual({
      season: 3,
      episode: 5,
    });
  });

  it("has no opinion about a title with no history row", () => {
    const rows = [row("harrowgate|series", { season: 3, episode: 5 })];
    expect(wantedEpisodeFor("Kepler.S02E04.1080p.WEB-DL", rows)).toBeNull();
    expect(wantedEpisodeFor("Harrowgate.S03.1080p.WEB-DL", [])).toBeNull();
  });

  // Release names come from whoever uploaded the torrent. One that is only
  // quality noise parses to no title at all.
  it("has no opinion about a name that parses to nothing", () => {
    expect(wantedEpisodeFor("1080p.WEB-DL.x265", [row("harrowgate|series", null)])).toBeNull();
  });

  // Continue watching passes the row's OWN `next`, and that must win: rows
  // written under an older key format are kept on purpose (they merge into the
  // new key the next time that title is streamed), so re-deriving the key from
  // `rawName` can miss the very row that was clicked.
  it("prefers the suggestion the caller already holds", () => {
    const rows = [row("harrowgate|series", { season: 3, episode: 5 })];
    expect(
      wantedEpisodeFor("Harrowgate.S03.1080p.WEB-DL", rows, { season: 9, episode: 1 }),
    ).toEqual({ season: 9, episode: 1 });
  });
});

describe("fileLabel", () => {
  it("shows the name and a human size", () => {
    expect(fileLabel(file("movie.mkv", 0, 1536))).toBe("movie.mkv · 1.50 KB");
  });
});

// The browser's equivalent of the TUI picker's `s` key. Rows, the badge and the
// keyboard target all come from here so app.ts stays wiring.
describe("pickerRows", () => {
  const pack = [
    file("Harrowgate - S03E01 - Low Tide.mkv", 0, 2_000_000),
    file("Harrowgate - S03E02 - Salt.mkv", 1, 3_000_000),
    file("Season 3 Gag Reel.mkv", 2, 40_000),
  ];

  it("draws title order, and largest-first for size", () => {
    expect(pickerRows(pack, "name", null).files.map((f) => f.index)).toEqual([0, 1, 2]);
    expect(pickerRows(pack, "size", null).files.map((f) => f.index)).toEqual([1, 0, 2]);
  });

  // The badge follows the FILE across a re-sort, exactly as the TUI's highlight
  // does. A preselect index left pointing at the old row would mark, and focus,
  // an unrelated episode the moment someone pressed sort.
  it("carries the preselected file across a re-sort", () => {
    const rows = pickerRows(pack, "size", 0);
    expect(rows.preselect).toBe(1);
    expect(rows.files[rows.preselect!]!.index).toBe(0);
    expect(rows.focus).toBe(1);
  });

  // `keep` is the file the user already had the keyboard on. It wins over the
  // preselection, so toggling sort does not yank focus back to "next".
  it("keeps the focused file focused, in preference to the preselection", () => {
    const rows = pickerRows(pack, "size", 0, 2);
    expect(rows.preselect).toBe(1);
    expect(rows.focus).toBe(2);
    expect(rows.files[rows.focus!]!.index).toBe(2);
  });

  // The state right after the sort button is clicked: the keyboard is on the
  // button, not on a file. Focusing the "next" row then would steal it from under
  // the press, so an explicit null keeps focus where it is.
  it("focuses nothing when asked to keep a focus that is not on a file row", () => {
    const rows = pickerRows(pack, "size", 0, null);
    expect(rows.preselect).toBe(1);
    expect(rows.focus).toBeNull();
  });

  it("has nothing to badge or focus when there is no preselection and nothing kept", () => {
    const rows = pickerRows(pack, "name", null);
    expect(rows.preselect).toBeNull();
    expect(rows.focus).toBeNull();
  });

  // A file that is not in the list at all (a stale index from a picker that has
  // since been replaced) is "no opinion", not a crash and not row 0.
  it("ignores a preselection or a kept file that is not in the list", () => {
    const rows = pickerRows(pack, "name", 99, 42);
    expect(rows.preselect).toBeNull();
    expect(rows.focus).toBeNull();
  });
});

// A recording set of effects for runPlay. `sleep` and `now` are fake so the
// polling loop runs at full speed and the ten-minute deadline is reachable in a
// test; everything else records what the flow asked for.
function harness(over: Partial<PlayEffects> = {}) {
  const calls = {
    starts: [] as boolean[],
    confirms: [] as string[],
    notices: [] as string[],
    stopped: [] as string[],
    opened: [] as string[],
    chosen: [] as {
      sessionId: string;
      capability: string;
      files: PublicStreamFile[];
      preselect: number | null;
    }[],
    polls: 0,
    progress: [] as (string | null)[],
    // Paired with `notices` so a test can assert not just WHAT was said but
    // whether the flow called it a cancellation or a failure — app.ts routes
    // the two to different places (a self-clearing line vs a persistent alert
    // with a Try again), so getting the kind wrong is silently losing an error.
    noticeKinds: [] as (string | undefined)[],
    slept: [] as { ms: number; aborts: boolean }[],
  };
  let clock = 0;
  const fx: PlayEffects = {
    start: async (_row, confirmed) => {
      calls.starts.push(confirmed);
      return { kind: "failed" };
    },
    poll: async () => {
      calls.polls++;
      return null;
    },
    stop: (id) => calls.stopped.push(id),
    confirm: (message) => {
      calls.confirms.push(message);
      return false;
    },
    notice: (message, kind) => {
      calls.notices.push(message);
      calls.noticeKinds.push(kind);
    },
    progress: (line) => calls.progress.push(line),
    choose: (sessionId, capability, _name, files, preselect) =>
      calls.chosen.push({ sessionId, capability, files, preselect }),
    open: (path) => calls.opened.push(path),
    // Records whether it was handed the signal: a sleep that ignores one makes a
    // cancel wait out the remaining POLL_MS before anything happens.
    sleep: async (ms, signal) => {
      calls.slept.push({ ms, aborts: signal !== undefined });
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
  return { fx, calls };
}

const started = (over: Partial<PublicStreamSession> = {}): StartResult => ({
  kind: "started",
  sessionId: "s1",
  capability: "cap",
  session: session(over),
});

describe("runPlay", () => {
  it("opens the player directly for a single ready file", async () => {
    const { fx, calls } = harness({
      start: async () => started({ files: [file("movie.mp4", 0)] }),
    });
    await runPlay(row(), fx);
    expect(calls.opened).toEqual(["/play/s1/0?k=cap&n=movie.mp4"]);
    expect(calls.confirms).toEqual([]);
    expect(calls.stopped).toEqual([]);
  });

  // MUTATION GUARD #1. Deleting the prompt — retrying with confirm: true as soon
  // as the 409 arrives — puts the user's IP in a public swarm they were paying
  // Real-Debrid to stay out of, with nothing on screen to say it happened.
  it("prompts on a torrent-confirm refusal and does not retry when refused", async () => {
    const { fx, calls } = harness({
      start: async (_row, confirmed) => {
        calls.starts.push(confirmed);
        return { kind: "confirm", reason: "your premium expired" };
      },
    });
    await runPlay(row(), fx);
    expect(calls.starts).toEqual([false]);
    expect(calls.confirms).toHaveLength(1);
    expect(calls.confirms[0]).toContain("your premium expired");
    expect(calls.opened).toEqual([]);
    expect(calls.notices).toEqual(["Playback cancelled — nothing was streamed."]);
    // The user declined the prompt, so this is their own doing. It must NOT be
    // reported as a failure: app.ts turns a failure into a persistent alert
    // with a Try again, and offering to retry something someone just said no to
    // is the app arguing with them.
    expect(calls.noticeKinds).toEqual(["cancelled"]);
  });

  it("retries with confirm: true only after the user accepts", async () => {
    const calls: boolean[] = [];
    const { fx, calls: rec } = harness({
      start: async (_row, confirmed) => {
        calls.push(confirmed);
        return confirmed
          ? started({ files: [file("movie.mp4", 0)] })
          : { kind: "confirm", reason: "no premium" };
      },
      confirm: () => true,
    });
    await runPlay(row(), fx);
    expect(calls).toEqual([false, true]);
    expect(rec.opened).toEqual(["/play/s1/0?k=cap&n=movie.mp4"]);
  });

  it("asks once per click, even if the server refuses the confirmation too", async () => {
    let confirms = 0;
    const { fx } = harness({
      start: async () => ({ kind: "confirm", reason: "no premium" }),
      confirm: () => {
        confirms++;
        return true;
      },
    });
    await runPlay(row(), fx);
    expect(confirms).toBe(1);
  });

  // MUTATION GUARD #2 and #3. The player page has no bearer token, so ?k= is
  // the only credential it can present and ?n= is the only way it can learn the
  // filename. Drop either and the page renders a fallback card instead of video.
  it("carries the capability and the filename into the player URL", async () => {
    const { fx, calls } = harness({
      start: async () => ({
        kind: "started",
        sessionId: "sess-9",
        capability: "secret-cap",
        session: session({ id: "sess-9", files: [file("Copper Kettle Run.mp4", 2)] }),
      }),
    });
    await runPlay(row(), fx);
    expect(calls.opened[0]).toBe("/play/sess-9/2?k=secret-cap&n=Copper+Kettle+Run.mp4");
  });

  // MUTATION GUARD #5. Real-Debrid caching reports a percent for minutes; a loop
  // that stopped at the first tick would strand a session that was about to be
  // ready and leave the user watching a frozen number.
  // `backend: "debrid"` throughout, because a percent is only a thing a debrid
  // resolve HAS: a swarm reports no cache progress, so its line names the release
  // and counts seconds instead. Asserting "55%" against a torrent session would
  // be asserting something the UI is right not to say.
  it("keeps polling while the session is resolving, and shows the percent", async () => {
    const states: PublicStreamSession[] = [
      session({ state: "resolving", backend: "debrid", progress: 10 }),
      session({ state: "resolving", backend: "debrid", progress: 55 }),
      session({ state: "ready", files: [file("movie.mp4", 0)] }),
    ];
    let i = 0;
    const { fx, calls } = harness({
      start: async () => started({ state: "resolving", backend: "debrid", progress: 0 }),
      poll: async () => {
        calls.polls++;
        return states[i++] ?? null;
      },
    });
    await runPlay(row(), fx, { providerLabel: "Real-Debrid" });
    expect(calls.polls).toBe(3);
    // On the progress channel, not the notice line: the percent re-fires every
    // second and would stamp over any real message the user needed to read.
    expect(calls.progress.some((n) => n?.includes("55%"))).toBe(true);
    expect(calls.opened).toEqual(["/play/s1/0?k=cap&n=movie.mp4"]);
  });

  it("gives up and stops the session once the resolve deadline passes", async () => {
    const { fx, calls } = harness({
      start: async () => started({ state: "resolving" }),
      poll: async () => {
        calls.polls++;
        return session({ state: "resolving", progress: 5 });
      },
    });
    await runPlay(row(), fx);
    // The fake clock only advances through sleep(), so this is exactly the
    // deadline divided by the poll interval.
    expect(calls.polls).toBe(RESOLVE_TIMEOUT_MS / POLL_MS);
    expect(calls.stopped).toEqual(["s1"]);
    expect(calls.notices.at(-1)).toContain("Gave up waiting");
  });

  it("stops polling and says so when the session can't be read", async () => {
    const { fx, calls } = harness({ start: async () => started({ state: "resolving" }) });
    await runPlay(row(), fx);
    expect(calls.polls).toBe(1);
    expect(calls.notices.at(-1)).toContain("Lost track");
  });

  it("shows a picker instead of opening anything when there are several videos", async () => {
    const { fx, calls } = harness({
      start: async () => started({ files: [file("a.mkv", 0), file("b.mkv", 1), file("c.nfo", 2)] }),
    });
    await runPlay(row(), fx);
    expect(calls.opened).toEqual([]);
    expect(calls.chosen).toHaveLength(1);
    expect(calls.chosen[0]!.capability).toBe("cap");
    expect(calls.chosen[0]!.files.map((f) => f.filename)).toEqual(["a.mkv", "b.mkv"]);
    // The session is the picker's to stop now, not this flow's.
    expect(calls.stopped).toEqual([]);
  });

  it("hands the picker the episode to open on", async () => {
    const { fx, calls } = harness({
      start: async () =>
        started({
          files: [file("Harrowgate.S03E04.mkv", 0), file("Harrowgate.S03E05.mkv", 1)],
        }),
    });
    await runPlay(row(), fx, { wanted: { season: 3, episode: 5 } });
    expect(calls.chosen[0]!.preselect).toBe(1);
  });

  it("passes no preselection when the caller has no next episode", async () => {
    const { fx, calls } = harness({
      start: async () => started({ files: [file("a.mkv", 0), file("b.mkv", 1)] }),
    });
    await runPlay(row(), fx);
    expect(calls.chosen[0]!.preselect).toBeNull();
  });

  it("surfaces the session's error and releases the session", async () => {
    const { fx, calls } = harness({
      start: async () => started({ state: "error", error: "Couldn't reach the swarm." }),
    });
    await runPlay(row(), fx);
    expect(calls.notices).toEqual(["Couldn't reach the swarm."]);
    // A FAILURE, so app.ts keeps it on screen with a Try again. Reported as an
    // ordinary notice this would clear itself after four seconds — and a play
    // can fail minutes in, by which point the user is far down a browse and the
    // line they needed has already gone.
    expect(calls.noticeKinds).toEqual(["failure"]);
    expect(calls.stopped).toEqual(["s1"]);
    expect(calls.opened).toEqual([]);
  });

  it("releases the session when a ready torrent has nothing in it", async () => {
    const { fx, calls } = harness({ start: async () => started({ files: [] }) });
    await runPlay(row(), fx);
    expect(calls.stopped).toEqual(["s1"]);
    expect(calls.opened).toEqual([]);
    expect(calls.noticeKinds).toEqual(["failure"]);
  });

  /**
   * The one thing this distinction exists for: every ending that is not the
   * user's own cancellation has to be reported as a failure, or it lands in the
   * self-clearing line and the app goes quiet about something that went wrong.
   * Asserted as a set over the whole flow rather than per case, so a new ending
   * added later cannot default to silence unnoticed.
   */
  it("calls every non-cancellation ending a failure", async () => {
    const endings = [
      // A session that resolves forever, and one that becomes unreadable —
      // both reached only from a start that SUCCEEDED, which the default
      // harness's start does not.
      {
        name: "resolve timed out",
        over: {
          start: async () => started({ state: "resolving" }),
          poll: async () => session({ state: "resolving", progress: 5 }),
        },
      },
      {
        name: "session unreadable",
        over: { start: async () => started({ state: "resolving" }), poll: async () => null },
      },
      {
        name: "session errored",
        over: { start: async () => started({ state: "error", error: "nope" }) },
      },
      { name: "no playable files", over: { start: async () => started({ files: [] }) } },
    ];
    for (const ending of endings) {
      const { fx, calls } = harness(ending.over as Partial<PlayEffects>);
      await runPlay(row(), fx);
      expect(`${ending.name}: ${calls.noticeKinds.at(-1)}`).toBe(`${ending.name}: failure`);
    }
  });

  it("says nothing extra when the start itself already failed and reported why", async () => {
    const { fx, calls } = harness();
    await runPlay(row(), fx);
    expect(calls.notices).toEqual([]);
    expect(calls.opened).toEqual([]);
  });

  describe("onUnresolved", () => {
    it("fires when start fails outright", async () => {
      let fired = 0;
      const { fx } = harness({ onUnresolved: () => fired++ });
      await runPlay(row(), fx);
      expect(fired).toBe(1);
    });

    // MUTATION GUARD. start() runs twice on the confirm-then-retry path — once
    // unconfirmed, once after the human says yes — and only the SECOND of
    // those two calls fails here. A caller-side latch that assumed both calls
    // could report "failed" would be guarding against something that cannot
    // happen; this proves the callback still fires exactly once even across
    // both calls, with the guarantee living in runPlay rather than in app.ts.
    it("fires exactly once, even when start is called twice on the confirm-then-fail path", async () => {
      let fired = 0;
      const { fx, calls } = harness({
        start: async (_row, confirmed) => {
          calls.starts.push(confirmed);
          return confirmed ? { kind: "failed" } : { kind: "confirm", reason: "no premium" };
        },
        confirm: () => true,
        onUnresolved: () => fired++,
      });
      await runPlay(row(), fx);
      expect(calls.starts).toEqual([false, true]);
      expect(fired).toBe(1);
    });

    it("does not fire when the user declines the confirm prompt", async () => {
      let fired = 0;
      const { fx } = harness({
        start: async () => ({ kind: "confirm", reason: "no premium" }),
        confirm: () => false,
        onUnresolved: () => fired++,
      });
      await runPlay(row(), fx);
      expect(fired).toBe(0);
    });

    it("does not fire when the server refuses the confirmation a second time", async () => {
      let fired = 0;
      const { fx } = harness({
        start: async () => ({ kind: "confirm", reason: "no premium" }),
        confirm: () => true,
        onUnresolved: () => fired++,
      });
      await runPlay(row(), fx);
      expect(fired).toBe(0);
    });

    it("does not fire when the session starts successfully", async () => {
      let fired = 0;
      const { fx } = harness({
        start: async () => started({ files: [file("movie.mp4", 0)] }),
        onUnresolved: () => fired++,
      });
      await runPlay(row(), fx);
      expect(fired).toBe(0);
    });

    it("is optional — runPlay does not require it", async () => {
      const { fx } = harness();
      await expect(runPlay(row(), fx)).resolves.toBeUndefined();
    });
  });

  describe("cancelling", () => {
    // A resolve can run for ten minutes. Before this there was no way out of one
    // but reloading the page, which orphaned the session either way.
    it("does not start anything at all when already aborted", async () => {
      const ac = new AbortController();
      ac.abort();
      const { fx, calls } = harness({
        start: async () => started({ files: [file("movie.mp4", 0)] }),
      });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(calls.starts).toEqual([]);
      expect(calls.opened).toEqual([]);
      expect(calls.notices).toEqual(["Stream cancelled."]);
    });

    // THE RACE THAT MATTERS. An abort landing after the POST succeeded but
    // before the first poll must still DELETE the session — otherwise
    // cancelling at the worst possible moment leaks the exact resource that
    // cancelling exists to release, and the torrent runs until the idle reaper.
    it("stops the session when the abort lands after it was started", async () => {
      const ac = new AbortController();
      const { fx, calls } = harness({
        start: async () => {
          ac.abort();
          return started({ state: "resolving", progress: 0 });
        },
      });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(calls.stopped).toEqual(["s1"]);
      expect(calls.notices).toContain("Stream cancelled.");
      expect(calls.polls).toBe(0);
      expect(calls.opened).toEqual([]);
    });

    it("stops polling and releases the session when cancelled mid-resolve", async () => {
      const ac = new AbortController();
      let polls = 0;
      const { fx, calls } = harness({
        start: async () => started({ state: "resolving", progress: 10 }),
        poll: async () => {
          polls++;
          if (polls === 2) ac.abort();
          return session({ state: "resolving", progress: 10 + polls });
        },
      });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(polls).toBe(2);
      expect(calls.stopped).toEqual(["s1"]);
      expect(calls.notices).toContain("Stream cancelled.");
    });

    // An aborted POST comes back as `failed` — the fetch threw and the caller
    // cannot tell a cancel from a dead server. Checked BEFORE the failed branch,
    // or a cancel exits with no "Stream cancelled." and fires onUnresolved, whose
    // Continue-watching binding launches a fallback SEARCH. Pressing Cancel would
    // start a search.
    it("reports a cancel during the initial POST as a cancel, and fires no fallback", async () => {
      const ac = new AbortController();
      let fallbacks = 0;
      const { fx, calls } = harness({
        start: async () => {
          ac.abort();
          return { kind: "failed" };
        },
        onUnresolved: () => fallbacks++,
      });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(calls.notices).toEqual(["Stream cancelled."]);
      expect(fallbacks).toBe(0);
      expect(calls.stopped).toEqual([]);
    });

    // Same rule on the second POST, the one after a human accepted the
    // torrent-confirm prompt.
    it("reports a cancel during the confirmed retry as a cancel", async () => {
      const ac = new AbortController();
      let fallbacks = 0;
      const { fx, calls } = harness({
        start: async (_row, confirmed) => {
          if (!confirmed) return { kind: "confirm", reason: "no premium" };
          ac.abort();
          return { kind: "failed" };
        },
        confirm: () => true,
        onUnresolved: () => fallbacks++,
      });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(calls.notices).toEqual(["Stream cancelled."]);
      expect(fallbacks).toBe(0);
    });

    it("hands the signal to start, poll and sleep, so an in-flight fetch dies too", async () => {
      const ac = new AbortController();
      const seen: { start?: boolean; poll?: boolean } = {};
      let polls = 0;
      const { fx, calls } = harness({
        start: async (_row, _confirmed, signal) => {
          seen.start = signal === ac.signal;
          return started({ state: "resolving", progress: 0 });
        },
        poll: async (_id, signal) => {
          seen.poll = signal === ac.signal;
          polls++;
          return polls === 1
            ? session({ state: "resolving" })
            : session({ files: [file("movie.mp4", 0)] });
        },
      });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(seen.start).toBe(true);
      expect(seen.poll).toBe(true);
      expect(calls.slept.every((s) => s.aborts)).toBe(true);
    });

    // An aborted fetch reads as an unreadable session, which has its own,
    // wrong, message: "Lost track of that stream — try again." tells a user who
    // just pressed Cancel that something went wrong.
    it("reports a cancel as a cancel, not as a lost session", async () => {
      const ac = new AbortController();
      const { fx, calls } = harness({
        start: async () => started({ state: "resolving", progress: 10 }),
        poll: async () => {
          ac.abort();
          return null;
        },
      });
      await runPlay(row(), fx, { signal: ac.signal });
      expect(calls.notices).toContain("Stream cancelled.");
      expect(calls.notices).not.toContain("Lost track of that stream — try again.");
      expect(calls.stopped).toEqual(["s1"]);
    });
  });

  describe("progress", () => {
    it("reports the waiting line on its own channel, not as a notice", async () => {
      let polls = 0;
      const { fx, calls } = harness({
        start: async () => started({ state: "resolving", backend: "debrid", progress: 40 }),
        poll: async () => {
          polls++;
          return polls === 1
            ? session({ state: "resolving", backend: "debrid", progress: 60 })
            : session({ files: [file("movie.mp4", 0)] });
        },
      });
      await runPlay(row(), fx, { providerLabel: "Real-Debrid" });
      expect(calls.progress[0]).toBe("Caching on Real-Debrid… 40% · 0s");
      expect(calls.notices).toEqual([]);
    });

    // The pill must come down however the flow ends, or it sits over the page
    // for good. Asserted for a success, a failure and a cancel.
    it("clears the waiting line however the flow ends", async () => {
      const ok = harness({ start: async () => started({ files: [file("movie.mp4", 0)] }) });
      await runPlay(row(), ok.fx);
      expect(ok.calls.progress.at(-1)).toBeNull();

      const bad = harness({ start: async () => started({ state: "error", error: "no peers" }) });
      await runPlay(row(), bad.fx);
      expect(bad.calls.progress.at(-1)).toBeNull();

      const ac = new AbortController();
      ac.abort();
      const off = harness();
      await runPlay(row(), off.fx, { signal: ac.signal });
      expect(off.calls.progress.at(-1)).toBeNull();
    });
  });
});
