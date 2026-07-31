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

describe("the PATH walk itself", () => {
  // These exercise the real lookup rather than a stubbed whichImpl: it replaces
  // player.ts's `spawn("command -v")` under a shell, so it needs its own cover.

  it("finds a binary in a PATH directory", async () => {
    const found = await findFfprobe({
      platform: "linux",
      env: { PATH: "/usr/bin:/opt/homebrew/bin" },
      accessImpl: async (p) => {
        if (p !== "/opt/homebrew/bin/ffprobe") throw new Error("ENOENT");
      },
    });
    expect(found).toBe("ffprobe");
  });

  it("returns null when no PATH directory has it", async () => {
    expect(
      await findFfprobe({
        platform: "linux",
        env: { PATH: "/usr/bin:/usr/local/bin" },
        accessImpl: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeNull();
  });

  it("tolerates an unset PATH", async () => {
    expect(await findFfprobe({ platform: "linux", env: {}, accessImpl: async () => {} })).toBeNull();
  });

  it("appends PATHEXT suffixes on Windows", async () => {
    const tried: string[] = [];
    const found = await findFfprobe({
      platform: "win32",
      env: { PATH: "C:\\bin", PATHEXT: ".COM;.EXE" },
      accessImpl: async (p) => {
        tried.push(p);
        if (!p.endsWith(".EXE")) throw new Error("ENOENT");
      },
    });
    expect(found).toBe("ffprobe");
    expect(tried).toEqual(["C:\\bin\\ffprobe.COM", "C:\\bin\\ffprobe.EXE"]);
  });

  it("splits PATH on semicolons on Windows, not colons", async () => {
    // A Windows PATH contains "C:\..." — splitting it on ":" would shred every
    // entry into a drive letter and a fragment.
    const found = await findFfprobe({
      platform: "win32",
      env: { PATH: "C:\\one;D:\\two", PATHEXT: ".EXE" },
      accessImpl: async (p) => {
        if (p !== "D:\\two\\ffprobe.EXE") throw new Error("ENOENT");
      },
    });
    expect(found).toBe("ffprobe");
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
