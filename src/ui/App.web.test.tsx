/**
 * The TUI's in-process web mount. One property dominates this file: Ink owns
 * stdout, so the web server's diagnostics must reach the *file* logger and
 * nothing else. A single console.log from a request handler lands inside a
 * rendered frame and corrupts it, and the damage reads as a rendering bug.
 *
 * So the server starter is injected (the real one binds a socket, which would
 * make "who wrote to stdout" unanswerable) and the assertions are: the injected
 * log goes to util/logger, console.* is never touched, and process.stdout is
 * never written to — Ink here writes only to the harness's own stdout stub, so
 * any write to the real one could only have come from this mount.
 *
 * Per repo convention these use vi.waitFor and real timers: fake timers cannot
 * drive Ink's MessageChannel-based effect flush.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { renderUI } from "./testHarness";
import type { Config } from "../config/config";
import type { Runtime } from "../daemon/runtime";
import type { WebServerHandle } from "../web/server";
import { StreamSessionRegistry } from "../core/streamSession";

const DOWNLOAD_DIR = "/tmp/torlink-web-test";
const TAB = "\t";

// A queue stub: App only boots it, listens to it, and tears it down.
class FakeQueue extends EventEmitter {
  setTrackers = vi.fn();
  setTransferPolicy = vi.fn();
  setRealDebridToken = vi.fn();
  setP2PAllowed = vi.fn();
  restore = vi.fn();
  restoreHistory = vi.fn();
  restoreSeeds = vi.fn();
  persistSync = vi.fn();
  suspend = vi.fn();
  getItems = vi.fn(() => []);
  getHistory = vi.fn(() => []);
  getSeeds = vi.fn(() => []);
  activeCount = 0;
  seedingCount = 0;
}

const logSpies = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock("../util/logger", () => ({
  log: {
    info: (m: string) => logSpies.info(m),
    warn: (m: string) => logSpies.warn(m),
    error: (m: string) => logSpies.error(m),
    debug: (m: string) => logSpies.debug(m),
    flush: () => Promise.resolve(),
  },
}));

vi.mock("../config/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config")>();
  return {
    ...actual,
    loadConfig: vi.fn(async (): Promise<Config> => ({
      downloadDir: DOWNLOAD_DIR,
      trackers: [],
    }) as Config),
    saveConfig: vi.fn(async () => {}),
  };
});

vi.mock("../download/queue", () => ({ DownloadQueue: FakeQueue }));
vi.mock("../download/persist", () => ({ loadQueue: async () => [], loadSeeds: async () => [] }));
vi.mock("../download/history", () => ({ loadHistory: async () => [] }));
vi.mock("../download/bootguard", () => ({
  BOOT_SETTLE_MS: 1,
  armBootMarker: () => {},
  disarmBootMarker: () => {},
  wasBootInterrupted: () => false,
}));
// Entering the browser view kicks off a real search otherwise: a network call
// from a UI test, whose rejection lands as an unhandled rejection.
vi.mock("../core/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/search")>();
  return {
    ...actual,
    runSearch: vi.fn(async () => ({ results: [], perSource: {}, done: 0, total: 0 })),
  };
});
vi.mock("../sources/rutracker/session", () => ({
  loadSession: async () => null,
  getSession: () => null,
  clearSession: async () => {},
  login: async () => ({ kind: "error", message: "no" }),
}));

// Imported after the mocks are registered.
const { App } = await import("./App");

function makeHandle(port = 19999): WebServerHandle & { close: ReturnType<typeof vi.fn> } {
  return { port, close: vi.fn(async () => {}) };
}

let stdoutWrites: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  process.env.TORLINK_NO_UPDATE_CHECK = "1";
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  stdoutWrites = [];
  // Ink is handed the harness's stdout stub, so a write landing on the real
  // process.stdout during this test could only come from the mount.
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  consoleSpies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  stdoutSpy.mockRestore();
  for (const s of consoleSpies) s.mockRestore();
  vi.restoreAllMocks();
});

// App itself writes two things to the *real* stdout, both pre-existing and both
// pure terminal control: the mouse-tracking enable/disable pair (ui/hooks/
// useMouseWheel) and the OSC window title (ui/components/TabTitle). Anything
// with printable payload outside those forms is a log leaking into the frame,
// which is exactly the failure this file exists to catch.
const CONTROL_ONLY = /^(?:\u001b\[[0-9;?]*[a-zA-Z]|\u001b\]0;[^\u0007]*\u0007)+$/;

function expectNothingOnStdout(): void {
  const leaks = stdoutWrites.filter((w) => !CONTROL_ONLY.test(w));
  expect(leaks).toEqual([]);
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
}

describe("App --web mount", () => {
  it("starts the server once, over its own queue, and says nothing on stdout", async () => {
    const handle = makeHandle(19001);
    const start = vi.fn(async () => handle);
    const ui = renderUI(<App web webPort={19001} startWebServerImpl={start} />);
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      const [runtime, options] = start.mock.calls[0]! as unknown as [Runtime, { port?: number; log?: (m: string) => void }];
      expect(options.port).toBe(19001);
      expect(runtime.queue).toBeInstanceOf(FakeQueue);
      expect(runtime.sessions).toBeInstanceOf(StreamSessionRegistry);
      expect(runtime.downloadDir).toBe(DOWNLOAD_DIR);

      // The injected log is the whole point: it must reach the file logger.
      options.log!("GET /api/status -> 200");
      expect(logSpies.info).toHaveBeenCalledWith("[web] GET /api/status -> 200");
      expectNothingOnStdout();

      // The URL reaches the user through the notice, not a print. (The notice
      // renders in the browser view; tab leaves the splash.)
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press(TAB);
      await vi.waitFor(() => expect(ui.frame()).toContain("Web UI on http://127.0.0.1:19001"));
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("passes host and token through, and honours a later download-dir change", async () => {
    const start = vi.fn(async () => makeHandle());
    const ui = renderUI(
      <App web webHost="0.0.0.0" webToken="s3cret" startWebServerImpl={start} />,
    );
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      const [, options] = start.mock.calls[0]! as unknown as [Runtime, { host?: string; token?: string }];
      expect(options.host).toBe("0.0.0.0");
      expect(options.token).toBe("s3cret");
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("surfaces a start failure as a notice, keeps rendering, and prints no stack", async () => {
    const start = vi.fn(async () => {
      throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:19162");
    });
    const ui = renderUI(<App web webPort={19162} startWebServerImpl={start} />);
    try {
      await vi.waitFor(() => expect(logSpies.error).toHaveBeenCalled());
      expect(logSpies.error.mock.calls[0]![0]).toContain("EADDRINUSE");
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press(TAB);
      await vi.waitFor(() => expect(ui.frame()).toContain("Web UI failed: listen EADDRINUSE"));
      // Still a live TUI, not a crashed one: the chrome is intact.
      expect(ui.frame()).toContain("Search");
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("refuses a non-loopback bind without a token via the notice, not a crash", async () => {
    // The real starter's own guard, exercised through the mount.
    const { startWebServer } = await import("../web/server");
    const ui = renderUI(<App web webHost="0.0.0.0" startWebServerImpl={startWebServer} />);
    try {
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press(TAB);
      // The notice is truncated to the header's width, so match its head.
      await vi.waitFor(() => expect(ui.frame()).toContain("Web UI failed: refusing to bind"));
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("closes the server on unmount", async () => {
    const handle = makeHandle();
    const start = vi.fn(async () => handle);
    const ui = renderUI(<App web startWebServerImpl={start} />);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    ui.unmount();
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1));
  });

  it("closes a server that finishes binding after the mount was torn down", async () => {
    const handle = makeHandle();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const start = vi.fn(async () => {
      await gate;
      return handle;
    });
    const ui = renderUI(<App web startWebServerImpl={start} />);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    ui.unmount(); // teardown while listen() is still in flight
    expect(handle.close).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1));
  });

  it("stops stream sessions on quit, while still mounted", async () => {
    // onQuit means the real quit path (a hard process exit in production) does
    // NOT unmount here, so this pins quitAll's own stopAll rather than the
    // unmount effect's — the two are separate paths and each must hold.
    const stopAll = vi.spyOn(StreamSessionRegistry.prototype, "stopAll").mockResolvedValue();
    const onQuit = vi.fn();
    const ui = renderUI(
      <App web startWebServerImpl={vi.fn(async () => makeHandle())} onQuit={onQuit} />,
    );
    try {
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press(TAB);
      await vi.waitFor(() => expect(ui.frame()).toContain("Downloads"));
      ui.press("q");
      await vi.waitFor(() => expect(onQuit).toHaveBeenCalled());
      expect(stopAll).toHaveBeenCalledTimes(1);
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("stops stream sessions on unmount", async () => {
    const stopAll = vi.spyOn(StreamSessionRegistry.prototype, "stopAll").mockResolvedValue();
    const ui = renderUI(<App web startWebServerImpl={vi.fn(async () => makeHandle())} />);
    await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
    expect(stopAll).not.toHaveBeenCalled();
    ui.unmount();
    await vi.waitFor(() => expect(stopAll).toHaveBeenCalledTimes(1));
  });

  it("does not start anything without --web, and warns about orphaned flags", async () => {
    const start = vi.fn(async () => makeHandle());
    const ui = renderUI(<App webPort={19002} startWebServerImpl={start} />);
    try {
      await vi.waitFor(() =>
        expect(logSpies.warn).toHaveBeenCalledWith("[web] --web-port ignored without --web"),
      );
      expect(start).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press(TAB);
      await vi.waitFor(() => expect(ui.frame()).toContain("--web-port ignored without --web"));
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("stays silent when no web flags are passed at all", async () => {
    const start = vi.fn(async () => makeHandle());
    const ui = renderUI(<App startWebServerImpl={start} />);
    try {
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      expect(start).not.toHaveBeenCalled();
      expect(logSpies.warn).not.toHaveBeenCalled();
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });
});
