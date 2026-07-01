# Real-Debrid vs Torrent Indicator in Downloads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make delivery method unmistakable in the downloads list — Real-Debrid items read `RD·<origin>` (green), P2P/torrent items read `P2P·<origin>` (amber) — for both active and completed rows.

**Architecture:** A pure `deliveryMethod(via)` helper decides RD vs P2P. `HistoryItem` gains a persisted `via` so completed items stay labeled. `Downloads.tsx` renders a `SourceBadge` (colored method + origin tag) in place of the origin-only tag.

**Tech Stack:** TypeScript (ESM, Node 22), Ink 7, vitest, tsup. Tests colocate as `src/**/*.test.ts`. `npm test` / `npx vitest run <path>` / `npm run typecheck`.

**Build order:** `deliveryMethod` helper → `HistoryItem.via` + `recordHistory` → `Downloads.tsx` badge.

---

## File Structure

**Modified**
- `src/ui/downloadState.ts` — add pure `deliveryMethod(via)`.
- `src/ui/downloadState.test.ts` — its test.
- `src/download/history.ts` — add `via?` to `HistoryItem`.
- `src/download/queue.ts` — stamp `via` in `recordHistory`.
- `src/ui/components/Downloads.tsx` — `SourceBadge`, wire active + recent rows, widen source column, drop `sourceTag`.

---

## Task 1: `deliveryMethod` helper

