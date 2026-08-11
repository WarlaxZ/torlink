import { describe, expect, it, vi } from "vitest";
import {
  PROBE_ORDINAL,
  SEGMENT_QUANTUM,
  looksTruncated,
  makeCheckHls,
  probeFetch,
  probeTarget,
  segmentUris,
} from "./hlsHealth";
import * as net from "../util/net";

// A media playlist in the shape Real-Debrid actually serves: no version tag, no
// stream-inf, relative segment names, ENDLIST at the bottom.
const manifest = (count: number): string => {
  const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXT-X-ALLOW-CACHE:YES", "#EXT-X-MEDIA-SEQUENCE:0"];
  for (let n = 0; n < count; n++) {
    lines.push("#EXTINF:5, nodesc", `${String(n).padStart(5, "0")}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
};

const MANIFEST_URL = "https://28.stream.example.test/t/ABCDEF/eng1/none/aac/full.m3u8";

describe("segmentUris", () => {
  it("returns the URI lines in order and nothing else", () => {
    expect(segmentUris(manifest(3))).toEqual(["00000.ts", "00001.ts", "00002.ts"]);
  });

  it("ignores comments, tags and blank lines", () => {
    const body = "#EXTM3U\n\n#EXT-X-TARGETDURATION:6\n#EXTINF:5,\n00000.ts\n   \n#EXT-X-ENDLIST\n";
    expect(segmentUris(body)).toEqual(["00000.ts"]);
  });

  it("survives CRLF, which some providers emit", () => {
    expect(segmentUris("#EXTM3U\r\n#EXTINF:5,\r\n00000.ts\r\n#EXT-X-ENDLIST\r\n")).toEqual(["00000.ts"]);
  });

  it("is empty for something that is not a playlist", () => {
    expect(segmentUris("")).toEqual([]);
    expect(segmentUris("#EXTM3U\n#EXT-X-ENDLIST\n")).toEqual([]);
  });
});

describe("looksTruncated", () => {
  // The measured signature: Real-Debrid flushes whatever the transcoder has
  // produced, rounded to a 256 KiB boundary. Genuine finished segments are
  // irregular sizes.
  it("flags an exact multiple of the 256 KiB quantum", () => {
    for (const n of [1, 2, 3, 4, 8, 10, 13]) {
      expect(looksTruncated(SEGMENT_QUANTUM * n)).toBe(true);
    }
  });

  it("passes the irregular sizes a finished segment actually has", () => {
    for (const n of [4639088, 3216116, 3135464, 5193124, 3390016]) {
      expect(looksTruncated(n)).toBe(false);
    }
  });

  // An empty body is a different failure and the caller reports it as one; it
  // must not be read as "an exact multiple of the quantum", which 0 is.
  it("does not call an empty body truncated", () => {
    expect(looksTruncated(0)).toBe(false);
  });
});

describe("probeTarget", () => {
  it("picks a segment past the transcoder's opening burst", () => {
    expect(probeTarget(MANIFEST_URL, manifest(704))).toBe(
      `https://28.stream.example.test/t/ABCDEF/eng1/none/aac/${String(PROBE_ORDINAL).padStart(5, "0")}.ts`,
    );
  });

  // A short file has no segment at the chosen ordinal. The last one is the best
  // available answer and is still past the burst on anything worth probing.
  it("falls back to the last segment of a short playlist", () => {
    expect(probeTarget(MANIFEST_URL, manifest(3))).toBe(
      "https://28.stream.example.test/t/ABCDEF/eng1/none/aac/00002.ts",
    );
  });

  it("is null when there is nothing to probe", () => {
    expect(probeTarget(MANIFEST_URL, "#EXTM3U\n#EXT-X-ENDLIST\n")).toBeNull();
  });

  // The segment name comes from a provider response, so it is not trusted to be
  // a bare filename. Anything that would leave the manifest's own directory —
  // or its host — is refused rather than fetched.
  it("refuses a segment URI that escapes the manifest's origin", () => {
    for (const bad of ["https://evil.test/x.ts", "//evil.test/x.ts", "http://28.stream.example.test/x.ts"]) {
      const body = `#EXTM3U\n#EXTINF:5,\n${bad}\n#EXT-X-ENDLIST\n`;
      expect(probeTarget(MANIFEST_URL, body)).toBeNull();
    }
  });

  it("refuses a segment URI that climbs out of the directory", () => {
    const body = "#EXTM3U\n#EXTINF:5,\n../../other/00000.ts\n#EXT-X-ENDLIST\n";
    expect(probeTarget(MANIFEST_URL, body)).toBeNull();
  });
});

