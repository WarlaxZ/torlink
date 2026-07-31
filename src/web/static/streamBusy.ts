// Whether a Play control is busy, disabled, or neither — and the one gate that
// stops a second stream starting while the first is still resolving.
//
// Pure, and here rather than in app.ts for the reason every model in this
// directory is: there is no jsdom in this repo, so a conditional that lives in
// app.ts is a conditional no test can reach. "If you are writing a conditional
// in app.ts that decides what to show, it belongs in a pure module" — CLAUDE.md,
// and this has been caught in review twice.
//
// DERIVED, NEVER STORED ON THE ELEMENT. The queue's rows are rebuilt four times a
// second by the SSE tick, so a `disabled` set once in a click handler is gone by
// the next frame — which is precisely the bug this closes. app.ts re-applies this
// over the live DOM after every render.

export interface FlowState {
  /**
   * The row a prepare is running for, or null. `key` is the info hash — the same
   * `DashRow.id` that `runPlay` was handed, so the two cannot disagree about
   * which row is busy.
   */
  prepare: { key: string; title: string } | null;
  /**
   * The title a pickController search is running for, or null. A TITLE, not a
   * hash: a one-click Play on a recommendation has no torrent yet, which is
   * exactly what it is off finding.
   */
  picking: string | null;
}

export interface ControlState {
  disabled: boolean;
  /** Render `aria-busy` on this one. At most one control can be busy. */
  busy: boolean;
  label: string;
}

/** What the control that started the flow says while it waits. */
export const BUSY_LABEL = "preparing…";

/**
 * What one Play control should look like right now.
 *
 * The rule is the terminal's, made visible: ONE prepare or pick at a time
 * (`if (preparing || streamFiles || activeStream) return`, src/ui/App.tsx). The
 * browser had the same rule per-row and SILENTLY RETURNED when it fired, so a
 * button stayed lit and did nothing when pressed — which is how a user learns to
 * press it repeatedly, starting nothing each time. So every control that is not
 * the busy one is DISABLED, not merely ineligible.
 *
 * `idleLabel` is passed in rather than assumed because the six Play controls do
 * not share one word: "play", "Play", "Play next". Nothing here decides copy.
 */
export function controlState(flow: FlowState, key: string, idleLabel: string): ControlState {
  // The prepare wins when both are set: a pick that has found its release and
  // handed off is now a prepare, and the row doing the work is a truer answer
  // than the title that asked for it.
  const active = flow.prepare?.key ?? flow.picking;
  if (active === null || active === undefined) {
    return { disabled: false, busy: false, label: idleLabel };
  }
  // Two namespaces (info hashes, titles) and no comparison across them: a key
  // from the other one never matches, and disabled is the right answer for it
  // anyway, since nothing may start while this flow runs.
  if (active === key) return { disabled: true, busy: true, label: BUSY_LABEL };
  return { disabled: true, busy: false, label: idleLabel };
}

/**
 * Whether a new play or pick may start at all.
 *
 * The browser's guard was `playing.has(row.id)` — per-row, so two different rows
 * could resolve at once, each polling a session for up to ten minutes, sharing
 * one progress line that reported whichever wrote last.
 */
export function isBusy(flow: FlowState): boolean {
  return flow.prepare !== null || flow.picking !== null;
}
