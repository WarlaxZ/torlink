import { beforeEach, describe, expect, it } from "vitest";
import { findFfmpeg, findFfprobe, resetFfmpegBinCache } from "./ffmpegBin";

beforeEach(() => resetFfmpegBinCache());

describe("findFfprobe", () => {
  it("returns the PATH name when it resolves", async () => {
    expect(await findFfprobe({ whichImpl: async (c) => c === "ffprobe" })).toBe("ffprobe");
  });

  it("returns null when nothing resolves — an absent binary is a normal answer", async () => {
    expect(await findFfprobe({ whichImpl: async () => false, platform: "linux" })).toBeNull();
  });

  it("falls back to a known Windows install path", async () => {
    const found = await findFfprobe({
      whichImpl: async () => false,
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      // Stubbed because the suite runs on machines where this path does not
      // exist; the assertion is about which path is CHOSEN, not about the disk.
      accessImpl: async () => {},
    });
    expect(found).toBe("C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe");
  });

  it("skips a Windows path whose env token is undefined", async () => {
    expect(
      await findFfprobe({
        whichImpl: async () => false,
        platform: "win32",
        env: {},
        accessImpl: async () => {},
      }),
    ).toBeNull();
  });

  it("skips a Windows path that is not on disk and tries the next", async () => {
    const tried: string[] = [];
    const found = await findFfprobe({
      whichImpl: async () => false,
      platform: "win32",
      env: { ProgramFiles: "C:\\PF", ChocolateyInstall: "C:\\choco" },
      accessImpl: async (p) => {
        tried.push(p);
        if (!p.startsWith("C:\\choco")) throw new Error("ENOENT");
      },
    });
    expect(found).toBe("C:\\choco\\bin\\ffprobe.exe");
    expect(tried[0]).toBe("C:\\PF\\ffmpeg\\bin\\ffprobe.exe");
  });

  it("memoises, so a lookup does not spawn once per request", async () => {
    let calls = 0;
    const whichImpl = async () => {
      calls += 1;
      return true;
    };
    await findFfprobe({ whichImpl });
    await findFfprobe({ whichImpl });
    expect(calls).toBe(1);
  });

  it("memoises a negative answer too", async () => {
    let calls = 0;
    const whichImpl = async () => {
      calls += 1;
      return false;
    };
    expect(await findFfprobe({ whichImpl, platform: "linux" })).toBeNull();
    expect(await findFfprobe({ whichImpl, platform: "linux" })).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("findFfmpeg", () => {
  it("looks up its own name, not ffprobe's", async () => {
    const asked: string[] = [];
    await findFfmpeg({
      whichImpl: async (c) => {
        asked.push(c);
        return true;
      },
    });
    expect(asked).toEqual(["ffmpeg"]);
  });

  it("is cached separately from ffprobe", async () => {
    const found = async (c: string) => c === "ffmpeg";
    expect(await findFfprobe({ whichImpl: found, platform: "linux" })).toBeNull();
    expect(await findFfmpeg({ whichImpl: found })).toBe("ffmpeg");
  });
});
