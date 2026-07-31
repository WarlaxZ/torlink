# The Season Tree (Piece A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make grouped TV results render as the tree they already are — season → episode → release — instead of a flat, seeder-ordered list where a season pack lands in the middle of its own episodes.

**Architecture:** `groupResults` is untouched. A new pure pass, `seasonTree`, folds a show's single-season groups under season nodes; `groupRowPlan` walks that tree and emits rows carrying a `depth`. Both front ends gain depth-indent rendering and nothing else — every decision stays in `src/util/resultGroup.ts`, which both already render from.

**Tech Stack:** TypeScript, vitest, Ink (terminal), plain DOM + tsup (browser). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-31-tv-season-tree-design.md`

## Global Constraints

- **Both front ends in the same change.** `src/ui/` and `src/web/static/` — a feature in one only is a bug report waiting to happen (`CLAUDE.md`).
- **`src/web` must not import from `src/ui`.** Lint enforces it. Share by putting the piece in `src/util/`.
- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` in `src/web/static/`.** Every node is `createElement` + `textContent`. Release names are attacker-controlled.
- **`app.ts` is DOM wiring only.** A conditional deciding *what to show* belongs in a pure module.
- **Never name a real film or show** in a test, helper, doc comment, example, or user-facing copy. Use the shared cast: `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **`src/util/resultGroup.ts` must stay browser-safe** — no `node:*`, direct or transitive. `npm run build` is the only check that catches a violation.
- **Gates before any task is done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) — leave it.
- **Conventional Commits.**

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/util/resultGroup.ts` | Grouping, the season tree, the row plan, headings | Modify — all new logic |
| `src/util/resultGroup.test.ts` | Unit tests for the above | Modify |
| `src/ui/components/Results.tsx` | Terminal list rendering + expansion state | Modify — indent, seed |
| `src/ui/components/Results.test.tsx` | Terminal rendering tests | Modify |
| `src/web/static/app.ts` | Browser DOM wiring | Modify — indent, seed |
| `src/web/static/styles.css` | Browser indent styling | Modify — depth-2 rule |
| `README.md` | User-facing description of grouping | Modify |

---

### Task 1: Build the season tree

**Files:**
- Modify: `src/util/resultGroup.ts`
- Test: `src/util/resultGroup.test.ts`

**Interfaces:**
- Consumes: existing `ResultGroup<T>`, `GroupableResult`.
- Produces: `SeasonNode<T>`, `TreeNode<T>`, `seasonTree(groups: readonly ResultGroup<T>[]): TreeNode<T>[]`.

- [ ] **Step 1: Write the failing tests**

Add to `src/util/resultGroup.test.ts`, importing `seasonTree` alongside the existing imports:

```ts
describe("seasonTree", () => {
  const isSeason = <T,>(node: unknown): node is { kind: "season" } & Record<string, unknown> =>
    typeof node === "object" && node !== null && "kind" in node;

  it("folds a show's packs and episodes under one season node", () => {
    const tree = seasonTree(
      groupResults(
        [
          r("Harrowgate.S03.1080p.WEB-DL"),
          r("Harrowgate.S03.2160p.WEB-DL"),
          r("Harrowgate.S03E02.1080p.WEB-DL"),
          r("Harrowgate.S03E02.2160p.WEB-DL"),
          r("Harrowgate.S03E01.1080p.WEB-DL"),
          r("Harrowgate.S03E01.2160p.WEB-DL"),
        ],
        "series",
      ),
    );
    expect(tree).toHaveLength(1);
    const node = tree[0]!;
    expect(isSeason(node)).toBe(true);
    if (!isSeason(node)) return;
    expect(node.key).toBe("harrowgate|series|s3");
    expect(node.season).toBe(3);
  });

  it("puts the pack before the episodes, and episodes ascending", () => {
    const tree = seasonTree(
      groupResults(
        [
          r("Harrowgate.S03E02.1080p.WEB-DL"),
          r("Harrowgate.S03E02.2160p.WEB-DL"),
          r("Harrowgate.S03.1080p.WEB-DL"),
          r("Harrowgate.S03.2160p.WEB-DL"),
          r("Harrowgate.S03E01.1080p.WEB-DL"),
          r("Harrowgate.S03E01.2160p.WEB-DL"),
        ],
        "series",
      ),
    );
    const node = tree[0]!;
    if (!isSeason(node)) throw new Error("expected a season node");
    expect((node.children as { episode?: number }[]).map((c) => c.episode)).toEqual([
      undefined,
      1,
      2,
    ]);
  });

  it("orders seasons newest first", () => {
    const tree = seasonTree(
      groupResults(
        [
          r("Harrowgate.S01E01.1080p.WEB-DL"),
          r("Harrowgate.S01E01.2160p.WEB-DL"),
          r("Harrowgate.S03E01.1080p.WEB-DL"),
          r("Harrowgate.S03E01.2160p.WEB-DL"),
        ],
        "series",
      ),
    );
    expect(tree.map((n) => (isSeason(n) ? n.season : null))).toEqual([3, 1]);
  });

  it("emits a show's whole season block where its first group sat", () => {
    // Kestrel comes between the two Harrowgate groups in input order. The show's
    // seasons must stay contiguous, at the position of its FIRST group, so every
    // existing sort still means what it means.
    const tree = seasonTree(
      groupResults(
        [
          r("Harrowgate.S01E01.1080p.WEB-DL"),
          r("Harrowgate.S01E01.2160p.WEB-DL"),
          r("Kestrel.2010.1080p.BluRay.x264"),
          r("Kestrel.2010.2160p.WEB-DL"),
          r("Harrowgate.S03E01.1080p.WEB-DL"),
          r("Harrowgate.S03E01.2160p.WEB-DL"),
        ],
        "series",
      ),
    );
    expect(tree.map((n) => (isSeason(n) ? `s${n.season}` : "film"))).toEqual([
      "s3",
      "s1",
      "film",
    ]);
  });

  it("leaves a film alone", () => {
    const tree = seasonTree(groupResults([r("Kestrel.2010.1080p"), r("Kestrel.2010.2160p")]));
    expect(tree).toHaveLength(1);
    expect(isSeason(tree[0])).toBe(false);
  });

  it("leaves a multi-season span pack top-level, not filed under its first season", () => {
    const tree = seasonTree(
      groupResults(
        [
          r("Harrowgate.S01-S03.COMPLETE.1080p.WEB-DL"),
          r("Harrowgate.S01-S03.COMPLETE.2160p.WEB-DL"),
        ],
        "series",
      ),
    );
    expect(isSeason(tree[0])).toBe(false);
  });

  it("leaves a seasonless complete-series pack top-level", () => {
    const tree = seasonTree(
      groupResults(
        [r("Harrowgate.COMPLETE.SERIES.1080p.WEB-DL"), r("Harrowgate.COMPLETE.SERIES.2160p")],
        "series",
      ),
    );
    expect(isSeason(tree[0])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/util/resultGroup.test.ts`
Expected: FAIL — `seasonTree is not a function`, and a typecheck error that `resultGroup` has no exported member `seasonTree`.

- [ ] **Step 3: Implement `seasonTree`**

Add to `src/util/resultGroup.ts`, after `groupResults`:

```ts
/**
 * A season of one show, holding its packs and its episode groups.
 *
 * `members` is every child's members concatenated in child order, which is what
 * lets `resultAtRow` keep working untouched: packs sort first, so the first
 * member of a collapsed season row is the best season pack.
 */
export interface SeasonNode<T> {
  kind: "season";
  key: string;
  title: string;
  season: number;
  /** Packs first, then episodes ascending. Never empty. */
  children: ResultGroup<T>[];
  /** Never empty. */
  members: T[];
}

/** A top-level node: a season of a show, or a group that has no season to sit under. */
export type TreeNode<T> = SeasonNode<T> | ResultGroup<T>;

/** True for a `SeasonNode`. `ResultGroup` has no `kind`, which is the discriminator. */
export function isSeasonNode<T>(node: TreeNode<T>): node is SeasonNode<T> {
  return "kind" in node;
}

/**
 * Which groups fold under a season.
 *
 * A group naming ONE season. A span pack ("S01-S03") names three and filing it
 * under season 1 would claim it is a season-1 release; a "complete series" pack
 * names none. Both stay top-level. Only the series branch of `factsFor` ever
 * sets `season`, so this needs no separate "is a series" flag.
 */
function foldsUnderSeason<T>(group: ResultGroup<T>): boolean {
  return group.season !== undefined && group.seasonEnd === undefined;
}

/** "harrowgate" out of "harrowgate|series|s3|e1" — the show's identity. */
function showOf(key: string): string {
  const at = key.indexOf("|series|");
  return at === -1 ? key : key.slice(0, at);
}

/** Packs before episodes; episodes ascending. */
function compareSeasonChild<T>(a: ResultGroup<T>, b: ResultGroup<T>): number {
  if (a.episode === undefined && b.episode === undefined) return 0;
  if (a.episode === undefined) return -1;
  if (b.episode === undefined) return 1;
  return a.episode - b.episode;
}

/**
 * Fold a show's single-season groups under season nodes.
 *
 * ORDER IS PRESERVED at the top level: a show's whole season block is emitted at
 * the position of its FIRST group, so `groupResults`' promise that groups sit
 * where their best member sits — which every sort depends on — still holds.
 * Within a show, seasons are newest first.
 */
export function seasonTree<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
): TreeNode<T>[] {
  const byShow = new Map<string, Map<number, ResultGroup<T>[]>>();
  for (const group of groups) {
    if (!foldsUnderSeason(group)) continue;
    const show = showOf(group.key);
    let seasons = byShow.get(show);
    if (!seasons) {
      seasons = new Map();
      byShow.set(show, seasons);
    }
    const bucket = seasons.get(group.season!) ?? [];
    bucket.push(group);
    seasons.set(group.season!, bucket);
  }

  const out: TreeNode<T>[] = [];
  const done = new Set<string>();
  for (const group of groups) {
    if (!foldsUnderSeason(group)) {
      out.push(group);
      continue;
    }
    const show = showOf(group.key);
    if (done.has(show)) continue;
    done.add(show);
    const seasons = byShow.get(show)!;
    for (const season of [...seasons.keys()].sort((a, b) => b - a)) {
      const children = [...seasons.get(season)!].sort(compareSeasonChild);
      out.push({
        kind: "season",
        key: `${show}|series|s${season}`,
        title: children[0]!.title,
        season,
        children,
        members: children.flatMap((child) => child.members),
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/util/resultGroup.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Run the gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/util/resultGroup.ts src/util/resultGroup.test.ts
git commit -m "feat(util): fold a show's seasons into a tree above its groups"
```

