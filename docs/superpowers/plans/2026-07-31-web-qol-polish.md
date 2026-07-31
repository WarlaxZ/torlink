# Web QoL Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group duplicate releases under one title in both front ends, make the preview pane
reachable at every scroll position and screen width, and fix the focus/keyboard/layout rough edges
around them.

**Architecture:** Three new dependency-light pure modules in `src/util/` (`resultGroup.ts`,
`releaseBadges.ts`) and one in `src/web/static/` (`resultFocus.ts`) hold every decision. Both front
ends consume the *same* grouping and row-flattening functions — the TUI renders the flat row plan
with Ink boxes, the browser renders it with `createElement`. All positioning work is CSS; no
JavaScript scroll maths, and the single document scroll is preserved.

**Tech Stack:** TypeScript, vitest, Ink + React (`src/ui`), hand-rolled DOM + tsup bundle
(`src/web/static`), `parse-torrent-title` via `src/util/release.ts`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-31-web-qol-polish-design.md`. Read it before Task 1.
- **A feature ships in both front ends.** Grouping and badges land in `src/ui` *and*
  `src/web/static` in this plan. Only the CSS/DOM tasks (3, 6, 7, 8, 11) are web-only, and they are
  legitimately so: the terminal's preview pane is on screen by construction.
- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` anywhere in
  `src/web/static/`.** Every node is `createElement` + `textContent`. Release names come from
  whoever uploaded a torrent; an `innerHTML` path there is stored XSS.
- **`src/web` must not import from `src/ui`**; **`src/core` must not import from either.** Enforced
  by `eslint.config.js`. Share by moving the piece down into `src/util/`.
- **`src/web/static/` must not import `node:*`**, directly or transitively. `npm run build` is the
  only check for this — run it.
- **Decisions go in pure modules, not `app.ts`.** `app.ts` is DOM wiring only. A conditional there
  deciding *what to show* or *what to send* belongs in a pure module; this has been caught in review
  twice.
- **Test fixtures name invented titles only**, from CLAUDE.md's cast: `Kestrel.2010.1080p.BluRay.x264`,
  `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`,
  `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`. Never a real film or show.
- **Gates, every task:** `npm test`, `npm run typecheck`, `npm run lint`. Plus `npm run build` on any
  task touching `src/web/static/`. Baseline: 132 files, 2025 tests, green. The known
  `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx` predates this work — leave it.
- **Conventional Commits**, and commit at the end of every task.

---

### Task 1: `src/util/resultGroup.ts` — the grouping engine

The whole feature rests on this module and it is pure, so it gets the most thorough tests.

**Files:**
- Create: `src/util/resultGroup.ts`
- Test: `src/util/resultGroup.test.ts`

**Interfaces:**
- Consumes: `parseRelease`, `type ParsedRelease` from `src/util/release.ts`; `type OmdbType` from
  `src/recc/omdb.ts` (type-only, already how `release.ts` refers to it).
- Produces, relied on by Tasks 2, 5, 9, 10:
  ```ts
  export interface GroupableResult { name: string }
  export interface ResultGroup<T> { key: string; title: string; year?: number; members: T[] }
  export type GroupRow<T> =
    | { kind: "group"; key: string; title: string; year?: number; members: T[]; expanded: boolean }
    | { kind: "release"; key: string; result: T; inGroup: boolean };
  export function groupKeyFor(name: string, hint?: OmdbType): string
  export function groupResults<T extends GroupableResult>(list: readonly T[], hint?: OmdbType): ResultGroup<T>[]
  export function groupRowPlan<T extends GroupableResult>(groups: readonly ResultGroup<T>[], expanded: ReadonlySet<string>): GroupRow<T>[]
  export function resultAtRow<T>(row: GroupRow<T>): T | null
  export function groupCountLabel(members: number): string
  ```

- [ ] **Step 1: Write the failing test**

