# Torrent Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Stream action (`v`) work peer-to-peer via WebTorrent when Real-Debrid isn't configured, streaming a torrent's largest video into the user's media player while it downloads to a temp dir.

**Architecture:** A new self-contained `torrentStream` engine turns a magnet into a locally-served HTTP URL (WebTorrent's built-in Node server) and returns files in the same `{ url, filename, bytes }` shape Real-Debrid produces, so the existing stream picker and player-launch code are reused unchanged. `streamResult` in `App.tsx` gains a pure decision branch: no RD token → torrent (warn once, remembered); RD configured but not working → always-warn confirm; RD working → unchanged. Streaming is ephemeral (temp dir, auto-cleaned) with an offer-to-keep prompt when the file finished.

**Tech Stack:** TypeScript, React + Ink (terminal UI), WebTorrent 2.x, Vitest.

## Global Constraints

- Node 22+ (project floor). Do not touch `.venv` or `node_modules`.
- Run `npm run lint`* and `npm test` before considering any task done. (*If no `lint` script exists, run `npm run typecheck`; the repo uses `tsc --noEmit`.)
- TDD: write the failing test first, prove it fails, then implement.
- WebTorrent is already a dependency (`webtorrent@^2.4.1`, installed 2.8.5). Do not add new runtime dependencies.
- Never *silently* fall back to peer-to-peer when Real-Debrid is configured — P2P exposes the user's real IP; a configured user expects RD's proxy. "Not configured" (no token) and "configured but not working" (present token that is non-premium or errors) are distinct states with distinct behaviour.
- Mock WebTorrent's network layer in tests (no real swarm), mirroring `src/download/queue.test.ts`.

---

## File Structure

- `src/util/player.ts` — **modify.** Becomes the home of the shared `StreamFile` shape (currently `ResolvedFile` lives in `realdebrid.ts`).
- `src/integrations/realdebrid.ts` — **modify.** Re-export `ResolvedFile` as an alias of `StreamFile` (keeps every existing import working).
- `src/webtorrent.d.ts` — **modify.** Add the client `createServer()` + Node server types.
- `src/integrations/torrentStream.ts` — **create.** The magnet → playable-URL engine.
- `src/integrations/torrentStream.test.ts` — **create.**
- `src/ui/streamRoute.ts` — **create.** Pure RD-state → route decision.
- `src/ui/streamRoute.test.ts` — **create.**
- `src/config/config.ts` — **modify.** Add `torrentStreamAck?: boolean`.
- `src/config/config.test.ts` — **modify.** Round-trip test for the new field.
- `src/ui/App.tsx` — **modify.** Route branch, active-stream state, stop key, prompts, keep flow.
- `src/ui/keymap.ts` — **modify.** Update the `v` label and add the stop hint.
- `src/ui/streamKeep.ts` — **create.** Pure helper for the keep move-path decision.
- `src/ui/streamKeep.test.ts` — **create.**

---

## Task 1: Shared `StreamFile` type

**Files:**
- Modify: `src/util/player.ts` (top of file + `pickStreamFile`/`streamCandidates` signatures)
- Modify: `src/integrations/realdebrid.ts:20-24`

**Interfaces:**
- Produces: `export interface StreamFile { url: string; filename: string; bytes: number }` in `src/util/player.ts`. `ResolvedFile` becomes `export type ResolvedFile = StreamFile` in `realdebrid.ts`. Because the shapes are structurally identical, all existing consumers keep compiling.

- [ ] **Step 1: Define `StreamFile` in `player.ts`**

`src/util/player.ts` currently begins by importing `ResolvedFile` from `realdebrid`. Replace that import with a local definition and use it throughout the file:

```ts
// at top of src/util/player.ts — remove:  import type { ResolvedFile } from "../integrations/realdebrid";
// add:
export interface StreamFile {
  url: string;
  filename: string;
  bytes: number;
}
```

Then replace the two `ResolvedFile` usages in this file (`pickStreamFile(files: ResolvedFile[])`, `streamCandidates(files: ResolvedFile[])`) with `StreamFile`.

- [ ] **Step 2: Re-point `ResolvedFile` in `realdebrid.ts`**

In `src/integrations/realdebrid.ts`, replace the interface (lines 20-24):

```ts
import type { StreamFile } from "../util/player";

// A resolved, directly-fetchable file (Real-Debrid direct link, or a
// local torrent-stream URL). Structurally identical to StreamFile.
export type ResolvedFile = StreamFile;
```

- [ ] **Step 3: Run typecheck to verify no breakage**

Run: `npm run typecheck`
Expected: PASS (all existing `ResolvedFile` imports in `App.tsx`, `StreamFilePrompt.tsx` still resolve via the alias).

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS (no behavioural change; `player.test.ts` still green).

- [ ] **Step 5: Commit**

```bash
git add src/util/player.ts src/integrations/realdebrid.ts
git commit -m "refactor: extract shared StreamFile shape for streaming sources"
```

---

## Task 2: Stream-route decision (pure function)

**Files:**
- Create: `src/ui/streamRoute.ts`
- Test: `src/ui/streamRoute.test.ts`

**Interfaces:**
- Consumes: `Config` (`src/config/config.ts`), `RdStatus` (`src/integrations/rdStatus.ts`), and `resolveRealDebridToken` (`src/config/config.ts`).
- Produces:
```ts
export type StreamRoute =
  | { kind: "realdebrid" }                    // attempt RD (working, or premium-unknown)
  | { kind: "torrent-auto" }                  // no RD token → torrent (one-time warn)
  | { kind: "torrent-confirm"; reason: string }; // RD configured but not working → always warn

export function classifyStreamRoute(config: Config, rdStatus: RdStatus | null): StreamRoute;
```

- [ ] **Step 1: Write the failing test**

`src/ui/streamRoute.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyStreamRoute } from "./streamRoute";
import type { Config } from "../config/config";
import type { RdStatus } from "../integrations/rdStatus";

const base: Config = { downloadDir: "/tmp/dl", trackers: [] };
const withToken: Config = { ...base, realDebridToken: "tok" };

describe("classifyStreamRoute", () => {
  it("no token -> torrent-auto", () => {
    expect(classifyStreamRoute(base, null)).toEqual({ kind: "torrent-auto" });
  });

  it("token + premium -> realdebrid", () => {
    const rd: RdStatus = { username: "u", premium: true, premiumUntil: null };
    expect(classifyStreamRoute(withToken, rd)).toEqual({ kind: "realdebrid" });
  });

  it("token + status unknown -> realdebrid (let the attempt decide)", () => {
    expect(classifyStreamRoute(withToken, null)).toEqual({ kind: "realdebrid" });
  });

  it("token + non-premium -> torrent-confirm with a reason", () => {
    const rd: RdStatus = { username: "u", premium: false, premiumUntil: null };
    const r = classifyStreamRoute(withToken, rd);
    expect(r.kind).toBe("torrent-confirm");
    expect((r as { reason: string }).reason).toMatch(/premium/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- streamRoute`
Expected: FAIL (`classifyStreamRoute` not defined).

- [ ] **Step 3: Implement**

`src/ui/streamRoute.ts`:

```ts
import { type Config, resolveRealDebridToken } from "../config/config";
import type { RdStatus } from "../integrations/rdStatus";

export type StreamRoute =
  | { kind: "realdebrid" }
  | { kind: "torrent-auto" }
  | { kind: "torrent-confirm"; reason: string };

// Decide how `v` should stream, given RD config + last-known account status.
// "Not configured" (no token) auto-routes to torrent; a present-but-non-premium
// token is "configured but not working" and requires an explicit confirm so we
// never silently expose the user's IP after they set RD up.
export function classifyStreamRoute(config: Config, rdStatus: RdStatus | null): StreamRoute {
  if (!resolveRealDebridToken(config)) return { kind: "torrent-auto" };
  if (rdStatus && !rdStatus.premium) {
    return { kind: "torrent-confirm", reason: "your Real-Debrid premium isn't active" };
  }
  return { kind: "realdebrid" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- streamRoute`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/streamRoute.ts src/ui/streamRoute.test.ts
git commit -m "feat: add stream-route decision (RD vs torrent)"
```

---

## Task 3: Config field for the one-time privacy acknowledgement

**Files:**
- Modify: `src/config/config.ts` (`Config` interface, near `mediaPlayer?`)
- Test: `src/config/config.test.ts`

**Interfaces:**
- Produces: `Config.torrentStreamAck?: boolean` — set true once the user has acknowledged that torrent streaming exposes their IP (the not-configured path only). Absent/false = not acknowledged.

- [ ] **Step 1: Write the failing test**

Add to `src/config/config.test.ts` (match the file's existing import/style; adapt the loader call to whatever helper the file already uses to read/write config):

```ts
it("persists torrentStreamAck across a write/read round-trip", async () => {
  const cfg = { ...defaultConfig, torrentStreamAck: true };
  await writeConfig(cfg);            // use the same write helper other tests use
  const read = await loadConfig();   // use the same load helper other tests use
  expect(read.torrentStreamAck).toBe(true);
});
```

If the config test file has no such round-trip helper, instead assert the field is accepted by the type and defaults to `undefined`:

```ts
it("defaults torrentStreamAck to undefined", () => {
  expect(defaultConfig.torrentStreamAck).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL (property `torrentStreamAck` does not exist on type `Config`).

- [ ] **Step 3: Implement**

In `src/config/config.ts`, add to the `Config` interface just after `mediaPlayer?`:

```ts
  // Set once the user has acknowledged that streaming via torrent exposes their
  // IP to the swarm (the no-Real-Debrid path). Absent/false = not yet warned.
  torrentStreamAck?: boolean;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts src/config/config.test.ts
git commit -m "feat: add torrentStreamAck config field"
```

---

## Task 4: Torrent stream engine

**Files:**
- Modify: `src/webtorrent.d.ts`
- Create: `src/integrations/torrentStream.ts`
- Test: `src/integrations/torrentStream.test.ts`

**Interfaces:**
- Consumes: `StreamFile` (`src/util/player.ts`), `WebTorrent` (`webtorrent`).
- Produces:
```ts
export interface TorrentStreamSession {
  name: string;
  files: StreamFile[];        // all files, mapped to local server URLs
  dir: string;                // temp download dir (root)
  isComplete(): boolean;      // torrent fully downloaded (safe to keep)
  stop(opts?: { keep?: boolean }): Promise<void>; // close server + client; rm dir unless keep
}

export interface StreamTorrentOptions {
  signal?: AbortSignal;
  metadataTimeoutMs?: number;                       // default 60_000
  // Injection seams for tests:
  createClient?: () => WebTorrentLike;
  tmpBase?: string;                                 // default os.tmpdir()
  mkdtemp?: (prefix: string) => Promise<string>;
  rm?: (dir: string) => Promise<void>;
}

export function streamTorrent(magnet: string, opts?: StreamTorrentOptions): Promise<TorrentStreamSession>;
```
`WebTorrentLike` is the minimal structural subset the engine touches (see Step 3), so tests can pass a fake without a real swarm.

- [ ] **Step 1: Extend the WebTorrent type shim**

WebTorrent's server lives on the **client** (`client.createServer(opts?)`) and serves each file at `http://<host>:<port>/webtorrent/<infoHash>/<encodeURI(file.path)>` (verified in `node_modules/webtorrent/lib/server.js`: `serveTorrentPage` builds `${pathname}/${torrent.infoHash}/${file.path}` and the request handler does `decodeURI` then matches `file.path.replace(/\\/g,'/')`).

Add to `src/webtorrent.d.ts` inside the `WebTorrent` class and module:

```ts
  interface TorrentServer {
    listen(port?: number, hostname?: string, cb?: () => void): void;
    address(): { port: number } | null;
    close(cb?: () => void): void;
    destroy(cb?: () => void): void;
  }
```
and add to the `WebTorrent` class body:
```ts
    createServer(opts?: { hostname?: string; pathname?: string }): TorrentServer;
```
Export `TorrentServer` from the module alongside `Torrent`/`TorrentFile`.

- [ ] **Step 2: Write the failing test**

`src/integrations/torrentStream.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { streamTorrent } from "./torrentStream";

// Minimal fakes ---------------------------------------------------------------
function fakeServer() {
  return {
    listen: (_p: number, _h: string | (() => void), cb?: () => void) => {
      const done = typeof _h === "function" ? _h : cb;
      done?.();
    },
    address: () => ({ port: 54321 }),
    close: (cb?: () => void) => cb?.(),
    destroy: (cb?: () => void) => cb?.(),
  };
}

function fakeTorrent() {
  const t = new EventEmitter() as any;
  t.infoHash = "abc123";
  t.name = "Big Buck Bunny";
  t.done = false;
  t.files = [
    { name: "readme.txt", path: "Big Buck Bunny/readme.txt", length: 100 },
    { name: "bbb.mp4", path: "Big Buck Bunny/bbb.mp4", length: 5000 },
  ];
  return t;
}

function fakeClient(torrent: any) {
  return {
    add: (_magnet: string, _opts: unknown) => {
      queueMicrotask(() => torrent.emit("metadata"));
      return torrent;
    },
    createServer: () => fakeServer(),
    get: () => torrent,
    remove: (_id: string, cb?: () => void) => cb?.(),
    destroy: (cb?: () => void) => cb?.(),
  };
}

describe("streamTorrent", () => {
  it("maps files to local server URLs after metadata", async () => {
    const torrent = fakeTorrent();
    const rm = vi.fn(async () => {});
    const session = await streamTorrent("magnet:?xt=urn:btih:abc123", {
      createClient: () => fakeClient(torrent) as any,
      mkdtemp: async () => "/tmp/torlink-stream-x",
      rm,
    });
    expect(session.name).toBe("Big Buck Bunny");
    const mp4 = session.files.find((f) => f.filename === "bbb.mp4")!;
    expect(mp4.bytes).toBe(5000);
    expect(mp4.url).toBe(
      "http://localhost:54321/webtorrent/abc123/Big%20Buck%20Bunny/bbb.mp4",
    );
  });

  it("stop() without keep removes the temp dir", async () => {
    const torrent = fakeTorrent();
    const rm = vi.fn(async () => {});
    const session = await streamTorrent("magnet:?x", {
      createClient: () => fakeClient(torrent) as any,
      mkdtemp: async () => "/tmp/torlink-stream-y",
      rm,
    });
    await session.stop();
    expect(rm).toHaveBeenCalledWith("/tmp/torlink-stream-y");
  });

  it("stop({keep:true}) leaves the temp dir in place", async () => {
    const torrent = fakeTorrent();
    const rm = vi.fn(async () => {});
    const session = await streamTorrent("magnet:?x", {
      createClient: () => fakeClient(torrent) as any,
      mkdtemp: async () => "/tmp/torlink-stream-z",
      rm,
    });
    await session.stop({ keep: true });
    expect(rm).not.toHaveBeenCalled();
  });

  it("rejects when metadata never arrives before the timeout", async () => {
    const torrent = new EventEmitter() as any; // never emits metadata
    const client = {
      add: () => torrent,
      createServer: () => fakeServer(),
      get: () => torrent,
      remove: (_i: string, cb?: () => void) => cb?.(),
      destroy: (cb?: () => void) => cb?.(),
    };
    const rm = vi.fn(async () => {});
    await expect(
      streamTorrent("magnet:?x", {
        createClient: () => client as any,
        mkdtemp: async () => "/tmp/torlink-stream-timeout",
        rm,
        metadataTimeoutMs: 5,
      }),
    ).rejects.toThrow(/no peers|metadata|timed out/i);
    expect(rm).toHaveBeenCalledWith("/tmp/torlink-stream-timeout");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- torrentStream`
Expected: FAIL (`streamTorrent` not defined).

- [ ] **Step 4: Implement the engine**

`src/integrations/torrentStream.ts`:

```ts
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import WebTorrent from "webtorrent";
import type { StreamFile } from "../util/player";

export interface TorrentStreamSession {
  name: string;
  files: StreamFile[];
  dir: string;
  isComplete(): boolean;
  stop(opts?: { keep?: boolean }): Promise<void>;
}

// The minimal structural subset of the WebTorrent client the engine touches,
// so tests can inject a fake without a real swarm.
export interface WebTorrentLike {
  add(magnet: string, opts: { path: string }): TorrentLike;
  createServer(opts?: { hostname?: string; pathname?: string }): ServerLike;
  get(id: string): TorrentLike | null;
  remove(id: string, cb?: (err?: Error) => void): void;
  destroy(cb?: (err?: Error) => void): void;
}
interface TorrentLike {
  infoHash: string;
  name: string;
  done: boolean;
  files: { name: string; path: string; length: number }[];
  on(event: "metadata" | "error", cb: (arg?: unknown) => void): void;
  destroy(cb?: (err?: Error) => void): void;
}
interface ServerLike {
  listen(port?: number, hostname?: string, cb?: () => void): void;
  address(): { port: number } | null;
  close(cb?: () => void): void;
}

export interface StreamTorrentOptions {
  signal?: AbortSignal;
  metadataTimeoutMs?: number;
  createClient?: () => WebTorrentLike;
  tmpBase?: string;
  mkdtemp?: (prefix: string) => Promise<string>;
  rm?: (dir: string) => Promise<void>;
}

const DEFAULT_METADATA_TIMEOUT_MS = 60_000;

function toStreamFiles(
  torrent: TorrentLike,
  host: string,
  port: number,
): StreamFile[] {
  return torrent.files.map((f) => {
    const rel = f.path.replace(/\\/g, "/");
    return {
      url: `http://${host}:${port}/webtorrent/${torrent.infoHash}/${encodeURI(rel)}`,
      filename: f.name,
      bytes: f.length,
    };
  });
}