---

### Task 2: Emit season rows, with depth and short headings

**Files:**
- Modify: `src/util/resultGroup.ts`
- Test: `src/util/resultGroup.test.ts`

**Interfaces:**
- Consumes: `seasonTree`, `isSeasonNode`, `SeasonNode<T>` from Task 1.
- Produces: `GroupRow<T>` gains a `{ kind: "season" }` variant and a `depth: number` on every variant; `groupHeading(group, opts?: { underSeason?: boolean })`.

- [ ] **Step 1: Write the failing tests**

Add to `src/util/resultGroup.test.ts`:

```ts
describe("groupRowPlan with seasons", () => {
  const SEASON = [
    r("Harrowgate.S03.1080p.WEB-DL"),
    r("Harrowgate.S03.2160p.WEB-DL"),
    r("Harrowgate.S03E01.1080p.WEB-DL"),
    r("Harrowgate.S03E01.2160p.WEB-DL"),
  ];

  it("collapses a season to one row", () => {
    const rows = groupRowPlan(groupResults(SEASON, "series"), new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("season");
    expect(rows[0]!.depth).toBe(0);
  });

  it("shows the pack and the episode indented when the season is open", () => {
    const rows = groupRowPlan(groupResults(SEASON, "series"), new Set(["harrowgate|series|s3"]));
    expect(rows.map((row) => `${row.kind}@${row.depth}`)).toEqual([
      "season@0",
      "group@1",
      "group@1",
    ]);
  });

  it("puts a release at depth 2 under an open episode inside an open season", () => {
    const rows = groupRowPlan(
      groupResults(SEASON, "series"),
      new Set(["harrowgate|series|s3", "harrowgate|series|s3|e1"]),
    );
    expect(rows.filter((row) => row.kind === "release").every((row) => row.depth === 2)).toBe(true);
  });

  it("acts on the best season pack when the season row is collapsed", () => {
    const rows = groupRowPlan(groupResults(SEASON, "series"), new Set());
    expect(resultAtRow(rows[0]!)?.name).toBe("Harrowgate.S03.1080p.WEB-DL");
  });

  it("falls through to the first episode when the season has no pack", () => {
    const rows = groupRowPlan(
      groupResults(
        [
          r("Harrowgate.S03E02.1080p.WEB-DL"),
          r("Harrowgate.S03E02.2160p.WEB-DL"),
          r("Harrowgate.S03E01.1080p.WEB-DL"),
          r("Harrowgate.S03E01.2160p.WEB-DL"),
        ],
        "series",
      ),
      new Set(),
    );
    expect(resultAtRow(rows[0]!)?.name).toBe("Harrowgate.S03E01.1080p.WEB-DL");
  });

  it("drops a season node holding only one child, so a lone release stays a plain row", () => {
    const rows = groupRowPlan(groupResults([r("Harrowgate.S03E01.1080p.WEB-DL")], "series"), new Set());
    expect(rows.map((row) => row.kind)).toEqual(["release"]);
    expect(rows[0]!.depth).toBe(0);
  });

  it("leaves a film's rows exactly as they were", () => {
    const rows = groupRowPlan(
      groupResults([r("Kestrel.2010.1080p.BluRay.x264"), r("Kestrel.2010.2160p.WEB-DL")]),
      new Set(),
    );
    expect(rows.map((row) => row.kind)).toEqual(["group"]);
    expect(rows[0]!.depth).toBe(0);
  });

  it("gives every row a unique key at three levels", () => {
    const rows = groupRowPlan(
      groupResults(SEASON, "series"),
      new Set(["harrowgate|series|s3", "harrowgate|series|s3|e1", "harrowgate|series|s3|pack"]),
    );
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

describe("groupHeading under a season", () => {
  it("drops the show name a season row already states", () => {
    const [group] = groupResults([r("Kepler.S02E04.1080p.WEB-DL")], "series");
    expect(groupHeading(group!, { underSeason: true })).toBe("S02E04");
  });

  it("names a pack as what it is", () => {
    const [group] = groupResults([r("Harrowgate.S03.1080p.WEB-DL")], "series");
    expect(groupHeading(group!, { underSeason: true })).toBe("Season pack");
  });

  it("is unchanged without the option", () => {
    const [group] = groupResults([r("Kepler.S02E04.1080p.WEB-DL")], "series");
    expect(groupHeading(group!)).toBe("Kepler S02E04");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/util/resultGroup.test.ts`