Create `src/util/resultGroup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  groupCountLabel,
  groupKeyFor,
  groupResults,
  groupRowPlan,
  resultAtRow,
} from "./resultGroup";

const r = (name: string) => ({ name });

describe("groupKeyFor", () => {
  it("keys a film on title and year, so two films sharing a title stay apart", () => {
    expect(groupKeyFor("Kestrel.2010.1080p.BluRay.x264")).toBe("kestrel|2010|movie");
    // The real case this protects: same title, different film.
    expect(groupKeyFor("Ashfall.1999.1080p")).not.toBe(groupKeyFor("Ashfall.2024.1080p"));
  });

  it("collapses different releases of one film onto one key", () => {
    expect(groupKeyFor("Kestrel.2010.1080p.BluRay.x264")).toBe(
      groupKeyFor("Kestrel.2010.2160p.WEB-DL.DV.HDR-OTHER"),
    );
  });

  // parseRelease's own `key` is `title|year|type`, which for ANY series is
  // `kepler||series` — every episode of every season in one bucket. These two
  // fixtures exist to catch exactly that.
  it("keys an episode on season and episode", () => {
    expect(groupKeyFor("Kepler.S02E04.1080p.WEB-DL")).toBe("kepler|series|s2|e4");
  });

  it("keys a season pack distinctly from an episode of that season", () => {
    expect(groupKeyFor("Harrowgate.S03.1080p.WEB-DL")).toBe("harrowgate|series|s3|pack");
    expect(groupKeyFor("Harrowgate.S03.1080p.WEB-DL")).not.toBe(
      groupKeyFor("Harrowgate.S03E01.1080p.WEB-DL"),
    );
  });

  it("keeps two episodes of one season apart", () => {
    expect(groupKeyFor("Kepler.S02E04.1080p.WEB-DL")).not.toBe(
      groupKeyFor("Kepler.S02E05.1080p.WEB-DL"),
    );
  });

  it("strips a tracker prefix, which stranded 5 of 129 live results in its own group", () => {
    expect(groupKeyFor("www.uindex.org    -    Kestrel 2010 1080p BluRay")).toBe(
      groupKeyFor("Kestrel.2010.1080p.BluRay.x264"),
    );
  });

  it("strips a container extension", () => {
    expect(groupKeyFor("Kestrel.2010.1080p.TELESYNC.x264.mkv")).toBe(
      groupKeyFor("Kestrel.2010.1080p.BluRay.x264"),
    );
  });

  // Order matters: punctuation must become spaces BEFORE the leading article is
  // dropped. Built the other way round, a wrapped title keeps its "the" once the
  // wrapper is stripped and splits into its own group.
  it("drops a leading article after punctuation is normalised, not before", () => {
    expect(groupKeyFor("(Кестрел) The Kestrel 2010 1080p")).toBe(
      groupKeyFor("Kestrel.2010.1080p.BluRay.x264"),
    );
  });

  it("falls back to the normalised raw name when the parser returns null", () => {
    // parseRelease returns null for some real names. The group must still exist.
    const key = groupKeyFor("     ");
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });
});

describe("groupResults", () => {
  it("preserves the caller's order: groups by first member, members as given", () => {
    const list = [
      r("Ashfall.1999.1080p"),
      r("Kestrel.2010.1080p.BluRay.x264"),
      r("Ashfall.1999.2160p.WEB-DL"),
    ];
    const groups = groupResults(list);
    expect(groups.map((g) => g.title)).toEqual(["Ashfall", "Kestrel"]);
    expect(groups[0]!.members.map((m) => m.name)).toEqual([
      "Ashfall.1999.1080p",
      "Ashfall.1999.2160p.WEB-DL",
    ]);
  });

  it("carries the display title and year for the group heading", () => {
    const groups = groupResults([r("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP")]);
    expect(groups[0]!.title).toBe("Tin Rivers");
    expect(groups[0]!.year).toBe(2024);
  });
});

describe("groupRowPlan", () => {
  const groups = groupResults([
    r("Kestrel.2010.1080p.BluRay.x264"),
    r("Kestrel.2010.2160p.WEB-DL"),
    r("Ashfall.1999.1080p"),
  ]);

  it("renders a lone release as a plain row, not a group of one", () => {
    const rows = groupRowPlan(groups, new Set());
    const ashfall = rows.filter((row) => row.kind === "release");
    expect(ashfall).toHaveLength(1);
    expect(ashfall[0]!.kind === "release" && ashfall[0]!.inGroup).toBe(false);
  });

  it("collapses a real group to its header alone", () => {
    const rows = groupRowPlan(groups, new Set());
    expect(rows.map((row) => row.kind)).toEqual(["group", "release"]);
    expect(rows[0]!.kind === "group" && rows[0]!.members).toHaveLength(2);
    expect(rows[0]!.kind === "group" && rows[0]!.expanded).toBe(false);
  });

  it("emits a header plus every member once expanded", () => {
    const rows = groupRowPlan(groups, new Set(["kestrel|2010|movie"]));
    expect(rows.map((row) => row.kind)).toEqual(["group", "release", "release", "release"]);
    expect(rows[1]!.kind === "release" && rows[1]!.inGroup).toBe(true);
  });

  it("gives every row a unique key, so a re-render cannot collide them", () => {
    const rows = groupRowPlan(groups, new Set(["kestrel|2010|movie"]));
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

describe("resultAtRow", () => {
  it("resolves a collapsed header to its first member, so every action still has a target", () => {
    const groups = groupResults([
      r("Kestrel.2010.1080p.BluRay.x264"),
      r("Kestrel.2010.2160p.WEB-DL"),
    ]);
    const rows = groupRowPlan(groups, new Set());
    expect(resultAtRow(rows[0]!)?.name).toBe("Kestrel.2010.1080p.BluRay.x264");
  });
});

describe("groupCountLabel", () => {
  it("says releases, and gets the singular right", () => {
    expect(groupCountLabel(2)).toBe("2 releases");
    expect(groupCountLabel(1)).toBe("1 release");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/util/resultGroup.test.ts`
Expected: FAIL — `Failed to resolve import "./resultGroup"`.

- [ ] **Step 3: Write the implementation**

Create `src/util/resultGroup.ts`:

```ts
// Grouping many releases of one thing into one row, for both front ends.
//
// A NEW FILE rather than an addition to resultSort.ts, whose header states it
// "IMPORTS NOTHING, deliberately" — this needs `./release`. That import is
// browser-safe and already in the web bundle (src/web/static/streamFlow.ts
// imports parseRelease, and tsup.web.config.ts has noExternal for its one
// runtime dependency), so `src/web/static/searchModel.ts` can reach this the
// same way it reaches sortResults and filterResults.
//
// Structural input type and a generic return, the convention resultSort.ts and
// resultFilter.ts already follow: TorrentResult and PublicSearchResult both fit
// without either front end's types leaking in here.
import { parseRelease } from "./release";
import type { OmdbType } from "../recc/omdb";

export interface GroupableResult {
  name: string;
}

export interface ResultGroup<T> {
  /** The grouping key. Stable, and used as the expand/collapse identity. */
  key: string;
  /** Display title, from the parser — "Tin Rivers", not "Tin.Rivers.2024…". */
  title: string;
  year?: number;
  /** Never empty. In the order the caller supplied. */
  members: T[];
}

/** One line of the rendered list: a group heading, or a release. */
export type GroupRow<T> =
  | { kind: "group"; key: string; title: string; year?: number; members: T[]; expanded: boolean }
  | { kind: "release"; key: string; result: T; inGroup: boolean };

/**
 * Normalise a parsed title before it becomes a key.
 *
 * THE ORDER IS LOAD-BEARING. Punctuation becomes spaces BEFORE the leading
 * article is dropped: a title wrapped in another script — "супер … (the …
 * movie)" in live data — keeps its "the" if the article is stripped first, and
 * splits off into a group of its own.
 */
function normaliseTitle(raw: string): string {
  return raw
    // "www.uindex.org    -    Kestrel 2010": a tracker stamps its domain on the
    // front of the release name. Five of 129 live results for one film were
    // stranded in their own group by this alone.
    .replace(/^\s*(?:www\.)?[a-z0-9-]+\.[a-z]{2,12}\s*[-–—]\s*/i, "")
    .replace(/\.(?:mkv|mp4|m4v|avi|7z|zip|iso)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(?:the|a|an)\s+/, "")
    .trim();
}

/**
 * The grouping key for one release name.
 *
 * NOT `parseRelease().key`, which is `title|year|type` and therefore
 * `kepler||series` for every episode of every season of a show — one bucket for
 * a whole series, which makes grouping useless on a TV tab. Films key on title
 * and year (so `Ashfall.1999` and `Ashfall.2024` stay apart); episodes key down
 * to the episode; a season pack keys distinctly from any episode in it.
 */
export function groupKeyFor(name: string, hint?: OmdbType): string {
  const parsed = parseRelease(name, hint);
  // parseRelease returns null for some real names (a Korean-titled release in
  // live data). A group of one is the right answer, not a crash.
  if (!parsed) return `raw|${normaliseTitle(name) || name.trim().toLowerCase()}`;
  const title = normaliseTitle(parsed.title) || parsed.title.trim().toLowerCase();
  if (parsed.type === "series") {
    const season = parsed.season !== undefined ? `s${parsed.season}` : "s";
    const episode = parsed.episode !== undefined ? `e${parsed.episode}` : "pack";
    return `${title}|series|${season}|${episode}`;
  }
  return `${title}|${parsed.year ?? ""}|${parsed.type ?? ""}`;
}

/**
 * Group a list that has ALREADY been filtered and sorted.
 *
 * Order is preserved in both directions — groups by their first member, members
 * as given — so every existing sort still means what it means. `sortResults`'s
 * "none" is the server's seeders-then-recency order and both front ends show
 * it; grouping must not quietly reorder that.
 */
export function groupResults<T extends GroupableResult>(
  list: readonly T[],
  hint?: OmdbType,
): ResultGroup<T>[] {
  const byKey = new Map<string, ResultGroup<T>>();
  for (const item of list) {
    const key = groupKeyFor(item.name, hint);
    const existing = byKey.get(key);
    if (existing) {
      existing.members.push(item);
      continue;
    }
    const parsed = parseRelease(item.name, hint);
    const group: ResultGroup<T> = {
      key,
      title: parsed?.title ?? item.name,
      members: [item],
    };
    if (parsed?.year !== undefined) group.year = parsed.year;
    byKey.set(key, group);
  }
  return [...byKey.values()];
}

/**
 * Flatten groups into the rows to render, honouring what is expanded.
 *
 * A group of one is emitted as a plain release row: a disclosure arrow over
 * "1 release" is noise, and it would make the common case (a search where
 * nothing duplicates) look like a different feature.
 *
 * Shared by both front ends deliberately — the browser renders these rows with
 * createElement and the terminal with Ink boxes, but "which rows are there" is
 * one decision, and this codebase records four bugs caused by copying one
 * instead.
 */
export function groupRowPlan<T extends GroupableResult>(
  groups: readonly ResultGroup<T>[],
  expanded: ReadonlySet<string>,
): GroupRow<T>[] {
  const rows: GroupRow<T>[] = [];
  for (const group of groups) {
    const first = group.members[0];
    if (first === undefined) continue;
    if (group.members.length === 1) {
      rows.push({ kind: "release", key: group.key, result: first, inGroup: false });
      continue;
    }
    const isOpen = expanded.has(group.key);
    const row: GroupRow<T> = {
      kind: "group",
      key: group.key,
      title: group.title,
      members: group.members,
      expanded: isOpen,
    };
    if (group.year !== undefined) row.year = group.year;
    rows.push(row);
    if (!isOpen) continue;
    group.members.forEach((member, i) => {
      rows.push({ kind: "release", key: `${group.key}#${i}`, result: member, inGroup: true });
    });
  }
  return rows;
}

