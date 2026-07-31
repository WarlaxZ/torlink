// Pure decision logic for "press Play on a dashboard row". Separate from the
// DOM binding in app.ts for the same reason dashboard.ts and playerModel.ts are:
// there is no headless-browser test environment in this repo and adding one for
// this would be disproportionate, so everything with a decision in it lives
// here, where a plain unit test can reach it, and app.ts stays wiring.
//
// Bundled for the browser, so: no node:* imports, direct or transitive.
//
// FOUR VALUE IMPORTS LEAVE THIS DIRECTORY, all four for one reason — the piece is
// a decision both front ends make, so it is shared rather than copied — and each
// is argued at its own import line below: `util/videoFiles` (which files are
// candidates), `util/nextEpisodeFile` (which one to open on),
// `util/streamHistoryKey` (which history row a release belongs to) and
// `util/release` (what a release name says). The type-only imports are free:
// `../wire` and `../../util/episode` are erased at build time, as in dashboard.ts.
//
// `../../util/videoFiles` is the first, and it is
// deliberate: it is the video-first heuristic the TUI's file picker uses, and
// reimplementing it here would be the fourth instance of the copy-then-drift bug
// this codebase keeps hitting (uploadSpeed, the byte formatter, the progress
// unit). That module is dependency-free and stays that way — `platform:
// "browser"` in tsup.web.config.ts fails the build if it ever isn't.
import { streamCandidates } from "../../util/videoFiles";
// The fifth, same argument, and this one was a bug report rather than a
// prediction: the ORDER a picker lists a torrent's files in used to be private to
// `src/ui/components/StreamFilePrompt.tsx`, so the browser listed a season pack
// in whatever order the torrent named its files — E08 above E02 — while the
// terminal listed it E01…E10. The rule moved down to src/util rather than being
// written a second time here.
import { nextSort, sortStreamFiles, type StreamFileSort } from "../../util/streamFileSort";
// The second, and the same argument: which
// file is the next episode is a decision both front ends make, so it is shared
// rather than copied. It pulls in `release.ts` (and so parse-torrent-title),
// which is why it is a module of its own and not part of videoFiles.ts.
import { nextEpisodeIndex } from "../../util/nextEpisodeFile";
// The third and fourth, and the same argument again: the stream-history store's
// dedupe key decides which row a release belongs to (and `parseRelease` is what it
// is derived from), so a second derivation of either in the browser would be the
// fifth recorded copy-then-drift bug here. `historyKeyFor` was module-private in
// src/core/streamHistory.ts, which imports node:fs and so cannot be reached from a
// browser bundle; it moved down to src/util (whence src/core re-exports it) rather
// than being copied. `release.ts` was already in this bundle via nextEpisodeFile.
import { historyKeyFor } from "../../util/streamHistoryKey";
import { parseRelease } from "../../util/release";
// The sixth value import out of this directory, and the same argument as the
// other five: what a waiting user reads is a decision both front ends make, so
// it is shared rather than written twice. It lived inline in src/ui/App.tsx's
// render until this file needed it. See src/util/prepareLine.ts.
import { prepareLine } from "../../util/prepareLine";
import type { EpisodeRef } from "../../util/episode";
import type { PublicStreamFile, PublicStreamHistoryItem, PublicStreamSession } from "../wire";
import { formatBytes, shortName, type DashRow } from "./dashboard";

// Re-exported for the same reason dashboard.ts re-exports the status types: one
// import site for app.ts, and — more to the point — no opportunity for anyone to
// *redeclare* these shapes in the browser bundle. Hand-mirroring a producer's
// payload is what dropped `uploadSpeed` and what read `progress` in the wrong
// unit.
export type {
  PublicStreamFile,
  PublicStreamSession,
  StartStreamResponse,
  StreamConfirmResponse,
} from "../wire";
// Same argument, one layer further down: app.ts holds an episode reference on its
// way to `runPlay`, and re-exporting the one declaration is what stops it from
// spelling `{ season, episode }` out again. See src/util/episode.ts.
export type { EpisodeRef } from "../../util/episode";

