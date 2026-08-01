import { describe, expect, it } from "vitest";
import { abortableSleep } from "./abortableSleep";

describe("abortableSleep", () => {
  it("resolves after the delay when nothing aborts", async () => {
    const began = Date.now();
    await abortableSleep(20);
    expect(Date.now() - began).toBeGreaterThanOrEqual(15);
  });

  it("works with no signal at all", async () => {
    await expect(abortableSleep(1)).resolves.toBeUndefined();
  });

  // The whole reason this exists. A sleep that ran its full POLL_MS would leave
  // Cancel looking inert for the rest of the second.
  it("gives up as soon as the signal aborts, long before the delay", async () => {
    const ac = new AbortController();
    const began = Date.now();
    const waited = abortableSleep(5_000, ac.signal);
    ac.abort();
    await waited;
    expect(Date.now() - began).toBeLessThan(200);
  });

  // A cancel can land between two polls, so the next sleep starts life aborted.
  it("returns immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const began = Date.now();
    await abortableSleep(5_000, ac.signal);
    expect(Date.now() - began).toBeLessThan(200);
  });

  it("resolves, never rejects — the caller's next line is an abort check", async () => {
    const ac = new AbortController();
    const waited = abortableSleep(5_000, ac.signal);
    ac.abort();
    await expect(waited).resolves.toBeUndefined();
  });

  // Left attached, the listener keeps this closure and its timer reachable for as
  // long as the signal is — for a long-lived controller, until the tab closes.
  it("removes its abort listener once the delay has elapsed", async () => {
    const ac = new AbortController();
    let removed = 0;
    const realRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.removeEventListener = (...args: Parameters<typeof realRemove>) => {
      removed++;
      return realRemove(...args);
    };
    await abortableSleep(5, ac.signal);
    expect(removed).toBe(1);
  });

  // The abort path relies on `{ once: true }` rather than an explicit removal, so
  // this pins that the listener really is gone: a second abort must not fire it.
  it("does not fire its listener twice when the signal aborts repeatedly", async () => {
    const ac = new AbortController();
    let resolutions = 0;
    const waited = abortableSleep(5_000, ac.signal).then(() => resolutions++);
    ac.abort();
    ac.abort();
    await waited;
    expect(resolutions).toBe(1);
  });
});