Expected: FAIL — `depth` does not exist on `GroupRow`, and `groupHeading` takes one argument.

- [ ] **Step 3: Add the `season` row variant and `depth`**

Replace the `GroupRow` type in `src/util/resultGroup.ts`:

```ts
/**
 * One line of the rendered list: a season heading, a group heading, or a release.
 *
 * `depth` is how far the row is indented — 0 top level, 1 inside an open season,
 * 2 a release inside an episode group inside an open season. Both front ends
 * read it rather than deriving indent themselves.
 */
export type GroupRow<T> =
  | {
      kind: "season";
      key: string;
      title: string;
      season: number;
      members: T[];
      expanded: boolean;
      depth: number;
    }
  | {
      kind: "group";
      key: string;
      title: string;
      year?: number;
      season?: number;
      seasonEnd?: number;
      episode?: number;
      members: T[];
      expanded: boolean;
      depth: number;
    }
  | { kind: "release"; key: string; result: T; inGroup: boolean; depth: number };
```

- [ ] **Step 4: Rewrite `groupRowPlan` over the tree**

Replace `groupRowPlan` in `src/util/resultGroup.ts`:

```ts
/**
 * One group's rows, at a given depth. The "group of one" rule is here: a
 * disclosure arrow over "1 release" is noise, and it would make the common case
 * — a search where nothing duplicates — look like a different feature.
 */
function pushGroupRows<T extends GroupableResult>(
  rows: GroupRow<T>[],
  group: ResultGroup<T>,
  expanded: ReadonlySet<string>,
  depth: number,
): void {
  const first = group.members[0];
  if (first === undefined) return;
  if (group.members.length === 1) {
    rows.push({ kind: "release", key: group.key, result: first, inGroup: depth > 0, depth });
    return;
  }
  const isOpen = expanded.has(group.key);
  const row: GroupRow<T> = {
    kind: "group",
    key: group.key,
    title: group.title,
    members: group.members,
    expanded: isOpen,
    depth,
  };
  if (group.year !== undefined) row.year = group.year;
  if (group.season !== undefined) row.season = group.season;
  if (group.seasonEnd !== undefined) row.seasonEnd = group.seasonEnd;
  if (group.episode !== undefined) row.episode = group.episode;
  rows.push(row);
  if (!isOpen) return;
  group.members.forEach((member, i) => {
    rows.push({
      kind: "release",
      key: `${group.key}#${i}`,
      result: member,
      inGroup: true,
      depth: depth + 1,
    });
  });
}

/**
 * Flatten the season tree into the rows to render, honouring what is expanded.
 *
 * A season node holding a SINGLE child is dropped and its child emitted in its
 * place: wrapping one episode in a season row is the same noise as a disclosure
 * over "1 release", and without this a search returning one release of one show
 * would grow a heading it never had.
 *
 * Shared by both front ends deliberately. The browser renders these rows with
 * createElement and the terminal with Ink boxes, but "which rows are there" is
 * one decision, and this codebase records four bugs caused by copying one
 * instead of moving it down here.
 */