export async function streamTorrent(
  magnet: string,
  opts: StreamTorrentOptions = {},
): Promise<TorrentStreamSession> {
  const createClient = opts.createClient ?? (() => new WebTorrent() as unknown as WebTorrentLike);
  const mkdtemp = opts.mkdtemp ?? ((prefix) => fs.mkdtemp(prefix));
  const rm = opts.rm ?? ((dir) => fs.rm(dir, { recursive: true, force: true }));
  const timeoutMs = opts.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const host = "localhost";

  const dir = await mkdtemp(path.join(opts.tmpBase ?? os.tmpdir(), "torlink-stream-"));
  const client = createClient();
  client.destroy && ((client as { on?: (e: string, cb: () => void) => void }).on?.("error", () => {}));

  const cleanup = async () => {
    try {
      await new Promise<void>((res) => client.destroy(() => res()));
    } catch {}
    await rm(dir).catch(() => {});
  };

  return new Promise<TorrentStreamSession>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void cleanup().finally(() =>
        reject(new Error("No peers found — couldn't start the stream (metadata timed out).")),
      );
    }, timeoutMs);

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void cleanup().finally(() => reject(new Error("Stream cancelled.")));
      });
    }

    let torrent: TorrentLike;
    try {
      torrent = client.add(magnet, { path: dir });
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      void cleanup().finally(() => reject(e instanceof Error ? e : new Error(String(e))));
      return;
    }

    torrent.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void cleanup().finally(() =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
    });

    torrent.on("metadata", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const server = client.createServer();
      server.listen(0, host, () => {
        const port = server.address()?.port ?? 0;
        resolve({
          name: torrent.name,
          files: toStreamFiles(torrent, host, port),
          dir,
          isComplete: () => torrent.done === true,
          stop: async ({ keep = false }: { keep?: boolean } = {}) => {
            await new Promise<void>((res) => server.close(() => res()));
            await new Promise<void>((res) => client.destroy(() => res()));
            if (!keep) await rm(dir).catch(() => {});
          },
        });
      });
    });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- torrentStream`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/webtorrent.d.ts src/integrations/torrentStream.ts src/integrations/torrentStream.test.ts
git commit -m "feat: add ephemeral torrent stream engine"
```

