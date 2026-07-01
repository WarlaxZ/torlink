import { describe, it, expect } from "vitest";
import {
  validateToken,
  resolveMagnet,
  addMagnet,
  findTorrentByHash,
  isPremiumActive,
  RealDebridError,
  messageForTorrentStatus,
  messageForErrorSlug,
  type RealDebridFetch,
} from "./realdebrid";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonRes(status: number, obj: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  } as unknown as Response;
}

function emptyRes(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => "",
  } as unknown as Response;
}

// Build a fetch mock that routes by method + path and records every call.
function router(routes: (call: Call) => Response, calls: Call[] = []): RealDebridFetch {
  return async (url, init = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url,
      method: (init.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return routes(call);
  };
}

const noSleep = async (): Promise<void> => {};

describe("validateToken", () => {
  it("returns the username on success", async () => {
    const fetchImpl = router(() => jsonRes(200, { username: "ada", email: "a@b.c" }));
    await expect(validateToken("tok", { fetchImpl })).resolves.toMatchObject({ username: "ada" });
  });

  it("throws a RealDebridError on 401", async () => {
    const fetchImpl = router(() => jsonRes(401, { error: "bad_token", error_code: 8 }));
    await expect(validateToken("tok", { fetchImpl })).rejects.toBeInstanceOf(RealDebridError);
  });

  it("sends the bearer token", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(() => jsonRes(200, { username: "ada" }), calls);
    await validateToken("my-token", { fetchImpl });
    expect(calls[0]?.url).toContain("/user");
    expect(calls[0]?.headers.Authorization).toBe("Bearer my-token");
  });
});

describe("isPremiumActive", () => {
  it("is true only for a premium account with time remaining", () => {
    expect(isPremiumActive({ username: "a", type: "premium", premium: 86400 })).toBe(true);
    expect(isPremiumActive({ username: "a", type: "premium", premium: 0 })).toBe(false);
    expect(isPremiumActive({ username: "a", type: "free", premium: 0 })).toBe(false);
    expect(isPremiumActive({ username: "a" })).toBe(false);
  });
});

describe("addMagnet", () => {
  it("does not retry a transient 5xx (so it can't create duplicates)", async () => {
    let calls = 0;
    const fetchImpl = router(() => {
      calls++;
      return jsonRes(503, { error: "service_unavailable" });
    });
    await expect(
      addMagnet("tok", "magnet:?xt=urn:btih:abc", { fetchImpl, sleepImpl: noSleep }),
    ).rejects.toBeInstanceOf(RealDebridError);
    expect(calls).toBe(1);
  });
});

describe("findTorrentByHash", () => {
  it("pages past a full first page to find a later match", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `p1-${i}`,
      hash: `0000${i}`,
      status: "downloaded",
    }));
    const fetchImpl = router((c) => {
      const page = new URLSearchParams(c.url.split("?")[1] ?? "").get("page");
      if (page === "1") return jsonRes(200, page1);
      if (page === "2") return jsonRes(200, [{ id: "MATCH", hash: "deadbeef", status: "downloaded" }]);
      return jsonRes(200, []);
    });
    const hit = await findTorrentByHash("tok", "DEADBEEF", { fetchImpl });
    expect(hit?.id).toBe("MATCH");
  });

  it("stops at the end of the list (short page) and returns undefined when absent", async () => {
    let pages = 0;
    const fetchImpl = router(() => {
      pages++;
      return jsonRes(200, [{ id: "x", hash: "ffff", status: "downloaded" }]); // 1 item < limit
    });
    const hit = await findTorrentByHash("tok", "aaaa", { fetchImpl });
    expect(hit).toBeUndefined();
    expect(pages).toBe(1); // short first page => no further paging
  });
});

