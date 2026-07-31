// Remembers whether a provider's HLS manifest was worth offering, so reloading a
// player page does not pull another probe segment through this machine.
//
// Same shape and same reasoning as ProbeCache — bounded rather than tied to
// session lifetime, because a bound needs no teardown hook and a stale entry for
// a dead session is harmless while session ids are never reused.
//
// The value is the verdict, so `undefined` (never asked) stays distinguishable
// from `false` (asked, and the answer was no). A single boolean field could not
// express that, and re-probing every load would defeat the point.

const DEFAULT_MAX = 64;

export class HlsVerdictCache {
  private readonly entries = new Map<string, boolean>();

  constructor(private readonly max: number = DEFAULT_MAX) {}

  // JSON-encoded rather than `${sid}:${index}`: a session id containing the
  // separator would otherwise collide with a different (sid, index) pair.
  private key(sid: string, index: number): string {
    return JSON.stringify([sid, index]);
  }

  get(sid: string, index: number): boolean | undefined {
    return this.entries.get(this.key(sid, index));
  }

  set(sid: string, index: number, usable: boolean): void {
    const key = this.key(sid, index);
    // Delete first so a re-set moves the entry to the end of the insertion order
    // rather than leaving it where it was — otherwise the most recently written
    // entry could be the next one evicted.
    this.entries.delete(key);
    this.entries.set(key, usable);
    // Map iterates in insertion order, so the first key is the oldest.
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
