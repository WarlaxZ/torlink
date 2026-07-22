import { describe, it, expect } from "vitest";
import { chunkNetflixCsv } from "./netflixImport.js";

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
    const chunks = chunkNetflixCsv(csv, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.startsWith(`${HEADER}\n`)).toBe(true);
    const seen = chunks.flatMap((c) => c.split("\n").slice(1));
    expect(seen.sort()).toEqual([...rows].sort());
  });

  it("emits an over-budget row as its own single chunk rather than dropping it", () => {
    const big = `${"X".repeat(100)},1/1/20`;
    const csv = `${HEADER}\nsmall,1/1/20\n${big}`;
    const chunks = chunkNetflixCsv(csv, 30);
    expect(chunks.some((c) => c.includes(big))).toBe(true);
  });

  it("tolerates CRLF line endings", () => {
    const csv = `${HEADER}\r\nThe Matrix,1/2/20\r\nHeat,3/4/21\r\n`;
    expect(chunkNetflixCsv(csv)).toEqual([`${HEADER}\nThe Matrix,1/2/20\nHeat,3/4/21`]);
  });
});

import { formatImportSummary } from "./netflixImport.js";

describe("formatImportSummary", () => {
  it("renders imported, matched and unmatched counts", () => {
    expect(
      formatImportSummary({ imported: 342, resolved: 128, unresolved: 214, unresolvedTitles: [], chunks: 1 }),
    ).toBe("Imported 342 · 128 matched · 214 unmatched");
  });
});