describe("resolveMagnet", () => {
  function happyRoutes(): (c: Call) => Response {
    let infoCalls = 0;
    return (c) => {
      if (c.method === "POST" && c.url.includes("/torrents/addMagnet")) {
        return jsonRes(201, { id: "T1", uri: "rd://T1" });
      }
      if (c.method === "POST" && c.url.includes("/torrents/selectFiles/T1")) {
        return emptyRes(204);
      }
      if (c.method === "GET" && c.url.includes("/torrents/info/T1")) {
        infoCalls++;
        if (infoCalls < 2) {
          return jsonRes(200, { status: "downloading", progress: 40, links: [] });
        }
        return jsonRes(200, {
          status: "downloaded",
          progress: 100,
          links: ["https://rd/link1", "https://rd/link2"],
        });
      }
      if (c.method === "POST" && c.url.includes("/unrestrict/link")) {
        const link = new URLSearchParams(c.body ?? "").get("link");
        const n = link === "https://rd/link1" ? 1 : 2;
        return jsonRes(200, {
          download: `https://dl/file${n}`,
          filename: `file${n}.mkv`,
          filesize: n * 100,
        });
      }
      throw new Error(`unexpected call ${c.method} ${c.url}`);
    };
  }

  it("runs addMagnet -> selectFiles -> poll -> unrestrict and returns files", async () => {
    const progress: number[] = [];
    const files = await resolveMagnet("tok", "magnet:?xt=urn:btih:abc", {
      fetchImpl: router(happyRoutes()),
      sleepImpl: noSleep,
      onProgress: (p) => progress.push(p),
    });
    expect(files).toEqual([
      { url: "https://dl/file1", filename: "file1.mkv", bytes: 100 },
      { url: "https://dl/file2", filename: "file2.mkv", bytes: 200 },
    ]);
    expect(progress).toContain(40);
    expect(progress.at(-1)).toBe(100);
  });

  it("selects all files and sends the magnet as a form body", async () => {
    const calls: Call[] = [];
    await resolveMagnet("tok", "magnet:?xt=urn:btih:abc", {
      fetchImpl: router(happyRoutes(), calls),
      sleepImpl: noSleep,
    });
    const add = calls.find((c) => c.url.includes("/torrents/addMagnet"));
    expect(new URLSearchParams(add?.body ?? "").get("magnet")).toBe("magnet:?xt=urn:btih:abc");
    const select = calls.find((c) => c.url.includes("/torrents/selectFiles"));
    expect(new URLSearchParams(select?.body ?? "").get("files")).toBe("all");
  });

  it("throws a RealDebridError when the torrent enters an error status", async () => {
    const fetchImpl = router((c) => {
      if (c.url.includes("/torrents/addMagnet")) return jsonRes(201, { id: "T1" });
      if (c.url.includes("/torrents/selectFiles")) return emptyRes(204);
      if (c.url.includes("/torrents/info")) return jsonRes(200, { status: "magnet_error", progress: 0, links: [] });
      throw new Error("unexpected");
    });
    await expect(
      resolveMagnet("tok", "magnet:?xt=urn:btih:abc", { fetchImpl, sleepImpl: noSleep }),
    ).rejects.toBeInstanceOf(RealDebridError);
  });

  it("reuses an already-downloaded torrent from the pool instead of adding it", async () => {
    const calls: Call[] = [];
    const fetchImpl = router((c) => {
      if (c.method === "GET" && c.url.includes("/torrents?")) {
        return jsonRes(200, [{ id: "OLD", hash: "AABBCCDD", status: "downloaded" }]);
      }
      if (c.method === "GET" && c.url.includes("/torrents/info/OLD")) {
        return jsonRes(200, { status: "downloaded", progress: 100, links: ["https://rd/cached"] });
      }
      if (c.method === "POST" && c.url.includes("/unrestrict/link")) {
        return jsonRes(200, { download: "https://dl/cached", filename: "cached.mkv", filesize: 5 });
      }
      throw new Error(`unexpected call ${c.method} ${c.url}`);
    }, calls);

    const files = await resolveMagnet("tok", "magnet:?xt=urn:btih:aabbccdd", {
      fetchImpl,
      sleepImpl: noSleep,
      knownHash: "aabbccdd",
    });

    expect(files).toEqual([{ url: "https://dl/cached", filename: "cached.mkv", bytes: 5 }]);
    expect(calls.some((c) => c.url.includes("/torrents/addMagnet"))).toBe(false);
  });

  it("selects files on a reused torrent still awaiting selection", async () => {
    const calls: Call[] = [];
    let infoCalls = 0;
    const fetchImpl = router((c) => {
      if (c.method === "GET" && c.url.includes("/torrents?")) {
        return jsonRes(200, [{ id: "OLD", hash: "aabbccdd", status: "waiting_files_selection" }]);
      }
      if (c.method === "POST" && c.url.includes("/torrents/selectFiles/OLD")) return emptyRes(204);
      if (c.method === "GET" && c.url.includes("/torrents/info/OLD")) {
        infoCalls++;
        return infoCalls < 2
          ? jsonRes(200, { status: "downloading", progress: 10, links: [] })
          : jsonRes(200, { status: "downloaded", progress: 100, links: ["https://rd/x"] });
      }
      if (c.method === "POST" && c.url.includes("/unrestrict/link")) {
        return jsonRes(200, { download: "https://dl/x", filename: "x.mkv", filesize: 1 });
      }
      throw new Error(`unexpected ${c.method} ${c.url}`);
    }, calls);

    const files = await resolveMagnet("tok", "magnet:?xt=urn:btih:aabbccdd", {
      fetchImpl,
      sleepImpl: noSleep,
      knownHash: "aabbccdd",
    });
    expect(files).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("/torrents/addMagnet"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/torrents/selectFiles/OLD"))).toBe(true);
  });

  it("selects files later when a reused torrent only reaches selection after converting", async () => {
    const calls: Call[] = [];
    let infoCalls = 0;
    const fetchImpl = router((c) => {
      if (c.method === "GET" && c.url.includes("/torrents?")) {
        // Reused torrent is still converting — not yet at file selection.
        return jsonRes(200, [{ id: "OLD", hash: "aabbccdd", status: "magnet_conversion" }]);
      }
      if (c.method === "POST" && c.url.includes("/torrents/selectFiles/OLD")) return emptyRes(204);
      if (c.method === "GET" && c.url.includes("/torrents/info/OLD")) {
        infoCalls++;
        if (infoCalls === 1) return jsonRes(200, { status: "magnet_conversion", progress: 0, links: [] });
        if (infoCalls === 2) return jsonRes(200, { status: "waiting_files_selection", progress: 0, links: [] });
        return jsonRes(200, { status: "downloaded", progress: 100, links: ["https://rd/late"] });
      }
      if (c.method === "POST" && c.url.includes("/unrestrict/link")) {
        return jsonRes(200, { download: "https://dl/late", filename: "late.mkv", filesize: 3 });
      }
      throw new Error(`unexpected ${c.method} ${c.url}`);
    }, calls);

    const files = await resolveMagnet("tok", "magnet:?xt=urn:btih:aabbccdd", {
      fetchImpl,
      sleepImpl: noSleep,
      knownHash: "aabbccdd",
    });

    expect(files).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("/torrents/addMagnet"))).toBe(false);
    // Selected exactly once, only after it reached waiting_files_selection.
    expect(calls.filter((c) => c.url.includes("/torrents/selectFiles/OLD"))).toHaveLength(1);
  });

  it("falls back to addMagnet when no pooled torrent matches the hash", async () => {
    const calls: Call[] = [];
    const fetchImpl = router((c) => {
      if (c.method === "GET" && c.url.includes("/torrents?")) {
        return jsonRes(200, [{ id: "OTHER", hash: "ffffffff", status: "downloaded" }]);
      }
      if (c.method === "POST" && c.url.includes("/torrents/addMagnet")) return jsonRes(201, { id: "T1" });
      if (c.method === "POST" && c.url.includes("/torrents/selectFiles/T1")) return emptyRes(204);
      if (c.method === "GET" && c.url.includes("/torrents/info/T1")) {
        return jsonRes(200, { status: "downloaded", progress: 100, links: ["https://rd/new"] });
      }
      if (c.method === "POST" && c.url.includes("/unrestrict/link")) {
        return jsonRes(200, { download: "https://dl/new", filename: "new.mkv", filesize: 2 });
      }
      throw new Error(`unexpected ${c.method} ${c.url}`);
    }, calls);

    await resolveMagnet("tok", "magnet:?xt=urn:btih:aabbccdd", {
      fetchImpl,
      sleepImpl: noSleep,
      knownHash: "aabbccdd",
    });
    expect(calls.some((c) => c.url.includes("/torrents/addMagnet"))).toBe(true);
  });

  it("aborts cleanly when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchImpl = router(happyRoutes());
    await expect(
      resolveMagnet("tok", "magnet:?xt=urn:btih:abc", {
        fetchImpl,
        sleepImpl: noSleep,
        signal: ctrl.signal,
      }),
    ).rejects.toBeTruthy();
  });
});

