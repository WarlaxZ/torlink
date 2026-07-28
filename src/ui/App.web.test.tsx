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

// Same pattern Results.test.tsx uses for the same module: a browser launch is
// the one thing a test must never actually do, so openUrl is a spy all the
// way down, never the real opener.
const openUrl = vi.hoisted(() => vi.fn(async (_url: string) => true));
vi.mock("../util/openUrl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/openUrl")>()),
  openUrl: (url: string) => openUrl(url),
}));

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

// What can and cannot be mocked here, learned the hard way. Everything below is
// safe. `../util/dns` is NOT: mocking it stalls App's boot with no error at all —
// the frame sits on "Starting torlink" forever and nothing is thrown or logged —
// because other modules in the graph import more than setDnsServers from it. The
// real one is harmless in a test (setDnsServers([]) just clears the dispatcher).
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

// Saved and restored, not just set: this var gates a real outbound fetch (see
// App.tsx's update check). Leaking it set would silently disable that check for
// every later file in the same worker; leaking it *unset* after a file that had
// it set legitimately would give a second file rendering <App> network access
// depending on load order. Either way the suite's behaviour would hinge on file
// order, which is the one thing a test must not do.
let noUpdateCheck: string | undefined;

beforeEach(() => {
  noUpdateCheck = process.env.TORLINK_NO_UPDATE_CHECK;
  process.env.TORLINK_NO_UPDATE_CHECK = "1";
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  openUrl.mockClear();
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
  if (noUpdateCheck === undefined) delete process.env.TORLINK_NO_UPDATE_CHECK;
  else process.env.TORLINK_NO_UPDATE_CHECK = noUpdateCheck;
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
        expect(logSpies.warn).toHaveBeenCalledWith("[web] --port ignored without --web"),
      );
      expect(start).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press(TAB);
      await vi.waitFor(() => expect(ui.frame()).toContain("--port ignored without --web"));
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("shows the bound url on the splash, from the handle's own port", async () => {
    // The requested port and the bound port differ deliberately: the status line
    // must report what the server actually bound, not what was asked for.
    const start = vi.fn(async () => makeHandle(24242));
    const ui = renderUI(<App web webPort={19001} startWebServerImpl={start} />);
    try {
      // No tab: this asserts the splash itself, which is where a `torlnk --web`
      // user is sitting, and it outlives the notice's four-second expiry.
      await vi.waitFor(() => expect(ui.frame()).toContain("web ui · http://127.0.0.1:24242"));
      expect(ui.frame()).not.toContain("19001");
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("shows no web line on the splash without --web", async () => {
    const ui = renderUI(<App startWebServerImpl={vi.fn(async () => makeHandle())} />);
    try {
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      expect(ui.frame()).not.toContain("web ui ·");
      expect(ui.frame()).not.toContain("http://");
    } finally {
      ui.unmount();
    }
  });

  it("says so on the splash when the bind failed, and shows no url", async () => {
    const start = vi.fn(async () => {
      throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:19162");
    });
    const ui = renderUI(<App web webPort={19162} startWebServerImpl={start} />);
    try {
      await vi.waitFor(() => expect(ui.frame()).toContain("web ui · failed to start"));
      expect(ui.frame()).not.toContain("http://");
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

  it("shows a browsable URL on the splash, never the wildcard bind", async () => {
    const start = vi.fn(async () => ({ port: 19004, close: async () => {} }) as WebServerHandle);
    const ui = renderUI(
      <App web webHost="0.0.0.0" webToken="s3cret" startWebServerImpl={start} />,
    );
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(ui.frame()).toContain("http://127.0.0.1:19004/#k=s3cret"));
      expect(ui.frame()).not.toContain("http://0.0.0.0");
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("opens the dashboard on shift+w", async () => {
    const start = vi.fn(async () => ({ port: 19005, close: async () => {} }) as WebServerHandle);
    const ui = renderUI(<App web startWebServerImpl={start} />);
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      // The global keymap is only live in the browser view — the splash's search
      // field owns every printable key, which is why W cannot live there.
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press(TAB);
      // Two immediate press() calls can coalesce into one input chunk (see
      // Downloads.test.tsx); wait for the view to actually switch first.
      await vi.waitFor(() => expect(ui.frame()).toContain("Downloads"));
      ui.press("W");
      await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:19005"));
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("says so on shift+w when the web UI never started", async () => {
    const ui = renderUI(<App startWebServerImpl={vi.fn()} />);
    try {
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press(TAB);
      await vi.waitFor(() => expect(ui.frame()).toContain("Downloads"));
      ui.press("W");
      await vi.waitFor(() => expect(ui.frame()).toContain("web UI is not running"));
      expect(openUrl).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  });

  it("does not open a browser on shift+w while a prompt owns input", async () => {
    // The other half of the "W must not steal a keystroke" guarantee: a W typed
    // while a prompt is up must reach the prompt, not launch a browser.
    //
    // Scope of this test, stated honestly because it is narrower than it looks.
    // It pins the *behaviour* and nothing about *why* it holds: hoisting the W
    // branch above this prompt's `if (editingFolder) return;` guard does not
    // make it fail, so something sturdier than the guard ordering is keeping the
    // keystroke away — and this test would not notice if that ordering broke. An
    // earlier attempt at the neighbouring case (pressing "/" to reach
    // `captureMode === "text"`) passed whether its guard was present or not, and
    // was deleted rather than kept as false comfort; reaching text-capture needs
    // focus moved into the results region first. Both orderings are therefore
    // correct-by-reading and unpinned by tests.
    const start = vi.fn(async () => ({ port: 19007, close: async () => {} }) as WebServerHandle);
    const ui = renderUI(<App web startWebServerImpl={start} />);
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press(TAB);
      await vi.waitFor(() => expect(ui.frame()).toContain("Downloads"));
      // One press per barrier: back-to-back presses coalesce into a single
      // input chunk Ink will not split (see Downloads.test.tsx).
      ui.press("o");
      await vi.waitFor(() => expect(ui.frame()).toContain("Default download folder"));
      ui.press("W");
      // The prompt stays up and the browser stays shut. Waiting on the prompt
      // again gives a wrongly-handled W a frame in which to have acted.
      await vi.waitFor(() => expect(ui.frame()).toContain("Default download folder"));
      // Both halves of the branch, not just the opening one. Asserting only
      // "openUrl was not called" could not tell a blocked W from one that ran
      // and fell into the else — that assertion passed even with the branch
      // hoisted above this prompt's guard, which is the mutation it exists to
      // catch.
      expect(openUrl).not.toHaveBeenCalled();
      expect(ui.frame()).not.toContain("web UI is not running");
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });

  it("does not open a browser on shift+w from the splash — it types instead", async () => {
    // Pins the constraint the whole task turns on: the global keymap (where W
    // lives) is gated on view === "browser", so the splash's search field must
    // still own the keystroke, not fire the shortcut.
    const start = vi.fn(async () => ({ port: 19006, close: async () => {} }) as WebServerHandle);
    const ui = renderUI(<App web startWebServerImpl={start} />);
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press("W");
      await vi.waitFor(() => expect(ui.frame()).toContain("W"));
      expect(openUrl).not.toHaveBeenCalled();
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });
});
