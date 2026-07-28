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

const { runServe } = await import("./serve");
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

  it("still refuses a non-loopback bind without --web", async () => {
    // No link to hand back, so nothing justifies a secret the caller did not
    // choose: a scripted API consumer needs a token stable across restarts.
    await runServe({ port: await freePort(), host: "0.0.0.0", downloadDir: dir });
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("refusing to bind 0.0.0.0 without a token");
  });
});