export function groupRowPlan<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
  expanded: ReadonlySet<string>,
): GroupRow<T>[] {
  const rows: GroupRow<T>[] = [];
  for (const node of seasonTree(groups)) {
    if (!isSeasonNode(node)) {
      pushGroupRows(rows, node, expanded, 0);
      continue;
    }
    const only = node.children.length === 1 ? node.children[0] : undefined;
    if (only) {
      pushGroupRows(rows, only, expanded, 0);
      continue;
    }
    const isOpen = expanded.has(node.key);
    rows.push({
      kind: "season",
      key: node.key,
      title: node.title,
      season: node.season,
      members: node.members,
      expanded: isOpen,
      depth: 0,
    });
    if (!isOpen) continue;
    for (const child of node.children) pushGroupRows(rows, child, expanded, 1);
  }
  return rows;
}
```

- [ ] **Step 5: Teach `groupHeading` the short form**

Replace `groupHeading` in `src/util/resultGroup.ts`:

```ts
/**
 * What a group heading says.
 *
 * Shared by both front ends because the alternative — each formatting its own —
 * is exactly the copy-then-drift this codebase records four bugs from. The
 * season and episode are the point: `title` alone made a pack and every episode
 * of one season render as identical rows.
 *
 * `underSeason` is the form for a row nested inside a season heading, which
 * already states the show and the season. Repeating both at every level reads as
 * noise; "S03E01" and "Season pack" say the only thing that differs.
 */
export function groupHeading(
  group: {
    title: string;
    year?: number;
    season?: number;
    seasonEnd?: number;
    episode?: number;
  },
  opts?: { underSeason?: boolean },
): string {
  if (opts?.underSeason && group.season !== undefined) {
    return group.episode !== undefined
      ? `S${pad(group.season)}E${pad(group.episode)}`
      : "Season pack";
  }
  if (group.season !== undefined) {
    const span = group.seasonEnd !== undefined ? `-S${pad(group.seasonEnd)}` : "";
    const episode = group.episode !== undefined ? `E${pad(group.episode)}` : "";
    return `${group.title} S${pad(group.season)}${span}${episode}`;
  }
  // A film. The year is what tells two films sharing a title apart, which is the
  // same job the season does for a show.
  return group.year !== undefined ? `${group.title} (${group.year})` : group.title;
}
```

Also update the `resultAtRow` doc comment, which currently claims the first member is best "under the current sort" — that reasoning no longer covers a season row:

```ts
/**
 * The release a row acts on.
 *
 * A collapsed header resolves to its FIRST member. For a group that is its best
 * one under the current sort; for a SEASON row it is the best season pack,
 * because `seasonTree` sorts packs ahead of episodes for exactly this reason —
 * `play`/`add` on a collapsed season must grab the season, not episode one.
 * Do not "fix" that ordering away.
 *
 * That is what lets every existing action keep working untouched: play, add,
 * favourite and the preview lookup all take a release, and a header hands them
 * one without any new picking logic.
 */
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/util/resultGroup.test.ts`
Expected: PASS. Pre-existing tests in this file that assert row kinds now also see `depth`; none of them assert on object identity, so they should pass unchanged. If `groupRowPlan` tests fail on the film path, that is a real regression — fix the code, not the test.

- [ ] **Step 7: Run the gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/util/resultGroup.ts src/util/resultGroup.test.ts
git commit -m "feat(util): render seasons as rows, with depth and short child headings"
```

Note: `npm test` will fail in `src/ui/components/Results.test.tsx` and possibly typecheck in the two front ends, because they do not yet handle `kind: "season"`. That is expected at this point — **do not commit until Task 3 if the gates are red.** If they are red, carry this task's changes forward uncommitted and commit at the end of Task 4.

---

### Task 3: The default-open season

**Files:**
- Modify: `src/util/resultGroup.ts`
- Test: `src/util/resultGroup.test.ts`

**Interfaces:**
- Consumes: `seasonTree`, `isSeasonNode`.
- Produces: `defaultExpandedKeys(groups: readonly ResultGroup<T>[]): string[]`.

- [ ] **Step 1: Write the failing test**

The fixture deliberately includes strays. A clean single-season fixture passes while the real behaviour is wrong — this is the mistake the spec records.

