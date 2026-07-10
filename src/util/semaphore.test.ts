import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Semaphore } from "./semaphore";

// Semaphore itself uses no timers; the one yield below just proves queued
// waiters stay parked. Drive it with fake timers so it never leans on real
// wall-clock scheduling.
const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("Semaphore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("admits up to the limit immediately", async () => {
    const s = new Semaphore(2);
    await s.acquire();
    await s.acquire();
    expect(s.available).toBe(0);
  });

  it("queues waiters past the limit and resumes them FIFO on release", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const order: string[] = [];
    const a = s.acquire().then(() => order.push("a"));
    const b = s.acquire().then(() => order.push("b"));
    await tick();
    expect(order).toEqual([]);
    s.release();
    await a;
    expect(order).toEqual(["a"]);
    s.release();
    await b;
    expect(order).toEqual(["a", "b"]);
  });

  it("frees a slot on release when nobody is waiting", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    expect(s.available).toBe(0);
    s.release();
    expect(s.available).toBe(1);
  });
});
