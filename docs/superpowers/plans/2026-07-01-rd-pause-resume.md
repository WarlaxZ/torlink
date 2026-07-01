# Pause / Resume for Real-Debrid Downloads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `p` pause/resume Real-Debrid downloads per-item across all phases — pausing an in-progress transfer keeps the partial file and frees the slot; resuming re-resolves a fresh link and continues via HTTP `Range`.

**Architecture:** `downloadFiles` becomes resume-aware (per-file partial detection, `Range`/append, `200`-ignores-Range restart, complete-file skip, progress seeding) and keeps partials on a `"pause"` abort vs deletes on cancel/error. `DownloadQueue.pause/resume` gain RD branches; `driveDebrid` treats a pause-abort as "leave paused"; `cancel` aborts with reason `"cancel"`.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, tsup. Tests colocate as `src/**/*.test.ts`. `npm test` / `npx vitest run <path>` / `npm run typecheck` / `npm run build`.

**Build order:** `downloadFiles` (resume + reason cleanup) → queue (`cancel` reason, `pause`/`resume`, `driveDebrid`) → verify.

---

## File Structure

**Modified**
- `src/download/http.ts` — resume-aware `downloadFiles`; keep-vs-delete by `signal.reason`.
- `src/download/http.test.ts` — resume/restart/skip/keep/delete tests.
- `src/download/queue.ts` — `cancel` abort reason; RD `pause`/`resume`; `driveDebrid` pause handling.
- `src/download/queue.test.ts` — RD pause/resume tests.

---

## Task 1: Resume-aware `downloadFiles`

**Files:**
- Modify: `src/download/http.ts`
- Test: `src/download/http.test.ts`

- [ ] **Step 1: Write the failing tests — append to `src/download/http.test.ts` inside `describe("downloadFiles", ...)`** (it has `makeDir`, `file`, `afterEach` cleanup)

```typescript
  it("resumes a partial file via Range and appends the rest", async () => {
    const dir = await makeDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "hel"); // 3 of 5 bytes
    let seenRange: string | null = null;
    const written = await downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
      fetchImpl: async (_url, init) => {
        seenRange = ((init?.headers as Record<string, string>) ?? {})["Range"] ?? null;
        return new Response("lo", { status: 206 });
      },
    });
    expect(seenRange).toBe("bytes=3-");
    expect(written).toEqual([path.join(dir, "a.txt")]);
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("hello");
  });

  it("restarts a file when the server ignores Range (200)", async () => {
    const dir = await makeDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "XX"); // stale partial
    await downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
      fetchImpl: async () => new Response("hello", { status: 200 }),
    });
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("hello");
  });

  it("skips a file that is already complete on disk", async () => {
    const dir = await makeDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "hello"); // complete
    let fetched = false;
    const written = await downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
      fetchImpl: async () => {
        fetched = true;
        return new Response("hello");
      },
    });
    expect(fetched).toBe(false);
    expect(written).toEqual([path.join(dir, "a.txt")]);
  });

  it("keeps partial files when aborted with reason 'pause'", async () => {
    const dir = await makeDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "hel");
    const ctrl = new AbortController();
    ctrl.abort("pause");
    await expect(
      downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
        fetchImpl: async () => new Response("lo", { status: 206 }),
        signal: ctrl.signal,
      }),
    ).rejects.toBeTruthy();
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("hel");
  });

  it("deletes partial files when aborted with reason 'cancel'", async () => {
    const dir = await makeDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.txt"), "hel");
    const ctrl = new AbortController();
    ctrl.abort("cancel");
    await expect(
      downloadFiles([file("https://dl/a", "a.txt", 5)], dir, {
        fetchImpl: async () => new Response("lo", { status: 206 }),
        signal: ctrl.signal,
      }),
    ).rejects.toBeTruthy();
    await expect(fs.access(path.join(dir, "a.txt"))).rejects.toBeTruthy();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/download/http.test.ts`
Expected: FAIL — no `Range`/append/skip; the "keeps on pause" test fails because the current code deletes on any abort.

- [ ] **Step 3: Rewrite `downloadFiles` — `src/download/http.ts`**

Replace the entire `downloadFiles` function body with the resume-aware version (keep the imports, `abortError`, `cleanup`, and `sanitizeFilename` as-is):