describe("makeCheckHls", () => {
  const okSegment = { status: 200, bytes: 4639088 };

  const fetcher = (
    manifestBody: string | null,
    segment: { status: number; bytes: number } | "timeout" | null,
  ) =>
    vi.fn(async (url: string) => {
      if (url.endsWith(".m3u8")) {
        return manifestBody === null ? null : { status: 200, bytes: manifestBody.length, body: manifestBody };
      }
      if (segment === "timeout" || segment === null) return null;
      return { status: segment.status, bytes: segment.bytes, body: "" };
    });

  it("offers a manifest whose probe segment came back whole", async () => {
    const fetchImpl = fetcher(manifest(704), okSegment);
    await expect(makeCheckHls({ fetchImpl })(MANIFEST_URL)).resolves.toBe(true);
  });

  // The bug this exists for: the transcoder cannot sustain realtime, so it hands
  // over a partial segment as a complete 200 and the browser silently freezes.
  it("refuses a manifest whose probe segment came back truncated", async () => {
    const fetchImpl = fetcher(manifest(704), { status: 200, bytes: SEGMENT_QUANTUM * 4 });
    await expect(makeCheckHls({ fetchImpl })(MANIFEST_URL)).resolves.toBe(false);
  });

  it("refuses a manifest whose probe segment never arrived", async () => {
    const fetchImpl = fetcher(manifest(704), "timeout");
    await expect(makeCheckHls({ fetchImpl })(MANIFEST_URL)).resolves.toBe(false);
  });

  it("refuses a probe segment that answered with an error status", async () => {
    const fetchImpl = fetcher(manifest(704), { status: 404, bytes: 0 });
    await expect(makeCheckHls({ fetchImpl })(MANIFEST_URL)).resolves.toBe(false);
  });

  it("refuses an empty probe segment", async () => {
    const fetchImpl = fetcher(manifest(704), { status: 200, bytes: 0 });
    await expect(makeCheckHls({ fetchImpl })(MANIFEST_URL)).resolves.toBe(false);
  });

  it("refuses when the manifest itself cannot be read", async () => {
    await expect(makeCheckHls({ fetchImpl: fetcher(null, okSegment) })(MANIFEST_URL)).resolves.toBe(false);
  });

  it("refuses a manifest with no segments in it", async () => {
    const fetchImpl = fetcher("#EXTM3U\n#EXT-X-ENDLIST\n", okSegment);
    await expect(makeCheckHls({ fetchImpl })(MANIFEST_URL)).resolves.toBe(false);
  });

  // Never throws: every caller's next move for a "no" is the same, and an
  // exception escaping here would fail a whole `.info` request.
  it("answers false rather than throwing when the fetch blows up", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    await expect(makeCheckHls({ fetchImpl })(MANIFEST_URL)).resolves.toBe(false);
  });

  it("fetches the manifest and exactly one segment, and no more", async () => {
    const fetchImpl = fetcher(manifest(704), okSegment);
    await makeCheckHls({ fetchImpl })(MANIFEST_URL);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("probeFetch", () => {
  // The regression: probeFetch used the global `fetch`, so HLS health probes to
  // the provider CDN skipped the custom-DNS dispatcher every other request uses —
  // the same bug that made the poster cache unreachable on a custom-DNS box. The
  // production probe MUST go through torlinkFetch, and still read status + bytes
  // off the streamed body.
  it("fetches through torlink's DNS-aware fetch and reports status and byte count", async () => {
    const spy = vi
      .spyOn(net, "torlinkFetch")
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }));
    try {
      const res = await probeFetch("https://28.stream.example.test/seg.ts", 1000);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res).toEqual({ status: 200, bytes: 5, body: expect.any(String) });
    } finally {
      spy.mockRestore();
    }
  });
});
