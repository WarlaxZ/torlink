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
// Split out once a second file needed the same shape. Everything here has at
// least one consumer and most have two — but not all, so a lone caller is not
// evidence that an export is dead.

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

// Ask the OS for a port instead of guessing one.
//
// These used to pick at random from 20000-40000 and accept the number if a
// loopback connect was refused, which was wrong twice over and flaked for real:
// `mints a token for a non-loopback bind` failed roughly one run in four,
// timing out at 5s because the port it had been handed was taken by the time
// runServe bound it, so no listener ever appeared.
//
// Two bugs, one fix. The probe only asked 127.0.0.1, while several tests bind
// the wildcard — a port busy on any other interface answered "free". And the
// gap between probing and binding is a race every parallel vitest worker was
// free to win. Binding port 0 closes both: the kernel only hands out a port
// that is genuinely unused *everywhere*, and it will not hand the same one to a
// concurrent asker while this socket is open. The window between our close and
// the caller's bind is still technically a race, but the kernel does not reuse
// a just-released ephemeral port that eagerly, which is the difference between
// "flakes weekly" and "guesses and hopes".
function askOsForPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no port from listen(0)"))));
    });
  });
}

// A port whose successor is also free. serve binds one port now, but several
// tests assert that the *next* one stays free — that is where the dashboard
// used to land, and "no second listener" is the claim worth pinning down.
export async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = await askOsForPort("0.0.0.0");
    // The successor still has to be checked by hand: listen(0) says nothing
    // about base + 1, and that is the port these tests assert stays empty.
    if (!(await isListening(base + 1))) return base;
  }
  throw new Error("no free port pair");
}

// The wildcard is the default deliberately: a port free on 0.0.0.0 is free on
// every interface, so it is safe for a loopback-binding caller too. The reverse
// is not true, which is what the old loopback-only probe got wrong.
export async function freePort(host = "0.0.0.0"): Promise<number> {
  return askOsForPort(host);
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
