import { describe, it, expect, vi } from "vitest";
import { chunkNetflixCsv, formatImportSummary, uploadNetflixCsv } from "./netflixImport.js";
import type { FetchImpl } from "../util/net";

const HEADER = "Title,Date";

describe("chunkNetflixCsv", () => {
  it("returns one chunk containing the header and all rows when under budget", () => {
    const csv = `${HEADER}\nThe Matrix,1/2/20\nHeat,3/4/21`;
    const chunks = chunkNetflixCsv(csv);
    expect(chunks).toEqual([`${HEADER}\nThe Matrix,1/2/20\nHeat,3/4/21`]);
  });

  it("returns [] when there are no data rows", () => {
    expect(chunkNetflixCsv(HEADER)).toEqual([]);
    expect(chunkNetflixCsv(`${HEADER}\n`)).toEqual([]);
  });

  it("skips blank data lines", () => {
    const csv = `${HEADER}\nThe Matrix,1/2/20\n\n\nHeat,3/4/21\n`;
    expect(chunkNetflixCsv(csv)).toEqual([`${HEADER}\nThe Matrix,1/2/20\nHeat,3/4/21`]);
  });

  it("splits into multiple chunks that each re-include the header, honoring the byte budget", () => {
    const rows = ["A,1/1/20", "B,2/2/20", "C,3/3/20", "D,4/4/20"];
    const csv = `${HEADER}\n${rows.join("\n")}`;
    const budget = 30;
    const chunks = chunkNetflixCsv(csv, budget);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.startsWith(`${HEADER}\n`)).toBe(true);
      // Every chunk (no oversized rows here) stays within the byte budget.
      expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(budget);
    }
    const seen = chunks.flatMap((c) => c.split("\n").slice(1));
    expect(seen.sort()).toEqual([...rows].sort());
  });

  it("emits an over-budget row as its own single chunk rather than dropping it", () => {
    const big = `${"X".repeat(100)},1/1/20`;
    const csv = `${HEADER}\nsmall,1/1/20\n${big}`;
    const chunks = chunkNetflixCsv(csv, 30);
    // The oversized row lands in a chunk by itself (header + that one row only).
    expect(chunks).toContain(`${HEADER}\n${big}`);
  });

  it("tolerates CRLF line endings", () => {
    const csv = `${HEADER}\r\nThe Matrix,1/2/20\r\nHeat,3/4/21\r\n`;
    expect(chunkNetflixCsv(csv)).toEqual([`${HEADER}\nThe Matrix,1/2/20\nHeat,3/4/21`]);
  });
});

describe("formatImportSummary", () => {
  it("renders imported, matched and unmatched counts", () => {
    expect(
      formatImportSummary({ imported: 342, resolved: 128, unresolved: 214, unresolvedTitles: [], chunks: 1 }),
    ).toBe("Imported 342 · 128 matched · 214 unmatched");
  });
});

function jsonRes(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CONFIG = { reccUrl: "http://host:4100", reccToken: "tok" };
const CSV = "Title,Date\nThe Matrix,1/2/20\nHeat,3/4/21";

describe("uploadNetflixCsv", () => {
  it("POSTs multipart to /import/netflix with a bearer token and returns the aggregated result", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes(202, { imported: 2, resolved: 1, unresolved: 1, unresolvedTitles: ["Heat"] }));
    const outcome = await uploadNetflixCsv(CONFIG, CSV, { fetchImpl: fetchImpl as unknown as FetchImpl });

    expect(outcome).toEqual({
      ok: true,
      result: { imported: 2, resolved: 1, unresolved: 1, unresolvedTitles: ["Heat"], chunks: 1 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: FormData }];
    expect(url).toBe("http://host:4100/import/netflix");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(init.body).toBeInstanceOf(FormData);
    const file = init.body.get("file") as Blob;
    expect(await file.text()).toContain("Title,Date");
  });

  it("aggregates counts and de-duplicates unresolved titles across chunks", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(202, { imported: 1, resolved: 1, unresolved: 1, unresolvedTitles: ["Heat"] }))
      .mockResolvedValueOnce(jsonRes(202, { imported: 1, resolved: 0, unresolved: 2, unresolvedTitles: ["Heat", "Dune"] }));
    const outcome = await uploadNetflixCsv(CONFIG, CSV, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      budgetBytes: 25,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.imported).toBe(2);
      expect(outcome.result.unresolved).toBe(3);
      expect(outcome.result.unresolvedTitles).toEqual(["Heat", "Dune"]);
      expect(outcome.result.chunks).toBe(2);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("coerces stringy numeric fields and ignores non-string titles from the response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes(202, { imported: "2", resolved: "1", unresolved: "1", unresolvedTitles: ["Heat", 42] }));
    const outcome = await uploadNetflixCsv(CONFIG, CSV, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.imported).toBe(2);
      expect(outcome.result.resolved).toBe(1);
      expect(outcome.result.unresolvedTitles).toEqual(["Heat"]);
    }
  });

  it("reports progress per chunk", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(202, { imported: 1, resolved: 1, unresolved: 0, unresolvedTitles: [] }));
    const seen: Array<[number, number]> = [];
    await uploadNetflixCsv(CONFIG, CSV, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      budgetBytes: 25,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([[1, 2], [2, 2]]);
  });

  it("returns a not-linked error when reccUrl is missing", async () => {
    const outcome = await uploadNetflixCsv({ reccToken: "t" }, CSV);
    expect(outcome).toEqual({ ok: false, error: "reccd is not linked — set it up in Accounts first" });
  });

  it("returns a no-rows error for a header-only CSV", async () => {
    const fetchImpl = vi.fn();
    const outcome = await uploadNetflixCsv(CONFIG, "Title,Date", { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome).toEqual({ ok: false, error: "no rows found in the CSV" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 401 to a token error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(401, { error: "unauthorized" }));
    const outcome = await uploadNetflixCsv(CONFIG, CSV, { fetchImpl: fetchImpl as unknown as FetchImpl });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("reccd rejected the token — check reccToken");
  });

  it("reports which chunk failed and includes the partial result so far", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(202, { imported: 1, resolved: 1, unresolved: 0, unresolvedTitles: [] }))
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    const outcome = await uploadNetflixCsv(CONFIG, CSV, {
      fetchImpl: fetchImpl as unknown as FetchImpl,
      budgetBytes: 25,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("chunk 2/2");
      expect(outcome.partial?.imported).toBe(1);
    }
  });
});
