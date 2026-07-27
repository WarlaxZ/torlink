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
import type { Runtime } from "./runtime";

const startRuntime = vi.hoisted(() => vi.fn());
vi.mock("./runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime")>()),
  startRuntime,
}));

const { runServe } = await import("./serve");
const { runWatch } = await import("./watch");

interface Fake {
  runtime: Runtime;
  suspend: ReturnType<typeof vi.fn>;
  stopAll: ReturnType<typeof vi.fn>;
}

function fakeRuntime(downloadDir: string): Fake {
  const suspend = vi.fn();
  const stopAll = vi.fn().mockResolvedValue(undefined);
  const runtime = {
    queue: {
      suspend,
      on: vi.fn(),
      off: vi.fn(),
      getItems: () => [],
      getSeeds: () => [],
    } as unknown as Runtime["queue"],
    downloadDir,
    sessions: { stopAll } as unknown as Runtime["sessions"],
  };
  return { runtime, suspend, stopAll };
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

async function waitUntil(fn: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// A port whose successor is also free, because the default web port is `port + 1`
// and a test that asserts that needs both ends of the pair.
async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    if (!(await isListening(base)) && !(await isListening(base + 1))) return base;
  }
  throw new Error("no free port pair");
}

// Signals are delivered by calling the handler runServe/runWatch just installed,
// not by process.emit: vitest has its own signal handlers and emitting for real
// would take the worker down with us.
function newSignalHandler(before: Set<unknown>): () => void {
  const added = process.listeners("SIGTERM").find((l) => !before.has(l));
  if (!added) throw new Error("no SIGTERM handler was installed");
  return added as () => void;
}

describe("runServe web mount", () => {
  let dir: string;
  let fake: Fake;
  let exit: ReturnType<typeof vi.spyOn>;
  let errors: string[];
  let logs: string[];
  let sigterm: Set<unknown>;
  let sigint: Set<unknown>;

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
    sigterm = new Set(process.listeners("SIGTERM"));
    sigint = new Set(process.listeners("SIGINT"));
  });

  afterEach(async () => {
    for (const l of process.listeners("SIGTERM")) {
      if (!sigterm.has(l)) process.off("SIGTERM", l as never);
    }
    for (const l of process.listeners("SIGINT")) {
      if (!sigint.has(l)) process.off("SIGINT", l as never);
    }
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("serves the api and mounts the web ui on the api port + 1", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    expect(await waitUntil(() => isListening(port + 1))).toBe(true);

    const api = await fetch(`http://127.0.0.1:${port}/health`);
    expect(api.status).toBe(200);
    const ui = await fetch(`http://127.0.0.1:${port + 1}/health`);
    expect(ui.status).toBe(200);
    const status = await fetch(`http://127.0.0.1:${port + 1}/api/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ downloads: [], seeds: [] });

    newSignalHandler(before)();
    await done;
  });

  it("uses --web-port when one is given", async () => {
    const port = await freePortPair();
    const webPort = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, webPort, downloadDir: dir });
    expect(await waitUntil(() => isListening(webPort))).toBe(true);
    const ui = await fetch(`http://127.0.0.1:${webPort}/health`);
    expect(ui.status).toBe(200);
    // The derived port stays free: an explicit --web-port replaces it.
    expect(await isListening(port + 1)).toBe(false);
    newSignalHandler(before)();
    await done;
  });

  it("does not mount the web ui without --web", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    expect(await isListening(port + 1)).toBe(false);
    expect(await isListening(9162)).toBe(false); // nor the default web port
    newSignalHandler(before)();
    await done;
  });

  it("warns when --web-port is set without --web", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, webPort: 31999, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    expect(logs.join("\n")).toContain("warning: --web-port 31999 ignored without --web");
    newSignalHandler(before)();
    await done;
  });

  it("refuses to start when the web port equals the api port", async () => {
    const port = await freePortPair();
    await runServe({ port, web: true, webPort: port, downloadDir: dir });
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("must differ from the api port");
    // Bailed before anything was started, so nothing is left listening.
    expect(startRuntime).not.toHaveBeenCalled();
    expect(await isListening(port)).toBe(false);
  });

  it("exits non-zero with the port in the message when the web port is taken", async () => {
    const port = await freePortPair();
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(port + 1, "127.0.0.1", r));
    try {
      await runServe({ port, web: true, downloadDir: dir });
      expect(exit).toHaveBeenCalledWith(1);
      expect(errors.join("\n")).toContain(`could not start the web ui on port ${port + 1}`);
      expect(errors.join("\n")).toContain("EADDRINUSE");
      // The API never came up: a half-configured daemon is worse than none.
      expect(await isListening(port)).toBe(false);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("reports a taken api port as a refusal and releases the web port again", async () => {
    const port = await freePortPair();
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
    try {
      await runServe({ port, web: true, downloadDir: dir });
      expect(exit).toHaveBeenCalledWith(1);
      expect(errors.join("\n")).toContain(`could not start the api on port ${port}`);
      // The web server came up first; a refused API must not leave it orphaned.
      expect(await isListening(port + 1)).toBe(false);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("releases the web port, stops stream sessions and suspends the queue on a signal", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port + 1))).toBe(true);

    // Hold an event stream open, like a browser would. Without the handle's
    // close() this connection keeps the web server alive forever.
    const events = await fetch(`http://127.0.0.1:${port + 1}/api/events`);
    expect(events.status).toBe(200);

    newSignalHandler(before)();
    await done;

    expect(fake.stopAll).toHaveBeenCalled();
    expect(fake.suspend).toHaveBeenCalled();
    expect(await waitUntil(async () => !(await isListening(port + 1)))).toBe(true);
    expect(await waitUntil(async () => !(await isListening(port)))).toBe(true);
    await events.body?.cancel().catch(() => {});
  });
});

describe("runWatch shutdown", () => {
  let dir: string;
  let fake: Fake;
  let sigterm: Set<unknown>;
  let sigint: Set<unknown>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-watch-shutdown-"));
    fake = fakeRuntime(dir);
    startRuntime.mockResolvedValue(fake.runtime);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    sigterm = new Set(process.listeners("SIGTERM"));
    sigint = new Set(process.listeners("SIGINT"));
  });

  afterEach(async () => {
    for (const l of process.listeners("SIGTERM")) {
      if (!sigterm.has(l)) process.off("SIGTERM", l as never);
    }
    for (const l of process.listeners("SIGINT")) {
      if (!sigint.has(l)) process.off("SIGINT", l as never);
    }
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
