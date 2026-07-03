import type { SourceId } from "./types";

// Tracks per-source failures so a source that's down (or blocked) stops being
// queried for a while, instead of stalling every search on its timeout. State
// is in-memory for the session; a cooldown lets a recovered source come back on
// its own. All the logic is pure over a caller-supplied map + clock so it's
// easy to test; the app shares one module-level map (`sourceHealth`).

export interface Health {
  fails: number;
  // Epoch ms until which the source is skipped; 0 means "not skipped".
  skipUntil: number;
}

// Consecutive failures before a source is benched.
export const FAIL_THRESHOLD = 3;
// How long to bench it before giving it another chance.
export const COOLDOWN_MS = 10 * 60 * 1000;

export function recordSuccess(map: Map<SourceId, Health>, id: SourceId): void {
  map.delete(id);
}

export function recordFailure(
  map: Map<SourceId, Health>,
  id: SourceId,
  now: number,
  threshold = FAIL_THRESHOLD,
  cooldownMs = COOLDOWN_MS,
): void {
  const h = map.get(id) ?? { fails: 0, skipUntil: 0 };
  h.fails += 1;
  if (h.fails >= threshold) h.skipUntil = now + cooldownMs;
  map.set(id, h);
}

// True while a source is benched. Once the cooldown lapses it returns false, so
// the source is retried once; a fresh failure re-benches it, a success clears it.
export function isSkipped(map: Map<SourceId, Health>, id: SourceId, now: number): boolean {
  const h = map.get(id);
  return !!h && h.skipUntil > now;
}

// The single map the running app shares across searches.
export const sourceHealth = new Map<SourceId, Health>();
