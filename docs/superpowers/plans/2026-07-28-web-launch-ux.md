# Web Launch UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `torlnk serve --web` ends with a working dashboard on screen — a reachable URL, a token minted when exposure would otherwise be refused, and a browser opened unless `--headless`.

**Architecture:** A new pure module (`src/web/links.ts`) becomes the single source of browsable URLs, replacing three sites that interpolate the *bind* host and so print `http://0.0.0.0:9161`. `runServe` mints a token when `--web` is set on a non-loopback bind with no token supplied, puts it in the link's fragment (`/#k=…`), and opens the loopback URL through the existing `src/util/openUrl.ts`. A second pure module (`src/web/static/authLink.ts`) lets the browser adopt that fragment and strip it. The TUI gains a `W` key over the same URL builder.

**Tech Stack:** TypeScript, Node 22, vitest, Ink (React for the TUI), tsup. No new dependencies — `node:crypto`, `node:os` and the existing `openUrl` cover everything.

**Spec:** `docs/superpowers/specs/2026-07-28-web-launch-ux-design.md`

---

## File Structure

**Create:**
- `src/web/links.ts` — pure: bind host → browsable host(s), and (host, port, token) → URL. No I/O; the interface list is a parameter.
- `src/web/links.test.ts`
- `src/web/static/authLink.ts` — pure: `#k=<token>` → token. Its own module because `app.ts` has no test (the repo tests client logic through extracted pure models — `searchModel.ts`, `dashboard.ts`, `previewModel.ts` — and leaves `app.ts` as the untested imperative shell).
- `src/web/static/authLink.test.ts`
- `src/daemon/serve.launch.test.ts` — the mint + open behaviour of `runServe`. A new file rather than growing `shutdown.test.ts`, which is about teardown.

**Modify:**
- `src/daemon/serve.ts` — `ServeOptions` gains `headless`, `daemon`, `openUrlImpl`, `isTTY`; the token becomes mintable; the startup log prints browsable URLs; the browser opens. Also the file-header comment's use of "headless".
- `src/web/server.ts:527` — its log line states the bind, not a URL (callers own the browsable URL now).
- `src/cli/args.ts` — `headless` on `SERVE_FLAGS` and the `serve` shape; `--headless` without `--web` is invalid; `HELP_TEXT`.
- `src/cli/args.test.ts` — two `toEqual` serve expectations gain `headless: false`.
- `src/index.tsx` — pass `headless` and `daemon` into `runServe`; the "Headless subcommands" comment.
- `src/web/static/app.ts` — adopt and strip the link token.
- `src/ui/App.tsx` — the splash URL comes from `links.ts`; `W` opens it.
- `src/ui/keymap.ts` — a `shift+w` help row.
- `src/ui/App.web.test.tsx` — assertions for the URL and the `W` key.
- `README.md` — the "In your browser" and "Reaching it from another device" sections.

**Testing notes that bite:**
- Ink tests (`App.web.test.tsx`) use **real timers and `vi.waitFor`** — see that file's header: fake timers cannot drive Ink's MessageChannel-based effect flush. Everything else uses fake timers where timing matters.
- `runServe` only resolves on a signal. The pattern is `newSignalHandler(before)()` then `await done` — copy it from `src/daemon/shutdown.test.ts`, never `process.emit`.
- `process.stdout.isTTY` is false under vitest, which is why `isTTY` is an injected option.

---

## Task 1: `src/web/links.ts` — the one place that knows a browsable URL

**Files:**
- Create: `src/web/links.ts`
- Test: `src/web/links.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/web/links.test.ts`:

```ts
// The bug this module exists to kill: `--host 0.0.0.0` used to be printed
// verbatim as `http://0.0.0.0:9161`, which is not an address a browser can
// visit. Pure by construction — the interface list is a parameter — so every
// case below is exercised without depending on the machine's NICs.
import { describe, it, expect } from "vitest";
import { displayHosts, webUrl, type NetInterfaces } from "./links";

const IFACES: NetInterfaces = {
  lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  eth0: [
    { family: "IPv4", address: "192.168.1.24", internal: false },
    { family: "IPv6", address: "fe80::1", internal: false },
  ],
  docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
};

