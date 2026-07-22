import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawn = vi.fn();

vi.mock("node:child_process", () => ({ spawn }));

type FakeProc = EventEmitter & { kill: () => void };

function fakeProc(code: number): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.kill = vi.fn();
  queueMicrotask(() => proc.emit("close", code));
  return proc;
}

function onPlatform(platform: string): () => void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  return () => {
    Object.defineProperty(process, "platform", { value: original });
    vi.resetModules();
    spawn.mockReset();
  };
}

describe("imdbTitleUrl", () => {
  it("builds the canonical IMDb title page URL", async () => {
    const { imdbTitleUrl } = await import("./openUrl");
    expect(imdbTitleUrl("tt26581740")).toBe("https://www.imdb.com/title/tt26581740/");
  });
});

describe("openUrl", () => {
  it("opens http(s) URLs via the Linux opener, falling back", async () => {
    const restore = onPlatform("linux");
    try {
      spawn.mockImplementation((cmd: string) => fakeProc(cmd === "gio" ? 0 : 1));
      const { openUrl } = await import("./openUrl");

      await expect(openUrl("https://www.imdb.com/title/tt1/")).resolves.toBe(true);
      expect(spawn).toHaveBeenCalledWith("xdg-open", ["https://www.imdb.com/title/tt1/"]);
      expect(spawn).toHaveBeenCalledWith("gio", ["open", "https://www.imdb.com/title/tt1/"]);
    } finally {
      restore();
    }
  });

  it("rejects non-http URLs without spawning (no arbitrary handler launch)", async () => {
    const restore = onPlatform("linux");
    try {
      const { openUrl } = await import("./openUrl");
      await expect(openUrl("file:///etc/passwd")).resolves.toBe(false);
      await expect(openUrl("")).resolves.toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
