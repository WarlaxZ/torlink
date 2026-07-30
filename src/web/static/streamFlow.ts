// Pure decision logic for "press Play on a dashboard row". Separate from the
// DOM binding in app.ts for the same reason dashboard.ts and playerModel.ts are:
// there is no headless-browser test environment in this repo and adding one for
// this would be disproportionate, so everything with a decision in it lives
// here, where a plain unit test can reach it, and app.ts stays wiring.
//
// Bundled for the browser, so: no node:* imports, direct or transitive.
//
// TWO IMPORTS LEAVE THIS DIRECTORY. `../wire` is types-only and erased at build
// time, as in dashboard.ts. `../../util/videoFiles` is a *value* import and is
// deliberate: it is the video-first heuristic the TUI's file picker uses, and
// reimplementing it here would be the fourth instance of the copy-then-drift bug
// this codebase keeps hitting (uploadSpeed, the byte formatter, the progress
// unit). That module is dependency-free and stays that way — `platform:
// "browser"` in tsup.web.config.ts fails the build if it ever isn't.
import { streamCandidates } from "../../util/videoFiles";
// The second value import out of this directory, and the same argument: which
// file is the next episode is a decision both front ends make, so it is shared
// rather than copied. It pulls in `release.ts` (and so parse-torrent-title),
// which is why it is a module of its own and not part of videoFiles.ts.
import { nextEpisodeIndex } from "../../util/nextEpisodeFile";
import type { EpisodeRef } from "../../util/episode";
import type { PublicStreamFile, PublicStreamSession } from "../wire";
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
 * - `n` is the filename. It is the ONLY way the player page can learn it: a
 *   phone handed this link holds the capability but not the bearer token, so
 *   `GET /api/stream/:sid` is closed to it. Omit `n` and the page shows
 *   "Unnamed file" and — because `canDirectPlay("")` is pessimistic — the
 *   fallback card, even for an mp4 the browser would have played.
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
  const files = streamCandidates(session.files);
  if (files.length === 0) return { kind: "empty" };
  if (files.length === 1) return { kind: "single", file: files[0]! };
  return { kind: "choose", files, preselect: nextEpisodeIndex(files, { next }) };
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
    label: `Preparing “${label}” — ${resolvePercent(session)}%`,
  };
}

// The session's own percent, defended against a backend that reports something
// outside the documented 0–100 integer range. Same floor-don't-round rule as
// dashboard.ts: rounding 99.6 up to 100 on something that is still working
// reads as a stuck UI.
function resolvePercent(session: PublicStreamSession): number {
  const pct = session.progress;
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, Math.floor(pct)));
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
  /** POST /api/stream. `confirmed` is only ever true after a human said so. */
  start(row: DashRow, confirmed: boolean): Promise<StartResult>;
  /** GET /api/stream/:sid, or null when it can't be read. */
  poll(sessionId: string): Promise<PublicStreamSession | null>;
  /** DELETE /api/stream/:sid, best effort. */
  stop(sessionId: string): void;
  /** A blocking yes/no. window.confirm in the browser. */
  confirm(message: string): boolean;
  /** Transient message in the dashboard's notice line. */
  notice(message: string): void;
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
  sleep(ms: number): Promise<void>;
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
 *
 * `wanted` is data, not an effect, which is why it is a parameter rather than
 * another member of `PlayEffects`: it is the Continue-watching row's own `next`,
 * passed straight through to `streamOutcome`. Every other caller — a search
 * result, a queue row — has no such row and passes nothing. (Named `wanted`
 * rather than `next` only because the polling loop below already has a `next`.)
 */
export async function runPlay(
  row: DashRow,
  fx: PlayEffects,
  wanted?: EpisodeRef | null,
): Promise<void> {
  let start = await fx.start(row, false);

  if (start.kind === "confirm") {
    if (!fx.confirm(confirmFallbackMessage(start.reason, row.name))) {
      fx.notice("Playback cancelled — nothing was streamed.");
      return;
    }
    start = await fx.start(row, true);
    // A second 409 means the server didn't accept the confirmation. Do not loop
    // asking: one prompt per click.
    if (start.kind === "confirm") {
      fx.notice("Couldn't start that stream.");
      return;
    }
  }
  if (start.kind !== "started") {
    if (start.kind === "failed") fx.onUnresolved?.();
    return;
  }

  const { sessionId, capability } = start;
  let session = start.session;
  const began = fx.now();
  for (;;) {
    const decision = pollDecision(session, fx.now() - began, row.name);
    if (decision.kind === "settled") break;
    if (decision.kind === "timeout") {
      fx.notice(decision.message);
      fx.stop(sessionId);
      return;
    }
    fx.notice(decision.label);
    await fx.sleep(decision.delayMs);
    const next = await fx.poll(sessionId);
    if (!next) {
      // The session is gone or unreadable. Not stopped here: a DELETE we can't
      // read the answer to adds nothing, and the id may not exist at all.
      fx.notice("Lost track of that stream — try again.");
      return;
    }
    session = next;
  }

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
