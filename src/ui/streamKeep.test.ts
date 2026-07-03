import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { keepMovePlan, moveKeptFiles, type KeepFsOps } from "./streamKeep";

describe("keepMovePlan", () => {
  it("moves the torrent's top-level folder from temp into downloads", () => {
    const plan = keepMovePlan({
      streamDir: "/tmp/torlink-stream-abc",
      torrentName: "Big Buck Bunny",
      downloadDir: "/home/u/Downloads",
    });
    expect(plan.from).toBe(path.join("/tmp/torlink-stream-abc", "Big Buck Bunny"));
    expect(plan.to).toBe(path.join("/home/u/Downloads", "Big Buck Bunny"));
  });
});

describe("moveKeptFiles", () => {
  const plan = { from: "/tmp/torlink-stream-abc/Movie", to: "/home/u/Downloads/Movie" };
  const downloadDir = "/home/u/Downloads";

  function makeFs(overrides: Partial<KeepFsOps> = {}): KeepFsOps {
    return {
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      cp: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("returns true when rename succeeds, without touching cp/rm", async () => {
    const fs = makeFs();
    const ok = await moveKeptFiles(plan, downloadDir, fs);
    expect(ok).toBe(true);
    expect(fs.rename).toHaveBeenCalledWith(plan.from, plan.to);
    expect(fs.cp).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it("falls back to copy+remove when rename fails across devices", async () => {
    const fs = makeFs({
      rename: vi.fn().mockRejectedValue(new Error("EXDEV")),
    });
    const ok = await moveKeptFiles(plan, downloadDir, fs);
    expect(ok).toBe(true);
    expect(fs.cp).toHaveBeenCalledWith(plan.from, plan.to, { recursive: true });
    expect(fs.rm).toHaveBeenCalledWith(plan.from, { recursive: true, force: true });
  });

  it("preserves the source and returns false when both rename and copy fail", async () => {
    const fs = makeFs({
      rename: vi.fn().mockRejectedValue(new Error("EXDEV")),
      cp: vi.fn().mockRejectedValue(new Error("ENOSPC")),
    });
    const ok = await moveKeptFiles(plan, downloadDir, fs);
    expect(ok).toBe(false);
    expect(fs.rm).not.toHaveBeenCalled();
  });
});
