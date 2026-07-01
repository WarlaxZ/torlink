import { describe, it, expect } from "vitest";
import { parseRetryAfter, backoffDelay, fetchResilient, HttpError } from "./net";

function fakeRes(status: number, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe("parseRetryAfter", () => {
  it("parses delta-seconds and rejects garbage", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
  it("parses an HTTP date relative to now", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(5_000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });
});

describe("backoffDelay", () => {
  it("applies jitter and honors retry-after as a floor", () => {
    expect(backoffDelay(0, 500, 20000, undefined, () => 0.5)).toBe(250);
    expect(backoffDelay(2, 500, 20000, undefined, () => 0)).toBe(0);
    expect(backoffDelay(0, 500, 20000, 1000, () => 0.5)).toBe(1000);
  });
});

describe("fetchResilient", () => {
  const opts = { sleepImpl: async () => {}, baseMs: 1, capMs: 1 };

  it("retries a 503 then returns the success response", async () => {
    let calls = 0;
    const res = await fetchResilient("http://x", {
      ...opts,
      retries: 3,
      fetchImpl: async () => (++calls === 1 ? fakeRes(503) : fakeRes(200)),
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("throws after exhausting retries", async () => {
    await expect(
      fetchResilient("http://x", { ...opts, retries: 2, fetchImpl: async () => fakeRes(503) }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      fetchResilient("http://x", { ...opts, signal: ctrl.signal, fetchImpl: async () => fakeRes(200) }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("does not retry a non-retryable status", async () => {
    let calls = 0;
    const res = await fetchResilient("http://x", {
      ...opts,
      fetchImpl: async () => (++calls, fakeRes(404)),
    });
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("throws immediately on a Cloudflare 503 by default (scraper protection)", async () => {
    let calls = 0;
    await expect(
      fetchResilient("http://x", {
        ...opts,
        retries: 3,
        fetchImpl: async () => (++calls, fakeRes(503, { server: "cloudflare" })),
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1); // no retries — thrown on the first hit
  });

  it("retries a Cloudflare 503 when retryCdn503 is set, instead of throwing", async () => {
    let calls = 0;
    const res = await fetchResilient("http://x", {
      ...opts,
      retries: 3,
      retryCdn503: true,
      fetchImpl: async () => (++calls === 1 ? fakeRes(503, { server: "cloudflare" }) : fakeRes(200)),
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("reports each retryable response to onAttempt (retry then success)", async () => {
    let n = 0;
    const seen: Array<{ status: number; attempt: number; willRetry: boolean; retryAfterMs?: number }> = [];
    const res = await fetchResilient("http://x", {
      ...opts,
      retries: 3,
      onAttempt: (i) => seen.push({ status: i.status, attempt: i.attempt, willRetry: i.willRetry, retryAfterMs: i.retryAfterMs }),
      fetchImpl: async () => (++n === 1 ? fakeRes(503, { "retry-after": "2" }) : fakeRes(200)),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ status: 503, attempt: 0, willRetry: true, retryAfterMs: 2000 }]);
  });

  it("reports the final give-up to onAttempt with willRetry=false", async () => {
    const seen: boolean[] = [];
    await expect(
      fetchResilient("http://x", {
        ...opts,
        retries: 1,
        onAttempt: (i) => seen.push(i.willRetry),
        fetchImpl: async () => fakeRes(503),
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(seen).toEqual([true, false]);
  });

  it("does not call onAttempt on a first-try success", async () => {
    let called = false;
    await fetchResilient("http://x", {
      ...opts,
      onAttempt: () => (called = true),
      fetchImpl: async () => fakeRes(200),
    });
    expect(called).toBe(false);
  });

  it("floors the backoff at minBackoffMs when there is no Retry-After", async () => {
    const delays: number[] = [];
    let n = 0;
    await fetchResilient("http://x", {
      baseMs: 1,
      capMs: 1,
      retries: 3,
      minBackoffMs: 1000,
      sleepImpl: async (ms: number) => {
        delays.push(ms);
      },
      fetchImpl: async () => (++n === 1 ? fakeRes(503) : fakeRes(200)),
    });
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
  });

  it("honors a Retry-After larger than minBackoffMs", async () => {
    const delays: number[] = [];
    let n = 0;
    await fetchResilient("http://x", {
      baseMs: 1,
      capMs: 1,
      retries: 3,
      minBackoffMs: 1000,
      sleepImpl: async (ms: number) => {
        delays.push(ms);
      },
      fetchImpl: async () => (++n === 1 ? fakeRes(503, { "retry-after": "5" }) : fakeRes(200)),
    });
    expect(delays[0]).toBeGreaterThanOrEqual(5000);
  });

  it("without minBackoffMs the backoff can be below a second (unchanged default)", async () => {
    const delays: number[] = [];
    let n = 0;
    await fetchResilient("http://x", {
      baseMs: 1,
      capMs: 1,
      retries: 3,
      sleepImpl: async (ms: number) => {
        delays.push(ms);
      },
      fetchImpl: async () => (++n === 1 ? fakeRes(503) : fakeRes(200)),
    });
    expect(delays[0]).toBeLessThan(1000);
  });

  // A response-like object that exposes a body via text().
  function bodyRes(status: number, body: string): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => body,
    } as unknown as Response;
  }

  it("passes the response body snippet to onAttempt only on give-up", async () => {
    const seen: Array<{ willRetry: boolean; bodySnippet?: string }> = [];
    await expect(
      fetchResilient("http://x", {
        ...opts,
        retries: 1,
        onAttempt: (i) => seen.push({ willRetry: i.willRetry, bodySnippet: i.bodySnippet }),
        fetchImpl: async () => bodyRes(503, '{"error":"fair_usage_limit","error_code":35}'),
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ willRetry: true, bodySnippet: undefined });
    expect(seen[1]!.willRetry).toBe(false);
    expect(seen[1]!.bodySnippet).toContain("fair_usage_limit");
  });

  it("truncates the body snippet to 200 chars", async () => {
    let snippet: string | undefined;
    await expect(
      fetchResilient("http://x", {
        ...opts,
        retries: 0,
        onAttempt: (i) => {
          if (!i.willRetry) snippet = i.bodySnippet;
        },
        fetchImpl: async () => bodyRes(503, "x".repeat(500)),
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(snippet).toHaveLength(200);
  });

  it("yields undefined bodySnippet when the body read fails (best-effort)", async () => {
    let snippet: string | undefined = "sentinel";
    await expect(
      fetchResilient("http://x", {
        ...opts,
        retries: 0,
        onAttempt: (i) => {
          if (!i.willRetry) snippet = i.bodySnippet;
        },
        fetchImpl: async () =>
          ({
            status: 503,
            ok: false,
            headers: { get: () => null },
            text: async () => {
              throw new Error("boom");
            },
          }) as unknown as Response,
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(snippet).toBeUndefined();
  });
});
