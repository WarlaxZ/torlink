// What `runServe --web` tells the user, and what it opens.
//
// Separate from shutdown.test.ts (which is about teardown) and sharing its
// harness (testHarness.ts): real sockets, because "what got printed for this
// bind" is only observable once something is actually listening, and
// `startRuntime` stubbed, because the real one loads the user's config and
// arms a boot marker.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { NetInterfaces } from "../web/links";
import {
  fakeRuntime,
  isListening,
  waitUntil,
  withTimeout,
  freePort,
  newSignalHandler,
  snapshotSignalListeners,
  restoreSignalListeners,
} from "./testHarness";

const startRuntime = vi.hoisted(() => vi.fn());
vi.mock("./runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime")>()),
  startRuntime,
}));
// runServe auto-provisions an anonymous reccd account on every call. The
// ambient TORLINK_RECC_URL guard in test-setup.ts already stops this from
// reaching the real host, but this file calls the real runServe directly, so
// it gets its own mock too — same belt-and-braces layering as
// App.web.test.tsx, for the same reason: a single line of defence is exactly
// what let the earlier incident happen.
vi.mock("../recc/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../recc/provision")>()),
  ensureReccAccount: vi.fn(async () => {}),
}));

const { runServe, shouldOpenBrowser } = await import("./serve");
const { disarmBootMarker } = await import("../download/bootguard");

// Same shape as web/links.test.ts's IFACES: a loopback entry, an external
// IPv4 (what a LAN line should show), and an IPv6 link-local (which the LAN
// list deliberately omits — see links.ts for why).
const IFACES: NetInterfaces = {
  lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  eth0: [
    { family: "IPv4", address: "192.168.1.24", internal: false },
    { family: "IPv6", address: "fe80::1", internal: false },
  ],
  docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
};

// Lines this suite cares about, pulled out once so every test filters the
// same way regardless of exact wording elsewhere in the log.
function perHostLines(logs: string[]): string[] {
  return logs.filter((l) => l.includes("open on ") || l.includes("open from "));
}

// A happens-after barrier for the "opener was not called" tests: the log line
// below is the very last thing the `if (options.web)` block writes, after
// which the browser-open decision has already been made (fire-and-forget or
// not). Asserting `opened` is empty right after `isListening` goes true was
// only passing on incidental ordering — with the open now fired without an
// `await` (so a slow opener can't block startup), that luck matters more, not
// less, so a negative assertion waits for this line first.
async function waitForBootLine(logs: string[]): Promise<void> {
  expect(await waitUntil(async () => logs.some((l) => l.includes("api + web ui on one port")))).toBe(true);
}

