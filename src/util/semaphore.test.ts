import { describe, it, expect } from "vitest";
import { Semaphore } from "./semaphore";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("Semaphore", () => {
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
