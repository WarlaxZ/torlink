// What a user waiting for a stream to resolve reads, for both front ends.
//
// This lived inline in src/ui/App.tsx's render (a three-armed ternary in a
// <Spinner label>) until the browser needed the same line. It moved down here
// rather than being written a second time: this codebase records four bugs
// caused by copy-then-drift — a byte formatter, an uploadSpeed field, a
// progress unit, an API path table — and a waiting line the two front ends
// disagree about is the same bug in a place the user is staring at for minutes.
//
// IMPORTS NOTHING, and must keep importing nothing: it is pulled into
// src/web/static's browser bundle (platform: "browser" in tsup.web.config.ts),
// where a transitive `node:*` fails the build. That is also why it is its own
// module rather than a function in a larger util.
//
// The affordance is NOT part of the line. The terminal appends
// "  (esc cancels)" and the browser puts a Cancel button next to it — a
// keybinding hint is CLAUDE.md's "a surface can't express it", and it is the
// only thing about this line that differs between the two.

export interface PrepareFacts {
  /**
   * Which network is resolving this. Spelled "rd" rather than "debrid" because
   * these field names are the TUI's `preparing` state verbatim, so its call
   * site is a spread and cannot silently mismatch. The browser's wire form is
   * `PublicStreamSession.backend`, which spells the same thing "debrid" — the
   * one mapping between them lives in streamFlow.ts's pollDecision.
   */
  source: "rd" | "torrent";
  /** Ignored when `source` is "torrent", which has no link-fetch step. */
  phase: "caching" | "fetching";
  /** Only meaningful when caching on debrid. Absent falls back to "debrid". */
  providerLabel?: string | null;
  /** The release name, already shortened by the caller. */
  label: string;
  /** Integer percent, 0-100. Clamped here rather than by callers. */
  pct: number;
  elapsedSec: number;
}

/**
 * The waiting line, without any affordance appended.
 *
 * The elapsed seconds are load-bearing, not decoration: a Real-Debrid cache
 * sits at one percent for minutes at a time, and a number that moves is the
 * whole difference between "working" and "hung".
 */
export function prepareLine(facts: PrepareFacts): string {
  const secs = `${whole(facts.elapsedSec)}s`;
  if (facts.source === "torrent") return `Finding peers… ${facts.label} · ${secs}`;
  if (facts.phase === "fetching") return `Fetching link… ${secs}`;
  const who = facts.providerLabel ?? "debrid";
  return `Caching on ${who}… ${Math.min(100, whole(facts.pct))}% · ${secs}`;
}

// Defended against a backend reporting something outside its documented range,
// and against a NaN — `Math.floor(NaN)` is NaN, which would render the word
// "NaN" at the user. Floors rather than rounds: see dashboard.ts's same rule.
//
// No upper bound here, because only one of the two callers has one: a percent
// caps at 100, an elapsed count does not. The cap is applied at the one call
// site that needs it rather than passed in, so nothing has to encode "no
// ceiling" as a magic number.
function whole(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
