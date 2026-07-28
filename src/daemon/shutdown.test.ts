// Integration tests for the two headless mount sites: what `runServe` starts
// (the API, and the web UI beside it) and what both daemons tear down on a
// signal. These bind real sockets on purpose — the whole point of the unit is
// that a second server comes up on the right port and that a signal actually
// releases it, and neither is observable from a pure function.
//
// `startRuntime` is the one thing stubbed: the real one loads the user's config,
// arms a boot marker and restores persisted state, none of which belongs in a
// test of a shutdown closure.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  fakeRuntime,
  isListening,
  waitUntil,
  withTimeout,
  freePortPair,
  newSignalHandler,
  snapshotSignalListeners,
  restoreSignalListeners,
  type Fake,
} from "./testHarness";

const startRuntime = vi.hoisted(() => vi.fn());
vi.mock("./runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime")>()),
  startRuntime,
}));

const { runServe } = await import("./serve");
const { runWatch } = await import("./watch");
const { armBootMarker, disarmBootMarker, wasBootInterrupted } = await import(
  "../download/bootguard"
);

describe("runServe web mount", () => {
  let dir: string;
  let fake: Fake;
  let exit: ReturnType<typeof vi.spyOn>;
  let errors: string[];
  let logs: string[];
  let signals: ReturnType<typeof snapshotSignalListeners>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-mount-"));
    fake = fakeRuntime(dir);
    startRuntime.mockReset();
    startRuntime.mockResolvedValue(fake.runtime);
    errors = [];
    logs = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    signals = snapshotSignalListeners();
  });

  afterEach(async () => {
    restoreSignalListeners(signals);
    vi.restoreAllMocks();
    // The marker lives in this worker's TORLINK_STATE_DIR (see test-setup.ts);
    // clear it either way so a test that arms it cannot leak into the next one.
    disarmBootMarker();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("serves the api and the web ui on one port", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    // One port answers both surfaces: the daemon API's bare paths and the
    // dashboard's /api/*. That is the whole point of dropping --web-port.
    const api = await fetch(`http://127.0.0.1:${port}/health`);
    expect(api.status).toBe(200);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ downloads: [], seeds: [] });
    const downloads = await fetch(`http://127.0.0.1:${port}/downloads`);
    expect(downloads.status).toBe(200);

    // Nothing on the port the old build derived for the dashboard.
    expect(await isListening(port + 1)).toBe(false);

    newSignalHandler(before)();
    await done;
  });

  it("serves only the api without --web", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    const api = await fetch(`http://127.0.0.1:${port}/health`);
    expect(api.status).toBe(200);
    // The dashboard's own routes are not mounted, and no second port is bound.
    const ui = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(ui.status).toBe(404);
    expect(await isListening(port + 1)).toBe(false);
    newSignalHandler(before)();
    await done;
  });

  // The failure mode this pair of tests guards, beyond the exit code: the real
  // startRuntime() arms the crash-boot marker just before restoring state, and
  // only a 4s *unref'd* timer or queue.suspend() disarms it. An EADDRINUSE lands
  // in milliseconds, so a startup that exits here used to leave the marker on
  // disk — and the next launch of *any* mode came up in safe mode with every
  // download and seed paused, claiming it recovered from a crash. startRuntime is
  // stubbed in this file, so the marker is armed by hand to stand in for it.
  it("leaves no boot marker armed when the port is taken with --web", async () => {
    const port = await freePortPair();
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
    try {
      armBootMarker();
      expect(wasBootInterrupted()).toBe(true);
      await runServe({ port, web: true, downloadDir: dir });
      expect(exit).toHaveBeenCalledWith(1);
      expect(wasBootInterrupted()).toBe(false);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("leaves no boot marker armed when the port is taken without --web", async () => {
    const port = await freePortPair();
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
    try {
      armBootMarker();
      await runServe({ port, downloadDir: dir });
      expect(exit).toHaveBeenCalledWith(1);
      expect(wasBootInterrupted()).toBe(false);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("exits non-zero with the port in the message when --web cannot bind", async () => {
    const port = await freePortPair();
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
    try {
      await runServe({ port, web: true, downloadDir: dir });
      expect(exit).toHaveBeenCalledWith(1);
      expect(errors.join("\n")).toContain(`could not start the web ui on port ${port}`);
      expect(errors.join("\n")).toContain("EADDRINUSE");
      // Nothing was left half-started on the port next door, which is where the
      // dashboard used to land: one --web daemon binds exactly one port.
      expect(await isListening(port + 1)).toBe(false);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("reports a taken api port as a refusal without --web", async () => {
    const port = await freePortPair();
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
    try {
      await runServe({ port, downloadDir: dir });
      expect(exit).toHaveBeenCalledWith(1);
      expect(errors.join("\n")).toContain(`could not start the api on port ${port}`);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  // The same CSRF gate on the pre-existing 9161 API, checked over a real socket.
  // A bad magnet answers 400 *before* the handler touches the queue, so 400 here
  // means "the request got through" and 403 means "it was blocked" — no fake
  // queue method is involved either way.
  it("blocks a cross-site POST to the api but not a curl-shaped one", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    const post = (headers: Record<string, string>): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/add`, { method: "POST", headers, body: "nope" });

    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    // The dashboard-shaped request, and the curl-shaped one with no headers.
    expect((await post({ origin: `http://127.0.0.1:${port}` })).status).toBe(400);
    expect((await post({})).status).toBe(400);

    newSignalHandler(before)();
    await done;
  });

  it("releases the port, stops stream sessions and suspends the queue on a signal", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    // Hold an event stream open, like a browser would. Without the handle's
    // close() this connection keeps the web server alive forever.
    const events = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(events.status).toBe(200);

    newSignalHandler(before)();
    await done;

    expect(fake.stopAll).toHaveBeenCalled();
    expect(fake.suspend).toHaveBeenCalled();
    // Asserted directly, not through waitUntil: runServe resolves only after
    // close() has called back, so anything still listening here is a real
    // failure rather than a race worth retrying.
    expect(await isListening(port)).toBe(false);
    await events.body?.cancel().catch(() => {});
  });

  it("finishes shutting down with a connected socket that never sends a request", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    // A bare TCP connection that never sends a byte — a browser's speculative
    // preconnect, a TCP health probe, a port scan. `server.close()` stops
    // accepting and then waits for open connections to end, and this one never
    // ends, so without `closeAllConnections()` on the API server the shutdown
    // below hangs forever (and `daemon/restart.ts` then reports stillRunning
    // after 10s, which is how `torlnk update` left the old daemon running).
    //
    // Note what this test can assert that the older ones could not: `isListening`
    // flips false the instant close() stops accepting, so a permanently hung
    // process passed those. The claim here is that the shutdown *finishes*.
    const idle = net.connect({ port, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      idle.once("connect", () => resolve());
      idle.once("error", reject);
    });

    newSignalHandler(before)();
    await expect(withTimeout(done, 3000, "runServe to finish shutting down")).resolves.toBeUndefined();
    expect(fake.suspend).toHaveBeenCalled();
    expect(await isListening(port)).toBe(false);
    idle.destroy();
  });

  it("ignores a second signal instead of tearing down twice", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    const handler = newSignalHandler(before);
    handler();
    handler(); // a supervisor's SIGTERM racing the user's Ctrl-C
    await withTimeout(done, 3000, "runServe to finish shutting down");
    // suspend() flushes state and disarms the boot marker; running it twice
    // mid-teardown is exactly what the re-entry guard is there to prevent.
    expect(fake.suspend).toHaveBeenCalledTimes(1);
    // Both handlers were removed by the first pass, so a third signal reaches
    // Node's default handler — the escape hatch from a shutdown that does hang.
    expect(process.listeners("SIGTERM").some((l) => !before.has(l))).toBe(false);
    expect(process.listeners("SIGINT").some((l) => !signals.sigint.has(l))).toBe(false);
  });
});

describe("runWatch shutdown", () => {
  let dir: string;
  let fake: Fake;
  let signals: ReturnType<typeof snapshotSignalListeners>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-watch-shutdown-"));
    fake = fakeRuntime(dir);
    startRuntime.mockResolvedValue(fake.runtime);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    signals = snapshotSignalListeners();
  });

  afterEach(async () => {
    restoreSignalListeners(signals);
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("stops stream sessions as well as the queue", async () => {
    const before = new Set(process.listeners("SIGTERM"));
    const done = runWatch(dir, dir);
    expect(
      await waitUntil(async () => process.listeners("SIGTERM").some((l) => !before.has(l))),
    ).toBe(true);
    newSignalHandler(before)();
    await done;
    expect(fake.stopAll).toHaveBeenCalled();
    expect(fake.suspend).toHaveBeenCalled();
  });
});