/**
 * Whether a row is worth offering a Play button on.
 *
 * A stream session is NOT the queue's download: it starts its own Real-Debrid
 * resolve or its own WebTorrent client from the same info hash. So the question
 * is not "are the bytes on disk yet" — it is "does this row identify a torrent
 * we could fetch". That makes the offer wide on purpose:
 *
 * - `downloading` — the whole point of streaming is watching before it finishes.
 * - `queued` / `paused` / `selecting` — the torrent is real and streaming it
 *   doesn't disturb the queue item; a paused download is exactly when someone
 *   wants a look at what they queued.
 * - a seed — finished, and re-fetchable; playable from the swarm or from RD.
 *
 * And narrow in the two places where a button would be a lie:
 *
 * - a `failed` download, where the magnet or the swarm is what failed. Play
 *   would start a session that fails the same way, a minute later, having shown
 *   a progress bar first.
 * - a `missing` seed, whose files are gone from disk. That row is a stub asking
 *   to be cleaned up, not media.
 */
export function isPlayable(row: DashRow): boolean {
  if (row.kind === "seed") return row.status !== "missing";
  return row.status !== "failed";
}

/**
 * The player URL for one file of a session: `/play/:sid/:idx?k=…&n=…`.
 *
 * Both query parameters are load-bearing and neither is optional:
 *
 * - `k` is the capability. The player page authenticates its `<video>` and its
 *   `.m3u` with it, because neither can send an `Authorization` header. Without
 *   it the page renders the "this link is incomplete" card and nothing plays.
 * - `n` is the filename, and it is what the page *displays*. A phone handed this
 *   link holds the capability but not the bearer token, so `GET /api/stream/:sid`
 *   is closed to it — but `GET /stream/:sid/:idx.info` is not, and that is where
 *   the page gets the container and codecs it decides playability from. Omit `n`
 *   and the page shows "Unnamed file" and still plays, because `.info` names the
 *   file server-side; only if `.info` is unreachable too does an empty name fall
 *   through to the pessimistic card.
 *
 * `file.index` is the session's own index, not a position in the filtered
 * candidate list: the two differ the moment a torrent contains a `.nfo`, and
 * using the wrong one plays a different file than the one that was clicked.
 *
 * The `:sid` encoding mirrors `streamHandle` in ../routes.ts and
 * `parsePlayerLocation` in ./playerModel.ts — one address, written three times,
 * so they have to agree.
 */
export function playerPath(
  sessionId: string,
  file: PublicStreamFile,
  capability: string,
): string {
  const query = new URLSearchParams({ k: capability, n: file.filename });
  return `/play/${encodeURIComponent(sessionId)}/${file.index}?${query.toString()}`;
}

/** What to do once a session has stopped resolving. */
export type StreamOutcome =
  /** Exactly one candidate: open the player on it, no picker. */
  | { kind: "single"; file: PublicStreamFile }
  /**
   * Several candidates: ask which one, opening on `preselect`.
   *
   * `preselect` is an index into `files` — the FILTERED list the picker draws,
   * not the session's own indexes, which differ the moment a release ships a
   * `.nfo`. Null is the ordinary answer and means "no opinion": the picker looks
   * exactly as it always has.
   */
  | { kind: "choose"; files: PublicStreamFile[]; preselect: number | null }
  /** The session failed. `message` is already worded for a human. */
  | { kind: "error"; message: string }
  /** Ready, but there is nothing in it to play. */
  | { kind: "empty" };