**Files:**
- Modify: `src/ui/downloadState.ts`
- Test: `src/ui/downloadState.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/ui/downloadState.test.ts`:
```typescript
import { deliveryMethod } from "./downloadState";

describe("deliveryMethod", () => {
  it("labels realdebrid as RD and everything else as P2P", () => {
    expect(deliveryMethod("realdebrid")).toBe("RD");
    expect(deliveryMethod("p2p")).toBe("P2P");
    expect(deliveryMethod(undefined)).toBe("P2P");
  });
});
```
(`describe`/`it`/`expect` are already imported at the top of the file; merge the `deliveryMethod` import into the existing `./downloadState` import line if one exists, otherwise this new import line is fine.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/downloadState.test.ts`
Expected: FAIL — `deliveryMethod is not a function` / not exported.

- [ ] **Step 3: Implement**

In `src/ui/downloadState.ts`, add the import at the top (the file currently has no imports; add this) and the function at the end:
```typescript
import type { DownloadVia } from "../download/types";
```
```typescript
// Which delivery method a download uses, for the downloads-list badge. Absent
// `via` means a legacy/plain magnet, i.e. peer-to-peer.
export function deliveryMethod(via: DownloadVia | undefined): "RD" | "P2P" {
  return via === "realdebrid" ? "RD" : "P2P";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/ui/downloadState.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/downloadState.ts src/ui/downloadState.test.ts
git commit -m "feat: add deliveryMethod helper (RD vs P2P) for the downloads badge"
```

---

## Task 2: Persist `via` on completed items

**Files:**
- Modify: `src/download/history.ts`
- Modify: `src/download/queue.ts`

- [ ] **Step 1: Add `via` to `HistoryItem`**

In `src/download/history.ts`, the interface is:
```typescript
export interface HistoryItem {
  id: string;
  name: string;
  source?: SourceId;
  sizeBytes: number;
  magnet: string;
  dir: string;
  completedAt: number;
}
```
Add a `via` field and import its type. Add to the imports at the top of the file:
```typescript
import type { DownloadVia } from "./types";
```
(If `history.ts` already imports from `./types`, merge `DownloadVia` into that import.) Then add the field (after `source?`):
```typescript
  source?: SourceId;
  // Delivery method of the completed download, so the history row can show
  // RD vs P2P. Optional: entries written before this existed load as undefined.
  via?: DownloadVia;
```

- [ ] **Step 2: Stamp `via` in `recordHistory` — `src/download/queue.ts`**

`recordHistory` currently builds:
```typescript
    const rec: HistoryItem = {
      id: it.id,
      name: it.name,
      source: it.source,
      sizeBytes: it.totalBytes,
      magnet: it.magnet,
      dir: it.dir,
      completedAt: Date.now(),
    };
```
Add an explicit `via` (so P2P completions record `"p2p"`, not undefined — only truly-legacy entries stay undefined):
```typescript
    const rec: HistoryItem = {
      id: it.id,
      name: it.name,
      source: it.source,
      sizeBytes: it.totalBytes,
      magnet: it.magnet,
      dir: it.dir,
      via: it.via ?? "p2p",
      completedAt: Date.now(),
    };
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS. (No behavior change yet beyond a new persisted field; existing tests unaffected.)

- [ ] **Step 4: Commit**

```bash
git add src/download/history.ts src/download/queue.ts
git commit -m "feat: record delivery method (via) on completed downloads"
```

---

## Task 3: Render the RD/P2P badge in Downloads

**Files:**
- Modify: `src/ui/components/Downloads.tsx`

- [ ] **Step 1: Imports + remove `sourceTag`**

In `src/ui/components/Downloads.tsx`:

Add `deliveryMethod` to the store/util imports. The file imports theme bits already (`import { COLOR, GUTTER, ICON, PAUSED, SOURCE_STYLE } from "../theme";`). Add a new import line:
```typescript
import { deliveryMethod } from "../downloadState";
import type { SourceId } from "../../sources/types";
```
(If `SourceId` is already imported in this file, don't duplicate it.)

Remove the now-unused `sourceTag` function:
```typescript
// Short tag shown in the source column: real source, "rd" for Real-Debrid, or
// "mag" for a bare magnet.
function sourceTag(via: QueueItem["via"]): string {
  return via === "realdebrid" ? "rd" : "mag";
}
```
Delete that entire function (it's replaced by `SourceBadge`).

- [ ] **Step 2: Add the `SourceBadge` component**

Add near the top of the file (module scope, after the other small helpers like `statusColor`/`statusIcon`):
```tsx
// The source cell: a colored delivery-method marker (RD green / P2P amber) plus
// the torrent origin tag, e.g. "RD·EZTV" / "P2P·YTS". `method` is null only for
// legacy history rows with no recorded method (shown origin-only, never
// mislabeled). With neither method nor source, falls back to a dim "mag".
function SourceBadge({
  method,
  source,
  dim,
}: {
  method: "RD" | "P2P" | null;
  source?: SourceId;
  dim?: boolean;
}) {
  const ss = source ? SOURCE_STYLE[source] : undefined;
  const methodColor = method === "RD" ? COLOR.good : COLOR.warn;
  if (!method && !ss) return <Text dimColor>mag</Text>;
  return (
    <Text>
      {method ? (
        <Text color={methodColor} dimColor={dim}>
          {method}
        </Text>
      ) : null}
      {method && ss ? <Text dimColor>·</Text> : null}
      {ss ? (
        <Text color={ss.color} dimColor={dim}>
          {ss.tag}
        </Text>
      ) : null}
    </Text>
  );
}
```

- [ ] **Step 3: Use it in the active rows + widen the column**

The active source cell currently is:
```tsx
              <Box width={4} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                <Text color={it.source ? ss.color : undefined} dimColor={!it.source || !here}>
                  {it.source ? ss.tag : sourceTag(it.via)}
                </Text>
              </Box>
```
Replace with (width 4 → 8, badge with method always present for active items):
```tsx
              <Box width={8} flexShrink={0} marginLeft={1} justifyContent="flex-end">
                <SourceBadge method={deliveryMethod(it.via)} source={it.source} dim={!here} />
              </Box>
```
(The local `const ss = SOURCE_STYLE[it.source ?? "fitgirl"];` a few lines above may now be unused in this row — if TypeScript/lint flags it as unused, remove that line; if it's still used elsewhere in the row, leave it. Check before deleting.)

- [ ] **Step 4: Use it in the recent (history) rows + widen the column**

The recent source cell currently is:
```tsx
            <Box width={4} flexShrink={0} marginLeft={1} justifyContent="flex-end">
              <Text color={h.source ? ss.color : undefined} dimColor={!h.source || !here}>
                {h.source ? ss.tag : "mag"}
              </Text>
            </Box>
```
Replace with (width 4 → 8; method null for legacy entries with no `via`):
```tsx
            <Box width={8} flexShrink={0} marginLeft={1} justifyContent="flex-end">
              <SourceBadge
                method={h.via === undefined ? null : deliveryMethod(h.via)}
                source={h.source}
                dim={!here}
              />
            </Box>
```
(Same note: if the recent row's local `const ss = SOURCE_STYLE[h.source ?? "fitgirl"];` becomes unused, remove it; otherwise leave it.)

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS (watch for unused-variable errors on the two `ss` locals and the removed `sourceTag`).

Manual smoke (recommended): `npm run dev` — start a Real-Debrid download and confirm the row shows `RD·<src>` (green RD); a P2P download shows `P2P·<src>` (amber P2P); a completed RD download keeps `RD·…` in "Recently downloaded".

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/Downloads.tsx
git commit -m "feat: show RD vs P2P delivery method in the downloads list"
```

---

## Final verification

- [ ] **Run everything**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/cli.cjs` emitted.

- [ ] **Manual end-to-end** (`npm run dev`)
  - Real-Debrid download → active row shows a green `RD·<origin>`.
  - P2P download (if you trigger one) → amber `P2P·<origin>`.
  - Completed RD download → still `RD·<origin>` under "Recently downloaded".
  - A pre-existing history entry (from before this change) → shows just its origin tag, not mislabeled.

---

## Notes

- `deliveryMethod` treats `undefined` `via` as P2P (matches the "absent = p2p" convention); active P2P items have `via` undefined and correctly render `P2P`.
- Only *history* rows pass `null` method (for legacy entries with no recorded `via`) — active rows always label, since `via` is known in-session.
- Column widened 4 → 8 to fit `P2P·NNNN` (longest origin tag is 4 chars); the flex name column absorbs the change, so no width math needs updating.
