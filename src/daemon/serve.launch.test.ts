// What `runServe --web` tells the user, and what it opens.
//
// Separate from shutdown.test.ts (which is about teardown) and sharing its
// harness shape: real sockets, because "what got printed for this bind" is only
// observable once something is actually listening, and `startRuntime` stubbed,
// because the real one loads the user's config and arms a boot marker.

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
const { disarmBootMarker } = await import("../download/bootguard");

function fakeRuntime(downloadDir: string): Runtime {
  return {
    queue: {
      suspend: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      getItems: () => [],
      getSeeds: () => [],
    } as unknown as Runtime["queue"],
    downloadDir,
    sessions: { stopAll: vi.fn().mockResolvedValue(undefined) } as unknown as Runtime["sessions"],
  };
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

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    if (!(await isListening(base))) return base;
  }
  throw new Error("no free port");
}

// Signals are delivered by calling the handler runServe just installed, not by
// process.emit: vitest has its own handlers and emitting for real takes the
// worker down.
function newSignalHandler(before: Set<unknown>): () => void {
  const added = process.listeners("SIGTERM").find((l) => !before.has(l));
  if (!added) throw new Error("no SIGTERM handler was installed");
  return added as () => void;
}

describe("runServe --web startup output", () => {
  let dir: string;
  let logs: string[];
  let errors: string[];
  let sigterm: Set<unknown>;
  let sigint: Set<unknown>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-launch-"));
    startRuntime.mockReset();
    startRuntime.mockResolvedValue(fakeRuntime(dir));
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    sigterm = new Set(process.listeners("SIGTERM"));
    sigint = new Set(process.listeners("SIGINT"));
  });

  afterEach(async () => {
    for (const l of process.listeners("SIGTERM")) if (!sigterm.has(l)) process.off("SIGTERM", l as never);
    for (const l of process.listeners("SIGINT")) if (!sigint.has(l)) process.off("SIGINT", l as never);
    vi.restoreAllMocks();
    disarmBootMarker();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("never prints the wildcard bind address as a URL", async () => {
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, host: "0.0.0.0", token: "s3cret", web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    // The whole bug: this string used to be the advice the user was given.
    expect(logs.join("\n")).not.toContain("http://0.0.0.0");
    expect(logs.join("\n")).toContain(`http://127.0.0.1:${port}`);

    newSignalHandler(before)();
    await done;
  });

  it("prints a loopback URL for a loopback bind, with no LAN lines", async () => {
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    // The old code's `listening on http://127.0.0.1:${port}` line already
    // contains this substring, so a bare `.toContain` here would pass against
    // the pre-fix implementation too. The `(this machine)` marker only the new
    // per-host logging produces, so anchor on that instead.
    expect(logs.join("\n")).toContain(`http://127.0.0.1:${port}  (this machine)`);
    expect(logs.join("\n")).not.toContain("from your LAN");

    // Exactly one per-host line: a loopback bind has one host to report, and a
    // regression that always appended a LAN line (even with an empty list)
    // would otherwise slip past the "not.toContain" check above. Matched on the
    // "(this machine)" / "(from your LAN)" suffix rather than "web ui on" alone,
    // since the summary line ("api + web ui on one port...") also contains that
    // substring.
    const perHostLines = logs.filter((l) => / \(this machine\)| \(from your LAN\)/.test(l));
    expect(perHostLines).toHaveLength(1);

    newSignalHandler(before)();
    await done;
  });

  it("puts a supplied token in the link fragment", async () => {
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, host: "0.0.0.0", token: "s3cret", web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    expect(logs.join("\n")).toContain(`http://127.0.0.1:${port}/#k=s3cret`);
    newSignalHandler(before)();
    await done;
  });
});
