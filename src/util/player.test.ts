import { describe, it, expect } from "vitest";
import { pickStreamFile, detectPlayer, streamCandidates } from "./player";
import type { ResolvedFile } from "../integrations/realdebrid";

function f(filename: string, bytes: number): ResolvedFile {
  return { url: `https://dl/${filename}`, filename, bytes };
}

describe("pickStreamFile", () => {
  it("returns null for no files", () => {
    expect(pickStreamFile([])).toBeNull();
  });

  it("prefers the largest video file over a larger non-video file", () => {
    const picked = pickStreamFile([
      f("movie.mkv", 700),
      f("extras.bin", 9000),
      f("sample.mp4", 50),
    ]);
    expect(picked?.filename).toBe("movie.mkv");
  });

  it("falls back to the largest file when none are video", () => {
    const picked = pickStreamFile([f("a.bin", 10), f("b.zip", 80), f("c.txt", 5)]);
    expect(picked?.filename).toBe("b.zip");
  });
});

describe("detectPlayer", () => {
  it("returns the first CLI candidate that exists", async () => {
    const found = await detectPlayer({
      which: async (cmd) => cmd === "vlc",
      appExists: async () => false,
      platform: "linux",
    });
    expect(found).toBe("vlc");
  });

  it("prefers mpv when several exist", async () => {
    const found = await detectPlayer({ which: async () => true, platform: "linux" });
    expect(found).toBe("mpv");
  });

  it("returns null when none exist", async () => {
    const found = await detectPlayer({
      which: async () => false,
      appExists: async () => false,
      platform: "linux",
    });
    expect(found).toBeNull();
  });

  it("finds a macOS .app bundle when nothing is on PATH", async () => {
    const found = await detectPlayer({
      which: async () => false,
      appExists: async (app) => app === "VLC",
      platform: "darwin",
    });
    expect(found).toBe("VLC");
  });

  it("does not look for .app bundles off macOS", async () => {
    const found = await detectPlayer({
      which: async () => false,
      appExists: async () => true,
      platform: "linux",
    });
    expect(found).toBeNull();
  });

  it("finds a Windows install path when nothing is on PATH", async () => {
    const found = await detectPlayer({
      which: async () => false,
      winFind: async (paths) => (paths.some((p) => p.includes("VLC")) ? "C:\\VLC\\vlc.exe" : null),
      platform: "win32",
    });
    expect(found).toBe("C:\\VLC\\vlc.exe");
  });

  it("falls back to Windows Media Player when VLC is absent", async () => {
    const found = await detectPlayer({
      which: async () => false,
      winFind: async (paths) =>
        paths.some((p) => p.includes("Windows Media Player"))
          ? "C:\\Program Files\\Windows Media Player\\wmplayer.exe"
          : null,
      platform: "win32",
    });
    expect(found).toBe("C:\\Program Files\\Windows Media Player\\wmplayer.exe");
  });

  it("does not probe Windows paths off Windows", async () => {
    const found = await detectPlayer({
      which: async () => false,
      winFind: async () => "C:\\VLC\\vlc.exe",
      platform: "linux",
    });
    expect(found).toBeNull();
  });

  it("returns null on Windows when no player is installed", async () => {
    const found = await detectPlayer({
      which: async () => false,
      winFind: async () => null,
      platform: "win32",
    });
    expect(found).toBeNull();
  });

  it("prefers an earlier Windows candidate over a later one", async () => {
    const found = await detectPlayer({
      which: async () => false,
      // Only Windows Media Player is present; VLC etc. are not.
      winFind: async (paths) =>
        paths.some((p) => p.includes("Windows Media Player"))
          ? "C:\\Program Files\\Windows Media Player\\wmplayer.exe"
          : null,
      platform: "win32",
    });
    expect(found).toBe("C:\\Program Files\\Windows Media Player\\wmplayer.exe");
  });
});

describe("streamCandidates", () => {
  it("returns only video files when any are present", () => {
    const files = [f("readme.txt", 10), f("movie.mkv", 900), f("sample.mp4", 50)];
    const out = streamCandidates(files);
    expect(out.map((x) => x.filename).sort()).toEqual(["movie.mkv", "sample.mp4"]);
  });

  it("falls back to all files when none look like video", () => {
    const files = [f("disc.iso", 900), f("readme.txt", 10)];
    expect(streamCandidates(files).length).toBe(2);
  });

  it("returns an empty array for no files", () => {
    expect(streamCandidates([])).toEqual([]);
  });
});