```typescript
export async function downloadFiles(
  files: ResolvedFile[],
  destDir: string,
  opts: DownloadFilesOptions = {},
): Promise<string[]> {
  const { onProgress, signal, fetchImpl = fetch as FetchImpl, nowImpl = Date.now } = opts;
  await fs.mkdir(destDir, { recursive: true });

  const total = files.reduce((sum, f) => sum + (f.bytes || 0), 0);
  const destPaths = files.map((f) => path.join(destDir, sanitizeFilename(f.filename)));
  const startedAt = nowImpl();
  let doneBytes = 0;

  // A pause abort keeps partial files (so resume can continue); any other abort
  // or error deletes this torrent's files. Distinguished by the signal reason.
  const bail = async (e: unknown): Promise<never> => {
    if (signal?.reason !== "pause") await cleanup(destPaths);
    throw e;
  };

  const report = (downloaded: number): void => {
    const elapsed = (nowImpl() - startedAt) / 1000;
    onProgress?.({ downloaded, total, speed: elapsed > 0 ? downloaded / elapsed : 0 });
  };

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const dest = destPaths[i]!;

    let existing = 0;
    try {
      existing = (await fs.stat(dest)).size;
    } catch {
      existing = 0;
    }

    // Already fully on disk — count it and move on without a request.
    if (f.bytes > 0 && existing >= f.bytes) {
      doneBytes += f.bytes;
      report(doneBytes);
      continue;
    }

    if (signal?.aborted) return bail(abortError());

    const wantRange = existing > 0;
    let res: Response;
    try {
      const init: RequestInit = {};
      if (signal) init.signal = signal;
      if (wantRange) init.headers = { Range: `bytes=${existing}-` };
      res = await fetchImpl(f.url, init);
    } catch (e) {
      return bail(e);
    }
    if (!res.ok || !res.body) {
      return bail(new Error(`Download failed for ${f.filename} (HTTP ${res.status}).`));
    }

    // Resume only if the server honored the range (206); a 200 means it's
    // sending the whole file, so restart this one from scratch (truncate).
    const append = wantRange && res.status === 206;
    let fileBytes = append ? existing : 0;

    const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    source.on("data", (chunk: Buffer) => {
      fileBytes += chunk.length;
      report(doneBytes + fileBytes);
    });

    try {
      await pipeline(source, createWriteStream(dest, { flags: append ? "a" : "w" }));
    } catch (e) {
      return bail(e);
    }
    doneBytes += fileBytes;
  }

  return destPaths;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/download/http.test.ts`
