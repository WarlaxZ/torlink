# Queue-in-place, Persistent Results & Clearer RD Errors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user queue downloads without leaving the results list, see which results are already downloading/done, navigate to the downloads view and back without a reload or losing position, and get Real-Debrid error messages that distinguish transient outages from gone/removed content.

**Architecture:** Two pure helpers (RD error-message mapping in `realdebrid.ts`; a `downloadStateFor` lookup) are TDD'd. The results list gains a status-marker column fed by the existing live queue/history hooks. The download handlers stop switching sections. The body switches from mounting one of three views to keeping all three mounted and toggling visibility + per-section input gating, so Results never unmounts (preserving its search + cursor + sort).

**Tech Stack:** TypeScript (ESM, Node 22), Ink 7 + React 19, vitest, tsup. Tests colocate as `src/**/*.test.ts`. `npm test` runs all; `npx vitest run <path>` runs one; `npm run typecheck`; `npm run build`.

**Build order rationale:** Error mapping (Task 1) and the `downloadStateFor` helper (Task 2) are isolated and pure. Markers (Task 3) and the no-navigate change (Task 4) build on them. The one structural change — persistent panes (Task 5) — lands last so the prior behavior exists to verify against.

---

## File Structure

**New files**
- `src/ui/downloadState.ts` — pure `downloadStateFor(hash, items, history)` → `DownloadState | null`.
- `src/ui/downloadState.test.ts` — its tests.

**Modified files**
- `src/integrations/realdebrid.ts` — add `messageForTorrentStatus` + `messageForErrorSlug`; use them in `resolveMagnet` and `mapStatus`; reword 503.
- `src/integrations/realdebrid.test.ts` — tests for the two new exported helpers.
- `src/ui/components/Results.tsx` — status-marker column (uses queue/history hooks + `downloadStateFor`).
- `src/ui/App.tsx` — remove section-navigation from the two download handlers; render the body as three persistent, visibility-toggled panes.
- `src/ui/components/Downloads.tsx` — section-aware `focused` so its input is gated when hidden.
- `src/ui/components/Seeding.tsx` — section-aware `focused` likewise.

---

## Task 1: Clearer Real-Debrid error messages

**Files:**
- Modify: `src/integrations/realdebrid.ts`
- Test: `src/integrations/realdebrid.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/integrations/realdebrid.test.ts` (add the two new names to the existing `./realdebrid` import, or add a new import line):

```typescript
import { messageForTorrentStatus, messageForErrorSlug } from "./realdebrid";

describe("messageForTorrentStatus", () => {
  it("gives specific, terminal-sounding copy per status", () => {
    expect(messageForTorrentStatus("dead")).toBe("No seeders — Real-Debrid can't fetch this torrent.");
    expect(messageForTorrentStatus("magnet_error")).toBe(
      "Real-Debrid couldn't read this magnet (it may be invalid or removed).",
    );
    expect(messageForTorrentStatus("virus")).toBe("Real-Debrid flagged this torrent's contents.");
  });

  it("falls back for an unknown/error status", () => {
    expect(messageForTorrentStatus("error")).toBe("Real-Debrid couldn't process this torrent.");
    expect(messageForTorrentStatus("whatever")).toBe("Real-Debrid couldn't process this torrent.");
  });
});

describe("messageForErrorSlug", () => {
  it("maps known unavailable/removed slugs", () => {
    expect(messageForErrorSlug("infringing_file")).toBe(
      "This was removed from Real-Debrid (copyright claim).",
    );
    expect(messageForErrorSlug("hoster_unavailable")).toBe(
      "This is no longer available on Real-Debrid (it may have been removed).",
    );
    expect(messageForErrorSlug("file_unavailable")).toBe(
      "This is no longer available on Real-Debrid (it may have been removed).",
    );
  });

  it("maps rate-limit slugs", () => {
    expect(messageForErrorSlug("too_many_requests")).toBe(
      "Real-Debrid rate limit reached — wait a moment and retry.",
    );
  });

  it("returns null for unknown/missing slugs so the caller uses its generic message", () => {
    expect(messageForErrorSlug(undefined)).toBeNull();
    expect(messageForErrorSlug("some_unknown_code")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: FAIL — `messageForTorrentStatus`/`messageForErrorSlug` are not exported.

- [ ] **Step 3: Add the two pure helpers**

In `src/integrations/realdebrid.ts`, add these exported functions just above the `mapStatus` function:

```typescript
// Human-readable, category-accurate copy for a terminal torrent status (one of
// ERROR_STATUSES). These all read as terminal — retrying won't help.
export function messageForTorrentStatus(status: string): string {
  switch (status) {
    case "dead":
      return "No seeders — Real-Debrid can't fetch this torrent.";
    case "magnet_error":
      return "Real-Debrid couldn't read this magnet (it may be invalid or removed).";
    case "virus":
      return "Real-Debrid flagged this torrent's contents.";
    default:
      return "Real-Debrid couldn't process this torrent.";
  }
}