/**
 * The release a row acts on.
 *
 * A collapsed header resolves to its FIRST member, which under the current sort
 * is its best one. That is what makes every existing action keep working
 * untouched: play, add, favourite and the preview lookup all take a release, and
 * a header hands them one without any new picking logic.
 */
export function resultAtRow<T>(row: GroupRow<T>): T | null {
  return row.kind === "release" ? row.result : (row.members[0] ?? null);
}

/** "12 releases" for a group heading. */
export function groupCountLabel(members: number): string {
  return `${members} release${members === 1 ? "" : "s"}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/util/resultGroup.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify against live-shaped data**

The normalisation exists because of measured behaviour, so confirm it still holds. With a dev server
running (`npm run dev -- serve --web --headless --port 9199`), group a real search and check the
count drops the way the spec records (129 results → ~22 groups, largest 92):

```bash
curl -sN --max-time 30 "http://127.0.0.1:9199/api/search?q=<some+popular+film>" \
  | grep '^data:' | tail -1 | sed 's/^data: //' | jq -r '.results[].name' > /tmp/live.txt
```

Then a throwaway script importing `groupResults` over those names, printing group sizes. Expected: a
single dominant group holding most rows, and no group merging two obviously different films. Delete
the script; it is a check, not an artifact.

- [ ] **Step 6: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/util/resultGroup.ts src/util/resultGroup.test.ts
git commit -m "feat: group many releases of one title behind one key

parseRelease's own key is title|year|type, which for any series is
kepler||series — a whole show in one bucket. Films key on title and year,
episodes down to the episode, and a season pack distinctly from any episode
in it."
```

---

### Task 2: `src/util/releaseBadges.ts` — the quality badges, shared

**Files:**
- Create: `src/util/releaseBadges.ts`
- Test: `src/util/releaseBadges.test.ts`

**Interfaces:**
- Consumes: `parseRelease` from `./release`; `FEATURES`, `hasFeature`, `type FeatureId` from
  `./releasePick`. **Read `src/util/releasePick.ts:48-66` first** for the exact `FEATURES` shape and
  the `FeatureId` union — the labels must come from there, not be retyped, so a badge means exactly
  what the user's `P` quality preference means.
- Produces, relied on by Tasks 8 and 10: `export function releaseBadges(name: string, hint?: OmdbType): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/util/releaseBadges.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { releaseBadges } from "./releaseBadges";

describe("releaseBadges", () => {
  it("leads with the resolution, which is what a viewer scans for first", () => {
    expect(releaseBadges("Kestrel.2010.1080p.BluRay.x264")[0]).toBe("1080p");
  });

  it("names the features a stacked release carries", () => {
    const badges = releaseBadges("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP");
    expect(badges[0]).toBe("2160p");
    // Labels come from FEATURES in releasePick.ts, so they read the same here as
    // they do in the TUI's quality prompt.
    expect(badges.join(" ")).toContain("HDR");
    expect(badges.join(" ")).toContain("Atmos");
  });

  it("returns nothing rather than guessing when the name carries no quality facts", () => {
    expect(releaseBadges("Ashfall")).toEqual([]);
  });

  it("survives a name the parser cannot read", () => {
    expect(releaseBadges("     ")).toEqual([]);
  });

  it("does not repeat a label", () => {
    const badges = releaseBadges("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR10.HDR.Atmos-GROUP");
    expect(new Set(badges).size).toBe(badges.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/util/releaseBadges.test.ts`
Expected: FAIL — cannot resolve `./releaseBadges`.

- [ ] **Step 3: Write the implementation**

Create `src/util/releaseBadges.ts`. Read `releasePick.ts:48-66` and iterate the real `FEATURES`
entries — do not hardcode a feature list here:

```ts
// The quality facts a row can show, as short labels.
//
// The labels come from FEATURES in releasePick.ts rather than being written
// again here, so a badge on a row means precisely what the same word means in
// the quality preference the user set with `P`. Two vocabularies for one concept
// is how "HEVC" ends up meaning something subtly different in two places.
import { parseRelease } from "./release";
import { FEATURES, hasFeature, type FeatureId } from "./releasePick";
import type { OmdbType } from "../recc/omdb";

export function releaseBadges(name: string, hint?: OmdbType): string[] {
  const parsed = parseRelease(name, hint);
  if (!parsed) return [];
  const badges: string[] = [];
  // Resolution first: it is the fact a viewer scans for. Printed as the parser
  // read it — the vocabulary includes "1080i" and "4k", and rewriting it here
  // would be a second opinion about what the release says.
  if (parsed.resolution) badges.push(parsed.resolution);
  for (const id of Object.keys(FEATURES) as FeatureId[]) {
    if (hasFeature(parsed, id)) badges.push(FEATURES[id].label);
  }
  return [...new Set(badges)];
}
```

If `FEATURES` is not a plain record keyed by `FeatureId`, adapt the iteration to its actual shape;
the requirement is that every label is read from `FEATURES`, never literal.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/util/releaseBadges.test.ts`
Expected: PASS. If a label assertion fails, correct the *test* to the real `FEATURES` label — the
table is the source of truth, not this plan.

- [ ] **Step 5: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/util/releaseBadges.ts src/util/releaseBadges.test.ts
git commit -m "feat: short quality badges for a release, labelled from FEATURES"
```

---

### Task 3: The web's grouping view state

**Files:**
- Modify: `src/web/static/searchModel.ts` (add after `visibleResults`, around `:139`; and after
  `parseLayout`, `:472-474`)
- Test: `src/web/static/searchModel.test.ts`

**Interfaces:**
- Consumes: Task 1's `groupResults`, `groupRowPlan`, `type GroupRow`, `type ResultGroup`.
- Produces, relied on by Tasks 4 and 8:
  ```ts
  export function visibleGroups(view: SearchView, reportsHealth: (source: string) => boolean): ResultGroup<PublicSearchResult>[]
  export function resultRowPlan(view: SearchView, reportsHealth: (source: string) => boolean, expanded: ReadonlySet<string>): GroupRow<PublicSearchResult>[]
  export function parseGrouping(raw: string | null): boolean
  export function groupingApplies(group: string): boolean
  ```
  `SearchView` gains one field: `grouped: boolean`, defaulting **true** in `emptyView()`.

- [ ] **Step 1: Write the failing test**

Append to `src/web/static/searchModel.test.ts` (match the file's existing fixture helpers — read the
top of it first and reuse its result-builder rather than writing a second one):

```ts
describe("resultRowPlan", () => {
  const view = (): SearchView => ({
    ...emptyView(),
    mode: "search",
    query: "kestrel",
    snapshot: snapshotOf([
      resultOf({ name: "Kestrel.2010.1080p.BluRay.x264", infoHash: "a1" }),
      resultOf({ name: "Kestrel.2010.2160p.WEB-DL", infoHash: "b2" }),
      resultOf({ name: "Ashfall.1999.1080p", infoHash: "c3" }),
    ]),
  });
  const health = () => true;

  it("collapses the duplicate title and leaves the singleton alone", () => {
    const rows = resultRowPlan(view(), health, new Set());
    expect(rows.map((r) => r.kind)).toEqual(["group", "release"]);
  });

  it("returns plain release rows for every result when grouping is off", () => {
    const rows = resultRowPlan({ ...view(), grouped: false }, health, new Set());
    expect(rows.map((r) => r.kind)).toEqual(["release", "release", "release"]);
  });

  it("expands the named group", () => {
    const all = resultRowPlan(view(), health, new Set());
    const key = all[0]!.key;
    const rows = resultRowPlan(view(), health, new Set([key]));
    expect(rows.map((r) => r.kind)).toEqual(["group", "release", "release", "release"]);
  });

  it("groups only what the filters left, so a filter still narrows the list", () => {
    const rows = resultRowPlan({ ...view(), textFilter: "ashfall" }, health, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("release");
  });

  it("defaults to grouped, because a duplicate-heavy browse is the common case", () => {
    expect(emptyView().grouped).toBe(true);
  });
});

describe("parseGrouping", () => {
  it("defaults on for a missing or junk stored value", () => {
    expect(parseGrouping(null)).toBe(true);
    expect(parseGrouping("nonsense")).toBe(true);
  });

  it("honours an explicit opt-out", () => {
    expect(parseGrouping("off")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/web/static/searchModel.test.ts`
Expected: FAIL — `resultRowPlan` / `parseGrouping` are not exported.

- [ ] **Step 3: Implement**

In `searchModel.ts`: add the import alongside the two existing `src/util` value imports at `:17-18`,
and extend that file-header comment — it currently says "THREE IMPORTS LEAVE THIS DIRECTORY" and
enumerates them, so it must now say four and name the new one for the same reason.

```ts
import { groupResults, groupRowPlan, type GroupRow, type ResultGroup } from "../../util/resultGroup";
```

Add `grouped: boolean` to `SearchView` with a comment, and `grouped: true` in `emptyView()`. Then:

```ts
/**
 * The groups to render: `visibleResults`, grouped.
 *
 * Grouping runs AFTER filter and sort for two reasons — a filter must still
 * narrow the list rather than narrow within groups, and the group order then
 * follows whatever sort is selected, so "seeders ▾" still means seeders ▾.
 */
export function visibleGroups(
  view: SearchView,
  reportsHealth: (source: string) => boolean,
): ResultGroup<PublicSearchResult>[] {
  return groupResults(visibleResults(view, reportsHealth));
}

/**
 * The flat row list `app.ts` renders — group headings and release rows in
 * order. The same `groupRowPlan` the TUI's list uses.
 *
 * Grouping off yields one release row per result, so the toggle is genuinely a
 * view option rather than a different code path.
 */
export function resultRowPlan(
  view: SearchView,
  reportsHealth: (source: string) => boolean,
  expanded: ReadonlySet<string>,
): GroupRow<PublicSearchResult>[] {
  const shown = visibleResults(view, reportsHealth);
  if (!view.grouped) {
    return shown.map((result) => ({
      kind: "release" as const,
      key: result.infoHash,
      result,
      inGroup: false,
    }));
  }
  return groupRowPlan(groupResults(shown), expanded);
}

/**
 * A remembered grouping preference, or the default.
 *
 * Parsed rather than cast for the reason {@link parseLayout} is: the value comes
 * from localStorage, which is user-writable and survives upgrades. Defaults ON
 * — a browse of one category routinely returns four uploads of every film, and
 * 129 results that are 22 things is the state this feature exists to fix.
 */
export function parseGrouping(raw: string | null): boolean {
  return raw !== "off";
}
```

Also export `groupingApplies(group: string): boolean` returning `true` for every group — grouping is
useful on any tab, and on Games/Music/Books the parser simply finds nothing to merge, which is the
safe direction. Keep it as a named function anyway so the rule has one home if that changes.

Re-export `type GroupRow` from this module, matching how it already re-exports the wire and sort
types so `app.ts` has one import site.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/web/static/searchModel.test.ts` → PASS.

- [ ] **Step 5: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/web/static/searchModel.ts src/web/static/searchModel.test.ts
git commit -m "feat(web): group the results list, defaulting on"
```

---

### Task 4: `src/web/static/resultFocus.ts` — stop dropping focus on every click

The measured bug: `selectResult` → `renderResults()` → `resultsList.replaceChildren(...)`
(`app.ts:1426`) destroys the clicked button, and focus lands on `<body>`
(`focusAfterClick: "BODY."`). The list is unusable by keyboard and no arrow-key navigation can work
until this is fixed.

**Files:**
- Create: `src/web/static/resultFocus.ts`
- Test: `src/web/static/resultFocus.test.ts`
- Modify: `src/web/static/app.ts` (`renderResults`, `:1408-1445`)

**Interfaces:**
- Produces, relied on by Task 5:
  ```ts
  export interface FocusSnapshot { rowKey: string; control: string }
  export function focusTargetAfterRender(before: FocusSnapshot | null, rowKeys: readonly string[]): FocusSnapshot | null
  ```

- [ ] **Step 1: Write the failing test**

Create `src/web/static/resultFocus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { focusTargetAfterRender } from "./resultFocus";

describe("focusTargetAfterRender", () => {
  it("returns focus to the same control on the same row", () => {
    const before = { rowKey: "b2", control: "name" };
    expect(focusTargetAfterRender(before, ["a1", "b2", "c3"])).toEqual(before);
  });

  it("does nothing when focus was not in the list", () => {
    expect(focusTargetAfterRender(null, ["a1"])).toBeNull();
  });

  it("falls back to the nearest surviving row when the focused row is gone", () => {
    // A filter or a collapsing group can remove the row under the cursor. Focus
    // must land somewhere in the list, not on <body>.
    const target = focusTargetAfterRender({ rowKey: "b2", control: "name" }, ["a1", "c3"]);
    expect(target).not.toBeNull();
    expect(["a1", "c3"]).toContain(target!.rowKey);
  });

  it("gives up when the list is empty", () => {
    expect(focusTargetAfterRender({ rowKey: "b2", control: "name" }, [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/web/static/resultFocus.test.ts` → FAIL, unresolved import.

- [ ] **Step 3: Implement the module**

Create `src/web/static/resultFocus.ts`:

```ts
// Where focus should go after the results list is rebuilt.
//
// The list is replaced wholesale on every snapshot frame AND on every selection
// (renderResults → replaceChildren), so the button the user just activated stops
// existing. Measured before this module: focus fell to <body>, which makes the
// list unusable by keyboard and makes arrow-key navigation impossible.
//
// The DECISION lives here so a test can reach it; app.ts does the .focus() call.

export interface FocusSnapshot {
  /** The row's stable identity — a group key or an info hash. */
  rowKey: string;
  /** Which control within the row, e.g. "name", "disclosure", "play". */
  control: string;
}

export function focusTargetAfterRender(
  before: FocusSnapshot | null,
  rowKeys: readonly string[],
): FocusSnapshot | null {
  if (!before) return null;
  if (rowKeys.length === 0) return null;
  if (rowKeys.includes(before.rowKey)) return before;
  // The row went away — a filter removed it, or a group collapsed over it. Land
  // on the first surviving row rather than nowhere; "nowhere" is the bug.
  return { rowKey: rowKeys[0]!, control: before.control };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run src/web/static/resultFocus.test.ts` → PASS.

- [ ] **Step 5: Wire it into `app.ts`**

In `renderResults` (`app.ts:1408`), before `resultsList.replaceChildren(...)`, capture a snapshot
from `document.activeElement` when it sits inside `resultsList` — read `data-row-key` and
`data-control` off the focused element (Task 8 puts those attributes on every row control; until
then use the row's info hash). After `replaceChildren`, ask `focusTargetAfterRender` for the target
and `.focus()` the matching element, guarded by `{ preventScroll: true }` so restoring focus never
yanks the page.

Requirements:
- No behaviour when focus was elsewhere on the page — typing in the search box must not be stolen.
- `preventScroll: true` is not optional: without it, restoring focus to a row scrolls it into view
  and fights the user's own scrolling on every streamed frame.

- [ ] **Step 6: Check the queue pane for the same bug**

`src/web/static/app.ts`'s queue list re-renders roughly four times a second. Check whether it also
replaces its children wholesale, and if a focused control there is destroyed the same way, apply the
same treatment. If it is already safe, say so in the commit body rather than changing it.

- [ ] **Step 7: Verify by hand**

`npm run build && npm run dev -- serve --web`. Click a result name, then press Tab: focus must
continue from that row, not restart at the top of the document. Type in the search box while results
stream in: the caret must stay put.

- [ ] **Step 8: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/web/static/resultFocus.ts src/web/static/resultFocus.test.ts src/web/static/app.ts
git commit -m "fix(web): keep focus in the results list across a re-render

Selecting a row rebuilt the list and dropped focus to <body>, so the list
could not be used from the keyboard at all."
```

---

### Task 5: Keyboard navigation of the results list

**Files:**
- Modify: `src/web/static/app.ts`
- Modify: `src/web/static/styles.css` (focus ring on the roving item)

Depends on Task 4 — arrow keys cannot work while focus is destroyed on every render.

- [ ] **Step 1: Implement roving tabindex**

On the results list: exactly one row control is `tabindex="0"` at a time (the selected row, or the
first row), every other is `tabindex="-1"`. `↑`/`↓` move focus and selection between rows;
`Home`/`End` jump to first/last; `Enter` selects (loads the preview). A group heading's disclosure
button expands/collapses through its native activation — no custom key.

Frame this as listbox accessibility, not as app keybindings: the browser's vocabulary is buttons, and
arrow-key movement is behaviour a list of selectable options already owes a keyboard user.

- [ ] **Step 2: Add `/` to focus the search box**

A document-level `keydown`: `/` focuses `#query` and preventDefaults, **unless** the event target is
already an `input`, `textarea`, `select`, or has `isContentEditable` — otherwise typing a slash into
the filter box moves focus out from under the user. This is what makes the unpinned search form in
Task 7 acceptable.

- [ ] **Step 3: Verify by hand**

`npm run build && npm run dev -- serve --web`. Tab into the list once, then drive it entirely by
keyboard: arrows move the highlight and the preview follows; Enter selects; Tab from a row reaches
that row's buttons. Press `/` from the list — the search box takes the caret. Press `/` inside the
filter box — a literal slash is typed.

- [ ] **Step 4: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/web/static/app.ts src/web/static/styles.css
git commit -m "feat(web): drive the results list from the keyboard"
```

---

### Task 6: A preview pane you can see, at every width

**Files:**
- Modify: `src/web/static/styles.css` (`.split` `:487-498`, `.preview` `:560-563`, `.poster` `:569-585`)
- Modify: `src/web/static/index.html` (`.split`, `:137-150` — a close button for the narrow bar)
- Modify: `src/web/static/app.ts` (wire the close button only)

- [ ] **Step 1: Wide width — pin it**

`.preview` gets `position: sticky`, a `top` derived from Task 7's toolbar height (use a CSS custom
property, e.g. `--toolbar-h`, so the two cannot drift), `max-height: calc(100vh - var(--toolbar-h) - 2rem)`,
and `overflow-y: auto` for a long plot.

Do **not** make `#results` a scroll container. The poster `IntersectionObserver`
(`app.ts:1195-1208`) uses the default viewport root; a new scrolling ancestor makes it silently stop
firing and posters never load. The preview's own internal scroll is fine — no row posters live
inside it.

- [ ] **Step 2: Narrow width — a bottom bar**

In the `max-width: 46rem` block: put `#results` and `#preview` in the *same* grid area, and give the
preview `position: sticky; bottom: 0; align-self: end;` plus a compact skin — poster and text in a
row, small poster, plot clamped to two lines (`-webkit-line-clamp`), and a close button.

Sharing the list's grid area is the point, not a trick: a sticky item can only travel within its own
grid area, so a preview in its own single-column row above a 25,000px list is still 25,000px away
from a selection at the bottom.

Check: the bar must not cover the last row's buttons — add `padding-bottom` to the list equal to the
bar's height, and make sure the bar's own backdrop is opaque.

- [ ] **Step 3: Close button**

Add the button to `#preview` in `index.html` (visible only in the narrow skin, via CSS). Its click
clears the selection — reuse the existing "selection removed" path in `renderResults`
(`app.ts:1440-1443`) rather than writing a second one.

- [ ] **Step 4: Verify by hand, both widths**

`npm run build && npm run dev -- serve --web`, then browse Movies so the list is long.

- Wide: select a row, scroll to the bottom of the list. The preview must stay on screen the whole
  way. Before this task the same check measured `previewTop: -1402`.
- Narrow (a real narrow window or devtools at ~400px): select a row well down the list. The compact
  bar must appear pinned at the bottom immediately, with no scrolling.
- Both: scroll down and confirm row posters still load — that is the `IntersectionObserver` check.

- [ ] **Step 5: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/web/static/styles.css src/web/static/index.html src/web/static/app.ts
git commit -m "fix(web): pin the preview pane so a selection is never off-screen

Wide: sticky under the toolbar. Narrow: a compact bar sharing the list's grid
area, because a sticky item can only travel within its own area and the old
single-column row sat 25,000px above the fold."
```

---

### Task 7: A sticky toolbar

**Files:**
- Modify: `src/web/static/index.html` (wrap `#tabs` `:90` and `.controls` `:92-128` in one element)
- Modify: `src/web/static/styles.css` (`header` `:42-50`, the new wrapper)

- [ ] **Step 1: Wrap and pin**

Wrap `#tabs` and `.controls` in a single `<div class="toolbar">` inside `#pane-search`. Pin `header`
and `.toolbar` with `position: sticky; top: 0` / `top: <header height>`, both with an opaque
background (`var(--bg)`) — a translucent sticky bar over scrolling release names is unreadable.

Publish the total height as `--toolbar-h` on `:root` and have Task 6's preview `top` read it.

The search form stays **unpinned** — it is 100px on its own, and `/` (Task 5) reaches it from
anywhere. Measured budget: header plus toolbar is about 140px of a 774px viewport.

- [ ] **Step 2: Check the other panes**

`.toolbar` is inside `#pane-search`, so For You / Saved / Queue are unaffected — confirm by opening
each. The header is shared and must stay pinned on all four.

- [ ] **Step 3: Verify by hand**

Scroll a long browse: the nav tabs, category tabs, sort, filter and layout controls stay reachable
the whole way down. Switch category from the pinned bar mid-scroll. Confirm the preview still pins
directly below the toolbar with no gap or overlap.

- [ ] **Step 4: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/web/static/index.html src/web/static/styles.css
git commit -m "feat(web): pin the header and the results toolbar"
```

---

### Task 8: Render the groups, and the badges, in the browser

The largest DOM task. **Read `app.ts:1310-1451` before starting** — `renderResult` (`:1362`),
`renderResultCard` (`:1323`), `resultActions` (`:1262`), `appendCachedBadge` (`:1312`) and
`renderResults` (`:1408`) are the functions this changes.

**Files:**
- Modify: `src/web/static/app.ts`
- Modify: `src/web/static/index.html` (a `group` control beside `#layout`, `:120-126`)
- Modify: `src/web/static/styles.css` (group heading and badge styles)

**Interfaces:**
- Consumes: Task 3's `resultRowPlan`, `parseGrouping`, `type GroupRow`; Task 1's `groupCountLabel`,
  `resultAtRow`; Task 2's `releaseBadges`; Task 4's focus snapshot attributes.

- [ ] **Step 1: The control**

Add a `group` checkbox beside the layout control in `index.html`, labelled "group". Persist it to
`localStorage` through `parseGrouping`, exactly as `layout` is persisted through `parseLayout`.
Changing it re-renders; it does not re-run the search.

- [ ] **Step 2: Render a group heading row**

A new `renderGroupRow(row)` beside `renderResult`. Every node `createElement` + `textContent` —
a title parsed out of a release name is still a stranger's string.

Contents: poster thumbnail (via the existing `mountResultPoster`, using the group's **first
member's** name so the artwork cache key matches the release rows), the clean title and year, the
badges of the best member, `groupCountLabel(members.length)`, and a disclosure button carrying
`aria-expanded` and toggling the group's key in an `expandedGroups: Set<string>` at module scope.

Clicking the heading selects the group — `preview.select(...)` with the **group's title**, not a
release name. This is a genuine improvement: the lookup gets "Tin Rivers" instead of
`Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`.

The heading's action buttons act on `resultAtRow(row)` — the first member under the current sort. No
new picking logic.

- [ ] **Step 3: Badges on release rows**

In `renderResult` and `renderResultCard`, append badge `span`s from `releaseBadges(result.name, …)`
next to the existing cached badge, following `appendCachedBadge`'s shape (`:1312-1319`). Empty array
appends nothing.

- [ ] **Step 4: Render from the row plan**

Change `renderResults` (`:1408`) to build from `resultRowPlan(searchView, reportsHealthLookup(sources), expandedGroups)`
instead of `visibleResults`, mapping each row to `renderGroupRow` / `renderResult` /
`renderResultCard`. Keep everything else in that function intact — the `posterObserver.disconnect()`
at the top, the grid/list decision, the status line, and the "selected row was filtered away" branch
at `:1440`.

Two things to preserve carefully:
- The status line count. `searchStatus(view, shown)` takes a **result** count; keep passing the
  number of results, not the number of rows, or a grouped browse will report "22 results" when 210
  arrived. Decide it in `searchModel.ts` if it needs any thought — not here.
- Set `data-row-key` and `data-control` on every focusable control in a row, so Task 4's focus
  restore has something to match.

- [ ] **Step 5: Style it**

A group heading must read as a heading, not as a row with extra text: the count and disclosure
arrow distinct from the release rows beneath it, and the member rows visually indented or otherwise
marked as belonging to it (`inGroup: true` is on every such row). Follow the existing calm theme —
`var(--dim)`, `var(--line)`, `var(--sunken)` — and add no new colours.

- [ ] **Step 6: Verify by hand**

`npm run build && npm run dev -- serve --web`. Browse Movies: the 210-row list from the spec must
collapse to far fewer entries, with `4 releases` style counts on the duplicates. Expand one — its
members appear beneath it. Toggle grouping off — every release returns as its own row. Reload — the
toggle is remembered. Switch to grid layout with grouping on. Check the badges read correctly against
a few release names you can verify by eye.

- [ ] **Step 7: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/web/static/app.ts src/web/static/index.html src/web/static/styles.css
git commit -m "feat(web): render grouped results and quality badges"
```

---

### Task 9: Width and back-to-top

**Files:**
- Modify: `src/web/static/styles.css` (`body` `:31-40`, `.split` `:487-492`)
- Modify: `src/web/static/index.html` (the button)
- Modify: `src/web/static/app.ts` (show/hide and click)

- [ ] **Step 1: Widen**

`body`'s `max-width: 60rem` → `78rem`, and the preview column `16rem` → `20rem` above `76rem`. The
extra room goes to the results column and the preview; cards, prose and the search form keep a
comfortable measure rather than stretching to fill.

Re-check the `46rem` and `34rem` breakpoints still behave — they are unrelated to the cap, but this
is the change most likely to expose a layout that was only ever seen at 60rem.

- [ ] **Step 2: Back to top**

A `position: fixed` button, appearing after roughly two viewports of scroll, scrolling to top on
click. On narrow widths it sits **above** the compact preview bar from Task 6 so the two never
overlap. Respect `prefers-reduced-motion` for the scroll behaviour.

- [ ] **Step 3: Verify by hand**

At 1440px the page should no longer leave a third of the screen empty. Scroll a long browse: the
button appears, works, and does not sit on top of the preview bar at phone width with a row
selected.

- [ ] **Step 4: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint && npm run build
git add src/web/static/styles.css src/web/static/index.html src/web/static/app.ts
git commit -m "feat(web): widen the page cap to 78rem and add back-to-top"
```

---

### Task 10: Badges in the terminal

Smaller than the TUI grouping task and independent of it, so it lands first and separately.

**Files:**
- Modify: `src/ui/components/Results.tsx` (the row JSX, `:652-710`; the header row, `:623-651`)
- Test: the existing Ink harness test for `Results` (find it under `src/ui/`; follow its patterns)

- [ ] **Step 1: Write the failing test**

A `Results` render whose fixture includes `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`,
asserting the frame contains `2160p` and `HDR`. Use `makeTestStore` from `src/ui/testHarness.ts`.

- [ ] **Step 2: Run it and confirm it fails**

Expected: the frame contains the release name but no badge text.

- [ ] **Step 3: Implement**

Append a badge box to the row, copying the `cached` badge pattern at `:680-684` — a
`<Box flexShrink={0} marginLeft={1}>` between the Name box and the stats columns, from
`releaseBadges(r.name, hintForSection(section))`.

Two constraints:
- **Width.** The row is a fixed-column layout and the terminal may be 80 cols. Badges must be
  `flexShrink={0}` *after* a `flexGrow` name that already truncates, and at narrow widths show fewer
  badges (resolution only) rather than pushing the stats columns off the edge. Check at 80 columns.
- The header row at `:623-651` must stay in sync with the columns.

- [ ] **Step 4: Run it and confirm it passes**

Then `npm run previews` if that script renders the results pane, and eyeball the output.

- [ ] **Step 5: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/ui/components/Results.tsx src/ui/<the test file>
git commit -m "feat(tui): show quality badges on a result row"
```

---

### Task 11: Grouping in the terminal

**Files:**
- Modify: `src/ui/components/Results.tsx` (`results` memo `:250-258`; cursor `:262-302`; `moveTo`
  `:387-390`; `useInput` `:392-449`; the rendered list `:585-710`)
- Modify: `src/ui/keymap.ts` (`HELP_GROUPS` "Search" group `:44-65`; `footerHints` results
  fallthrough `:229-244`)
- Test: the existing `Results` harness test, and `src/ui/keymap.test.ts`

**Interfaces:**
- Consumes: Task 1's `groupResults`, `groupRowPlan`, `resultAtRow`, `groupCountLabel`, `type GroupRow`.

- [ ] **Step 1: Write the failing tests**

In the `Results` harness test:
- Two releases of `Kestrel.2010` plus one `Ashfall.1999` render as a heading with `2 releases` and
  one plain row.
- Pressing `g` on the heading reveals both members.
- Pressing `c` collapses it again.

In `keymap.test.ts`: `HELP_GROUPS`' "Search" group contains the expand and collapse hints. Follow
the file's existing assertions.

- [ ] **Step 2: Run them and confirm they fail**

- [ ] **Step 3: Flatten to one cursor**

Follow `src/ui/components/Downloads.tsx:113-134`, this repo's existing answer to a grouped list —
**read it first**. There is no collapsible or tree pattern anywhere in `src/ui` to copy; this is the
closest real analogue.

- Derive `rows: GroupRow<TorrentResult>[]` from `groupRowPlan(groupResults(results, hintForSection(section)), expanded)`
  in a `useMemo` beside the existing `results` memo. `results` stays exactly as it is — it is the
  filtered, sorted list and the input to grouping.
- `expanded` is a local `useState<Set<string>>`, matching `previewOn`, `aliveOnly`, `textFilter`,
  `mode` and `cursor`. **No new `Store` field**, so `makeStore` (`scripts/render-previews-impl.tsx`)
  and `makeTestStore` (`src/ui/testHarness.ts`) do not move.
- The cursor indexes `rows`, not `results`. `clamped`, `windowStart`, `visible` and `pageJump` all
  switch to `rows.length`.
- Every existing action key keeps working unchanged by resolving the cursor through
  `resultAtRow(rows[clamped])` — a collapsed heading hands them its best member. Replace the
  `const r = results[clamped]` reads in `useInput` (`:423`, `:429`, `:432`, `:435`, `:438`, `:441`,
  `:444`) with that. `selectedResult` (`:313`) — which drives the preview pane — resolves the same
  way.
- Reset `expanded` when the query or section changes, alongside the existing reset at `:286-290`.

- [ ] **Step 4: `g` and `c`**

Add to the `mode === "list"` `useInput`: `g` expands the group under the cursor, `c` collapses it.
Both verified free against this component's `useInput` and `App.tsx`'s global one
(`App.tsx:2146-2310`). **Do not use `→`/`←`** — they are pane navigation (`App.tsx:2288-2295`).

Place them after the early-return guards but with the same `results.length === 0` protection the
other row keys have.

- [ ] **Step 5: Render headings**

A heading row shows the disclosure state, the clean title and year, the badges of its first member,
and `groupCountLabel(members.length)`. Member rows are marked as belonging (`inGroup: true`) — indent
them under the heading. Reuse `COLOR` and `ICON` from wherever the rest of this file takes them; add
no new colours or glyphs if an existing one fits.

- [ ] **Step 6: Make `selRef` real**

`selRef` is written at `:389` and `:287` and **never read** — `grep -n selRef src/ui/components/Results.tsx`
returns exactly three hits. Its comment claims it "keeps the cursor on their row while streamed-in
sources reshuffle the list", which is currently false. Grouping reshuffles rows, so implement it: after
`rows` changes, if `selRef.current` names a result still present, move the cursor to its row.

- [ ] **Step 7: Both halves of `keymap.ts`**

`HELP_GROUPS`' "Search" group gets `{ keys: "g", label: … }` and `{ keys: "c", label: … }`. The
results fallthrough of `footerHints` (`:229-244`) gets a hint too — **place it early in the array**:
that row already measures 115 cols bare and 131 with Real-Debrid configured, so it is truncated at
80 today and anything appended at the end is invisible.

- [ ] **Step 8: Run the tests and the app**

`npm test`, then `npm run dev` and drive the real TUI: search something duplicate-heavy, confirm the
headings, `g`/`c`, that `v`/`d`/`r` on a collapsed heading act on its best release, and that the
preview pane follows the cursor. Check at 80 columns.

- [ ] **Step 9: Gates and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/ui/components/Results.tsx src/ui/keymap.ts src/ui/<the test files>
git commit -m "feat(tui): group releases under one title, with g and c

Flattens headings and members to a single cursor the way Downloads.tsx
already does, and resolves a collapsed heading to its best member so every
existing action key works untouched. selRef is now actually read."
```

---

### Task 12: Docs and the full sweep

**Files:**
- Modify: `README.md` (the browser-interface section, `:140-200`)

- [ ] **Step 1: README**

Add grouping and the badges to the browser-interface prose, and re-read **"What the browser can't do
yet"** (`:186` onward) to confirm every line in it is still true after this work. Mention that
grouping is in both front ends and defaults on.

If any invented-cast rule or screenshot claim is now stale, fix the prose — but **do not touch
`preview/web-*.jpg|png`**; real titles in those screenshots are a deliberate call by the repo owner.

- [ ] **Step 2: Grep for breakage the way CLAUDE.md asks**

```bash
grep -rn "visibleResults" src --include='*.ts' --include='*.tsx' | cut -c1-120
grep -rn "not.toContain\|not.toBe(" src/web/*.test.ts | cut -c1-120
```

Every call site of anything this plan changed must be updated, and any negative assertion that was
protecting an XSS or leak invariant must still name something the test actually puts in play — a
negative assertion about a string nothing contains any more passes vacuously.

- [ ] **Step 3: Full gates**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```

All four must pass. Baseline was 132 files / 2025 tests; the count should be up, not down. The one
known `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx` stays.

- [ ] **Step 4: Both front ends, side by side, one last time**

`npm run dev` and `npm run dev -- serve --web` against the same config: the same search must group
the same way in both, and a preference set in one must not contradict the other.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: grouping, badges and the pinned preview in the browser UI"
```

---

## Self-Review

**Spec coverage.** §1 resultGroup → Task 1. §2 web rendering → Tasks 3, 8; terminal → Tasks 11;
toggle → Tasks 3 (parse), 8 (control), 11 (keys). §3 preview → Task 6. §4 toolbar → Task 7; focus →
Task 4; keyboard → Task 5. §5 badges → Tasks 2, 8, 10. §6 width and back-to-top → Task 9. Testing
and gates → every task, plus Task 12. README → Task 12.

**Ordering.** Task 4 precedes Task 5 (arrow keys need focus to survive). Task 7 precedes Task 6's
`top` value, but Task 6 is written first and consumes `--toolbar-h`; if executed in numeric order,
set the custom property in Task 6 and pin the toolbar to it in Task 7. Task 10 precedes Task 11 so
the badge work is reviewable apart from the larger grouping change.

**Type consistency.** `groupResults` / `groupRowPlan` / `resultAtRow` / `groupCountLabel` /
`GroupRow` / `ResultGroup` / `GroupableResult` are used under those exact names in Tasks 3, 8 and 11.
`releaseBadges` in Tasks 8 and 10. `focusTargetAfterRender` / `FocusSnapshot` in Tasks 4 and 5.
`parseGrouping` in Tasks 3 and 8. `SearchView.grouped` in Tasks 3 and 8.

**Known soft spots**, called out rather than papered over: Task 8's exact DOM for a group heading and
Task 11's exact Ink JSX are described by requirement and anchor point rather than transcribed,
because both depend on surrounding code the implementer must read first — `app.ts:1310-1451` and
`Results.tsx:585-710`. Task 10's test file and Task 2's exact `FEATURES` labels are to be discovered
in the repo; the plan says which file is the source of truth in each case.