---

## Task 5: Wire torrent streaming into the app (ephemeral, auto-clean)

This task makes `v` stream via torrent end-to-end with the privacy prompts and an active-stream indicator, cleaning up on stop or quit. The "offer to keep" flow is added in Task 6 (until then, stop always cleans up).

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/keymap.ts`

**Interfaces:**
- Consumes: `classifyStreamRoute` (Task 2), `streamTorrent`/`TorrentStreamSession` (Task 4), `streamCandidates`/`playStream` (existing), `ConfirmPrompt` (existing), `Config.torrentStreamAck` (Task 3), `rdStatus` state (already in `App.tsx`).
- Produces: torrent streaming behaviour on the existing `v` action; no new store method (reuses `streamResult`).

- [ ] **Step 1: Update the keymap labels/hints**

In `src/ui/keymap.ts`: change line 45 `{ keys: "v", label: "Stream via Real-Debrid" }` to `{ keys: "v", label: "Stream" }` (it now covers both paths), and add a hint in the Search group for stopping an active stream: `{ keys: "x", label: "Stop active stream" }`. Update the second `v` label (`:138`) similarly if it still says anything RD-specific.

- [ ] **Step 2: Add imports and active-stream state in `App.tsx`**

Add imports near the existing stream imports (line 16 / 54-56):

```ts
import { streamTorrent, type TorrentStreamSession } from "../integrations/torrentStream";
import { classifyStreamRoute } from "./streamRoute";
```

Add state near `pendingStreamUrl`/`streamFiles` (lines 140-143):

```ts
const [activeStream, setActiveStream] = useState<{ session: TorrentStreamSession; name: string } | null>(null);
// Confirm state for the two torrent privacy prompts.
const [torrentPrompt, setTorrentPrompt] = useState<
  { input: DownloadInput; reason?: string } | null