Expected: PASS (new + the existing streaming/sanitize/failed-response/aborted tests — the failed-response and already-aborted cases have `signal.reason !== "pause"`, so they still delete).

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck && npm test`
Expected: PASS.
```bash
git add src/download/http.ts src/download/http.test.ts
git commit -m "feat: resume-aware downloadFiles (Range/append, keep partials on pause)"
```

---

## Task 2: RD pause/resume in `DownloadQueue`

**Files:**
- Modify: `src/download/queue.ts`
- Test: `src/download/queue.test.ts`

- [ ] **Step 1: Write the failing test — append to `src/download/queue.test.ts` in the `"DownloadQueue Real-Debrid scheduling"` describe (it has `tick`, `DebridDeps`)**

```typescript
  it("pauses an in-progress Real-Debrid download and resumes it to completion", async () => {
    const q = new DownloadQueue();
    let downloadCalls = 0;
    const deps: DebridDeps = {
      resolveMagnet: async () => [{ url: "u", filename: "f.mkv", bytes: 10 }],
      downloadFiles: async (_files, _dir, opts) => {
        downloadCalls++;
        if (downloadCalls === 1) {
          // First run: block until pause aborts us, then throw like a real abort.
          await new Promise<void>((_res, rej) => {
            opts?.signal?.addEventListener("abort", () =>
              rej(Object.assign(new Error("Download aborted."), { name: "AbortError" })),
            );
          });
        }
        opts?.onProgress?.({ downloaded: 10, total: 10, speed: 0 });
        return ["/downloads/f.mkv"];
      },
      sleep: async () => {},
    };

    const p = q.addDebrid({ id: "rd1", name: "M", magnet: "m" }, "/downloads", "tok", deps);
    await tick();
    await tick();

    q.pause("rd1");
    await p; // driveDebrid returns once the pause abort unwinds
    expect(q.getItems().find((i) => i.id === "rd1")?.status).toBe("paused");

    q.resume("rd1");
    for (let n = 0; n < 5 && q.has("rd1"); n++) await tick();
    expect(q.has("rd1")).toBe(false); // second download run completed → history
    expect(downloadCalls).toBe(2);
    q.suspend();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/download/queue.test.ts`
Expected: FAIL — `pause` no-ops for RD, so the item never becomes `paused` (and the blocked download keeps the promise pending).

- [ ] **Step 3: `cancel` aborts with a reason — `src/download/queue.ts`**

In `cancel(id)`, change the abort to pass a reason so `downloadFiles` deletes partials:
```typescript
    this.debridAborts.get(id)?.abort("cancel");
```
(was `this.debridAborts.get(id)?.abort();`)

- [ ] **Step 4: RD branch in `pause(id)` — `src/download/queue.ts`**

`pause` currently is:
```typescript
  pause(id: string): void {
    const it = this.items.get(id);
    if (!it || it.status !== "downloading") return;
    // Pausing/resuming an HTTP transfer would need range-resume; not in v1, so
    // a Real-Debrid download can only be cancelled, never paused.
    if (it.via === "realdebrid") return;
    it.status = "paused";
    it.speed = 0;
    it.peers = 0;
    it.eta = undefined;
    this.engine.remove(id);
    this.changed();
    void this.persist();
    this.maybeStopPoll();
  }
```
Replace the RD early-return with a real pause branch:
```typescript
  pause(id: string): void {
    const it = this.items.get(id);
    if (!it || it.status !== "downloading") return;
    if (it.via === "realdebrid") {
      // Abort the in-flight pipeline with a "pause" reason so downloadFiles keeps
      // the partial file(s); driveDebrid sees the paused status and won't fail it.
      it.status = "paused";
      it.speed = 0;
      it.peers = 0;
      it.eta = undefined;
      this.debridAborts.get(id)?.abort("pause");
      this.changed();
      void this.persist();
      this.maybeStopPoll();
      return;
    }
    it.status = "paused";
    it.speed = 0;
    it.peers = 0;
    it.eta = undefined;
    this.engine.remove(id);
    this.changed();
    void this.persist();
    this.maybeStopPoll();
  }
```

- [ ] **Step 5: RD branch in `resume(id)` — `src/download/queue.ts`**

`resume` currently is:
```typescript
  resume(id: string): void {
    const it = this.items.get(id);
    if (!it || it.status !== "paused") return;
    it.status = "downloading";
    this.startEngine(it);
    this.ensurePoll();
    this.changed();
    void this.persist();
  }
```
Add an RD branch before the P2P logic:
```typescript
  resume(id: string): void {
    const it = this.items.get(id);
    if (!it || it.status !== "paused") return;
    if (it.via === "realdebrid") {
      if (!this.debridToken) {
        it.status = "failed";
        it.error = "Set a Real-Debrid token, then download again.";
        this.changed();
        return;
      }
      // Re-run the pipeline: re-resolve for a fresh link, then downloadFiles
      // continues each partial file via HTTP Range from its on-disk size.
      it.status = "downloading";
      it.error = undefined;
      this.debridAttempts.set(id, 0);
      this.changed();
      void this.persist();
      void this.driveDebrid(id, this.debridToken, this.debridDeps);
      return;
    }
    it.status = "downloading";
    this.startEngine(it);
    this.ensurePoll();
    this.changed();
    void this.persist();
  }
```

- [ ] **Step 6: `driveDebrid` leaves a paused item alone — `src/download/queue.ts`**

In `driveDebrid`'s `catch (e)` block, add a paused-check as the FIRST statement (before the attempts/transient logic):
```typescript
      } catch (e) {
        // A pause aborted the pipeline: the item is already marked paused; leave
        // it (don't fail or requeue). The finally still releases the slot.
        if (this.items.get(id)?.status === "paused") return;
        const attempts = (this.debridAttempts.get(id) ?? 0) + 1;
        this.debridAttempts.set(id, attempts);
        // …existing transient/terminal logic unchanged…
```

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run src/download/queue.test.ts`
Expected: PASS (new pause/resume test + all existing queue tests; the existing cancel behavior is unchanged aside from the reason string).

- [ ] **Step 8: Verify + commit**

Run: `npm run typecheck && npm test`
Expected: PASS.
```bash
git add src/download/queue.ts src/download/queue.test.ts
git commit -m "feat: pause/resume Real-Debrid downloads (keep partial, resume via re-resolve + Range)"
```

---

## Task 3: Verify UI + full check

**Files:** none (verification only — the UI is already wired: `Downloads.tsx` `togglePause` → `queue.togglePause`, and the pause/resume footer hints exist).

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/cli.cjs` emitted.

- [ ] **Step 2: Manual smoke** (`npm run dev`)
  - Start a Real-Debrid download; while it's downloading, press `p` → row shows "paused N%", the transfer stops, and the partial file remains on disk. A queued item may start (freed slot).
  - Press `p` again (resume) → it re-resolves and continues from the paused %, completing to the same file (no full re-download).
  - Press `c` on an RD download → it's cancelled and its partial file is removed.
  - Pause a *queued* RD item → stays paused, doesn't start; resume → runs.

- [ ] **Step 3: Commit (if any doc/touch-ups needed; otherwise skip)**

No code changes expected in this task.

---

## Final verification

- [ ] `npm run typecheck && npm test && npm run build` — all green.
- [ ] Manual: pause mid-download keeps the partial and frees the slot; resume continues from the partial to completion; cancel deletes the partial.

---

## Notes

- Pause vs cancel is distinguished purely by `signal.reason` (`"pause"` keeps partials; anything else deletes) — a genuine mid-download *error* has no `"pause"` reason, so it still cleans up as before.
- Resume re-resolves (fresh RD link) before continuing, so an expired paused link is never a problem; `downloadFiles` then `Range`-continues from the on-disk bytes, or restarts that file if the server answers `200`.
- Brief cosmetic flicker on resume: `runDebrid` sets `progress = 0` after re-resolve; `downloadFiles`' first progress callback (seeded from the on-disk size) corrects it immediately.
- No schema/UI change: `paused` status, `downloadedBytes`, and `progress` already persist; a paused RD item survives restart (restore only rewrites *downloading* RD items) and resumes from its on-disk partial.