/**
 * Turn a settled session into the next thing the UI does.
 *
 * The file list is `streamCandidates`, not `session.files`: a scene release is a
 * video plus a `.nfo`, a `.srt`, a sample and a screens folder, and a picker
 * listing all of them makes the user do the filtering that the heuristic already
 * did for the TUI. When nothing looks like video the heuristic hands back
 * everything, so an unrecognised container is still reachable.
 *
 * A `resolving` session never reaches here — `pollDecision` owns that state —
 * but it is treated as an error rather than silently as "empty", because a
 * caller that skipped the polling loop has a bug and should see it.
 *
 * `next` is the episode to open the picker on: pass a Continue-watching row's
 * own `next`, which the server computed with `nextEpisode` over the row's
 * high-water mark. It crosses the wire already (`PublicStreamHistoryItem`), so
 * nothing here recomputes it and no field was added to carry it.
 *
 * ONE HALF OF THE PRESELECTION IS TUI-ONLY, deliberately. `nextEpisodeIndex`
 * also falls back to the first not-yet-watched file (preferring one that names
 * some episode) when nothing parses as the episode asked for; that needs the
 * watched FILENAMES, which `PublicFavourite` withholds on purpose (it sends a
 * count — see wire.ts for why filenames from inside a stranger's torrent are not
 * handed to a browser). This is neither of CLAUDE.md's two named exemptions: the
 * browser COULD express it and is simply not given the data, by a privacy
 * decision recorded in wire.ts. The parse-based preselection, which is the
 * feature, is identical in both front ends.
 */
export function streamOutcome(
  session: PublicStreamSession,
  next?: EpisodeRef | null,
): StreamOutcome {
  if (session.state === "error") {
    // The core reuses the TUI's wording, so this is already a sentence a person
    // can act on. Only the generic case is written here.
    return { kind: "error", message: session.error ?? "The stream failed to start." };
  }
  if (session.state !== "ready") {
    return { kind: "error", message: "The stream is still starting." };
  }
  const candidates = streamCandidates(session.files);
  if (candidates.length === 0) return { kind: "empty" };
  if (candidates.length === 1) return { kind: "single", file: candidates[0]! };
  // Sorted BEFORE the preselection is counted, because `preselect` is an index
  // into the list the picker draws: counting it over the torrent's own order and
  // then drawing a different order badges — and focuses — an unrelated episode.
  // Safe to do here, unlike in the TUI (which sorts at display and remaps by
  // `url`), because `nextEpisodeIndex`'s only position-sensitive branch is its
  // `watched` fallback, and the browser is not given watched filenames — see the
  // note above about the half of the preselection that stays TUI-only.
  const files = sortStreamFiles(candidates, "name");
  return { kind: "choose", files, preselect: nextEpisodeIndex(files, { next }) };
}

/** One rendering of the picker list: what to draw, what to badge, where the keyboard goes. */
export interface PickerRows {
  /** The files in display order. */
  files: PublicStreamFile[];
  /** The row to badge "next", as an index into `files` above, or null. */
  preselect: number | null;
  /** The row to put the keyboard on, as an index into `files` above, or null. */
  focus: number | null;
}

/**
 * The picker's list for one sort mode — the browser's equivalent of the TUI
 * picker's `s` key, and here rather than in app.ts because it is three decisions
 * and app.ts is wiring.
 *
 * Both `marked` and `keep` are indexes into `files` AS GIVEN (`streamOutcome`'s
 * list), and both are resolved to the FILE and looked up again in the sorted
 * list: an index into an order the user is no longer looking at points at the
 * wrong row. Same rule, and the same reason, as `StreamFilePrompt`'s remap by
 * `url` — the identity here is the session's own file index.
 *
 * `keep` is the file the user already had focused and WINS over `marked`, so
 * pressing sort re-orders the list under the keyboard instead of yanking it back
 * to the "next" episode.
 *
 * OMITTING `keep` AND PASSING NULL MEAN DIFFERENT THINGS, and the difference is
 * the sort button itself. Omitted is "opening the picker": focus follows the
 * preselection, which is what makes Enter play the episode Continue-watching
 * promised. Null — or an index naming a file not in the list, e.g. a stale one
 * from a picker since replaced — is "asked, and the keyboard is not on a file
 * row", which is exactly the state after clicking sort: `focus` is then null and
 * nothing is stolen from the button that was just pressed.
 */
export function pickerRows(
  files: readonly PublicStreamFile[],
  mode: StreamFileSort,
  marked: number | null,
  keep?: number | null,
): PickerRows {
  const sorted = sortStreamFiles(files, mode);
  const rowOf = (at: number | null | undefined): number | null => {
    if (at === null || at === undefined) return null;
    const file = files[at];
    if (!file) return null;
    const row = sorted.findIndex((f) => f.index === file.index);
    return row >= 0 ? row : null;
  };
  const preselect = rowOf(marked);
  const focus = keep === undefined ? preselect : rowOf(keep);
  return { files: sorted, preselect, focus };
}