describe("runServe --web startup output", () => {
  let dir: string;
  let logs: string[];
  let errors: string[];
  let signals: ReturnType<typeof snapshotSignalListeners>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-launch-"));
    startRuntime.mockReset();
    startRuntime.mockResolvedValue(fakeRuntime(dir).runtime);
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    signals = snapshotSignalListeners();
  });

  afterEach(async () => {
    restoreSignalListeners(signals);
    vi.restoreAllMocks();
    disarmBootMarker();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("ignores an injected LAN-shaped interfaces fixture for an explicit host", async () => {
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    // A loopback bind, not host: "0.0.0.0" — binding the real wildcard address
    // risks a macOS firewall prompt and briefly exposes a port to the LAN in
    // CI. `interfaces` carries addresses that *would* show up as LAN lines if
    // the bind were a wildcard, so this still exercises something real: that
    // displayHosts's non-wildcard branch (see web/links.ts) truly ignores the
    // interface list rather than passing only because the test runner's own
    // NICs happen to have nothing external.
    const done = runServe({
      port,
      host: "127.0.0.1",
      token: "s3cret",
      web: true,
      downloadDir: dir,
      interfaces: IFACES,
    });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    // The whole bug: a bare 0.0.0.0 (with or without a scheme) used to be the
    // advice the user was given. Checked against the per-host lines
    // specifically, not the whole log, so a regression elsewhere in the log
    // block can't hide a real failure here.
    expect(perHostLines(logs).some((l) => l.includes("0.0.0.0"))).toBe(false);
    expect(logs.join("\n")).toContain(`http://127.0.0.1:${port}`);
    expect(logs.join("\n")).not.toContain("open from your LAN");

    newSignalHandler(before)();
    await done;
  });

  it("prints a loopback URL for a loopback bind, with no LAN lines", async () => {
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    expect(logs.join("\n")).toContain(`open on this machine:  http://127.0.0.1:${port}`);
    expect(logs.join("\n")).not.toContain("open from your LAN");
    // Exactly one per-host line: a loopback bind has one host to report.
    expect(perHostLines(logs)).toHaveLength(1);
    newSignalHandler(before)();
    await done;
  });

  it("puts a supplied token in the link fragment", async () => {
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({
      port,
      host: "127.0.0.1",
      token: "s3cret",
      web: true,
      downloadDir: dir,
    });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    expect(logs.join("\n")).toContain(`http://127.0.0.1:${port}/#k=s3cret`);
    newSignalHandler(before)();
    await done;
  });

  it("prints every LAN address from an injected interfaces fixture, exactly once each", async () => {
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    // A real wildcard bind, kept deliberately: displayHosts only takes its LAN
    // branch when the *bind* host is a wildcard (see web/links.ts), so there is
    // no way to exercise it without one — a loopback bind ignores `interfaces`
    // entirely, which is exactly what the test above pins. `interfaces` is
    // still injected so the LAN addresses asserted below are the fixture's,
    // not whatever NICs happen to be present on the machine running this
    // suite. A token is required here for the same reason it would be in
    // production: runServe refuses to bind a non-loopback host without one.
    const done = runServe({
      port,
      host: "0.0.0.0",
      token: "s3cret",
      web: true,
      downloadDir: dir,
      interfaces: IFACES,
    });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    const lines = perHostLines(logs);
    expect(lines.some((l) => l.includes("0.0.0.0"))).toBe(false);
    // The other half of this task lives in web/server.ts, and this is the only
    // assertion covering it. Narrowing the check above to the per-host lines
    // excluded that file's bind line by construction — reverting it to the
    // original `web ui on http://0.0.0.0:9161` passed 701 tests. Pinned
    // positively, on the new wording, so a third rewording is caught too.
    expect(logs.join("\n")).toContain(`web ui bound to 0.0.0.0:${port}`);
    expect(logs.join("\n")).toContain(`open on this machine:  http://127.0.0.1:${port}/#k=s3cret`);
    expect(logs.join("\n")).toContain(`open from your LAN:    http://192.168.1.24:${port}/#k=s3cret`);
    expect(logs.join("\n")).toContain(`open from your LAN:    http://172.17.0.1:${port}/#k=s3cret`);
    // Two LAN addresses in the fixture, plus the local line: three total, and
    // no more — a regression that duplicated the loop or re-ran it would
    // otherwise slip past the two toContain checks above.
    expect(lines).toHaveLength(3);

    newSignalHandler(before)();
    await done;
  });

  it("logs the port actually bound, not the literal 0 requested with port: 0", async () => {
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port: 0, web: true, downloadDir: dir });
    expect(
      await waitUntil(async () => logs.some((l) => l.includes("open on this machine:"))),
    ).toBe(true);

    const line = logs.find((l) => l.includes("open on this machine:")) ?? "";
    const match = line.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    expect(match).not.toBeNull();
    const bound = Number(match![1]);
    expect(bound).toBeGreaterThan(0);
    expect(await isListening(bound)).toBe(true);

    newSignalHandler(before)();
    await done;
  });

  it("mints a token for a non-loopback bind with --web and no token", async () => {
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, host: "0.0.0.0", web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    const minted = /\b([0-9a-f]{32})\b/.exec(logs.join("\n"))?.[1];
    expect(minted).toBeDefined();
    // Printed unfragmented too, so a script can scrape it out of the log.
    expect(logs.join("\n")).toContain(`token ${minted}`);
    expect(logs.join("\n")).toContain(`#k=${minted}`);

    // And it is the real credential, not decoration.
    const denied = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Authorization: `Bearer ${minted}` },
    });
    expect(allowed.status).toBe(200);

    newSignalHandler(before)();
    await done;
  });

  it("mints a different token each boot — not a fixed placeholder", async () => {
    // The other mint test only pins shape (32 hex chars) and that the token
    // actually gates the API; a hardcoded 32-char constant would pass both.
    // Two boots minting the same value is the concrete failure that would slip
    // through otherwise: everyone on the LAN sharing one baked-in "secret".
    const portA = await freePort();
    const beforeA = new Set(process.listeners("SIGTERM"));
    const doneA = runServe({ port: portA, host: "0.0.0.0", web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(portA))).toBe(true);
    const mintedA = /\btoken ([0-9a-f]{32})\b/.exec(logs.join("\n"))?.[1];
    expect(mintedA).toBeDefined();
    newSignalHandler(beforeA)();
    await doneA;

    logs.length = 0;
    const portB = await freePort();
    const beforeB = new Set(process.listeners("SIGTERM"));
    const doneB = runServe({ port: portB, host: "0.0.0.0", web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(portB))).toBe(true);
    const mintedB = /\btoken ([0-9a-f]{32})\b/.exec(logs.join("\n"))?.[1];
    expect(mintedB).toBeDefined();
    newSignalHandler(beforeB)();
    await doneB;

    expect(mintedA).not.toBe(mintedB);
  });

  it("does not mint on a loopback bind — a tokenless local API keeps working", async () => {
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    expect(logs.join("\n")).not.toMatch(/\b[0-9a-f]{32}\b/);
    const open = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(open.status).toBe(200);
    newSignalHandler(before)();
    await done;
  });

  it("never overrides a supplied token", async () => {
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, host: "0.0.0.0", token: "s3cret", web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    const allowed = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(allowed.status).toBe(200);
    expect(logs.join("\n")).not.toMatch(/\b[0-9a-f]{32}\b/);
    newSignalHandler(before)();
    await done;
  });

  it("does not mint a token for a non-loopback --web bind when Access is enforced", async () => {
    // Access at the origin is a strictly stronger gate than a token, so the
    // bind is allowed tokenless — and NOT minted one: a minted token would
    // break the browser UI behind a tunnel, which is the whole point of Access.
    process.env.TORLINK_CF_ACCESS_TEAM_DOMAIN = "myteam.cloudflareaccess.com";
    process.env.TORLINK_CF_ACCESS_AUD = "aud-tag-123";
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    try {
      const done = runServe({ port, host: "0.0.0.0", web: true, downloadDir: dir });
      expect(await waitUntil(() => isListening(port))).toBe(true);
      // No 32-hex minted secret anywhere in the log.
      expect(logs.join("\n")).not.toMatch(/\b[0-9a-f]{32}\b/);
      // And it is Access, not a token, gating the API: a tokenless request is
      // 403 (the Access guard), never 401 (a token check that isn't there).
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(res.status).toBe(403);
      newSignalHandler(before)();
      await done;
    } finally {
      delete process.env.TORLINK_CF_ACCESS_TEAM_DOMAIN;
      delete process.env.TORLINK_CF_ACCESS_AUD;
    }
  });

  it("still refuses a non-loopback bind without --web", async () => {
    // No link to hand back, so nothing justifies a secret the caller did not
    // choose: a scripted API consumer needs a token stable across restarts.
    //
    // Bounded, because `process.exit` is stubbed here: if this guard regresses
    // into minting, runServe goes on to bind a socket and never resolves, and
    // the failure arrives as a bare 5s vitest timeout that says nothing about
    // what broke. withTimeout names it in one second instead.
    await withTimeout(
      runServe({ port: await freePort(), host: "0.0.0.0", downloadDir: dir }),
      1000,
      "the refusal to bind 0.0.0.0 without a token",
    );
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("refusing to bind 0.0.0.0 without a token");
  });

  it("opens the loopback link, fragment and all", async () => {
    const port = await freePort();
    const opened: string[] = [];
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({
      port,
      host: "127.0.0.1",
      token: "s3cret",
      web: true,
      downloadDir: dir,
      isTTY: true,
      openUrlImpl: async (url: string) => {
        opened.push(url);
        return true;
      },
    });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    expect(await waitUntil(async () => opened.length > 0)).toBe(true);
    expect(opened).toEqual([`http://127.0.0.1:${port}/#k=s3cret`]);
    newSignalHandler(before)();
    await withTimeout(done, 1000, "shutdown after opening the loopback link");
  });

  it("falls back to the real process.stdout.isTTY when none is injected", async () => {
    // The production default, and the one branch every other test here steps
    // around by passing `isTTY` explicitly: `options.isTTY ?? process.stdout
    // .isTTY === true`. Replacing that whole expression with a bare
    // `options.isTTY` used to break nothing at all.
    //
    // Safe to drive for real because the *opener* is still injected — this
    // makes the decision take the production path without any chance of a
    // browser window opening on the machine running the suite. vitest's stdout
    // is never a TTY, hence the override.
    const port = await freePort();
    const opened: string[] = [];
    const before = new Set(process.listeners("SIGTERM"));
    const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true, writable: true });
    try {
      const done = runServe({
        port,
        web: true,
        downloadDir: dir,
        openUrlImpl: async (url: string) => {
          opened.push(url);
          return true;
        },
      });
      expect(await waitUntil(() => isListening(port))).toBe(true);
      // 1.5s, not the 5s default: the open happens within milliseconds of the
      // listener coming up, so a regression here should report in a second
      // rather than sitting on the default and looking like a slow machine.
      expect(await waitUntil(async () => opened.length > 0, 1500)).toBe(true);
      expect(opened).toEqual([`http://127.0.0.1:${port}`]);
      newSignalHandler(before)();
      await withTimeout(done, 1000, "shutdown after the isTTY fallback open");
    } finally {
      // Restored precisely, not deleted: leaving isTTY true would make every
      // later test in this worker think it was attached to a terminal.
      if (original) Object.defineProperty(process.stdout, "isTTY", original);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  it("opens nothing under --headless", async () => {
    const port = await freePort();
    const opened: string[] = [];
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({
      port,
      web: true,
      downloadDir: dir,
      headless: true,
      isTTY: true,
      openUrlImpl: async (url: string) => {
        opened.push(url);
        return true;
      },
    });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    await waitForBootLine(logs);
    expect(opened).toEqual([]);
    newSignalHandler(before)();
    await withTimeout(done, 1000, "shutdown after a headless boot");
  });

  it("opens nothing under --daemon — the detached child has no user to show it to", async () => {
    // runServe itself never calls daemonize() (that lives in index.tsx, the
    // process that forks the detached child) — passing daemon: true here forks
    // nothing, it only feeds the same flag the real detached child's argv
    // would carry through to runServe.
    const port = await freePort();
    const opened: string[] = [];
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({
      port,
      web: true,
      downloadDir: dir,
      daemon: true,
      isTTY: true,
      openUrlImpl: async (url: string) => {
        opened.push(url);
        return true;
      },
    });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    await waitForBootLine(logs);
    expect(opened).toEqual([]);
    newSignalHandler(before)();
    await withTimeout(done, 1000, "shutdown after a --daemon boot");
  });

  it("opens nothing when stdout is not a terminal", async () => {
    const port = await freePort();
    const opened: string[] = [];
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({
      port,
      web: true,
      downloadDir: dir,
      isTTY: false,
      openUrlImpl: async (url: string) => {
        opened.push(url);
        return true;
      },
    });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    await waitForBootLine(logs);
    expect(opened).toEqual([]);
    newSignalHandler(before)();
    await withTimeout(done, 1000, "shutdown after a non-terminal boot");
  });

  it("survives an opener that fails, and says where to go instead", async () => {
    // A box with no xdg-open must still come up. This is the difference between
    // "the dashboard is at <url>" and a dead daemon.
    const port = await freePort();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({
      port,
      web: true,
      downloadDir: dir,
      isTTY: true,
      openUrlImpl: async () => false,
    });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    expect(await waitUntil(async () => logs.join("\n").includes("could not open a browser"))).toBe(true);
    expect(logs.join("\n")).toContain(`http://127.0.0.1:${port}`);
    const alive = await fetch(`http://127.0.0.1:${port}/health`);
    expect(alive.status).toBe(200);
    newSignalHandler(before)();
    await withTimeout(done, 1000, "shutdown after a failed browser open");
  });

  it("opens the loopback URL, never the LAN one, for a wildcard bind", async () => {
    // The browser runs on this machine, not out on the LAN — even though a LAN
    // address would often work too, opening it would be the wrong choice, and
    // a bug that grabbed the last logged URL instead of the local one would
    // pick a LAN address whenever `interfaces` reports any.
    const port = await freePort();
    const opened: string[] = [];
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({
      port,
      host: "0.0.0.0",
      token: "s3cret",
      web: true,
      downloadDir: dir,
      interfaces: IFACES,
      isTTY: true,
      openUrlImpl: async (url: string) => {
        opened.push(url);
        return true;
      },
    });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    expect(await waitUntil(async () => opened.length > 0)).toBe(true);
    expect(opened).toEqual([`http://127.0.0.1:${port}/#k=s3cret`]);
    newSignalHandler(before)();
    await withTimeout(done, 1000, "shutdown after opening the loopback URL over a wildcard bind");
  });
});

describe("shouldOpenBrowser", () => {
  it("opens for an interactive foreground serve --web", () => {
    expect(shouldOpenBrowser({ headless: false, daemon: false, isTTY: true })).toBe(true);
  });
  it("does not open when --headless was passed", () => {
    expect(shouldOpenBrowser({ headless: true, daemon: false, isTTY: true })).toBe(false);
  });
  it("does not open under --daemon — the child has no user", () => {
    expect(shouldOpenBrowser({ headless: false, daemon: true, isTTY: true })).toBe(false);
  });
  it("does not open when stdout is not a terminal", () => {
    // systemd, a pipe, CI: nothing is watching, and a browser would be a
    // process spawned on a machine nobody is sitting at.
    expect(shouldOpenBrowser({ headless: false, daemon: false, isTTY: false })).toBe(false);
  });
});