describe("displayHosts", () => {
  it("maps an IPv4 wildcard to loopback plus every external IPv4", () => {
    expect(displayHosts("0.0.0.0", IFACES)).toEqual({
      local: "127.0.0.1",
      lan: ["192.168.1.24", "172.17.0.1"],
    });
  });
  it("maps an IPv6 wildcard the same way", () => {
    expect(displayHosts("::", IFACES).local).toBe("127.0.0.1");
  });
  it("treats an empty host as a wildcard", () => {
    expect(displayHosts("", IFACES).local).toBe("127.0.0.1");
  });
  it("passes an explicit host through with no LAN list", () => {
    expect(displayHosts("192.168.1.24", IFACES)).toEqual({ local: "192.168.1.24", lan: [] });
  });
  it("brackets an IPv6 literal so it can be concatenated into a URL", () => {
    expect(displayHosts("::1", IFACES)).toEqual({ local: "[::1]", lan: [] });
  });
  it("does not double-bracket an already-bracketed literal", () => {
    expect(displayHosts("[::1]", IFACES).local).toBe("[::1]");
  });
  it("skips internal addresses and IPv6 in the LAN list", () => {
    expect(displayHosts("0.0.0.0", IFACES).lan).not.toContain("127.0.0.1");
    expect(displayHosts("0.0.0.0", IFACES).lan).not.toContain("fe80::1");
  });
  it("yields an empty LAN list on a machine with only loopback", () => {
    expect(displayHosts("0.0.0.0", { lo: IFACES.lo }).lan).toEqual([]);
  });
  it("tolerates the numeric family node used to report", () => {
    const numeric: NetInterfaces = { eth0: [{ family: 4, address: "10.0.0.2", internal: false }] };
    expect(displayHosts("0.0.0.0", numeric).lan).toEqual(["10.0.0.2"]);
  });
  it("tolerates an undefined interface entry", () => {
    expect(displayHosts("0.0.0.0", { eth0: undefined }).lan).toEqual([]);
  });
});