// Re-exported for app.ts, for the reason the file header gives: one import site,
// and no opportunity for the browser bundle to redeclare either the mode union or
// the toggle rule. See src/util/streamFileSort.ts.
export { nextSort, type StreamFileSort };

/**
 * Which episode to open the picker on for a release the user pressed Play on.
 *
 * WHY THIS EXISTS: without it the browser preselects from ONE entry point and the
 * terminal preselects from all of them. In the TUI every play path funnels
 * through `openStreamPicker` with the row `recordStreamHistory` has just merged,
 * so playing a season pack found in *search results* still opens on the episode
 * you are up to. In the browser the only caller holding a Continue-watching row
 * is the Continue-watching strip; a search hit and a library row hold a release
 * name and nothing else. CLAUDE.md makes a feature that exists on one surface and
 * not the other the default-prohibited outcome, and this is that same feature,
 * not a second one.
 *
 * So the row is FOUND, by the store's own dedupe key — `historyKeyFor` over the
 * parsed release name, the same key the server wrote. Not by info hash: the
 * whole case is that the pack now being played is a different torrent from the
 * single episode that was recorded.
 *
 * `held` is a suggestion the caller already has (`PublicStreamHistoryItem.next`,
 * computed server-side over the stored high-water mark) and WINS when given.
 * That is not belt-and-braces: rows written under an older key format are kept on
 * purpose and only migrate when their title is next streamed, so a re-derived key
 * can miss the very row that was clicked. A miss is ordinary here — null leaves
 * the picker behaving exactly as it always has.
 *
 * ONE KNOWN DIFFERENCE FROM THE TUI, recorded rather than papered over: the
 * terminal reads the row AFTER the merge, so playing something LATER than the
 * high-water mark (S03E07 when the row says E04) preselects E08 there and E05
 * here. Closing it would mean a second `recordStream` in the browser — the
 * copy-then-drift bug this module keeps refusing — and the realistic instances
 * are single-file torrents, which open no picker at all.
 */
export function wantedEpisodeFor(
  name: string,
  rows: readonly PublicStreamHistoryItem[],
  held?: EpisodeRef | null,
): EpisodeRef | null {
  if (held) return held;
  const parsed = parseRelease(name);
  if (!parsed) return null;
  const key = historyKeyFor(parsed);
  return rows.find((r) => r.key === key)?.next ?? null;
}

/** How long between polls of a resolving session. */
export const POLL_MS = 1000;

/**
 * When to stop waiting for a session to resolve.
 *
 * Generous because Real-Debrid genuinely takes minutes to cache a torrent it
 * has never seen, and a dashboard that gives up at thirty seconds would report
 * a failure for something that was about to work. But not unbounded: a session
 * that is never going to resolve would otherwise poll for as long as the tab
 * is open, once a second, forever.
 */
export const RESOLVE_TIMEOUT_MS = 10 * 60 * 1000;

/** What the polling loop should do next. */
export type PollDecision =
  /** Still resolving: show `label`, wait `delayMs`, poll again. */
  | { kind: "poll"; delayMs: number; label: string }
  /** Resolving for too long; give up and show `message`. */
  | { kind: "timeout"; message: string }
  /** Settled — hand the session to `streamOutcome`. */
  | { kind: "settled" };

/**
 * The polling loop's only decision, extracted so it can be tested without a
 * timer or a DOM.
 *
 * THE GUARD THAT MATTERS: while `state === "resolving"` this must keep polling.
 * Real-Debrid caching sits at a mid-range percent for minutes at a time and a
 * loop that stopped early would leave the user staring at "42%" with nothing
 * ever happening — the session would go on to become ready and nobody would
 * open it. The percent is reported for the same reason: a number that moves is
 * the difference between "working" and "hung".
 */
