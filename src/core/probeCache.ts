// Remembers what a probe found, so loading a player page twice does not spawn
// ffprobe twice against a CDN.
//
// Bounded rather than tied to session lifetime on purpose: a bound needs no
// teardown hook, and a stale entry for a dead session is harmless because the
// key includes the session id and ids are never reused.
import type { MediaFacts } from "../util/playability";

const DEFAULT_MAX = 64;

export class ProbeCache {
  private readonly entries = new Map<string, MediaFacts>();

  constructor(private readonly max: number = DEFAULT_MAX) {}

  // JSON-encoded rather than `${sid}:${index}`: a session id containing the
  // separator would otherwise collide with a different (sid, index) pair.
  private key(sid: string, index: number): string {
    return JSON.stringify([sid, index]);
  }

  get(sid: string, index: number): MediaFacts | undefined {
    return this.entries.get(this.key(sid, index));
  }

  set(sid: string, index: number, facts: MediaFacts): void {
    const key = this.key(sid, index);
    // Delete first so a re-set moves the entry to the end of the insertion
    // order rather than leaving it where it was — otherwise the most recently
    // written entry could be the next one evicted.
    this.entries.delete(key);
    this.entries.set(key, facts);
    // Map iterates in insertion order, so the first key is the oldest.
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