>(null);
```

- [ ] **Step 3: Add the torrent-stream starter**

Add a `useCallback` alongside `streamResult` (before it, so `streamResult` can call it). It reuses `streamCandidates` + `playStream` exactly like the RD path:

```ts
const startTorrentStream = useCallback(
  (input: DownloadInput) => {
    if (!config) return;
    if (preparing || streamFiles || activeStream) return;
    const controller = new AbortController();
    prepareAbort.current = controller;
    setPreparing({ label: truncate(cleanText(input.name), 32), phase: "caching", pct: 0 });
    void (async () => {
      try {
        const session = await streamTorrent(input.magnet, { signal: controller.signal });
        if (controller.signal.aborted) { void session.stop(); return; }
        prepareAbort.current = null;
        setPreparing(null);
        const candidates = streamCandidates(session.files).sort((a, b) => b.bytes - a.bytes);
        if (candidates.length === 0) {
          setNotice("This torrent has nothing to stream.");
          void session.stop();
          return;
        }
        setActiveStream({ session, name: input.name });
        const file = candidates[0]!; // TODO multi-file picker reuse — see note
        void playStream(file.url, input.name);
      } catch (e) {
        prepareAbort.current = null;
        setPreparing(null);
        if (controller.signal.aborted) return;
        setNotice(e instanceof Error ? e.message : "Couldn't start torrent stream.");
      }
    })();
  },
  [config, preparing, streamFiles, activeStream, playStream],
);
```

Note on the multi-file picker: to reuse `StreamFilePrompt` for torrent (as with RD), have `startTorrentStream` set `streamFiles` when `candidates.length > 1` and, when the existing `finishStream` picks a file, ensure `activeStream` is already set so cleanup can find the session. The simplest correct wiring: set `setActiveStream({ session, name })` first, then `if (candidates.length > 1) setStreamFiles(candidates); else playStream(candidates[0].url, name)`. `finishStream` already calls `playStream`; no change needed there. Implement it this way and delete the `// TODO` line.