export function pollDecision(
  session: PublicStreamSession,
  elapsedMs: number,
  name: string,
  providerLabel?: string | null,
): PollDecision {
  if (session.state !== "resolving") return { kind: "settled" };
  const label = shortName(name);
  if (elapsedMs >= RESOLVE_TIMEOUT_MS) {
    return {
      kind: "timeout",
      message: `Gave up waiting for “${label}” to be ready. It may still be caching — try again in a few minutes.`,
    };
  }
  return {
    kind: "poll",
    delayMs: POLL_MS,
    // `phase: "caching"` unconditionally: the wire has one `resolving` state and
    // no way to distinguish the provider's link-fetch step from its cache, so
    // the browser never renders prepareLine's "Fetching link…" arm. The TUI
    // does, from its own richer local state. Reporting a percent of 0 as
    // "Caching… 0%" is honest for that moment; inventing a phase would not be.
    //
    // The clamp on `progress` lives in prepareLine, which is why there is no
    // longer a `resolvePercent` here — one guard, shared with the terminal,
    // rather than two that can disagree about what 99.7% rounds to.
    label: prepareLine({
      source: session.backend === "debrid" ? "rd" : "torrent",
      phase: "caching",
      providerLabel,
      label,
      pct: session.progress,
      elapsedSec: elapsedMs / 1000,
    }),
  };
}

/**
 * The prompt shown when the server answers `409 torrent-confirm`.
 *
 * This exists because the alternative — proceeding — is a privacy failure, not
 * an inconvenience. The user configured Real-Debrid so their IP would stay out
 * of public swarms; Real-Debrid is configured but not working; falling back to
 * peer-to-peer "helpfully" puts their address in a swarm they were paying to
 * avoid, with no indication it happened. So the server refuses, and this is the
 * question it refuses in favour of.
 *
 * The consequence is spelled out rather than implied. "Continue anyway?" is not
 * informed consent when the thing being consented to is publishing your IP.
 */
export function confirmFallbackMessage(reason: string, name: string): string {
  return (
    `Real-Debrid can't be used for “${shortName(name)}”: ${reason}\n\n` +
    "Stream it peer-to-peer instead? Your IP address will be visible to everyone " +
    "in the swarm — which is what Real-Debrid was avoiding."
  );
}

/** One line in the file picker: the name, and how big it is. */
export function fileLabel(file: PublicStreamFile): string {
  return `${file.filename} · ${formatBytes(file.bytes)}`;
}

/** What `POST /api/stream` came back with. */
export type StartResult =
  | { kind: "started"; sessionId: string; capability: string; session: PublicStreamSession }
  /**
   * The 409. Real-Debrid is configured but not usable, and the server refused
   * to substitute a public swarm on the user's behalf. NOT a failure and NOT a
   * go-ahead — the only correct next step is to ask a human.
   */
  | { kind: "confirm"; reason: string }
  /** Anything else. The transport layer has already told the user why. */
  | { kind: "failed" };

/**
 * Everything `runPlay` does to the outside world, injected.
 *
 * The flow below is the part of this feature with actual decisions in it — when
 * to prompt, when to keep waiting, what to open — and it would otherwise sit in
 * app.ts where no test in this repo can reach it (there is no DOM here, by
 * choice). So the effects are parameters and the flow is testable end to end.
 */