```ts
describe("defaultExpandedKeys", () => {
  it("opens the highest-ranked season even when strays share the result set", () => {
    // Shaped after a real search: the season asked for, ANOTHER show's season 4,
    // and two unrelated episodes matching on a word. Four top-level rows, so a
    // rule counting "is it the only row" would leave the season shut.
    const groups = groupResults(
      [
        r("Harrowgate.S03E01.1080p.WEB-DL"),
        r("Harrowgate.S03E01.2160p.WEB-DL"),
        r("Harrowgate.S03.1080p.WEB-DL"),
        r("Harrowgate.S03.2160p.WEB-DL"),
        r("Kepler.S04E02.1080p.WEB-DL"),
        r("Kepler.S04E02.2160p.WEB-DL"),
        r("Tin.Rivers.S01E03.1080p.WEB-DL"),
        r("Ashfall.1999.1080p"),
      ],
      "series",
    );
    expect(defaultExpandedKeys(groups)).toEqual(["harrowgate|series|s3"]);
  });

  it("opens nothing when there is no season to open", () => {
    expect(
      defaultExpandedKeys(groupResults([r("Kestrel.2010.1080p"), r("Kestrel.2010.2160p")])),
    ).toEqual([]);
  });

  it("skips a season that the row plan drops for holding one child", () => {
    // One episode group means no season row exists to open.
    const groups = groupResults(
      [r("Harrowgate.S03E01.1080p.WEB-DL"), r("Harrowgate.S03E01.2160p.WEB-DL")],
      "series",
    );
    expect(defaultExpandedKeys(groups)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/util/resultGroup.test.ts -t defaultExpandedKeys`
Expected: FAIL — `defaultExpandedKeys is not a function`.

- [ ] **Step 3: Implement it**

Add to `src/util/resultGroup.ts`, after `groupRowPlan`:

```ts
/**
 * The keys a fresh result set should start with open.
 *
 * The highest-ranked season node, and only that one. Without it a search for one
 * season collapses to a single line, which reads as the list having failed.
 *
 * "Highest-ranked" rather than "the only one": a real search for one season of
 * one show also returned a different show's season and two unrelated episodes,
 * so a rule asking whether the season is alone would have left it shut on the
 * very query that motivated this. Ranking needs no counting and strays cannot
 * defeat it.
 *
 * A season the row plan DROPS (one child) is skipped — there is no row to open.
 *
 * A SEED, not a running rule: the caller puts these into the expansion set it
 * already owns, so collapsing one behaves like collapsing anything else.
 */
export function defaultExpandedKeys<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
): string[] {
  for (const node of seasonTree(groups)) {
    if (isSeasonNode(node) && node.children.length > 1) return [node.key];
  }
  return [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/util/resultGroup.test.ts -t defaultExpandedKeys`
Expected: PASS.

- [ ] **Step 5: Commit (with Task 2 if its gates were red)**

```bash
git add src/util/resultGroup.ts src/util/resultGroup.test.ts
git commit -m "feat(util): seed the highest-ranked season open"
```

---

### Task 4: Terminal rendering

**Files:**
- Modify: `src/ui/components/Results.tsx`
- Test: `src/ui/components/Results.test.tsx`