- [ ] **Step 4: Branch `streamResult` on the route**

Replace the early `if (!token) { setNotice(...); return; }` block (lines 493-497) with the route decision. Keep the rest of the RD path unchanged:

```ts
const route = classifyStreamRoute(config, rdStatus);
if (route.kind === "torrent-auto") {
  if (config.torrentStreamAck) { startTorrentStream(input); return; }
  setTorrentPrompt({ input }); // one-time warning, remembered on confirm
  return;
}
if (route.kind === "torrent-confirm") {
  setTorrentPrompt({ input, reason: route.reason }); // always warn
  return;
}
// route.kind === "realdebrid": fall through to the existing RD flow below.
const token = resolveRealDebridToken(config);
```

Add `rdStatus`, `startTorrentStream` to the `streamResult` dependency array.

- [ ] **Step 5: Render the privacy confirm prompt**

In the prompt-rendering region (near the `pendingP2P` block, ~line 1094), add a branch. The message differs by whether a `reason` is present (configured-but-not-working = always warn; no reason = one-time warn):

```tsx
{torrentPrompt ? (
  <ConfirmPrompt
    width={contentWidth}
    title={torrentPrompt.reason ? "Real-Debrid unavailable" : "Stream via torrent?"}
    message={
      torrentPrompt.reason
        ? `${torrentPrompt.reason}. Streaming via torrent connects you directly to peers, so your IP is visible to the swarm. Continue via torrent?`
        : "Streaming via torrent connects you directly to peers, so your IP is visible to the swarm (Real-Debrid keeps it private). Continue?"
    }
    onConfirm={() => {
      const { input, reason } = torrentPrompt;
      setTorrentPrompt(null);
      // Remember the acknowledgement only for the no-RD one-time warning.
      if (!reason && config) setConfig({ ...config, torrentStreamAck: true });
      startTorrentStream(input);
    }}
    onCancel={() => { setTorrentPrompt(null); setNotice("Stream cancelled."); }}
  />
) : null}
```

