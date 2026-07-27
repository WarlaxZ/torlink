import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatRate,
  mergeRows,
  rowsFromStatus,
  type DashRow,
  type StatusPayload,
} from "./dashboard";

const PAYLOAD: StatusPayload = {
  downloads: [
    { id: "a", name: "A Release", status: "downloading", progress: 0.5, peers: 4, speed: 1024 },
    { id: "b", name: "B Release", status: "queued", progress: 0, peers: 0, speed: 0 },
  ],
  seeds: [{ id: "c", name: "C Release", status: "seeding", peers: 2, uploaded: 2048 }],
};

describe("rowsFromStatus", () => {
  it("maps downloads and seeds into one display list", () => {
    const rows = rowsFromStatus(PAYLOAD);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0]).toEqual<DashRow>({
      id: "a",
      name: "A Release",
      kind: "download",
      status: "downloading",
      percent: 50,
      peers: 4,
      rate: 1024,
      uploaded: 0,
    });
    expect(rows[2]).toEqual<DashRow>({
      id: "c",
      name: "C Release",
      kind: "seed",
      status: "seeding",
      percent: 100,
      peers: 2,
      rate: 0,
      uploaded: 2048,
    });
  });

  it("clamps a progress value outside 0..1", () => {
    const rows = rowsFromStatus({
      downloads: [
        { id: "a", name: "A", status: "downloading", progress: 1.4, peers: 0, speed: 0 },
        { id: "b", name: "B", status: "downloading", progress: -1, peers: 0, speed: 0 },
      ],
      seeds: [],
    });
    expect(rows[0]!.percent).toBe(100);
    expect(rows[1]!.percent).toBe(0);
  });

  it("tolerates missing arrays", () => {
    expect(rowsFromStatus({} as StatusPayload)).toEqual([]);
  });
});

describe("mergeRows", () => {
  it("keeps the previous order for rows that persist", () => {
    const before = rowsFromStatus(PAYLOAD);
    const reordered = rowsFromStatus({
      downloads: [PAYLOAD.downloads[1]!, PAYLOAD.downloads[0]!],
      seeds: PAYLOAD.seeds,
    });
    expect(mergeRows(before, reordered).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("appends new rows at the end and drops removed ones", () => {
    const before = rowsFromStatus(PAYLOAD);
    const next = rowsFromStatus({
      downloads: [
        PAYLOAD.downloads[0]!,
        { id: "z", name: "Z", status: "queued", progress: 0, peers: 0, speed: 0 },
      ],
      seeds: [],
    });
    expect(mergeRows(before, next).map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("takes updated values from the new snapshot", () => {
    const before = rowsFromStatus(PAYLOAD);
    const next = rowsFromStatus({
      downloads: [{ ...PAYLOAD.downloads[0]!, progress: 0.9, speed: 4096 }],
      seeds: [],
    });
    const merged = mergeRows(before, next);
    expect(merged[0]).toMatchObject({ percent: 90, rate: 4096 });
  });
});

describe("rowsFromStatus edge cases", () => {
  it("treats a non-finite progress as 0 rather than NaN", () => {
    const rows = rowsFromStatus({
      downloads: [
        { id: "a", name: "A", status: "downloading", progress: Number.NaN, peers: 0, speed: 0 },
        {
          id: "b",
          name: "B",
          status: "downloading",
          progress: Number.POSITIVE_INFINITY,
          peers: 0,
          speed: 0,
        },
      ],
      seeds: [],
    });
    expect(rows[0]!.percent).toBe(0);
    expect(rows[1]!.percent).toBe(0);
  });

  it("rounds a fractional percent to nearest rather than truncating", () => {
    const rows = rowsFromStatus({
      downloads: [
        { id: "a", name: "A", status: "downloading", progress: 0.567, peers: 0, speed: 0 },
      ],
      seeds: [],
    });
    expect(rows[0]!.percent).toBe(57);
  });

  it("defaults missing numeric fields to 0", () => {
    const rows = rowsFromStatus({
      downloads: [{ id: "a", name: "A", status: "queued", progress: 0 }],
      seeds: [{ id: "c", name: "C", status: "seeding" }],
    } as unknown as StatusPayload);
    expect(rows[0]).toMatchObject({ peers: 0, rate: 0, uploaded: 0 });
    expect(rows[1]).toMatchObject({ peers: 0, rate: 0, uploaded: 0 });
  });
});

describe("formatBytes", () => {
  it("returns 0 B for zero, negative, and non-finite input", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("steps up to the next unit at exactly 1024", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("shows one decimal below 10 and whole numbers above it", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
  });

  it("stops at the largest known unit instead of running off the table", () => {
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
    expect(formatBytes(1024 ** 5)).toBe("1024 TB");
  });
});

describe("formatRate", () => {
  it("suffixes a positive rate with /s", () => {
    expect(formatRate(1024)).toBe("1.0 KB/s");
  });

  it("renders a dash for an idle rate", () => {
    expect(formatRate(0)).toBe("—");
    expect(formatRate(-1)).toBe("—");
  });
});
