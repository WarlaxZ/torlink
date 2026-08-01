import { describe, it, expect, vi, beforeEach } from "vitest";
import { pickStreamFile, detectPlayer, streamCandidates, attemptAutoPlay, detectAndPlay, launchPlayer, type StreamFile } from "./player";

let spawnCalls: Array<{ cmd: string; argv: string[] }> = [];

vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn((cmd: string, argv: string[]) => {
      spawnCalls.push({ cmd, argv });
      const mockProc = {
        on: vi.fn((event: string, callback: () => void) => {
          // Simulate immediate error for direct spawn (triggers macOS fallback if applicable)
          if (event === "error") {
            callback();
          }
          return mockProc;
        }),
        unref: vi.fn(() => mockProc),
      };
      return mockProc;
    }),
  };
});

function f(filename: string, bytes: number): StreamFile {
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

describe("detectAndPlay", () => {
  it("returns the detected player when it launches", async () => {
    const player = await detectAndPlay("http://x", "", {
      detect: async () => "mpv",
      launch: async () => true,
    });
    expect(player).toBe("mpv");
  });

  it("returns null when detection finds nothing", async () => {
    const player = await detectAndPlay("http://x", "", {
      detect: async () => null,
      launch: async () => true,
    });
    expect(player).toBeNull();
  });

  it("returns null when the detected player fails to launch", async () => {
    const player = await detectAndPlay("http://x", "", {
      detect: async () => "mpv",
      launch: async () => false,
    });
    expect(player).toBeNull();
  });
});

describe("attemptAutoPlay", () => {
  it("passes the subtitle url through attemptAutoPlay to the launcher", () => {
    // The path nearly every user takes: a configured player. Wiring only the
    // after-the-prompt launch would leave the feature dead for all of them.
    const seen: { command: string; url: string; sub?: string }[] = [];
    return attemptAutoPlay(
      "mpv",
      "http://up.test/v.mkv",
      "http://up.test/v.eng.srt",
      {
        launch: (command, url, sub) => {
          seen.push({ command, url, sub });
          return Promise.resolve(true);
        },
      },
    ).then(() => {
      expect(seen).toEqual([
        { command: "mpv", url: "http://up.test/v.mkv", sub: "http://up.test/v.eng.srt" },
      ]);
    });
  });

  it("passes an empty subtitle url when there is none", async () => {
    let seen = "unset";
    await attemptAutoPlay("mpv", "http://up.test/v.mkv", "", {
      launch: (_c, _u, sub) => {
        seen = sub ?? "undefined";
        return Promise.resolve(true);
      },
    });
    expect(seen).toBe("");
  });

  it("launches the configured player and reports played", async () => {
    const out = await attemptAutoPlay("vlc.exe", "http://x", "", {
      launch: async (cmd) => cmd === "vlc.exe",
    });
    expect(out).toEqual({ played: true, player: "vlc.exe", configuredFailed: false });
  });

  it("flags a configured player that fails to launch and does NOT auto-detect", async () => {
    let detected = false;
    const out = await attemptAutoPlay("vlc.exe", "http://x", "", {
      launch: async () => false,
      detect: async () => {
        detected = true;
        return "mpv";
      },
    });
    expect(out).toEqual({ played: false, configuredFailed: true });
    expect(detected).toBe(false);
  });

  it("auto-detects and launches when nothing is configured", async () => {
    const out = await attemptAutoPlay("", "http://x", "", {
      detect: async () => "mpv",
      launch: async () => true,
    });
    expect(out).toEqual({ played: true, player: "mpv", configuredFailed: false });
  });

  it("reports not-played (configuredFailed false) when detection finds nothing", async () => {
    const out = await attemptAutoPlay("", "http://x", "", {
      detect: async () => null,
      launch: async () => true,
    });
    expect(out).toEqual({ played: false, configuredFailed: false });
  });

  it("reports not-played when the detected player fails to launch", async () => {
    const out = await attemptAutoPlay("", "http://x", "", {
      detect: async () => "mpv",
      launch: async () => false,
    });
    expect(out).toEqual({ played: false, configuredFailed: false });
  });
});

describe("launchPlayer argv construction", () => {
  beforeEach(() => {
    spawnCalls = [];
  });

  it("passes only URL to mpv when no subtitle is provided", async () => {
    await launchPlayer("mpv", "http://stream.test/file.mkv");
    expect(spawnCalls).toContainEqual({
      cmd: "mpv",
      argv: ["http://stream.test/file.mkv"],
    });
  });

  it("passes subtitle flag before URL to mpv when subtitle is provided", async () => {
    const subUrl = "http://box.test:9161/stream/abc/1.vtt";
    await launchPlayer("mpv", "http://stream.test/file.mkv", subUrl);
    expect(spawnCalls).toContainEqual({
      cmd: "mpv",
      argv: [`--sub-file=${subUrl}`, "http://stream.test/file.mkv"],
    });
  });

  it("uses open -a with URL only when no subtitle on macOS", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const url = "http://stream.test/file.mkv";
    // First spawn fails so fallback to open -a is used
    await launchPlayer("VLC", url);
    expect(spawnCalls).toContainEqual({
      cmd: "open",
      argv: ["-a", "VLC", url],
    });
  });

  it("uses open -a with --args separator when subtitle is provided on macOS", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const url = "http://stream.test/file.mkv";
    const subUrl = "http://box.test:9161/stream/abc/1.vtt";
    // First spawn fails so fallback to open -a is used
    await launchPlayer("VLC", url, subUrl);
    expect(spawnCalls).toContainEqual({
      cmd: "open",
      argv: ["-a", "VLC", url, "--args", "--input-slave=" + subUrl],
    });
  });
});
