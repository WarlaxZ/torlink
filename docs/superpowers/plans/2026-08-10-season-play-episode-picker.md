# Season play → episode picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing play on a collapsed season made of loose episode releases reveals the episodes and lands on the next-up one instead of silently playing episode 1; and a live search auto-expands to the next-up episode instead of latching collapsed on the first sparse SSE frame.

**Architecture:** Two new pure functions in the shared `src/util/resultGroup.ts` — `seasonPlayPlan` (what play does on a season row) and `expansionSeed` (what to auto-open/land on, and when to stop retrying). Both front ends (`src/web/static/app.ts`, `src/ui/components/Results.tsx`) become thin wiring over them, per CLAUDE.md ("decisions in pure modules; move shared logic down, never copy"). Season packs are left on their existing resolve→file-picker path (already preselects the next episode).

**Tech Stack:** TypeScript, Vitest, Ink/React (TUI), vanilla DOM (web). Verify with `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

---

## File structure

- `src/util/resultGroup.ts` — add `SeasonPlayPlan`, `seasonPlayPlan`, `ExpansionSeed`, `expansionSeed`. (Modify.)
- `src/util/resultGroup.test.ts` — add tests for both. (Modify.)
- `src/web/static/searchModel.ts` — re-export the two functions + types for the browser bundle. (Modify.)
- `src/web/static/app.ts` — season-row play override; replace the inline seeding block with `expansionSeed`. (Modify.)
- `src/ui/components/Results.tsx` — `v`-key reveal for season rows; seeding/landing effects use `expansionSeed` and stop disarming on a transient sparse frame. (Modify.)

Fixtures use only the invented cast from CLAUDE.md (`Kepler.S02E0x` episodes, `Kepler.S02` pack, `Harrowgate.S03` pack). No real titles.

---

## Task 1: `seasonPlayPlan` in the shared module

**Files:**
- Modify: `src/util/resultGroup.ts`
- Test: `src/util/resultGroup.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/util/resultGroup.test.ts` (import `seasonPlayPlan` in the existing top `import { … } from "./resultGroup"` block):

```ts
describe("seasonPlayPlan", () => {
  // A show whose season 2 is present as loose episodes only.
  const looseSeason = () =>
    groupResults([
      r("Kepler.S02E01.1080p.WEB-DL"),
      r("Kepler.S02E02.1080p.WEB-DL"),
      r("Kepler.S02E03.1080p.WEB-DL"),
    ]);
  const seasonKey = "kepler|series|s2";
  const upTo = (episode: number): PositionLookup => (showKey) =>
    showKey === "kepler" ? { season: 2, episode } : null;

  it("reveals loose episodes and lands on the next-up episode", () => {
    const plan = seasonPlayPlan(looseSeason(), seasonKey, upTo(1));
    expect(plan.kind).toBe("reveal");
    if (plan.kind !== "reveal") throw new Error("expected reveal");
    expect(plan.expandKey).toBe(seasonKey);
    expect(plan.selectKey).toBe("kepler|series|s2|e2");
    expect(plan.select?.name).toBe("Kepler.S02E02.1080p.WEB-DL");
  });

  it("lands on the first episode when there is no watch position", () => {
    const plan = seasonPlayPlan(looseSeason(), seasonKey);
    expect(plan.kind).toBe("reveal");
    if (plan.kind !== "reveal") throw new Error("expected reveal");
    expect(plan.selectKey).toBe("kepler|series|s2|e1");
  });

  it("lands on the first episode when the next-up episode is not in the results", () => {
    // Up to E03 → next is E04, which the results do not have.
    const plan = seasonPlayPlan(looseSeason(), seasonKey, upTo(3));
    expect(plan.kind).toBe("reveal");
    if (plan.kind !== "reveal") throw new Error("expected reveal");
    expect(plan.selectKey).toBe("kepler|series|s2|e1");
  });

  it("resolves (does not reveal) when the season contains a pack", () => {
    const groups = groupResults([
      r("Kepler.S02.1080p.WEB-DL"),
      r("Kepler.S02E01.1080p.WEB-DL"),
      r("Kepler.S02E02.1080p.WEB-DL"),
    ]);
    const plan = seasonPlayPlan(groups, seasonKey, upTo(1));
    expect(plan.kind).toBe("resolve");
    if (plan.kind !== "resolve") throw new Error("expected resolve");
    // members[0] is the best pack (packs sort ahead of episodes).
    expect(plan.result.name).toBe("Kepler.S02.1080p.WEB-DL");
  });

  it("resolves for a key that is not a season node", () => {
    const groups = groupResults([r("Kestrel.2010.1080p.BluRay.x264")]);
    const plan = seasonPlayPlan(groups, "kestrel|2010|movie");
    expect(plan.kind).toBe("resolve");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/util/resultGroup.test.ts -t seasonPlayPlan`
Expected: FAIL — `seasonPlayPlan is not a function` / not exported.

- [ ] **Step 3: Implement `seasonPlayPlan`**

Add to `src/util/resultGroup.ts`, after `resultAtRow` (near line 514). It reuses the file's existing `seasonTree`, `isSeasonNode`, `SeasonNode`, `showKeyOf`, `PositionLookup`, `GroupableResult`, `ResultGroup`:

```ts
/**
 * What pressing play on a SEASON row should do.
 *
 * A season made of loose episodes has no single "the season" torrent, so
 * `members[0]` is merely the best release of episode one — playing it silently is
 * the bug this fixes. Instead: reveal the episodes and land on the one you are up
 * to. A season that DOES contain a pack keeps today's behaviour — grab the pack
 * (`members[0]`; packs sort first) and let the resolve→file-picker path preselect
 * the next episode, which also surfaces any extras inside the pack.
 *
 * Pure and shared so both front ends decide identically; the front ends only
 * wire the two outcomes. `resultAtRow` is deliberately NOT changed — add,
 * favourite and preview still resolve a release from it.
 */
export type SeasonPlayPlan<T> =
  | { kind: "resolve"; result: T | null }
  | { kind: "reveal"; expandKey: string; selectKey: string | null; select: T | null };

export function seasonPlayPlan<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
  seasonKey: string,
  positionFor?: PositionLookup,
): SeasonPlayPlan<T> {
  const node = seasonTree(groups).find(
    (n): n is SeasonNode<T> => isSeasonNode(n) && n.key === seasonKey,
  );
  // Not a season row (a film, a single-episode group) or gone: behave as play
  // does today — resolve the first member.
  if (!node) {
    return { kind: "resolve", result: groups.find((g) => g.key === seasonKey)?.members[0] ?? null };
  }
  // A child with no episode number is a pack: the whole season in one torrent.
  if (node.children.some((c) => c.episode === undefined)) {
    return { kind: "resolve", result: node.members[0] ?? null };
  }
  // Loose episodes only. Land on the next-up episode when the results have it,
  // else the first episode. `children` are episodes ascending (seasonTree sorts).
  const at = positionFor?.(showKeyOf(node.key)) ?? null;
  const target =
    (at &&
      node.children.find((c) => c.season === at.season && c.episode === at.episode + 1)) ||
    node.children[0]!;
  return {
    kind: "reveal",
    expandKey: node.key,
    selectKey: target.key,
    select: target.members[0] ?? null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/util/resultGroup.test.ts -t seasonPlayPlan`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/resultGroup.ts src/util/resultGroup.test.ts
git commit -m "feat(core): seasonPlayPlan — reveal loose episodes, resolve packs"
```

---

## Task 2: `expansionSeed` in the shared module

**Files:**
- Modify: `src/util/resultGroup.ts`
- Test: `src/util/resultGroup.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/util/resultGroup.test.ts` (import `expansionSeed`):

```ts
describe("expansionSeed", () => {
  const looseSeason = () =>
    groupResults([
      r("Kepler.S02E01.1080p.WEB-DL"),
      r("Kepler.S02E02.1080p.WEB-DL"),
      r("Kepler.S02E03.1080p.WEB-DL"),
    ]);
  const upTo1: PositionLookup = (showKey) => (showKey === "kepler" ? { season: 2, episode: 1 } : null);

  it("opens the season and points selection at the next-up episode", () => {
    const seed = expansionSeed(looseSeason(), upTo1, false);
    expect(seed.expandKeys).toContain("kepler|series|s2");
    expect(seed.selectKey).toBe("kepler|series|s2|e2");
    expect(seed.latch).toBe(true); // something was opened
  });

  it("does NOT latch on a sparse frame that forms no season, while the search runs", () => {
    // One episode → seasonTree drops a single-child season, so nothing to open.
    const oneEpisode = groupResults([r("Kepler.S02E01.1080p.WEB-DL")]);
    const seed = expansionSeed(oneEpisode, upTo1, false);
    expect(seed.expandKeys).toEqual([]);
    expect(seed.latch).toBe(false); // keep retrying as more results stream in
  });

  it("latches once the search has settled even with nothing to open", () => {
    const oneEpisode = groupResults([r("Kepler.S02E01.1080p.WEB-DL")]);
    const seed = expansionSeed(oneEpisode, upTo1, true);
    expect(seed.latch).toBe(true); // settled: stop retrying
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/util/resultGroup.test.ts -t expansionSeed`
Expected: FAIL — `expansionSeed is not a function`.

- [ ] **Step 3: Implement `expansionSeed`**

Add to `src/util/resultGroup.ts`, after `seasonPlayPlan`. It reuses the existing `defaultExpandedKeys` and `nextUpRowKey`:

```ts
/**
 * What a fresh result set should open and land on — and whether to stop trying.
 *
 * WHY `latch`: results stream in over SSE, so the FIRST frame is usually too
 * sparse to have formed the multi-episode season. Seeding on that frame and
 * latching (the previous behaviour in both front ends) opened nothing and never
 * retried, so a search for a show you are part-way through rendered collapsed
 * with no episode selected. Retry until either an expansion is applied or the
 * search settles — never latch on a frame that produced neither.
 */
export interface ExpansionSeed {
  /** Season keys to open. */
  expandKeys: string[];
  /** The group key to land selection on, or null. */
  selectKey: string | null;
  /** True once seeding is settled; the caller stops retrying. */
  latch: boolean;
}

export function expansionSeed<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
  positionFor: PositionLookup | undefined,
  searchSettled: boolean,
): ExpansionSeed {
  const expandKeys = defaultExpandedKeys(groups, positionFor);
  return {
    expandKeys,
    selectKey: nextUpRowKey(groups, positionFor),
    latch: expandKeys.length > 0 || searchSettled,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/util/resultGroup.test.ts -t expansionSeed`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/resultGroup.ts src/util/resultGroup.test.ts
git commit -m "feat(core): expansionSeed — retry auto-expand until formed or settled"
```

---

## Task 3: Re-export both functions for the browser bundle

**Files:**
- Modify: `src/web/static/searchModel.ts`

- [ ] **Step 1: Add to the existing `resultGroup` re-export block** (around `searchModel.ts:59-70`)

Change the block to include the new names and types (alphabetical, matching the file's style):

```ts
export {
  defaultExpandedKeys,
  expansionSeed,
  groupCountLabel,
  groupHeading,
  nextUpRowKey,
  positionNote,
  resultAtRow,
  seasonPlayPlan,
  showKeyOf,
  type ExpansionSeed,
  type GroupRow,
  type PositionLookup,
  type ResultGroup,
  type SeasonPlayPlan,
} from "../../util/resultGroup";
```

- [ ] **Step 2: Verify the re-export type-checks**

Run: `npm run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add src/web/static/searchModel.ts
git commit -m "chore(web): re-export seasonPlayPlan and expansionSeed"
```

---

## Task 4: Web — season-row play reveals episodes

**Files:**
- Modify: `src/web/static/app.ts` (imports; `resultActions` ~2064; `renderGroupRow` ~2471)

- [ ] **Step 1: Import the two helpers**

In the `from "./searchModel"` import block (around `app.ts:51-82`), add `expansionSeed`, `seasonPlayPlan` (and, if needed later, `visibleGroups` is already imported). Alphabetical within the block.

- [ ] **Step 2: Give `resultActions` an optional play override**

Change the signature and the play-button wiring (`app.ts:2064` and `2077`):

```ts
function resultActions(
  result: PublicSearchResult,
  rowKey: string,
  onPlay?: () => void,
): HTMLDivElement {
```

and

```ts
  playButton.addEventListener("click", () => {
    if (onPlay) onPlay();
    else void play(rowForPlay(result));
  });
```

- [ ] **Step 3: Compute the season play plan in `renderGroupRow` and pass the override**

In `renderGroupRow` (`app.ts:2471`), replace the single `resultActions(best, row.key)` call inside the `body.append(...)` (line 2514) with a computed override for season rows:

```ts
  // A season made of loose episodes plays nothing on click: it reveals the
  // episodes and lands on the one you are up to. The decision is seasonPlayPlan
  // (pure); this is only the wiring. A pack season / any other row keeps play.
  let onPlay: (() => void) | undefined;
  if (row.kind === "season") {
    const positionFor = positionLookup(savedState.continueWatching);
    const plan = seasonPlayPlan(
      visibleGroups(searchView, reportsHealthLookup(sources)),
      row.key,
      positionFor,
    );
    if (plan.kind === "reveal") {
      const target = plan.select;
      onPlay = () => {
        expandedGroups.add(plan.expandKey);
        if (target) selectResult(target);
        else renderResults();
      };
    }
  }
  body.append(head, meta, resultActions(best, row.key, onPlay));
```

Note: `selectResult` already sets `selectedHash`, re-renders, and updates the preview; adding `plan.expandKey` to `expandedGroups` first means the re-render shows the episodes with the next-up row highlighted.

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual verification in the browser**

Run: `npm run dev -- serve --web` (note the port/token it prints), then in a browser search a show with loose episodes and a known watch position. Press play on the collapsed season row.
Expected: the season expands and the next-up episode row is highlighted; nothing starts playing. Pressing play on an episode row still plays it. A season that contains a pack still resolves→file-picker as before.

- [ ] **Step 6: Commit**

```bash
git add src/web/static/app.ts
git commit -m "feat(web): season play reveals loose episodes and lands on next-up"
```

---

## Task 5: Web — fix the auto-expand seeding latch

**Files:**
- Modify: `src/web/static/app.ts` (`renderResults`, the `if (!seededExpansion)` block ~2559-2572)

- [ ] **Step 1: Replace the seeding block with `expansionSeed`**

Replace the whole `if (!seededExpansion) { … }` block (`app.ts:2559-2572`) with:

```ts
  if (!seededExpansion) {
    const groups = visibleGroups(searchView, reportsHealthLookup(sources));
    if (groups.length > 0) {
      const positionFor = positionLookup(savedState.continueWatching);
      // `running` is true between submit and the `done` frame; !running == settled.
      const seed = expansionSeed(groups, positionFor, !searchView.running);
      for (const key of seed.expandKeys) expandedGroups.add(key);
      // Select the episode you are up to, resolved from the GROUPS (rows do not
      // exist yet). Null when the results do not have it — nothing phantom.
      const landing = seed.selectKey ? groups.find((g) => g.key === seed.selectKey) : undefined;
      if (landing?.members[0]) selectedHash = landing.members[0].infoHash;
      // Latch only once something was opened or the search settled, so a sparse
      // first SSE frame no longer freezes the list collapsed.
      seededExpansion = seed.latch;
    }
  }
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual verification**

With `npm run dev -- serve --web` running, do a fresh search for a show you are part-way through (no manual expanding).
Expected: once results finish streaming, the season is already expanded with the next-up episode highlighted — no click needed.

- [ ] **Step 4: Commit**

```bash
git add src/web/static/app.ts
git commit -m "fix(web): don't latch auto-expand on the first sparse SSE frame"
```

---

## Task 6: Terminal — `v` on a loose-episode season reveals it

**Files:**
- Modify: `src/ui/components/Results.tsx` (imports ~21-30; `v` handler ~729-731)

- [ ] **Step 1: Import the helpers**

In the `from "../../util/resultGroup"` import block (`Results.tsx:21-30`), add `expansionSeed` and `seasonPlayPlan`.

- [ ] **Step 2: Change the `v` (stream) handler to reveal a loose-episode season**

Replace the `v` branch (`Results.tsx:729-731`):

```ts
      } else if (input === "v") {
        const row = rows[clamped];
        if (row?.kind === "season") {
          const plan = seasonPlayPlan(
            groupResults(results, hintForSection(section)),
            row.key,
            positionFor,
          );
          if (plan.kind === "reveal") {
            // Reveal the episodes and land the cursor on the next-up one. selRef
            // moves the cursor to the row once the rebuilt rows include it.
            if (plan.select) selRef.current = { key: plan.selectKey!, hash: plan.select.infoHash };
            setExpanded((current) => new Set(current).add(plan.expandKey));
          } else if (plan.result) {
            openStream(plan.result);
          }
        } else {
          const r = resultAt(clamped);
          if (r) openStream(r);
        }
      }
```

Note: `selRef`'s effect (`Results.tsx:485-499`) already moves the cursor to the row whose `key` matches `selRef.current.key` once the rows rebuild after expansion, with an infoHash fallback — the same mechanism the seeding "land" uses.

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the existing Results tests**

Run: `npx vitest run src/ui/components/Results.test.tsx`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/Results.tsx
git commit -m "feat(ui): v on a loose-episode season reveals it and lands on next-up"
```

---

## Task 7: Terminal — fix the auto-expand seeding + landing latches

**Files:**
- Modify: `src/ui/components/Results.tsx` (seeding effect ~393-404; landing effect ~644-662)

- [ ] **Step 1: Rewrite the seeding effect to use `expansionSeed`**

Replace the seeding effect (`Results.tsx:393-404`):

```ts
  useEffect(() => {
    if (results.length === 0) {
      seeded.current = false;
      landed.current = false;
      return;
    }
    if (seeded.current) return;
    const seed = expansionSeed(
      groupResults(results, hintForSection(section)),
      positionFor,
      !search.loading,
    );
    if (seed.expandKeys.length > 0) setExpanded(new Set(seed.expandKeys));
    if (seed.latch) {
      seeded.current = true;
      // Arm the cursor "land" only when there is somewhere to land.
      landed.current = seed.selectKey !== null;
    }
  }, [results, section, positionFor, search.loading]);
```

- [ ] **Step 2: Stop the landing effect disarming on a transient sparse frame**

In the landing effect (`Results.tsx:644-662`), change the "no key" branch so it only gives up once the search has settled:

```ts
    if (!key) {
      if (!search.loading) landed.current = false; // settled with nothing to land on
      return;
    }
```

And add `search.loading` to that effect's dependency array (keep the existing eslint-disable comment for `moveTo`):

```ts
  }, [rows, results, section, positionFor, search.loading]);
```

- [ ] **Step 3: Type-check and test**

Run: `npm run typecheck && npx vitest run src/ui/components/Results.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/Results.tsx
git commit -m "fix(ui): don't latch auto-expand/land on a sparse first frame"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole gate**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all PASS. The one known pre-existing lint warning (`react-hooks/exhaustive-deps` in `src/ui/App.tsx`) is allowed; no NEW warnings.

- [ ] **Step 2: Manual smoke of both surfaces**

- Web: `npm run dev -- serve --web` — search a part-watched show; confirm (a) it lands auto-expanded on next-up, and (b) play on a collapsed loose season reveals + highlights next-up without playing, while a pack season still resolves→file-picker.
- Terminal: `npm run dev` — same show; confirm `v` on a collapsed loose season expands it and moves the cursor to next-up, and a fresh search lands on next-up.

- [ ] **Step 3: Update docs if the web UI's limitations list mentions episode selection**

Check `README.md` (and the web UI's own limitations copy) for any claim that season play picks a single release / has no episode chooser; update if now inaccurate. Commit any change:

```bash
git add README.md
git commit -m "docs: season play now reveals episodes"
```

---

## Self-review notes

- **Spec coverage:** loose-episode reveal (Tasks 1,4,6); pack unchanged/resolve (Task 1 test + web/TUI wiring leave the resolve path alone); next-up fallback to first episode (Task 1 tests); auto-expand latch fix both surfaces (Tasks 2,5,7); shared decision in `src/util` (Tasks 1,2); no change to `resultAtRow`/add/favourite/preview (only the play/`v` paths branch).
- **Type consistency:** `seasonPlayPlan`/`SeasonPlayPlan`, `expansionSeed`/`ExpansionSeed`, `expandKey`/`selectKey`/`select` used identically across core, web, and TUI tasks.
- **Known caveat (documented in spec):** if `/api/saved` / `streamHistory` has not loaded when the season first forms, expansion still fires but selection falls back to the first episode; in practice it loads before a search settles.