// Map a Real-Debrid JSON `error` slug to clearer copy where we recognise it.
// Returns null for unknown/missing slugs so the caller falls back to its generic
// HTTP message. Slugs are matched conservatively (derived from RD's API error
// semantics); an unrecognised slug never produces a wrong message.
export function messageForErrorSlug(slug: string | undefined): string | null {
  if (!slug) return null;
  const s = slug.toLowerCase();
  if (s.includes("infring")) return "This was removed from Real-Debrid (copyright claim).";
  if (s === "hoster_unavailable" || s === "file_unavailable" || s.includes("no_longer_available")) {
    return "This is no longer available on Real-Debrid (it may have been removed).";
  }
  if (s.includes("too_many") || s === "slow_down" || s.includes("fair_usage")) {
    return "Real-Debrid rate limit reached — wait a moment and retry.";
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/integrations/realdebrid.test.ts`
Expected: PASS (all, including the pre-existing tests).

- [ ] **Step 5: Wire the helpers into `mapStatus` and `resolveMagnet`**

In `src/integrations/realdebrid.ts`, replace the body of `mapStatus` (currently it checks 401/403 → `TOKEN_REJECTED_MESSAGE`, then 404, then 503, then a generic fallback) with this version, which consults the slug map after the token check and reword 503:

```typescript
function mapStatus(status: number, code?: string): RealDebridError {
  if (status === 401 || status === 403) {
    return new RealDebridError(TOKEN_REJECTED_MESSAGE, status, code);
  }
  const slugMsg = messageForErrorSlug(code);
  if (slugMsg) return new RealDebridError(slugMsg, status, code);
  if (status === 404) {
    return new RealDebridError("Real-Debrid could not find this resource.", status, code);
  }
  if (status === 503) {
    return new RealDebridError("Real-Debrid is busy — try again shortly.", status, code);
  }
  return new RealDebridError(
    code
      ? `Real-Debrid error: ${code} (HTTP ${status}).`
      : `Real-Debrid request failed (HTTP ${status}).`,
    status,
    code,
  );
}
```

Then, in `resolveMagnet`, replace the terminal-status throw. Find:
```typescript
    if (ERROR_STATUSES.has(info.status)) {
      throw new RealDebridError(`Real-Debrid could not fetch this torrent (${info.status}).`);
    }
```
Replace with:
```typescript
    if (ERROR_STATUSES.has(info.status)) {
      throw new RealDebridError(messageForTorrentStatus(info.status));
    }
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS. (If a pre-existing test asserted the old 503 string "Real-Debrid is temporarily unavailable." or the old "could not fetch this torrent" text, update that test to the new copy and note it.)

- [ ] **Step 7: Commit**

```bash
git add src/integrations/realdebrid.ts src/integrations/realdebrid.test.ts
git commit -m "feat: clearer Real-Debrid error messages for dead/removed vs busy"
```

---

## Task 2: `downloadStateFor` helper

**Files:**
- Create: `src/ui/downloadState.ts`
- Test: `src/ui/downloadState.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/ui/downloadState.test.ts
import { describe, it, expect } from "vitest";
import { downloadStateFor } from "./downloadState";

const item = (id: string, status: string) => ({ id, status });
const hist = (id: string) => ({ id });

describe("downloadStateFor", () => {
  it("returns the active state when the hash is in the queue", () => {
    const items = [item("a", "downloading"), item("b", "paused"), item("c", "failed")];
    expect(downloadStateFor("a", items, [])).toBe("downloading");
    expect(downloadStateFor("b", items, [])).toBe("paused");
    expect(downloadStateFor("c", items, [])).toBe("failed");
  });

  it("treats any other active status as downloading (in-progress)", () => {
    expect(downloadStateFor("a", [item("a", "resolving")], [])).toBe("downloading");
  });

  it("returns done when only in history", () => {
    expect(downloadStateFor("h", [], [hist("h")])).toBe("done");
  });

  it("prefers an active queue item over history (re-download in progress)", () => {
    expect(downloadStateFor("x", [item("x", "downloading")], [hist("x")])).toBe("downloading");
  });

  it("returns null when the hash is untouched", () => {
    expect(downloadStateFor("z", [item("a", "downloading")], [hist("h")])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/downloadState.test.ts`
Expected: FAIL — `Cannot find module './downloadState'`.

- [ ] **Step 3: Implement**

```typescript
// src/ui/downloadState.ts
export type DownloadState = "downloading" | "paused" | "failed" | "done";

// What, if anything, has happened to a torrent (by infoHash) in the download
// queue or history. An active queue item takes precedence over history, so a
// re-download in progress shows its live state rather than "done".
export function downloadStateFor(
  hash: string,
  items: readonly { id: string; status: string }[],
  history: readonly { id: string }[],
): DownloadState | null {
  const active = items.find((it) => it.id === hash);
  if (active) {
    if (active.status === "paused") return "paused";
    if (active.status === "failed") return "failed";
    return "downloading";
  }
  if (history.some((h) => h.id === hash)) return "done";
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/downloadState.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/downloadState.ts src/ui/downloadState.test.ts
git commit -m "feat: add downloadStateFor lookup for result status markers"
```

---

## Task 3: Status-marker column in the results list

**Files:**
- Modify: `src/ui/components/Results.tsx`

- [ ] **Step 1: Add imports and the live status map**

In `src/ui/components/Results.tsx`, update the store import to add the queue hooks. The current line is:
```typescript
import { useStore, CATEGORIES } from "../store";
```
Change it to:
```typescript
import { useStore, useQueueItems, useQueueHistory, CATEGORIES } from "../store";
```
Add the helper + theme imports. After the existing theme import line (`import { COLOR, GUTTER, ICON, SOURCE_STYLE } from "../theme";`) add:
```typescript
import { downloadStateFor, type DownloadState } from "../downloadState";
```

Add `queue` to the `useStore()` destructure (it currently destructures `query, submitQuery, section, region, setRegion, setCaptureMode, requestP2PDownload, startDebridDownload, streamResult, debridConfigured, copyMagnet, contentWidth, listRows`):
```typescript
    queue,
```

Just after the `const search = useConcurrentSearch(query);` line, add the live arrays and a per-render lookup map:
```typescript
  const queueItems = useQueueItems(queue);
  const queueHistory = useQueueHistory(queue);
  const stateFor = (hash: string): DownloadState | null =>
    downloadStateFor(hash, queueItems, queueHistory);
```

- [ ] **Step 2: Add a marker-glyph helper**

Near the top of `Results.tsx` (module scope, after the imports), add:
```typescript
// Glyph + colour for a result row's download state. Returns null for untouched.
function stateMark(state: DownloadState | null): { icon: string; color?: string; dim?: boolean } | null {
  switch (state) {
    case "downloading":
      return { icon: ICON.down, color: COLOR.accent };
    case "paused":
      return { icon: ICON.pause, dim: true };
    case "failed":
      return { icon: ICON.error, color: COLOR.bad };
    case "done":
      return { icon: ICON.done, color: COLOR.good };
    default:
      return null;
  }
}
```

- [ ] **Step 3: Render a one-character status column per row**

In the list-row `.map(...)` (the block rendering each `r`), there is a row with the pointer gutter, the index number box, then the name box. Between the index-number box and the name box, insert a one-wide status column. The current sequence is:

```tsx
                      <Box width={numW} flexShrink={0} justifyContent="flex-end">
                        <Text dimColor>{index + 1}</Text>
                      </Box>
                      <Box flexGrow={1} minWidth={0} marginLeft={1}>
```
Insert the status column between them:
```tsx
                      <Box width={numW} flexShrink={0} justifyContent="flex-end">
                        <Text dimColor>{index + 1}</Text>
                      </Box>
                      <Box width={1} flexShrink={0} marginLeft={1}>
                        {(() => {
                          const m = stateMark(stateFor(r.infoHash));
                          return m ? <Text color={m.color} dimColor={m.dim}>{m.icon}</Text> : <Text> </Text>;
                        })()}
                      </Box>
                      <Box flexGrow={1} minWidth={0} marginLeft={1}>
```

In the header row (the block with the bold dimColor `#` / `Name` labels), add a matching one-wide spacer between the `#` box and the `Name` box so columns line up. The current sequence:
```tsx
                    <Box width={numW} flexShrink={0} justifyContent="flex-end">
                      <Text bold dimColor>#</Text>
                    </Box>
                    <Box flexGrow={1} minWidth={0} marginLeft={1}>
                      <Text bold dimColor>Name</Text>
                    </Box>
```
becomes:
```tsx
                    <Box width={numW} flexShrink={0} justifyContent="flex-end">
                      <Text bold dimColor>#</Text>
                    </Box>
                    <Box width={1} flexShrink={0} marginLeft={1} />
                    <Box flexGrow={1} minWidth={0} marginLeft={1}>
                      <Text bold dimColor>Name</Text>
                    </Box>
```

- [ ] **Step 4: Show the marker in the detail view**

In the `Detail` component, the title row renders the name and the source tag. Add the marker before the name. Find the title `<Box>` in `Detail` (the one with `<Text bold color={COLOR.text} wrap="truncate-end">{cleanText(r.name)}</Text>`). `Detail` does not currently receive download state — pass it in. Update `Detail`'s props and call site:

In the `Detail` function signature, add a `mark` prop:
```tsx
function Detail({
  r,
  width,
  debridConfigured,
  mark,
}: {
  r: TorrentResult;
  width: number;
  debridConfigured: boolean;
  mark: { icon: string; color?: string; dim?: boolean } | null;
}) {
```
In `Detail`'s title row, prefix the name `<Box flexGrow={1} ...>` with the marker:
```tsx
        {mark ? (
          <Box marginRight={1} flexShrink={0}>
            <Text color={mark.color} dimColor={mark.dim}>{mark.icon}</Text>
          </Box>
        ) : null}
        <Box flexGrow={1} minWidth={0}>
          <Text bold color={COLOR.text} wrap="truncate-end">
            {cleanText(r.name)}
          </Text>
        </Box>
```
At the `Detail` call site (in the returned JSX, `mode === "detail" && detail ? <Detail r={detail} ... /> : ...`), pass:
```tsx
            <Detail
              r={detail}
              width={Math.max(10, contentWidth - 4)}
              debridConfigured={debridConfigured}
              mark={stateMark(stateFor(detail.infoHash))}
            />
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS. Manual (optional): `npm run dev`, search, queue an item with `r`/`d` → a `↓` appears on that row; a previously-completed item shows `✓`.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/Results.tsx
git commit -m "feat: show download status markers on result rows"
```

---

## Task 4: Stay in the results list when downloading

**Files:**
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Remove navigation from `startDownload`**

In `src/ui/App.tsx`, `startDownload` currently ends with:
```typescript
      queue.add(input, config.downloadDir);
      setNotice(`Added: ${truncate(cleanText(input.name), 40)}`);
      setSection("downloads");
      setRegion("content");
```
Remove the last two lines so it becomes:
```typescript
      queue.add(input, config.downloadDir);
      setNotice(`Added: ${truncate(cleanText(input.name), 40)}`);
```

- [ ] **Step 2: Remove navigation from `startDebridDownload`**

`startDebridDownload` currently ends with:
```typescript
      void queue.addDebrid(input, config.downloadDir, token);
      setNotice(`Real-Debrid: ${truncate(cleanText(input.name), 40)}`);
      setSection("downloads");
      setRegion("content");
```
Remove the last two lines so it becomes:
```typescript
      void queue.addDebrid(input, config.downloadDir, token);
      setNotice(`Real-Debrid: ${truncate(cleanText(input.name), 40)}`);
```

- [ ] **Step 3: Check for now-unused setters**

`setSection` and `setRegion` are still used elsewhere in `App.tsx` (e.g. `submitQuery`, the main `useInput`), so they remain imported/used. Confirm with a quick grep that neither became unused:

Run: `grep -n "setSection\|setRegion" src/ui/App.tsx`
Expected: still referenced in other handlers — no unused-variable error.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat: keep focus in results list after queueing a download"
```

---

## Task 5: Persistent body panes (non-destructive navigation)

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/components/Downloads.tsx`
- Modify: `src/ui/components/Seeding.tsx`

- [ ] **Step 1: Gate Results input on its section being active**

In `src/ui/components/Results.tsx`, the line:
```typescript
  const focused = region === "content";
```
becomes (Results owns the category sections — it must be inactive while Downloads/Seeding are showing):
```typescript
  const focused = region === "content" && section !== "downloads" && section !== "seeding";
```
`section` is already destructured from the store in this component. This single change deactivates all three of Results' `useInput` hooks (each gated on `focused`) and unfocuses its rendering when a non-category section is active.

- [ ] **Step 2: Gate Downloads input on the downloads section**

In `src/ui/components/Downloads.tsx`, add `section` to the `useStore()` destructure. The current line:
```typescript
  const { queue, region, contentWidth, listRows, startDownload, setDownloadFocus, copyLink } = useStore();
```
becomes:
```typescript
  const { queue, region, section, contentWidth, listRows, startDownload, setDownloadFocus, copyLink } = useStore();
```
Then change:
```typescript
  const focused = region === "content";
```
to:
```typescript
  const focused = region === "content" && section === "downloads";
```

- [ ] **Step 3: Gate Seeding input on the seeding section**

In `src/ui/components/Seeding.tsx`, add `section` to the `useStore()` destructure. The current line:
```typescript
  const { queue, region, contentWidth, listRows, setNotice, setSeedFocus } = useStore();
```
becomes:
```typescript
  const { queue, region, section, contentWidth, listRows, setNotice, setSeedFocus } = useStore();
```
Then change:
```typescript
  const focused = region === "content";
```
to:
```typescript
  const focused = region === "content" && section === "seeding";
```

- [ ] **Step 4: Render all three panes persistently in App**

In `src/ui/App.tsx`, the body currently renders one view at a time:
```tsx
          <Sidebar />
          <Box flexGrow={1} flexDirection="column">
            {section === "downloads" ? (
              <Downloads />
            ) : section === "seeding" ? (
              <Seeding />
            ) : (
              <Results />
            )}
          </Box>
```
Replace the inner `<Box flexGrow={1} ...>` block with three persistent, visibility-toggled panes:
```tsx
          <Sidebar />
          <Box flexGrow={1} flexDirection="column">
            <Box
              flexGrow={1}
              flexDirection="column"
              display={section !== "downloads" && section !== "seeding" ? "flex" : "none"}
            >
              <Results />
            </Box>
            <Box
              flexGrow={1}
              flexDirection="column"
              display={section === "downloads" ? "flex" : "none"}
            >
              <Downloads />
            </Box>
            <Box
              flexGrow={1}
              flexDirection="column"
              display={section === "seeding" ? "flex" : "none"}
            >
              <Seeding />
            </Box>
          </Box>
```
Now `<Results/>` stays mounted across section changes, preserving its `useConcurrentSearch` results, `cursor`, and `sort`; the hidden panes take no layout space (`display: "none"`) and their `useInput` is inactive (Steps 1–3).

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

Manual smoke (recommended — this is the structural change): `npm run dev`, run a search, scroll down a few rows, press `r`/`d` on several (you stay put, markers appear), switch to Downloads (sidebar) and back → same row, same results, no reload; confirm keys only act on the visible pane (e.g. `c` on Downloads cancels, but does nothing while Results is showing).

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx src/ui/components/Downloads.tsx src/ui/components/Seeding.tsx
git commit -m "feat: persistent body panes so results survive navigation"
```

---

## Final verification

- [ ] **Run the full suite, typecheck, and build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/cli.cjs` emitted.

- [ ] **Manual end-to-end smoke** (`npm run dev`)
  - Search, scroll, press `r` on several results without leaving the list; each shows `↓`, then `✓` when complete.
  - A previously-downloaded item shows `✓` on its row before you touch it.
  - Switch to Downloads and back: same scroll position, same results, instant (no re-search).
  - Trigger an RD failure on a dead/removed magnet and confirm the message reads as gone/removed rather than "temporarily unavailable".

---

## Notes

- Part 4's slug mapping (`messageForErrorSlug`) only rewrites messages for slugs it recognises; any unrecognised RD `error` slug keeps the existing generic `Real-Debrid error: <code> (HTTP <status>)` text, so there's no risk of mislabeling an unknown failure.
- No change to persistence, the queue engine, or the search logic itself — Task 5 only changes when components mount and whether their input is active.