describe("webUrl", () => {
  it("builds a bare URL with no token", () => {
    expect(webUrl("127.0.0.1", 9161)).toBe("http://127.0.0.1:9161");
  });
  it("puts the token in the fragment, never the query", () => {
    expect(webUrl("127.0.0.1", 9161, "abc")).toBe("http://127.0.0.1:9161/#k=abc");
  });
  it("encodes a token with URL-significant characters", () => {
    expect(webUrl("127.0.0.1", 9161, "a b&c")).toBe("http://127.0.0.1:9161/#k=a%20b%26c");
  });
  it("treats an empty token as no token", () => {
    expect(webUrl("127.0.0.1", 9161, "")).toBe("http://127.0.0.1:9161");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/web/links.test.ts`
Expected: FAIL — `Failed to resolve import "./links"`.

- [ ] **Step 3: Write the implementation**

Create `src/web/links.ts`:

```ts
// Turning a bind address into an address a human can open.
//
// These are not the same string, and the whole reason this module exists is that
// treating them as the same shipped a bug: `--host 0.0.0.0` was printed straight
// into the startup log as `http://0.0.0.0:9161`, which resolves to loopback on
// Linux by accident of the resolver and fails outright from Windows or a phone.
// A user pastes it, gets nothing, and concludes the web UI did not start.
//
// Pure on purpose: the interface list is a parameter, so the whole module tests
// without depending on which NICs the developer's machine happens to have.

/** The part of `os.networkInterfaces()` output this module reads. */
export interface NetAddress {
  /** "IPv4" / "IPv6" on modern Node; older builds reported 4 / 6. */
  family: string | number;
  address: string;
  internal: boolean;
}

export type NetInterfaces = Record<string, NetAddress[] | undefined>;

/**
 * Addresses that mean "every interface". None of them is reachable as itself:
 * a wildcard says where to listen, and says nothing about where to connect.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", ""]);

/**
 * The browsable host(s) for a bind address: one to hand the local machine, and
 * the LAN addresses to hand anything else.
 *
 * A wildcard yields loopback plus every external IPv4. IPv6 is deliberately
 * left out of the LAN list — link-local addresses (`fe80::…`) need a scope id to
 * be usable and would be noise in a startup log.
 */
export function displayHosts(
  bindHost: string,
  interfaces: NetInterfaces,
): { local: string; lan: string[] } {
  const host = bindHost.trim();
  if (!WILDCARD_HOSTS.has(host)) return { local: bracket(host), lan: [] };

  const lan: string[] = [];
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      lan.push(entry.address);
    }
  }
  return { local: "127.0.0.1", lan };
}

// An IPv6 literal must be bracketed inside a URL or the port reads as another
// hextet. The colon is a safe detector: no hostname or IPv4 address contains one.
function bracket(host: string): string {
  if (!host.includes(":")) return host;
  return host.startsWith("[") ? host : `[${host}]`;
}

/**
 * The URL to open. A token rides in the *fragment*, not the query string: a
 * fragment never leaves the browser, so the secret stays out of the server's
 * access log and out of any `Referer` a click on the link generates.
 */
export function webUrl(host: string, port: number, token?: string): string {
  const base = `http://${host}:${port}`;
  return token ? `${base}/#k=${encodeURIComponent(token)}` : base;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/web/links.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/web/links.ts src/web/links.test.ts
git commit -m "feat(web): a pure module for browsable URLs

A bind host and a browsable host are not the same string. Treating them as
one printed http://0.0.0.0:9161 as advice."
```

---

## Task 2: Print URLs a browser can visit

**Files:**
- Modify: `src/web/server.ts:527`
- Modify: `src/daemon/serve.ts` (the `--web` log block, currently at 323-327)
- Test: `src/daemon/serve.launch.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/daemon/serve.launch.test.ts`:

```ts
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
    expect(logs.join("\n")).toContain(`http://127.0.0.1:${port}`);
    expect(logs.join("\n")).not.toContain("from your LAN");
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/daemon/serve.launch.test.ts`
Expected: FAIL — the first test finds `http://0.0.0.0` in the log; the third finds no `#k=`.

- [ ] **Step 3: Write the implementation**

In `src/web/server.ts`, add nothing to the imports and change **line 527** from:

```ts
  log(`web ui on http://${host}:${bound}${token ? " (token required)" : " (loopback only)"}`);
```

to:

```ts
  // The bind, not a URL. This server knows where it is listening; it does not
  // know what a browser should type — a wildcard bind has no single answer, and
  // printing `http://0.0.0.0:9161` here is what sent users to a dead address.
  // The browsable URLs are the caller's to log (see web/links.ts).
  log(`web ui listening on ${host}:${bound}${token ? " (token required)" : " (loopback only)"}`);
```

In `src/daemon/serve.ts`, add to the imports at the top of the file:

```ts
import os from "node:os";
import { displayHosts, webUrl } from "../web/links";
```

Then replace the two log lines inside the `if (options.web)` block (currently 323-327, immediately after the `try/catch` around `startWebServer`):

```ts
    log(`listening on http://${host}:${port}  (api + web ui, downloads -> ${runtime.downloadDir})`);
    log(token ? "auth: token required" : "auth: none (loopback only)");
```

with:

```ts
    // The handle's port, not the requested one: it reports what was actually
    // bound, which is the only correct answer once `port: 0` is in play. `web?.`
    // because it is assigned inside the try above, which TypeScript will not
    // narrow through the catch — it is never null here.
    const bound = web?.port ?? port;
    const { local, lan } = displayHosts(host, os.networkInterfaces());
    localUrl = webUrl(local, bound, token ?? undefined);
    log(`web ui on ${localUrl}  (this machine)`);
    for (const address of lan) {
      log(`web ui on ${webUrl(address, bound, token ?? undefined)}  (from your LAN)`);
    }
    log(`api + web ui on one port, downloads -> ${runtime.downloadDir}`);
    log(token ? "auth: token required" : "auth: none (loopback only)");
```

Declare `localUrl` just above the `let web: WebServerHandle | null = null;` line, because Task 6 reads it after this block:

```ts
  // The URL a browser on this machine should open — set once the web server is
  // up, so the browser-open below and the log above cannot disagree.
  let localUrl: string | null = null;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/daemon/serve.launch.test.ts src/daemon/shutdown.test.ts src/web/server.test.ts`
Expected: PASS with no test edits. No existing test asserts on the old `web ui on http://…` wording — verified with `grep -rn "web ui on" src/ --include=*.test.ts`, whose only hits are a test *title* in `shutdown.test.ts:141` and the unrelated `could not start the web ui on port` error at `shutdown.test.ts:222`.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts src/daemon/serve.ts src/daemon/serve.launch.test.ts
git commit -m "fix(serve): print a URL a browser can open, not the bind host

--host 0.0.0.0 printed http://0.0.0.0:9161 as the address to visit. The
server knows where it listens; only the caller can say what to type."
```

---

## Task 3: Mint a token instead of refusing, when `--web` can hand back a link

**Files:**
- Modify: `src/daemon/serve.ts:286-295` (the host/token guard)
- Test: `src/daemon/serve.launch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe` block in `src/daemon/serve.launch.test.ts`:

```ts
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
    expect(logs.join("\n")).not.toContain("token ");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/daemon/serve.launch.test.ts`
Expected: FAIL — the mint tests time out waiting for a listener, because the current guard calls `process.exit` (stubbed) and returns.

- [ ] **Step 3: Write the implementation**

In `src/daemon/serve.ts`, add to the imports:

```ts
import { randomBytes } from "node:crypto";
```

Replace the guard at 286-295:

```ts
  const token = options.token && options.token.trim() ? options.token.trim() : null;

  // Fail soft, not open: never expose a public interface without a token.
  if (!LOOPBACK_HOSTS.has(host) && !token) {
    console.error(
      `error: refusing to bind ${host} without a token. Pass --token <secret> ` +
        `(or set TORLINK_API_TOKEN), or bind 127.0.0.1.`,
    );
    process.exit(1);
    return;
  }
```

with:

```ts
  let token = options.token && options.token.trim() ? options.token.trim() : null;
  let mintedToken = false;

  // Fail soft, not open: never expose a public interface without a token.
  //
  // With --web there is a browser to hand a working link to, so the secret can
  // be minted rather than demanded — that is the whole difference between the
  // two branches. Without --web there is nothing to hand it to: the caller is a
  // script, and a fresh secret every boot is worse than the error it replaced,
  // because the script would start failing 401 instead of failing to start.
  if (!LOOPBACK_HOSTS.has(host) && !token) {
    if (!options.web) {
      console.error(
        `error: refusing to bind ${host} without a token. Pass --token <secret> ` +
          `(or set TORLINK_API_TOKEN), or bind 127.0.0.1.`,
      );
      process.exit(1);
      return;
    }
    token = randomBytes(16).toString("hex");
    mintedToken = true;
  }
```

Then, in the `if (options.web)` block from Task 2, add one line as the last log in the block (after the `api + web ui on one port…` summary — see the Task 2 amendment at the end of this plan; the `auth:` line this originally referred to no longer exists in the `--web` branch):

```ts
    // Unfragmented and on its own line: the link is for the human, this is for
    // whatever script is reading the log.
    if (mintedToken) log(`token ${token}  (pass --token to pin it across restarts)`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/daemon/serve.launch.test.ts src/daemon/shutdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/serve.ts src/daemon/serve.launch.test.ts
git commit -m "feat(serve): mint a token when --web exposes a non-loopback host

The refusal stays wherever there is no link to hand back. Loopback stays
tokenless, so an existing curl against /add is untouched."
```

---

## Task 4: The browser adopts the link's token

**Files:**
- Create: `src/web/static/authLink.ts`
- Create: `src/web/static/authLink.test.ts`
- Modify: `src/web/static/app.ts` (after `storeToken`, around line 165)

- [ ] **Step 1: Write the failing test**

Create `src/web/static/authLink.test.ts`:

```ts
// The magic-link half of the token flow. A pure function because app.ts is the
// untested imperative shell of this layer — every piece of client logic worth a
// test lives in a module like this one (searchModel, dashboard, previewModel).
import { describe, it, expect } from "vitest";
import { tokenFromHash } from "./authLink";

describe("tokenFromHash", () => {
  it("reads the token out of a magic link", () => {
    expect(tokenFromHash("#k=deadbeef")).toBe("deadbeef");
  });
  it("works without the leading hash", () => {
    expect(tokenFromHash("k=deadbeef")).toBe("deadbeef");
  });
  it("decodes a percent-encoded token", () => {
    expect(tokenFromHash("#k=a%20b%26c")).toBe("a b&c");
  });
  it("finds k among other fragment params", () => {
    expect(tokenFromHash("#view=queue&k=deadbeef")).toBe("deadbeef");
  });
  it("returns empty for an empty hash", () => {
    expect(tokenFromHash("")).toBe("");
    expect(tokenFromHash("#")).toBe("");
  });
  it("returns empty when the fragment carries no token", () => {
    expect(tokenFromHash("#view=queue")).toBe("");
  });
  it("returns empty for a present but blank token", () => {
    expect(tokenFromHash("#k=")).toBe("");
    expect(tokenFromHash("#k=%20%20")).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/web/static/authLink.test.ts`
Expected: FAIL — `Failed to resolve import "./authLink"`.

- [ ] **Step 3: Write the implementation**

Create `src/web/static/authLink.ts`:

```ts
// The token a magic link carries.
//
// The fragment, not the query string, and that is the point: a fragment is never
// sent to the server, so a link printed in a startup log and pasted into a
// browser does not put the secret into the server's own access log, nor into the
// `Referer` of anything the page later requests.
//
// `k` matches the name the EventSource URL already uses (searchModel.ts), which
// has to pass the token in a query string because browsers cannot attach headers
// to an EventSource.

/** The token in `#k=<token>`, or "" when the fragment carries none. */
export function tokenFromHash(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return "";
  return (new URLSearchParams(raw).get("k") ?? "").trim();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/web/static/authLink.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire it into `app.ts`**

Add to the imports at the top of `src/web/static/app.ts` (alongside the other `./` imports):

```ts
import { tokenFromHash } from "./authLink";
```

Then, immediately after `let token = readStoredToken();` (currently line 165), insert:

```ts
// A magic link (`…/#k=<token>`) hands this page a working token so the user
// never types one. Adopted into the same sessionStorage slot the unlock form
// writes, then stripped from the address bar: a token that has since been
// rotated must present as the unlock form, and a hash left in place would make
// every reload retry the dead secret instead.
const linkToken = tokenFromHash(location.hash);
if (linkToken) {
  token = linkToken;
  storeToken(token);
  history.replaceState(null, "", location.pathname + location.search);
}
```

**A deliberate deviation from the spec's test list.** The spec asked for an
automated test that the hash is adopted, stripped, and the app unlocks. There is
no DOM test environment in this repo — `vitest.config.ts` sets no `environment`
(so tests run in node) and neither `jsdom` nor `happy-dom` is a dependency — so
that test would mean adding a dev dependency and a second test environment,
which is a larger change than the three lines it would cover. Instead the parsing
(all the logic) is unit-tested above, and the wiring is verified by hand in the
next step. If a DOM environment ever arrives, this is the first thing to cover
with it.

- [ ] **Step 6: Verify the wiring in a real browser**

```bash
npm run build
node dist/index.js serve --web --host 0.0.0.0 &
```

Take the `#k=…` URL from the startup log, open it, and confirm: the dashboard appears with no token prompt, and the address bar no longer shows `#k=`. Then reload — it stays unlocked (sessionStorage). Then `kill %1`.

- [ ] **Step 7: Commit**

```bash
git add src/web/static/authLink.ts src/web/static/authLink.test.ts src/web/static/app.ts
git commit -m "feat(web): adopt a token from the link fragment, then strip it

A fragment never reaches the server, so the secret stays out of the access
log and out of any Referer."
```

---

## Task 5: `--headless` on `serve`

**Files:**
- Modify: `src/cli/args.ts` (the `serve` shape at 27-42, `SERVE_FLAGS` at 113, the `serve` branch at 165-180, `HELP_TEXT`)
- Modify: `src/cli/args.test.ts` (two `toEqual` expectations at 122 and 149)

- [ ] **Step 1: Write the failing test**

Add to `src/cli/args.test.ts` inside the top-level `describe("parseCliArgs")`:

```ts
  it("parses --headless on serve --web", () => {
    expect(parseCliArgs(["serve", "--web", "--headless"])).toMatchObject({
      kind: "serve",
      web: true,
      headless: true,
    });
  });
  it("rejects --headless without --web, naming why", () => {
    expect(parseCliArgs(["serve", "--headless"])).toEqual({
      kind: "invalid",
      arg: "--headless",
      hint: "--headless only means something with --web: it stops torlink opening a browser",
    });
  });
  it("rejects --headless outside serve", () => {
    expect(parseCliArgs(["--headless"])).toEqual({ kind: "invalid", arg: "--headless" });
    expect(parseCliArgs(["watch", "/tmp", "--headless"])).toEqual({
      kind: "invalid",
      arg: "--headless",
    });
    expect(parseCliArgs(["files", "--headless"])).toEqual({
      kind: "invalid",
      arg: "--headless",
    });
  });
```

Also update the two existing full-shape expectations so they still describe the whole object. In `it("parses serve with defaults")` and `it("parses serve flags")`, add `headless: false` next to `web: false`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/cli/args.test.ts`
Expected: FAIL — `--headless` on `serve --web` returns `{ kind: "invalid" }`, and the two updated `toEqual` cases fail on the missing `headless` key.

- [ ] **Step 3: Write the implementation**

In `src/cli/args.ts`, add to the `serve` member of `CliCommand`, after `web?: boolean;`:

```ts
      /**
       * Do not open a browser on startup. Only meaningful with `--web`, which is
       * the only thing that has a browser to open.
       */
      headless?: boolean;
```

Change `SERVE_FLAGS`:

```ts
const SERVE_FLAGS: FlagSpec = {
  values: ["port", "host", "token", "to", "seed-time"],
  bools: ["delete-files", "daemon", "web", "headless"],
};
```

In the `serve` branch, after the `scan.rest.length > 0` check, add the orphan guard, then the field:

```ts
    // Strict, like every other flag on this command: `--headless` with no --web
    // turns nothing off, and accepting it silently is how `--web-host` came to
    // be a flag that did nothing. (The TUI warns instead of erroring for its
    // orphans, in App.tsx — a TUI cannot exit with a message anyone would read.)
    if (scan.bools.has("headless") && !scan.bools.has("web")) {
      return {
        kind: "invalid",
        arg: "--headless",
        hint: "--headless only means something with --web: it stops torlink opening a browser",
      };
    }
    return {
      kind: "serve",
      port: parsePort(scan.flags.port),
      host: scan.flags.host,
      token: scan.flags.token,
      downloadDir: scan.flags.to,
      seedTimeMs: seedTimeFrom(scan.flags["seed-time"]),
      deleteFiles: scan.bools.has("delete-files"),
      daemon: scan.bools.has("daemon"),
      web: scan.bools.has("web"),
      headless: scan.bools.has("headless"),
    };
```

`--headless` on the TUI, `watch` and `files` needs no work: their specs do not list it, so `scanFlags` already returns `{ kind: "invalid", arg: "--headless" }`.

In `HELP_TEXT`, the `--web` block currently reads:

```
web ui (--web): search, posters, streaming, the queue and For You in a
browser, over the same queue as the process hosting it.
  torlnk --web             the TUI hosts it; quitting the TUI stops it
  torlnk serve --web       the daemon hosts it, on serve's own port
It binds --host and --port like everything else — under serve there is one
server, not two: the dashboard's port also answers /add, /downloads and
/control. A non-loopback host is refused without a token.
```

Replace the last sentence and add the launch behaviour:

```
web ui (--web): search, posters, streaming, the queue and For You in a
browser, over the same queue as the process hosting it.
  torlnk --web             the TUI hosts it; quitting the TUI stops it
  torlnk serve --web       the daemon hosts it, on serve's own port
It binds --host and --port like everything else — under serve there is one
server, not two: the dashboard's port also answers /add, /downloads and
/control.

serve --web opens your browser on the link it prints, and mints a token for
you when --host is not loopback (pass --token to pin one across restarts).
--headless prints the link and opens nothing; so does --daemon, and so does
a stdout that is not a terminal. In the TUI, shift+w opens the dashboard.
```

Also fix the three `usage` lines that use "headless" to mean "no TUI", so the word has one meaning:

```
  torlnk watch <dir>          no TUI: download torrents dropped into <dir>
  torlnk serve                no TUI: HTTP add API (POST /add) on :9161
  torlnk serve --web          no TUI: the add API plus the browser UI on :9161
  torlnk files [dir]          no TUI: serve downloads over HTTP on :9160
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/cli/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/args.test.ts
git commit -m "feat(cli): --headless on serve --web, and one meaning for the word

serve called itself headless in its own help text, so the flag needed the
other uses renamed to 'no TUI' before it could mean anything."
```

---

## Task 6: Open the browser

**Files:**
- Modify: `src/daemon/serve.ts` (`ServeOptions`, the `--web` block)
- Modify: `src/index.tsx:60-71` (pass the new options through)
- Test: `src/daemon/serve.launch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/daemon/serve.launch.test.ts`:

```ts
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
```

Add `shouldOpenBrowser` to the import at the top of the file:

```ts
const { runServe, shouldOpenBrowser } = await import("./serve");
```

And append to the `describe("runServe --web startup output")` block:

```ts
  it("opens the loopback link, fragment and all", async () => {
    const port = await freePort();
    const opened: string[] = [];
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({
      port,
      host: "0.0.0.0",
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
    await waitUntil(async () => opened.length > 0);
    // Loopback, never the LAN address: this browser is on this machine.
    expect(opened).toEqual([`http://127.0.0.1:${port}/#k=s3cret`]);
    newSignalHandler(before)();
    await done;
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
    expect(opened).toEqual([]);
    newSignalHandler(before)();
    await done;
  });

  it("survives an opener that fails, and says where to go instead", async () => {
    // A box with no xdg-open must still come up. This used to be the difference
    // between "the dashboard is at <url>" and a dead daemon.
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
    await done;
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/daemon/serve.launch.test.ts`
Expected: FAIL — `shouldOpenBrowser is not a function`, and `openUrlImpl` / `isTTY` are not accepted options.

- [ ] **Step 3: Write the implementation**

In `src/daemon/serve.ts`, add to the imports:

```ts
import { openUrl } from "../util/openUrl";
```

Add to `ServeOptions`, after `web?: boolean;`:

```ts
  /** Do not open a browser. Only meaningful with `web`. */
  headless?: boolean;
  /**
   * This process was detached by `--daemon`. Used only to decide against
   * opening a browser: the parent that had a user has already exited.
   */
  daemon?: boolean;
  /**
   * Whether stdout is a terminal. Injected rather than read here, because
   * vitest's stdout is never a TTY — without this seam the browser-open path
   * would be unreachable from a test, which is exactly the path worth pinning.
   */
  isTTY?: boolean;
  /** The browser opener. Injected so a test does not spawn a real browser. */
  openUrlImpl?: (url: string) => Promise<boolean>;
```

Add the pure decision above `runServe`:

```ts
/**
 * Whether to open a browser on startup. Three ways to say no, and only the
 * first is a preference: `--headless` is the user's, `--daemon` means the
 * process that had a user has already exited, and a non-terminal stdout means
 * nobody is watching (systemd, a pipe, CI) — spawning a browser there puts a
 * window on a machine nobody is sitting at.
 */
export function shouldOpenBrowser(opts: {
  headless?: boolean;
  daemon?: boolean;
  isTTY?: boolean;
}): boolean {
  if (opts.headless) return false;
  if (opts.daemon) return false;
  return opts.isTTY === true;
}
```

At the end of the `if (options.web)` block — after the summary and minted-token log lines (the `auth:` line was dropped from this branch; see the Task 2 amendment at the end of this plan) — add:

```ts
    if (localUrl && shouldOpenBrowser({ ...options, isTTY: options.isTTY ?? process.stdout.isTTY === true })) {
      // Never fails the boot: openUrl swallows its own errors and reports false,
      // and a machine with no xdg-open is a machine that still wants its daemon.
      const opener = options.openUrlImpl ?? openUrl;
      if (!(await opener(localUrl))) log(`could not open a browser — open ${localUrl} yourself`);
    }
```

In `src/index.tsx`, extend the `serve` options object (lines 62-70):

```ts
  const options = {
    port: cmd.port,
    host: cmd.host,
    token: cmd.token ?? process.env.TORLINK_API_TOKEN,
    downloadDir: cmd.downloadDir,
    seedTimeMs: cmd.seedTimeMs,
    deleteFiles: cmd.deleteFiles,
    web: cmd.web,
    headless: cmd.headless,
    daemon: cmd.daemon,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/daemon/serve.launch.test.ts && npx tsc --noEmit`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/serve.ts src/index.tsx src/daemon/serve.launch.test.ts
git commit -m "feat(serve): open the browser on the link it just printed

Three ways to decline: --headless, --daemon, or a stdout nobody is reading."
```

---

## Task 7: The TUI's `W`

**Files:**
- Modify: `src/ui/App.tsx:509` (the splash URL) and the global keymap (after the `input === "V"` branch)
- Modify: `src/ui/keymap.ts` (the `Navigate` help group)
- Test: `src/ui/App.web.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `src/ui/App.web.test.tsx`, inside its top-level `describe`:

```ts
  it("shows a browsable URL on the splash, never the wildcard bind", async () => {
    const start = vi.fn(async () => ({ port: 19004, close: async () => {} }) as WebServerHandle);
    const ui = renderUI(
      <App web webHost="0.0.0.0" webToken="s3cret" startWebServerImpl={start} />,
    );
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      // The splash line is the only place a TUI user reads this address.
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
      ui.press("W");
      await vi.waitFor(() => expect(ui.frame()).toContain("web UI is not running"));
      expect(openUrl).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  });
```

`openUrl` needs a spy in this file. Add near the other `vi.mock` calls at the top:

```ts
const openUrl = vi.hoisted(() => vi.fn(async (_url: string) => true));
vi.mock("../util/openUrl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/openUrl")>()),
  openUrl: (url: string) => openUrl(url),
}));
```

and clear it in the file's existing `beforeEach`:

```ts
    openUrl.mockClear();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/App.web.test.tsx`
Expected: FAIL — the splash shows `http://0.0.0.0:19004`, and `W` does nothing.

- [ ] **Step 3: Write the implementation**

In `src/ui/App.tsx`, add to the imports:

```ts
import os from "node:os";
import { displayHosts, webUrl } from "../web/links";
import { openUrl } from "../util/openUrl";
```

(`openUrl` may already be imported by a sibling component but not by `App.tsx` — check before adding a duplicate.)

Replace line 509:

```ts
        const url = `http://${host}:${started.port}`;
```

with:

```ts
        // Not `host`: a wildcard bind is not an address, and printing it here
        // sent users to http://0.0.0.0:9162. The token rides in the fragment so
        // the link works without typing it (web/links.ts).
        const { local } = displayHosts(host, os.networkInterfaces());
        const url = webUrl(local, started.port, webToken?.trim() || undefined);
```

In the global keymap, add a branch after the `input === "V"` one:

```ts
      if (input === "W") {
        setShowHelp(false);
        if (webStatus && "url" in webStatus) {
          const target = webStatus.url;
          void openUrl(target).then((ok) => {
            if (!ok) setNotice(`Couldn't open a browser — open ${target} yourself`);
          });
        } else {
          setNotice("The web UI is not running — relaunch with --web");
        }
        return;
      }
```

No dependency array to update: Ink's `useInput(handler, { isActive })` takes options, not deps, and re-registers the handler every render — so the branch above always sees the current `webStatus`.

In `src/ui/keymap.ts`, add to the `Navigate` group's `hints`, after the `V` row:

```ts
      { keys: "shift+w", label: "Open the web UI in a browser (needs --web)" },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/App.web.test.tsx src/ui/keymap.test.ts src/ui/components/HelpOverlay.test.tsx`
Expected: PASS. If `HelpOverlay.test.tsx`'s scroll assertions shift because the Navigate group grew one row, adjust the expected scroll offsets — the rows asserted on (`Navigate`, `Seeding`, `Keyboard`) are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/ui/App.tsx src/ui/keymap.ts src/ui/App.web.test.tsx
git commit -m "feat(tui): shift+w opens the dashboard, on a URL that resolves

W lives in the global keymap, not the splash: the splash's search field owns
every printable key."
```

---

## Task 8: Documentation

**Files:**
- Modify: `README.md:182-215`
- Modify: `src/daemon/serve.ts:1` and `src/index.tsx:43` (the loose use of "headless")

- [ ] **Step 1: Update the README**

Replace the paragraph at `README.md:191` (`` `torlnk --web` lands on… ``) with:

```markdown
`torlnk --web` lands on **`http://127.0.0.1:9162`** and prints the address on the splash (shift+w opens it); `torlnk serve --web` lands on serve's own port, **`http://127.0.0.1:9161`**, and opens your browser there for you. Change either with `--port`. Under `serve` there's one server, not two: the same port answers the dashboard *and* `/add`, `/downloads` and `/control`, so there's one address to remember and one thing to firewall.

Pass `--headless` to `serve --web` if you'd rather it just printed the link. It also opens nothing under `--daemon`, or when stdout isn't a terminal — a browser window on a machine nobody is sitting at is not a feature.
```

Replace the "Reaching it from another device" opening (lines 195-203) with:

```markdown
### Reaching it from another device

Binding anything other than loopback **requires** a token — torlink will not leave your queue open to the network. With `--web` it mints one for you, because there's a link to hand it to:

```sh
torlnk serve --web --host 0.0.0.0
# web ui bound to 0.0.0.0:9161 (token required)
# open on this machine:  http://127.0.0.1:9161/#k=8f3c…
# open from your LAN:    http://192.168.1.24:9161/#k=8f3c…
# api + web ui on one port, downloads -> ~/Downloads/torlink
# token 8f3c…  (pass --token to pin it across restarts)
```

The token rides in the link's `#fragment`, which never leaves the browser — so the secret stays out of the server's own access log. The page adopts it and strips it from the address bar.

A minted token is new on every start. Pass your own when something else talks to the API, or when you want a link that keeps working:

```sh
torlnk --web --host 0.0.0.0 --token "$(openssl rand -hex 16)"
torlnk serve --web --host 0.0.0.0 --token "$(openssl rand -hex 16)"
```

Without `--web` there's no link to hand back, so `serve --host 0.0.0.0` still refuses to start without a token: a script needs a secret it chose, not a fresh one every boot.

Both commands read the same three flags — `--host`, `--port`, `--token` — because both are one process making one exposure decision.
```

In the paragraph at line 220 (`You enter the token once in the browser…`), change the opening to:

```markdown
You enter the token once in the browser, or follow a link that carries it.
```

- [ ] **Step 2: Fix the loose "headless"**

`src/daemon/serve.ts:1`, change the header's opening from `// Headless HTTP add API:` to:

```ts
// The HTTP add API (no terminal UI): torlnk exposes a tiny local server so
```

`src/index.tsx:43`, change `// Headless subcommands: run the download queue with no terminal UI` to:

```ts
// Subcommands with no terminal UI: run the download queue headless (for
```

Then grep for any remaining use of the word that means "no TUI":

```bash
grep -rn "headless" src/ README.md | grep -v "options.headless\|cmd.headless\|--headless\|headless:"
```

Expected: only comments that describe *not opening a browser*.

- [ ] **Step 3: Verify the whole suite and a real launch**

```bash
npx vitest run
npx tsc --noEmit
npm run build
node dist/index.js serve --web --host 0.0.0.0
```

Expected: green suite, no type errors, and a startup log with a `127.0.0.1` link, a LAN link, a minted token, and a browser that opens the dashboard already unlocked. `node dist/index.js serve --web --headless` prints the same links and opens nothing. `node dist/index.js serve --headless` exits 1 naming `--web`.

- [ ] **Step 4: Commit**

```bash
git add README.md src/daemon/serve.ts src/index.tsx
git commit -m "docs: the new web launch, and one meaning for 'headless'"
```

---

## Amendment: what Task 2 actually landed

Task 2's code blocks above are what was *specified*; three things changed during
its review, and later tasks should follow this section where the two disagree.

**The log block was reformatted.** As written, the block printed
`0.0.0.0:9161` one line above the good URL differing by a single word, said
`token required` twice two lines apart, and pushed the `(this machine)` marker
past 80 columns where it wrapped to an unpredictable offset. What landed:

```
web ui bound to 0.0.0.0:9161 (token required)
open on this machine:  http://127.0.0.1:9161/#k=8f3c…
open from your LAN:    http://172.25.6.62:9161/#k=8f3c…
api + web ui on one port, downloads -> /home/ash/Downloads/torlink
```

`server.ts` says `web ui bound to` (not `listening on`) so there is only one
`web ui …` line to confuse with the actionable ones. Markers *precede* the URL,
so they align in a column whatever the address width and survive a wrap. The
`auth:` line is gone from the `--web` branch only — the bind line above already
states it. The non-`--web` branch is untouched and keeps its `auth:` line.

**`const bound = web?.port ?? port` became `const bound = web.port`.** The
comment justifying the fallback claimed TypeScript will not narrow `web` through
the `catch`. That was wrong — the `catch` returns, so the fallback was
unreachable, and it was the silently-wrong branch: under `port: 0` it would have
printed `:0` as the address instead of failing loudly.

**`ServeOptions` gained `interfaces?: NetInterfaces`**, defaulting to
`os.networkInterfaces()`. Without it the LAN branch was unreachable from a test,
and mutation testing found that the entire `for (const address of lan)` loop and
its marker could be deleted with a green suite. Same argument as Task 6's
`isTTY` seam. The shared test helpers also moved to `src/daemon/testHarness.ts`
(following `src/ui/testHarness.ts`), which both `serve.launch.test.ts` and
`shutdown.test.ts` now import.

## Amendment: what later tasks changed

**Task 3 (minting) forced two security fixes the plan never mentioned.** The
minted token is printed to stdout, and under `--daemon` stdout is a file on
disk: `src/daemon/daemonize.ts` now creates the log `0600` and `fchmod`s it on
every spawn, because existing installs already have a world-readable one. The
run descriptor beside it got the same treatment — `torlnk update` relaunches a
daemon from it, so it stores the whole argv, and a `--token <secret>` is in
there verbatim.

**Task 6's browser-open is deliberately not awaited.** Awaiting it ran up to ~8s
of `xdg-open`/`gio` (4s each in `util/openFolder.ts`) *before* the SIGINT/SIGTERM
handlers were registered, because `--web` skips the `if (server)` block that
would otherwise sit between them. A Ctrl-C in that window hit Node's default
disposition, and since the boot marker stays armed until `queue.suspend()` and
`BOOT_SETTLE_MS` is 4000 — almost exactly that window — the next launch restored
everything paused. `shouldOpenBrowser` is also called with three named fields
rather than `{ ...options }`: excess-property checking does not reach spread-in
properties, so renaming `ServeOptions.headless` would have kept compiling while
`--headless` silently stopped working.

**Task 7's `shift+w` has three states, not two.** A failed bind is not the same
as no `--web`, and telling someone who passed the flag to pass it sends them in
a circle.

**A test-harness lesson worth keeping.** Two Ink tests waited on strings that
were *already on screen*, so the wait yielded nothing, the keystroke was still
unread in the harness's stdin at unmount, and every assertion after it passed
vacuously — one stayed green with the branch it guarded hoisted above its guard.
In this harness a flush assertion must be one that was **false** before the
press. `src/daemon/testHarness.ts` also asks the OS for ports now instead of
guessing: the old probe checked only loopback while several tests bind the
wildcard, and lost the race with parallel workers about one run in four.

## Out of scope

WSL2 NAT reachability. The LAN address this now prints truthfully (e.g. `172.25.6.62` under WSL2 without mirrored networking) is still unreachable from other machines without a `netsh interface portproxy` rule and a firewall opening on the Windows host. Printing the real interface address is as far as this goes; a WSL-detection hint was considered and left out.
