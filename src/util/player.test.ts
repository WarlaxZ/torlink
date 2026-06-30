import { describe, it, expect } from "vitest";
import { pickStreamFile, detectPlayer } from "./player";
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
});