describe("messageForTorrentStatus", () => {
  it("gives specific, terminal-sounding copy per status", () => {
    expect(messageForTorrentStatus("dead")).toBe("No seeders — Real-Debrid can't fetch this torrent.");
    expect(messageForTorrentStatus("magnet_error")).toBe(
      "Real-Debrid couldn't read this magnet (it may be invalid or removed).",
    );
    expect(messageForTorrentStatus("virus")).toBe("Real-Debrid flagged this torrent's contents.");
  });

  it("falls back for an unknown/error status", () => {
    expect(messageForTorrentStatus("error")).toBe("Real-Debrid couldn't process this torrent.");
    expect(messageForTorrentStatus("whatever")).toBe("Real-Debrid couldn't process this torrent.");
  });
});

describe("messageForErrorSlug", () => {
  it("maps known unavailable/removed slugs", () => {
    expect(messageForErrorSlug("infringing_file")).toBe(
      "This was removed from Real-Debrid (copyright claim).",
    );
    expect(messageForErrorSlug("hoster_unavailable")).toBe(
      "This is no longer available on Real-Debrid (it may have been removed).",
    );
    expect(messageForErrorSlug("file_unavailable")).toBe(
      "This is no longer available on Real-Debrid (it may have been removed).",
    );
  });

  it("maps rate-limit slugs", () => {
    expect(messageForErrorSlug("too_many_requests")).toBe(
      "Real-Debrid rate limit reached — wait a moment and retry.",
    );
  });

  it("returns null for unknown/missing slugs so the caller uses its generic message", () => {
    expect(messageForErrorSlug(undefined)).toBeNull();
    expect(messageForErrorSlug("some_unknown_code")).toBeNull();
  });

  it("matches no_longer_available as a substring", () => {
    expect(messageForErrorSlug("content_no_longer_available")).toBe(
      "This is no longer available on Real-Debrid (it may have been removed).",
    );
  });

  it("matches fair_usage as a substring for rate limiting", () => {
    expect(messageForErrorSlug("fair_usage_limit")).toBe(
      "Real-Debrid rate limit reached — wait a moment and retry.",
    );
  });

  it("does not misclassify hoster_temporarily_unavailable as permanently removed", () => {
    expect(messageForErrorSlug("hoster_temporarily_unavailable")).toBeNull();
  });
});
