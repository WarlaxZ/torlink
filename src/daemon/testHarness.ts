// Shared harness for the daemon's real-socket integration tests
// (shutdown.test.ts, serve.launch.test.ts). These tests bind real ports and
// deliver real signals because "does the port open" and "does a signal
// release it" are not observable from a stub — but that means every test file
// that does it needs the same plumbing: a free port, a poll for "is it up
// yet", a way to fire the SIGTERM handler runServe/runWatch just installed
// without taking the vitest worker down with a real process.emit, and a fake
// Runtime that stands in for the real one (which loads the user's config and
// arms the crash-boot marker — neither belongs in a test of a shutdown
// closure or a startup log line).
//
// Split out once a second file needed the same shape: anything added here is
// guaranteed to be exercised by both.

import net from "node:net";
import { vi } from "vitest";
import type { Runtime } from "./runtime";

export interface Fake {
  runtime: Runtime;
  suspend: ReturnType<typeof vi.fn>;
  stopAll: ReturnType<typeof vi.fn>;
}

export function fakeRuntime(downloadDir: string): Fake {
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

export function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

export async function waitUntil(fn: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Fail with "timed out waiting for X" instead of vitest's bare test timeout:
// the hang these tests exist for is indistinguishable from a slow machine
// otherwise.
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms).unref();
    }),
  ]);
}

// A port whose successor is also free. serve binds one port now, but several
// tests assert that the *next* one stays free — that is where the dashboard
// used to land, and "no second listener" is the claim worth pinning down.
export async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    if (!(await isListening(base)) && !(await isListening(base + 1))) return base;
  }
  throw new Error("no free port pair");
}

export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    if (!(await isListening(base))) return base;
  }
  throw new Error("no free port");
}

// Signals are delivered by calling the handler runServe/runWatch just
// installed, not by process.emit: vitest has its own signal handlers and
// emitting for real would take the worker down with us.
export function newSignalHandler(before: Set<unknown>): () => void {
  const added = process.listeners("SIGTERM").find((l) => !before.has(l));
  if (!added) throw new Error("no SIGTERM handler was installed");
  return added as () => void;
}

export interface SignalSnapshot {
  sigterm: Set<unknown>;
  sigint: Set<unknown>;
}

/** Call in `beforeEach`, before the code under test installs its handlers. */
export function snapshotSignalListeners(): SignalSnapshot {
  return {
    sigterm: new Set(process.listeners("SIGTERM")),
    sigint: new Set(process.listeners("SIGINT")),
  };
}

/** Call in `afterEach`, so a handler a test forgot to fire cannot leak into the next one. */
export function restoreSignalListeners(before: SignalSnapshot): void {
  for (const l of process.listeners("SIGTERM")) {
    if (!before.sigterm.has(l)) process.off("SIGTERM", l as never);
  }
  for (const l of process.listeners("SIGINT")) {
    if (!before.sigint.has(l)) process.off("SIGINT", l as never);
  }
}