Guard input while it's open: add `if (torrentPrompt) return;` next to the existing `if (pendingP2P) return;` guard (~line 893), and include `torrentPrompt` in the big overlay-open boolean expressions (lines 809/1132/1178 etc., wherever `pendingP2P` appears) so global keys don't fire behind it.

- [ ] **Step 6: Active-stream indicator + stop key + quit cleanup**

Add a stop handler and wire the stop key. Because `x` is bound in the Downloads/Accounts sections, intercept it at the top of the main `useInput` (before section handlers) **only when a stream is active**:

```ts
const stopStream = useCallback(() => {
  const active = activeStream;
  if (!active) return;
  setActiveStream(null);
  void active.session.stop(); // Task 6 replaces this with the keep prompt
  setNotice("Stream stopped.");
}, [activeStream]);
```

In the main input handler, near the top (after the overlay guards), add:

```ts
if (activeStream && (input === "x" || input === "X")) { stopStream(); return; }
```

Show the indicator: in the footer/notice area, when `activeStream` is set, render a line such as `▶ Streaming <name> via torrent · your IP is visible to peers · x to stop` (reuse the existing notice/footer styling; keep it non-modal so the user can keep browsing).

On quit: in the existing `quitAll`/unmount path (`src/index.tsx:49` teardown and `App`'s quit handler), call `activeStream?.session.stop()` so the temp dir is cleaned. Add it to the quit callback in `App.tsx` and, defensively, a `useEffect` cleanup that stops the session on unmount.

- [ ] **Step 7: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Manual verification (use the `verify` skill / `run` skill)**

Build and run the app with **no** RD token configured; search, press `v` on a well-seeded result (e.g. a Linux ISO), confirm the one-time warning appears, accept it, and confirm the file opens in mpv/vlc and streams. Press `v` again on another item and confirm the warning does **not** reappear (remembered). Configure a non-premium/invalid RD token and confirm `v` shows the always-warn confirm instead of auto-streaming. Press `x` to stop and confirm the temp dir under the OS temp dir is deleted.

- [ ] **Step 9: Commit**

```bash
git add src/ui/App.tsx src/ui/keymap.ts
git commit -m "feat: stream via torrent when Real-Debrid is unavailable"
```

---

## Task 6: Offer-to-keep flow

When the user stops a torrent stream (or quits) and the file fully downloaded, offer to keep it as a real download + seed, reusing the download queue. Partial downloads are cleaned up with no prompt.

**Files:**
- Create: `src/ui/streamKeep.ts`
- Test: `src/ui/streamKeep.test.ts`
- Modify: `src/ui/App.tsx`

**Interfaces:**
- Consumes: `TorrentStreamSession` (`dir`, `name`, `isComplete`), `DownloadInput`, `startDownload` (existing, `queue.add(input, dir)`), `Config.downloadDir`.
- Produces:
```ts
// Pure: decide the move for a kept stream. Returns the source (temp) and
// destination (downloads) paths for the torrent's top-level folder.
export function keepMovePlan(args: {
  streamDir: string;   // session.dir (temp root)
  torrentName: string; // session.name (top-level folder inside streamDir)
  downloadDir: string; // config.downloadDir
}): { from: string; to: string };
```

- [ ] **Step 1: Write the failing test**

`src/ui/streamKeep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { keepMovePlan } from "./streamKeep";

describe("keepMovePlan", () => {
  it("moves the torrent's top-level folder from temp into downloads", () => {
    const plan = keepMovePlan({
      streamDir: "/tmp/torlink-stream-abc",
      torrentName: "Big Buck Bunny",
      downloadDir: "/home/u/Downloads",
    });
    expect(plan.from).toBe(path.join("/tmp/torlink-stream-abc", "Big Buck Bunny"));
    expect(plan.to).toBe(path.join("/home/u/Downloads", "Big Buck Bunny"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- streamKeep`
Expected: FAIL (`keepMovePlan` not defined).

- [ ] **Step 3: Implement**

`src/ui/streamKeep.ts`:

```ts
import path from "node:path";

// WebTorrent lays a multi-file torrent out under <dir>/<torrent.name>/… and a
// single-file torrent directly at <dir>/<file>. We move the top-level entry
// named after the torrent; a single-file torrent's name IS that file.
export function keepMovePlan(args: {
  streamDir: string;
  torrentName: string;
  downloadDir: string;
}): { from: string; to: string } {
  return {
    from: path.join(args.streamDir, args.torrentName),
    to: path.join(args.downloadDir, args.torrentName),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- streamKeep`
Expected: PASS.

- [ ] **Step 5: Add the keep prompt + move/reseed in `App.tsx`**

Add state: `const [keepPrompt, setKeepPrompt] = useState<{ session: TorrentStreamSession; input: DownloadInput } | null>(null);`

`stopStream` (Task 5) becomes: if the session is complete, open the keep prompt instead of cleaning up immediately. Thread the originating `DownloadInput` through `activeStream` (extend it to `{ session, name, input }`).

```ts
const stopStream = useCallback(() => {
  const active = activeStream;
  if (!active) return;
  setActiveStream(null);
  if (active.session.isComplete()) {
    setKeepPrompt({ session: active.session, input: active.input });
  } else {
    void active.session.stop(); // partial: discard
    setNotice("Stream stopped.");
  }
}, [activeStream]);
```

Render the keep prompt (reuse `ConfirmPrompt`):

```tsx
{keepPrompt ? (
  <ConfirmPrompt
    width={contentWidth}
    title="Keep this download?"
    message={`"${truncate(cleanText(keepPrompt.session.name), 40)}" finished downloading. Keep it in your downloads and seed it?`}
    onConfirm={() => {
      const { session, input } = keepPrompt;
      setKeepPrompt(null);
      void (async () => {
        await session.stop({ keep: true }); // close server/client, leave files
        if (!config) return;
        const { keepMovePlan } = await import("./streamKeep");
        const { from, to } = keepMovePlan({
          streamDir: session.dir, torrentName: session.name, downloadDir: config.downloadDir,
        });
        try {
          await fs.mkdir(config.downloadDir, { recursive: true });
          await fs.rename(from, to);       // fast path (same volume)
        } catch {
          // cross-device: fall back to a recursive copy then remove
          await fs.cp(from, to, { recursive: true }).catch(() => {});
          await fs.rm(from, { recursive: true, force: true }).catch(() => {});
        }
        startDownload(input);              // queue.add verifies on-disk files + seeds
        setNotice(`Kept & seeding: ${truncate(cleanText(session.name), 32)}`);
      })();
    }}
    onCancel={() => {
      const { session } = keepPrompt;
      setKeepPrompt(null);
      void session.stop(); // discard temp
      setNotice("Stream stopped.");
    }}
  />
) : null}
```

Add `keepPrompt` to the input guards and overlay-open expressions like the other prompts. Import `fs` (`import { promises as fs } from "node:fs"`) if not already imported at the top of `App.tsx`.

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Manual verification**

With no RD token, stream a small well-seeded torrent to completion, press `x`, confirm the keep prompt appears, accept it, and confirm the file now lives in the downloads folder and appears in the Downloads/Seeding list (verify the temp dir is gone). Repeat but stop **before** completion and confirm no keep prompt and the temp dir is removed.

- [ ] **Step 8: Commit**

```bash
git add src/ui/streamKeep.ts src/ui/streamKeep.test.ts src/ui/App.tsx
git commit -m "feat: offer to keep a completed torrent stream as a download"
```

---

## Self-Review Notes

- **Spec coverage:** trigger/decision (Task 2 + 5 Step 4), torrent engine + local server + shared shape (Tasks 1, 4), ephemeral temp + cleanup (Task 4, Task 5 Step 6), offer-to-keep (Task 6), privacy warnings one-time + always (Task 3 + Task 5 Step 5), active-stream indicator + stop (Task 5 Step 6), tests + TDD (every task). All spec sections map to a task.
- **Open items resolved from the spec:** WebTorrent server API confirmed as `client.createServer()` with URL `…/webtorrent/<infoHash>/<encodeURI(path)>` (Task 4 Step 1); shared type resolved via `StreamFile` in `player.ts` + `ResolvedFile` alias (Task 1); config field named `torrentStreamAck` (Task 3); partial downloads get **no** keep prompt (Task 6 Step 5).
- **Type consistency:** `StreamFile`/`ResolvedFile` structurally identical; `classifyStreamRoute` returns `StreamRoute` consumed in Task 5 Step 4; `TorrentStreamSession` shape consumed in Tasks 5-6.
- **Risk to verify during Task 5:** the top-level `x`-while-streaming interception must not regress the Downloads/Accounts `x` bindings — verified in Task 5 Step 8.
```