export interface PlayEffects {
  /**
   * POST /api/stream. `confirmed` is only ever true after a human said so.
   *
   * `signal` is `PlayOptions.signal`, passed down so a cancel kills the request
   * in flight rather than waiting for it. An implementation that aborts must
   * NOT report that as a transport failure — the user asked for it. See the
   * abort check immediately after this is called in `runPlay`.
   */
  start(row: DashRow, confirmed: boolean, signal?: AbortSignal): Promise<StartResult>;
  /** GET /api/stream/:sid, or null when it can't be read. */
  poll(sessionId: string, signal?: AbortSignal): Promise<PublicStreamSession | null>;
  /** DELETE /api/stream/:sid, best effort. */
  stop(sessionId: string): void;
  /** A blocking yes/no. window.confirm in the browser. */
  confirm(message: string): boolean;
  /** Transient message in the dashboard's notice line. */
  notice(message: string): void;
  /**
   * The waiting line, or null to take it down.
   *
   * A SEPARATE CHANNEL FROM `notice`, deliberately. `notice` is a transient line
   * that hides itself after a few seconds; this one has to persist for as long
   * as the resolve does, which can be minutes, and it has a Cancel button
   * attached. Sharing one effect meant the progress label re-firing every second
   * stamped over any real message the user needed to read.
   *
   * REQUIRED, not optional: an implementation that forgot it would leave a pill
   * fixed over the page for good.
   */
  progress(line: string | null): void;
  /**
   * Show the file picker. Ownership of the session passes to it.
   *
   * `preselect` is an index into `files` to open on, or null for no opinion —
   * `streamOutcome`'s decision, not one to re-derive here.
   */
  choose(
    sessionId: string,
    capability: string,
    name: string,
    files: PublicStreamFile[],
    preselect: number | null,
  ): void;
  /** Go to a player URL. Ownership of the session passes to the player. */
  open(path: string): void;
  /**
   * Wait. Takes the signal so a cancel does not have to wait out the remaining
   * `POLL_MS` before anything visible happens — a Cancel button that looks
   * inert for most of a second gets pressed again.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  /**
   * Called when `start` could not start a session at all — `start.kind ===
   * "failed"` (a dead swarm, an unreachable server; `start` has already
   * shown its own notice for this). Optional: most callers have nothing to
   * add beyond that notice.
   *
   * FIRES AT MOST ONCE PER `runPlay` CALL, guaranteed by where `runPlay`
   * calls it rather than by anything the caller has to track — `start` runs
   * at most twice (the unconfirmed attempt, then once more after a human
   * accepts the torrent-confirm prompt), and only one of those two calls can
   * ever reach the "failed" branch: whichever one returns `"confirm"` is by
   * definition not "failed", and once a `"confirm"` is followed by a second
   * `"confirm"` `runPlay` returns before this fires at all. A caller wiring
   * this does not need to know any of that; it is exactly why the guarantee
   * belongs here and not as a flag re-derived in DOM code.
   */
  onUnresolved?(): void;
}

/**
 * The one wording for a cancelled stream, shared with the TUI's own
 * `cancelPreparing` (src/ui/App.tsx) by being the same string.
 */
export const CANCELLED_NOTICE = "Stream cancelled.";

/**
 * The three things `runPlay` needs that are DATA rather than effects.
 *
 * An options bag rather than three positional parameters: `wanted` was the third
 * argument, and the other two would make a call site read
 * `runPlay(row, fx, null, "Real-Debrid", signal)` — where transposing two
 * arguments typechecks and silently plays the wrong episode. This is not
 * hypothetical: the test that pins the preselection passed
 * `{ season: 3, episode: 5 }` positionally, which is structurally exactly what a
 * bag of options is not.
 */
export interface PlayOptions {
  /**
   * A Continue-watching row's own suggested episode, passed straight through to
   * `streamOutcome`. Every other caller — a search result, a queue row — has no
   * such row and passes nothing. (Named `wanted` rather than `next` only because
   * the polling loop already has a `next`.)
   */
  wanted?: EpisodeRef | null;
  /** Who is caching, for the waiting line. Absent renders "debrid". */
  providerLabel?: string | null;
  /**
   * Cancels the flow. Threaded into `start`, `poll` and `sleep` rather than
   * merely checked between them, so a cancel kills an in-flight fetch instead of
   * waiting it out — and, crucially, a session that HAD started is stopped on
   * the way out. See rule 3 below.
   */
  signal?: AbortSignal;
}

/**
 * Press Play on one row: start a session, wait for it, open something.
 *
 * The two rules this function exists to hold:
 *
 * 1. A `torrent-confirm` refusal PROMPTS. It never retries with `confirm: true`
 *    on its own. The user configured Real-Debrid so their IP would stay out of
 *    public swarms; retrying silently would put it in one.
 * 2. A `resolving` session is POLLED until it settles or the deadline passes.
 *    Real-Debrid caching sits mid-percent for minutes, and a loop that gave up
 *    early would strand a session that was about to be ready.
 * 3. A CANCEL RELEASES THE SESSION. Every exit after `start` succeeded stops the
 *    session, an abort included — a cancel that leaked the torrent would be
 *    worse than no cancel at all, because the user believes they stopped it.
 *
 * Everything in `PlayOptions` is DATA rather than an effect, which is why it is
 * a parameter and not more members of `PlayEffects`. See that interface.
 */