**Interfaces:**
- Consumes: `groupRowPlan`, `groupHeading`, `defaultExpandedKeys`, `resultAtRow`, `GroupRow`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/components/Results.test.tsx`, inside `describe("Results grouping", …)`:

```ts
it("renders a season row above its episodes, indented", async () => {
  const u = await mountWide(
    [
      t("p1", "Harrowgate.S03.1080p.WEB-DL"),
      t("p2", "Harrowgate.S03.2160p.WEB-DL"),
      t("e1", "Harrowgate.S03E01.1080p.WEB-DL"),
      t("e2", "Harrowgate.S03E01.2160p.WEB-DL"),
      t("f1", "Harrowgate.S03E02.1080p.WEB-DL"),
      t("f2", "Harrowgate.S03E02.2160p.WEB-DL"),
    ],
    120,
  );
  // The highest-ranked season is seeded open, so its children are on screen.
  expect(u.frame()).toContain("Harrowgate S03");
  expect(u.frame()).toContain("Season pack");
  expect(u.frame()).toContain("S03E01");
  // The show's name is stated once, by the season row — not repeated per child.
  expect(u.frame()).not.toContain("Harrowgate S03E01");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/components/Results.test.tsx -t "season row above"`
Expected: FAIL — no `Season pack` in the frame.

- [ ] **Step 3: Seed the expansion state**

In `src/ui/components/Results.tsx`, the expansion state is at line 276. Add a seeding effect below it. Import `defaultExpandedKeys` from `../../util/resultGroup` alongside the existing imports.

```tsx
const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
// The highest-ranked season opens itself once per result set. Seeded rather than
// applied every render so that collapsing it stays collapsed — the expansion set
// means "what is open", and a running rule would fight the user.
const seeded = useRef(false);
useEffect(() => {
  if (results.length === 0) {
    seeded.current = false;
    return;
  }
  if (seeded.current) return;
  seeded.current = true;
  const keys = defaultExpandedKeys(groupResults(results, hintForSection(section)));
  if (keys.length > 0) setExpanded(new Set(keys));
}, [results, section]);
```

`useEffect`, `useRef` and `useState` are already imported at `src/ui/components/Results.tsx:1`.
`groupResults` and `hintForSection` are already imported too — the component calls both at
line 332.

- [ ] **Step 4: Render the season row and the indent**

Replace the label expression at `src/ui/components/Results.tsx:786-788`:

```tsx
// groupHeading, not a local format: the browser's headings go through the same
// call, and a show's season is the only thing telling one heading from the next.
// Children of a season take the short form — the season row above them already
// states the show.
const caret = row.kind === "release" ? "" : `${row.expanded ? ICON.caretDown : ICON.caretRight} `;
const indent = "  ".repeat(row.depth);
const label =
  row.kind === "season"
    ? `${indent}${caret}${groupHeading(row)}`
    : row.kind === "group"
      ? `${indent}${caret}${groupHeading(row, { underSeason: row.depth > 0 })}`
      : `${indent}${cleanText(r.name)}`;
```

Update `isGroup` on the line above it, which drives the bold styling, so a season row is styled like a heading:

```tsx
const isGroup = row.kind === "group" || row.kind === "season";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/ui/components/Results.test.tsx`
Expected: PASS, including the pre-existing grouping and cursor-stability tests.

- [ ] **Step 6: Check the 80-column case by eye**

Run: `npm run dev` and search a show with a season pack and several episodes, in an 80-column terminal.
Confirm: a depth-2 release row is still readable. `Results.tsx:779-782` records that the name cell has ~61 columns at 80 wide and is already truncated — depth-2 spends four more on indent. If it is unusable, cap the indent at `"  ".repeat(Math.min(row.depth, 1))` and note it in the commit message; do not silently ship an unreadable row.

- [ ] **Step 7: Run the gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/ui/components/Results.tsx src/ui/components/Results.test.tsx
git commit -m "feat(ui): render the season tree in the results list"
```

---

### Task 5: Browser rendering, and the docs

**Files:**
- Modify: `src/web/static/app.ts`
- Modify: `src/web/static/searchModel.ts`
- Modify: `src/web/static/styles.css`
- Modify: `README.md`

**Interfaces:**
- Consumes: `groupRowPlan`, `groupHeading`, `defaultExpandedKeys`, `GroupRow`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Re-export the new helper**

In `src/web/static/searchModel.ts`, add `defaultExpandedKeys` to the existing re-export block from `../../util/resultGroup` (which already lists `groupCountLabel`, `groupHeading`, `resultAtRow`).

- [ ] **Step 2: Carry the season fields into `GroupFacts`**

In `src/web/static/app.ts`, `GroupFacts` (around line 1532) already carries `season`, `seasonEnd`, `episode`. Extend `groupFactsFor` to accept a season row as well, and record the depth so the heading can take the short form:

```ts
/** The heading facts for a season or group row, so the row and the card agree. */
function groupFactsFor(
  row: Extract<GroupRow<PublicSearchResult>, { kind: "group" } | { kind: "season" }>,
): GroupFacts {
  const facts: GroupFacts = {
    key: row.key,
    title: row.title,
    count: row.members.length,
    expanded: row.expanded,
    depth: row.depth,
  };
  if (row.kind === "season") {
    facts.season = row.season;
    return facts;
  }
  if (row.year !== undefined) facts.year = row.year;
  if (row.season !== undefined) facts.season = row.season;
  if (row.seasonEnd !== undefined) facts.seasonEnd = row.seasonEnd;
  if (row.episode !== undefined) facts.episode = row.episode;
  return facts;
}
```

Add `depth: number;` to the `GroupFacts` interface, and make `groupHeadingText` use it:

```ts
function groupHeadingText(facts: GroupFacts): string {
  return groupHeading(facts, { underSeason: facts.depth > 0 });
}
```

- [ ] **Step 3: Render season rows and the depth indent**

At `src/web/static/app.ts:1840`, the row plan is consumed. Extend the `kind === "group"` branch to also take `"season"`, since both render as a heading card:

```ts
row.kind === "group" || row.kind === "season"
  ? renderResultCard(row.members[0]!, row.key, groupFactsFor(row))
  : renderResultCard(row.result, row.key, undefined, row.inGroup)
```

`renderResultCard` sets `result-member` from `inGroup` at line 1625. Replace that with a depth class so two levels are distinguishable — pass `row.depth` in as a fourth argument in both branches and set:

```ts
if (depth > 0) li.classList.add(`result-depth-${Math.min(depth, 2)}`);
```

- [ ] **Step 4: Style the second level**

In `src/web/static/styles.css`, the `.result-member` rule at line 766 becomes the depth-1 rule, and depth 2 nests one step further. Keep the existing comment about the spine.

```css
/* A row inside an open season or group. Indented with a spine so the belonging is
   visible without a second colour — and the name keeps the weight it always had,
   so an expanded group looks like the list it is. */
.result-depth-1 {
  margin-left: 1.25rem;
  border-left: 2px solid var(--line);
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.result-depth-2 {
  margin-left: 2.5rem;
  border-left: 2px solid var(--line);
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

/* The indent and spine are a LIST idiom. In the grid every card is the same size
   by definition, so an indented one just breaks the columns — belonging is shown
   there by the member cards following their group card instead. */
.results-grid .result-depth-1,
.results-grid .result-depth-2 {
  margin-left: 0;
  border-left: 1px solid var(--line);
  border-radius: 0.5rem;
}
```

Grep for any other use of `.result-member` and update it: `grep -rn "result-member" src/`.

- [ ] **Step 5: Seed the expansion state**

`expandedGroups.clear()` at `src/web/static/app.ts:1105` runs when a search starts, before any results exist. Seed instead on the first non-empty render. Next to `expandedGroups` (line 967) add:

```ts
// Seeded once per search, not per frame: the set means "what is open", so a
// running rule would reopen a season the user just collapsed.
let seededExpansion = false;
```

Set `seededExpansion = false;` immediately after `expandedGroups.clear()` at line 1105. Then in `renderResults`, before the row plan is built:

```ts
if (!seededExpansion) {
  const groups = visibleGroups(searchView, reportsHealthLookup(sources));
  if (groups.length > 0) {
    seededExpansion = true;
    for (const key of defaultExpandedKeys(groups)) expandedGroups.add(key);
  }
}
```

`visibleGroups` is the existing export at `src/web/static/searchModel.ts:178` — it already
applies the right `hintForGroup` translation, and its own comment warns that passing no
hint makes the two front ends group the same feed differently. Use it; do not call
`groupResults` by hand here.

- [ ] **Step 6: Verify by running it**

There is no jsdom, deliberately — wiring is verified by running it.

```bash
npm run build && npm run dev -- serve --web --port 7391
```

Search a show by name and confirm: one collapsed row per season, newest season first, the top season open with `Season pack` first and episodes ascending beneath it, the second indent level visible on an open episode, and no console errors. Then toggle **group** off and confirm every release returns as a flat row.

- [ ] **Step 7: Update the README**

`README.md` around line 162 describes grouping. Extend the paragraph that ends "…because a whole season's worth of headings all reading just the show's name looks like the list failed to group at all." with the tree:

```markdown
A show's releases nest the way the show does: one row per season, newest first, holding
the season packs and then each episode in order. The season you are most likely to want
opens itself; the rest stay shut until you ask. Acting on a collapsed season row acts on
its best season pack, so `play` on `Harrowgate S03` gets the season rather than episode
one. The **group** control turns all of it off and gives you every release as its own row.
```

Check the web UI's own limitations list is still true while you are in there.

- [ ] **Step 8: Run the gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/web/static/app.ts src/web/static/searchModel.ts src/web/static/styles.css README.md
git commit -m "feat(web): render the season tree in the browser results list"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
| --- | --- |
| Row model, `depth`, season variant | 2 |
| What does not get a season node (span packs, seasonless packs) | 1 |
| Ordering: between shows, seasons descending, packs-then-episodes | 1 |
| Headings need a depth-aware form | 2 |
| The sort control rule | 1 (written into `seasonTree`'s doc comment) |
| Expansion defaults: highest-ranked season | 3 |
| The toggle (no new control) | 5, step 6 verification |
| `resultAtRow` on a collapsed season → best pack | 2 |
| Terminal 80-column risk | 4, step 6 |
| Row-count growth / cursor stability | 4, step 5 |
| Season keys must not collide | 2 ("unique key at three levels") |
| README | 5 |

**Known ordering hazard:** Task 2 leaves the tree green but both front ends red, because they do not yet know `kind: "season"`. Step 7 of Task 2 says so and tells the implementer to carry the change forward rather than commit a broken tree. Tasks 2–4 can be committed together if that is cleaner.

**Not covered, deliberately:** Piece B (watched marks, next-unwatched landing, per-episode plots) is a separate spec. The TUI's `g` not persisting across runs is noted in the spec as out of scope.