export async function runPlay(
  row: DashRow,
  fx: PlayEffects,
  opts: PlayOptions = {},
): Promise<void> {
  const { wanted, providerLabel, signal } = opts;

  // Every exit from here down goes through one of these two, so the waiting line
  // cannot be left up by a path someone forgot about.
  const done = (): void => fx.progress(null);
  const cancel = (sessionId: string | null): void => {
    if (sessionId) fx.stop(sessionId);
    done();
    fx.notice(CANCELLED_NOTICE);
  };

  if (signal?.aborted) {
    cancel(null);
    return;
  }

  // Every `await fx.start(...)` is followed by this, and it has to come BEFORE
  // the confirm/failed branches below. An aborted POST throws inside the effect,
  // which reports it as `failed` — indistinguishable from a dead server. Left to
  // fall through, a cancel would exit with no "Stream cancelled." at all AND
  // fire `onUnresolved`, whose Continue-watching binding launches a fallback
  // search: pressing Cancel would start a search.
  //
  // Stops the session when one came back regardless, since an abort that landed
  // just after the POST succeeded still owes it a stop.
  const abortedAfterStart = (result: StartResult): boolean => {
    if (!signal?.aborted) return false;
    cancel(result.kind === "started" ? result.sessionId : null);
    return true;
  };

  let start = await fx.start(row, false, signal);
  if (abortedAfterStart(start)) return;

  if (start.kind === "confirm") {
    if (!fx.confirm(confirmFallbackMessage(start.reason, row.name))) {
      done();
      fx.notice("Playback cancelled — nothing was streamed.");
      return;
    }
    start = await fx.start(row, true, signal);
    if (abortedAfterStart(start)) return;
    // A second 409 means the server didn't accept the confirmation. Do not loop
    // asking: one prompt per click.
    if (start.kind === "confirm") {
      done();
      fx.notice("Couldn't start that stream.");
      return;
    }
  }
  if (start.kind !== "started") {
    done();
    if (start.kind === "failed") fx.onUnresolved?.();
    return;
  }

  const { sessionId, capability } = start;
  let session = start.session;
  const began = fx.now();
  for (;;) {
    const decision = pollDecision(session, fx.now() - began, row.name, providerLabel);
    if (decision.kind === "settled") break;
    if (decision.kind === "timeout") {
      done();
      fx.notice(decision.message);
      fx.stop(sessionId);
      return;
    }
    fx.progress(decision.label);
    await fx.sleep(decision.delayMs, signal);
    if (signal?.aborted) {
      cancel(sessionId);
      return;
    }
    const next = await fx.poll(sessionId, signal);
    if (!next) {
      // An aborted fetch also lands here, and must not be reported as a
      // transport failure: "Lost track of that stream" tells a user who just
      // pressed Cancel that something went wrong.
      if (signal?.aborted) {
        cancel(sessionId);
        return;
      }
      // The session is gone or unreadable. Not stopped here: a DELETE we can't
      // read the answer to adds nothing, and the id may not exist at all.
      done();
      fx.notice("Lost track of that stream — try again.");
      return;
    }
    session = next;
  }

  done();

  const outcome = streamOutcome(session, wanted);
  if (outcome.kind === "error") {
    // Already worded for a human by the core, which reuses the TUI's strings.
    fx.notice(outcome.message);
    fx.stop(sessionId);
    return;
  }
  if (outcome.kind === "empty") {
    fx.notice("There is nothing playable in that torrent.");
    fx.stop(sessionId);
    return;
  }
  if (outcome.kind === "single") {
    fx.open(playerPath(sessionId, outcome.file, capability));
    return;
  }
  fx.choose(sessionId, capability, row.name, outcome.files, outcome.preselect);
}
