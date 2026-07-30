# Quality Preference and Auto-Pick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let torlink hold a stated viewing preference (a resolution ceiling, features to require, features to avoid) and use it to choose and play a release in one action, from a For You film and from a Continue Watching row.

**Architecture:** One pure ranking module, `src/util/releasePick.ts`, imported by both front ends — the terminal directly, the browser through its bundle. Configuration lives in `config.json` and is editable from both surfaces, written read-modify-write per request. Neither streaming, Real-Debrid, nor player launch is modified; the picker chooses a release and hands it to the existing paths.

**Tech Stack:** TypeScript, React + Ink (terminal), vanilla DOM + tsup `platform: "browser"` (web), Vitest, `parse-torrent-title`.

**Spec:** `docs/superpowers/specs/2026-07-30-quality-preference-auto-pick-design.md`. Read it before Task 1. Where this plan and the spec disagree, the spec is wrong and the plan records why (see Task 2, Task 10).

## Global Constraints

- **`src/util/releasePick.ts` may import only `./release`.** Nothing else. It is bundled for the browser (`tsup.web.config.ts`, `platform: "browser"`), so a `node:*` import — direct or transitive — breaks `npm run build`. `parseRelease` is already in the browser bundle via `src/web/static/streamFlow.ts:37`, which is what makes it the one safe import.
- **`src/web` must not import from `src/ui`**, and **`src/core` must not import from either**. Enforced by `eslint.config.js:56` and `:78`.
- **`src/web/static/` must not import `src/core/streamHistory.ts`** — it pulls in `node:fs`. The episode ref arrives over the wire instead (`routes.ts:824`).
- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` in `src/web/static/`.** Every node is `createElement` + `textContent`. Release names come from whoever uploaded a torrent. This is convention, not lint-enforced — there is nothing to catch a violation but review.
- **Config writes from the web are read-modify-write per request**: `loadConfig()` → change → `saveConfig()`. Never hold a snapshot across an `await`. `routes.ts:799-805` explains why.
- **Never name a real film or show** in a test, fixture, comment, or user-facing string. Use only: `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **A new `Store` field must be added in three places** or the build breaks: `src/ui/store.ts`, `makeTestStore` (`src/ui/testHarness.ts:140`), and `makeStore` (`scripts/render-previews-impl.tsx:95`). The first breaks `npm run typecheck`, the second `npm run previews`.
- **Every mutating web route is `POST` with an `action` discriminator in the body.** There are no `PUT` routes in this codebase. The spec says `PUT /api/preferences`; follow the codebase, not the spec — see Task 10.
- **Before declaring done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) is expected — leave it.
- Commit style is Conventional Commits.

---

### Task 1: Expose quality fields on `ParsedRelease`

`parseRelease()` throws away everything the parser knows except title/year/type/season/episode. The picker needs the rest.

**Files:**
- Modify: `src/util/release.ts:4-18` (the `ParsedRelease` interface) and `:82-96` (`parseRelease`)
- Test: `src/util/release.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ParsedRelease` gains `resolution?: string`, `codec?: string`, `colorList?: string[]`, `audioList?: string[]`, `channels?: number`, `bitdepth?: number`, `remux?: boolean`. `ParsedRelease.key` is **unchanged** (`title|year|type`).

**Why `key` must not change:** it is the OMDb title cache key (`titleCache` in `routes.ts`) and feeds `historyKeyFor` (`src/util/streamHistoryKey.ts`). Widening it invalidates every cached lookup and silently splits existing continue-watching entries.

- [ ] **Step 1: Write the failing test**

Add to `src/util/release.test.ts`:

```ts
describe("parseRelease quality fields", () => {
  it("exposes resolution, colour, audio, channels and group features", () => {
    const p = parseRelease("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP");
    expect(p?.resolution).toBe("2160p");
    expect(p?.colorList).toEqual(expect.arrayContaining(["HDR", "DV"]));
    expect(p?.audioList).toEqual(expect.arrayContaining(["atmos"]));
    expect(p?.channels).toBe(7.1);
  });

  it("exposes codec", () => {
    expect(parseRelease("Kestrel.2010.1080p.BluRay.x264")?.codec).toBe("x264");
  });

  it("leaves quality fields undefined when the name states none", () => {
    const p = parseRelease("Ashfall.1999.1080p");
    expect(p?.resolution).toBe("1080p");
    expect(p?.codec).toBeUndefined();
    expect(p?.audioList).toBeUndefined();
    expect(p?.remux).toBeUndefined();
  });

  it("does not change the cache key", () => {
    expect(parseRelease("Kestrel.2010.1080p.BluRay.x264")?.key).toBe("kestrel|2010|movie");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/util/release.test.ts -t "quality fields"`
Expected: FAIL — `p?.resolution` is `undefined` because the field does not exist.

- [ ] **Step 3: Implement**

In `src/util/release.ts`, add to the `ParsedRelease` interface after `episode?: number;`:

```ts
  /**
   * What the release name says about picture and sound. Raw parser vocabulary,
   * NOT a normalised enum: `resolution` can be "1080p", "1080i" or "4k", so
   * consumers must go through `resolutionHeight()` in `releasePick.ts` rather
   * than comparing strings. The `*List` fields are the parser's own `colorlist`
   * / `audiolist`, which carry every match rather than just the first — a
   * release can be both HDR and DV.
   */
  resolution?: string;
  codec?: string;
  colorList?: string[];
  audioList?: string[];
  channels?: number;
  bitdepth?: number;
  remux?: boolean;
```

In `parseRelease`, after the existing `if (typeof p.episode === "number") result.episode = p.episode;`:

```ts
  if (typeof p.resolution === "string") result.resolution = p.resolution;
  if (typeof p.codec === "string") result.codec = p.codec;
  if (typeof p.channels === "number") result.channels = p.channels;
  if (typeof p.bitdepth === "number") result.bitdepth = p.bitdepth;
  if (p.remux === true) result.remux = true;
  // `colorlist`/`audiolist` are only present when the parser matched more than
  // one; fall back to the singular field so a single match is not lost.
  const colorList = p.colorlist ?? (typeof p.color === "string" ? [p.color] : undefined);
  if (colorList?.length) result.colorList = colorList;
  const audioList = p.audiolist ?? (typeof p.audio === "string" ? [p.audio] : undefined);
  if (audioList?.length) result.audioList = audioList;
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/util/release.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/util/release.ts src/util/release.test.ts
git commit -m "feat: expose resolution, colour, audio and codec on ParsedRelease"
```

---

### Task 2: Resolution ranking and the feature table

**Files:**
- Create: `src/util/releasePick.ts`
- Test: `src/util/releasePick.test.ts`

**Interfaces:**
- Consumes: `ParsedRelease` from Task 1.
- Produces:
  - `type MaxResolution = "2160p" | "1080p" | "720p" | "480p"`
  - `const MAX_RESOLUTIONS: readonly MaxResolution[]`
  - `function resolutionHeight(token: string | undefined): number | null`
  - `type FeatureId = "hdr" | "dv" | "atmos" | "dd" | "dts" | "truehd" | "remux" | "hevc" | "tenbit"`
  - `const FEATURE_IDS: readonly FeatureId[]`
  - `const FEATURES: Record<FeatureId, { label: string; test: (p: ParsedRelease) => boolean }>`
  - `function hasFeature(p: ParsedRelease, id: FeatureId): boolean`

**Deviation from the spec, deliberate:** the spec implies a `Resolution` union used for both the cap and ranking. Verified parser output makes that wrong — it emits `"4k"` (from `4K` *and* `UHD`), `"1080i"`, and `"576p"`, and does not recognise `8K`/`2K` at all. An enum would silently mis-rank or drop those. `resolutionHeight()` converts any token to a comparable number instead, and `MaxResolution` stays a small closed set because it is a *user-facing choice*, not a parse result.

- [ ] **Step 1: Write the failing test**

Create `src/util/releasePick.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseRelease } from "./release";
import { resolutionHeight, hasFeature, FEATURE_IDS, FEATURES } from "./releasePick";

const p = (name: string) => {
  const parsed = parseRelease(name);
  if (!parsed) throw new Error(`fixture did not parse: ${name}`);
  return parsed;
};

describe("resolutionHeight", () => {
  it("reads the height out of a p or i token", () => {
    expect(resolutionHeight("1080p")).toBe(1080);
    expect(resolutionHeight("1080i")).toBe(1080);
    expect(resolutionHeight("576p")).toBe(576);
    expect(resolutionHeight("4320p")).toBe(4320);
  });

  it("treats 4k as 2160, because the parser emits it for both 4K and UHD", () => {
    expect(resolutionHeight("4k")).toBe(2160);
  });

  it("returns null for an absent or unrecognised token", () => {
    expect(resolutionHeight(undefined)).toBeNull();
    expect(resolutionHeight("")).toBeNull();
    expect(resolutionHeight("hdrip")).toBeNull();
  });
});

describe("hasFeature", () => {
  const rich = p("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP");
  const plain = p("Kestrel.2010.1080p.BluRay.x264");

  it("matches colour features from the colour list", () => {
    expect(hasFeature(rich, "hdr")).toBe(true);
    expect(hasFeature(rich, "dv")).toBe(true);
    expect(hasFeature(plain, "hdr")).toBe(false);
  });

  it("matches atmos", () => {
    expect(hasFeature(rich, "atmos")).toBe(true);
    expect(hasFeature(plain, "atmos")).toBe(false);
  });

  it("treats DD and DDP as Dolby Digital", () => {
    expect(hasFeature(p("Kepler.S02E04.1080p.WEB-DL.DD5.1"), "dd")).toBe(true);
    expect(hasFeature(p("Harrowgate.S03.1080p.WEB-DL.DDP5.1.x265"), "dd")).toBe(true);
  });

  it("is not fooled by a release group whose name contains the token", () => {
    expect(hasFeature(p("Kestrel.2010.1080p.BluRay.x264-REDDD"), "dd")).toBe(false);
  });

  it("matches the DTS family by prefix", () => {
    expect(hasFeature(p("Ashfall.1999.720p.BRRip.DTS-HD.MA"), "dts")).toBe(true);
  });

  it("matches hevc under every spelling the parser produces", () => {
    // x265 stays "x265"; HEVC, h265 and H.265 all normalise to "h265".
    expect(hasFeature(p("Harrowgate.S03.1080p.WEB-DL.DDP5.1.x265"), "hevc")).toBe(true);
    expect(hasFeature(p("Kestrel.2010.1080p.BluRay.HEVC-GROUP"), "hevc")).toBe(true);
    expect(hasFeature(p("Kestrel.2010.1080p.BluRay.h265-GROUP"), "hevc")).toBe(true);
    expect(hasFeature(plain, "hevc")).toBe(false);
  });

  it("has a label for every id", () => {
    for (const id of FEATURE_IDS) expect(FEATURES[id].label).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/util/releasePick.test.ts`
Expected: FAIL — cannot resolve `./releasePick`.

- [ ] **Step 3: Implement**

Create `src/util/releasePick.ts`:

```ts
// Choosing a release for a title, shared by the TUI and the browser.
//
// IMPORTS ONLY `./release`, and must stay that way. `src/web/static/` is
// bundled with `platform: "browser"` (tsup.web.config.ts), so any `node:*`
// import — direct or transitive — fails `npm run build`. `parseRelease` is
// already in that bundle via `src/web/static/streamFlow.ts`, which is what
// makes it the one safe dependency. The sibling modules `resultSort.ts` and
// `resultFilter.ts` import nothing at all for the same reason.

import { parseRelease, type ParsedRelease } from "./release";

/** The ceilings a user can choose. A closed set because it is a UI choice. */
export type MaxResolution = "2160p" | "1080p" | "720p" | "480p";
export const MAX_RESOLUTIONS: readonly MaxResolution[] = ["2160p", "1080p", "720p", "480p"];

/**
 * A comparable height for a parser resolution token, or null when the name
 * said nothing usable.
 *
 * NOT AN ENUM LOOKUP, deliberately. parse-torrent-title emits "1080p" but also
 * "1080i", "576p" and "4k" (for both "4K" and "UHD"), and does not recognise
 * "8K" or "2K" at all. A union type over the tidy values would silently
 * mis-rank the untidy ones, which are common in real release names.
 */
export function resolutionHeight(token: string | undefined): number | null {
  const t = (token ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t === "4k") return 2160;
  const m = /^(\d{3,4})[pi]$/.exec(t);
  return m ? Number(m[1]) : null;
}

export type FeatureId =
  | "hdr" | "dv" | "atmos" | "dd" | "dts" | "truehd" | "remux" | "hevc" | "tenbit";

const inList = (list: string[] | undefined, want: string): boolean =>
  (list ?? []).some((v) => v.toLowerCase() === want);

/**
 * The features a user can require or exclude.
 *
 * A FIXED TABLE RATHER THAN FREE TEXT. A typed token cannot fail loudly: "4k"
 * or "DD+" would match nothing and look like a broken preference, and a bare
 * substring test for "dd" also matches "DDP", and any release group with those
 * letters in its name. Every test below reads the parser's own classified
 * fields, never the raw release name.
 */
export const FEATURES: Record<FeatureId, { label: string; test: (p: ParsedRelease) => boolean }> = {
  hdr: { label: "HDR", test: (p) => inList(p.colorList, "hdr") },
  dv: { label: "Dolby Vision", test: (p) => inList(p.colorList, "dv") },
  atmos: { label: "Atmos", test: (p) => inList(p.audioList, "atmos") },
  dd: { label: "Dolby Digital", test: (p) => inList(p.audioList, "dd") || inList(p.audioList, "ddp") },
  // Prefix rather than an enumeration: the parser reports the specific variant
  // ("dts", "dts-hd-ma", "dts-x") and new ones appear. Safe here only because
  // no other audio codec's name starts with "dts".
  dts: { label: "DTS", test: (p) => (p.audioList ?? []).some((a) => a.toLowerCase().startsWith("dts")) },
  truehd: { label: "TrueHD", test: (p) => inList(p.audioList, "truehd") },
  remux: { label: "Remux", test: (p) => p.remux === true },
  // "hevc" is NOT a value the parser produces: it normalises HEVC, h265 and
  // H.265 all to "h265", and leaves x265 as "x265". Testing for "hevc" would
  // be dead code that silently missed the commonest spelling.
  hevc: { label: "HEVC / x265", test: (p) => p.codec === "x265" || p.codec === "h265" },
  tenbit: { label: "10-bit", test: (p) => p.bitdepth === 10 },
};

export const FEATURE_IDS: readonly FeatureId[] = Object.keys(FEATURES) as FeatureId[];

export function hasFeature(p: ParsedRelease, id: FeatureId): boolean {
  return FEATURES[id].test(p);
}

export function isFeatureId(v: unknown): v is FeatureId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FEATURES, v);
}

export function isMaxResolution(v: unknown): v is MaxResolution {
  return typeof v === "string" && (MAX_RESOLUTIONS as readonly string[]).includes(v);
}
```

`parseRelease` is imported but not yet used; Task 3 uses it. If lint objects to the unused import before then, add the import in Task 3 instead.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/util/releasePick.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/releasePick.ts src/util/releasePick.test.ts
git commit -m "feat: add resolution ranking and the release feature table"
```

---

### Task 3: The filter stages

Filters run before any sorting: drop noise, drop excluded features, apply the cap, then narrow to required features.

**Files:**
- Modify: `src/util/releasePick.ts`
- Test: `src/util/releasePick.test.ts`

**Interfaces:**
- Consumes: Task 2's `hasFeature`, `resolutionHeight`, `MaxResolution`, `FeatureId`.
- Produces (exported for testing and for Task 4):
  - `interface QualityPrefs { maxResolution?: MaxResolution; require: readonly FeatureId[]; exclude: readonly FeatureId[] }`
  - `const NO_PREFS: QualityPrefs`
  - `interface PickableResult { name: string; sizeBytes: number; seeders: number }`
  - `interface Survivor<T> { item: T; parsed: ParsedRelease }`
  - `interface FilterOutcome<T> { survivors: Survivor<T>[]; relaxed: FeatureId[]; overCap: boolean }`
  - `function filterCandidates<T extends PickableResult>(candidates: readonly T[], prefs: QualityPrefs): FilterOutcome<T>`

- [ ] **Step 1: Write the failing test**

Append to `src/util/releasePick.test.ts`:

```ts
import { filterCandidates, NO_PREFS, type QualityPrefs } from "./releasePick";

const c = (name: string, sizeBytes = 1, seeders = 1) => ({ name, sizeBytes, seeders });
const names = <T extends { name: string }>(s: { item: T }[]) => s.map((x) => x.item.name);
const prefs = (over: Partial<QualityPrefs> = {}): QualityPrefs => ({ ...NO_PREFS, ...over });

describe("filterCandidates", () => {
  it("drops names that parse to nothing but noise", () => {
    const out = filterCandidates([c("Kestrel.2010.1080p.BluRay.x264"), c("1080p.WEB-DL.x265")], prefs());
    expect(names(out.survivors)).toEqual(["Kestrel.2010.1080p.BluRay.x264"]);
  });

  it("drops an excluded feature and never brings it back", () => {
    const out = filterCandidates(
      [c("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP")],
      prefs({ exclude: ["dv"] }),
    );
    expect(out.survivors).toEqual([]);
    expect(out.relaxed).toEqual([]);
  });

  it("drops candidates above the cap", () => {
    const out = filterCandidates(
      [c("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP"), c("Kestrel.2010.1080p.BluRay.x264")],
      prefs({ maxResolution: "1080p" }),
    );
    expect(names(out.survivors)).toEqual(["Kestrel.2010.1080p.BluRay.x264"]);
    expect(out.overCap).toBe(false);
  });

  it("keeps a candidate whose resolution did not parse, rather than assuming it is too big", () => {
    const out = filterCandidates(
      [c("Kestrel.2010.BluRay.x264"), c("Kestrel.2010.1080p.BluRay.x264")],
      prefs({ maxResolution: "1080p" }),
    );
    expect(names(out.survivors)).toHaveLength(2);
  });

  it("ignores the cap and reports overCap when nothing is under it", () => {
    const out = filterCandidates(
      [c("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP")],
      prefs({ maxResolution: "720p" }),
    );
    expect(out.survivors).toHaveLength(1);
    expect(out.overCap).toBe(true);
  });

  it("keeps only candidates with every required feature", () => {
    const out = filterCandidates(
      [c("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP"), c("Kestrel.2010.1080p.BluRay.x264")],
      prefs({ require: ["atmos"] }),
    );
    expect(names(out.survivors)).toEqual(["Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP"]);
    expect(out.relaxed).toEqual([]);
  });

  it("relaxes a requirement nothing satisfies, and says which", () => {
    const out = filterCandidates([c("Kestrel.2010.1080p.BluRay.x264")], prefs({ require: ["atmos"] }));
    expect(out.survivors).toHaveLength(1);
    expect(out.relaxed).toEqual(["atmos"]);
  });

  it("drops the rarest requirement first so the commonest survives longest", () => {
    // Both candidates are HDR; neither is Atmos. "atmos" is the rarer, so it
    // goes and "hdr" is still enforced.
    const out = filterCandidates(
      [c("Tin.Rivers.2024.2160p.WEB-DL.HDR-GROUP"), c("Kestrel.2010.1080p.BluRay.x264")],
      prefs({ require: ["atmos", "hdr"] }),
    );
    expect(out.relaxed).toEqual(["atmos"]);
    expect(names(out.survivors)).toEqual(["Tin.Rivers.2024.2160p.WEB-DL.HDR-GROUP"]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/util/releasePick.test.ts -t "filterCandidates"`
Expected: FAIL — `filterCandidates` is not exported.

- [ ] **Step 3: Implement**

Append to `src/util/releasePick.ts`:

```ts
export interface QualityPrefs {
  maxResolution?: MaxResolution;
  require: readonly FeatureId[];
  exclude: readonly FeatureId[];
}

export const NO_PREFS: QualityPrefs = { require: [], exclude: [] };

/**
 * The fields a pick reads. Structural rather than `TorrentResult`, matching
 * `SortableResult` and `FilterableResult`, so the TUI's `TorrentResult` and the
 * browser's `PublicSearchResult` (which has no `magnet`) both satisfy it
 * without either layer importing the other's type.
 */
export interface PickableResult {
  name: string;
  sizeBytes: number;
  seeders: number;
}

export interface Survivor<T> {
  item: T;
  parsed: ParsedRelease;
}

export interface FilterOutcome<T> {
  survivors: Survivor<T>[];
  /** Requirements dropped to leave anything at all, in the order dropped. */
  relaxed: FeatureId[];
  /** True when no candidate was under the cap, so the cap was ignored. */
  overCap: boolean;
}

export function filterCandidates<T extends PickableResult>(
  candidates: readonly T[],
  prefs: QualityPrefs,
): FilterOutcome<T> {
  // 1. Parse, dropping names that are only quality/codec residue.
  let survivors: Survivor<T>[] = [];
  for (const item of candidates) {
    const parsed = parseRelease(item.name);
    if (parsed) survivors.push({ item, parsed });
  }

  // 2. Excluded features are HARD. Dropped even if that empties the list:
  //    "never play DV" has to mean never, and the caller reports the empty
  //    result rather than falling back to something the user ruled out.
  if (prefs.exclude.length) {
    survivors = survivors.filter((s) => !prefs.exclude.some((id) => hasFeature(s.parsed, id)));
  }

  // 3. The cap. A candidate whose resolution did not parse counts as UNDER it
  //    — the same trap `resultFilter.ts` documents for `seeders: 0`. Several
  //    sources emit names with no resolution token, and reading "unknown" as
  //    "too big" would empty those sources entirely.
  let overCap = false;
  const capHeight = prefs.maxResolution ? resolutionHeight(prefs.maxResolution) : null;
  if (capHeight !== null && survivors.length) {
    const under = survivors.filter((s) => {
      const h = resolutionHeight(s.parsed.resolution);
      return h === null || h <= capHeight;
    });
    if (under.length) survivors = under;
    else overCap = true; // nothing fits; keep everything and say so
  }

  // 4. Required features are SOFT. Drop the rarest unsatisfiable requirement
  //    and retry, so the commonest preference survives longest.
  const relaxed: FeatureId[] = [];
  let required = [...prefs.require];
  while (required.length && survivors.length) {
    const matching = survivors.filter((s) => required.every((id) => hasFeature(s.parsed, id)));
    if (matching.length) {
      survivors = matching;
      break;
    }
    // Rarest first: fewest survivors satisfy it.
    let rarest = required[0]!;
    let fewest = Infinity;
    for (const id of required) {
      const n = survivors.filter((s) => hasFeature(s.parsed, id)).length;
      if (n < fewest) {
        fewest = n;
        rarest = id;
      }
    }
    relaxed.push(rarest);
    required = required.filter((id) => id !== rarest);
  }

  return { survivors, relaxed, overCap };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/util/releasePick.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/releasePick.ts src/util/releasePick.test.ts
git commit -m "feat: filter release candidates by exclusions, cap and requirements"
```

---

### Task 4: The ranking, `rankReleases` and `pickBestRelease`

**Files:**
- Modify: `src/util/releasePick.ts`
- Test: `src/util/releasePick.test.ts`

**Interfaces:**
- Consumes: Task 3's `filterCandidates`, `Survivor`, `QualityPrefs`, `PickableResult`.
- Produces:
  - `type PickIntent = { kind: "film" } | { kind: "episode"; season: number; episode: number }`
  - `interface Pick<T> { chosen: T; parsed: ParsedRelease; relaxed: FeatureId[]; overCap: boolean; fromPack: boolean }`
  - `function rankReleases<T extends PickableResult>(candidates: readonly T[], prefs: QualityPrefs, intent: PickIntent): Pick<T>[]`
  - `function pickBestRelease<T extends PickableResult>(candidates: readonly T[], prefs: QualityPrefs, intent: PickIntent): Pick<T> | null`

Sort order: resolution (descending, or **ascending when `overCap`**), then intent band, then size descending, then seeders descending, then name ascending.

- [ ] **Step 1: Write the failing test**

Append to `src/util/releasePick.test.ts`:

```ts
import { rankReleases, pickBestRelease, type PickIntent } from "./releasePick";

const FILM: PickIntent = { kind: "film" };
const EP2: PickIntent = { kind: "episode", season: 3, episode: 2 };

describe("pickBestRelease", () => {
  it("returns null for an empty list", () => {
    expect(pickBestRelease([], NO_PREFS, FILM)).toBeNull();
  });

  it("returns null when exclusions removed everything", () => {
    const out = pickBestRelease(
      [c("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP")],
      prefs({ exclude: ["dv"] }),
      FILM,
    );
    expect(out).toBeNull();
  });

  it("ranks resolution above size", () => {
    const out = pickBestRelease(
      [c("Kestrel.2010.1080p.BluRay.REMUX", 42_000), c("Kestrel.2010.2160p.WEB-DL", 15_000)],
      NO_PREFS,
      FILM,
    );
    expect(out?.chosen.name).toBe("Kestrel.2010.2160p.WEB-DL");
  });

  it("uses size only to break a resolution tie", () => {
    const out = pickBestRelease(
      [c("Kestrel.2010.2160p.WEB-DL", 9_000), c("Kestrel.2010.2160p.WEB-DL.DV.HDR", 15_000)],
      NO_PREFS,
      FILM,
    );
    expect(out?.chosen.name).toBe("Kestrel.2010.2160p.WEB-DL.DV.HDR");
  });

  it("prefers the single episode over a pack at the same resolution, even when smaller", () => {
    const out = pickBestRelease(
      [c("Harrowgate.S03.1080p.WEB-DL", 50_000), c("Harrowgate.S03E02.1080p.WEB-DL", 2_000)],
      NO_PREFS,
      EP2,
    );
    expect(out?.chosen.name).toBe("Harrowgate.S03E02.1080p.WEB-DL");
    expect(out?.fromPack).toBe(false);
  });

  it("prefers a higher-resolution pack over a lower-resolution episode", () => {
    const out = pickBestRelease(
      [c("Harrowgate.S03.2160p.WEB-DL", 58_000), c("Harrowgate.S03E02.720p.WEB-DL", 1_000)],
      NO_PREFS,
      EP2,
    );
    expect(out?.chosen.name).toBe("Harrowgate.S03.2160p.WEB-DL");
    expect(out?.fromPack).toBe(true);
  });

  it("takes the episode once the cap removes the bigger pack", () => {
    const out = pickBestRelease(
      [c("Harrowgate.S03.2160p.WEB-DL", 58_000), c("Harrowgate.S03E02.720p.WEB-DL", 1_000)],
      prefs({ maxResolution: "1080p" }),
      EP2,
    );
    expect(out?.chosen.name).toBe("Harrowgate.S03E02.720p.WEB-DL");
  });

  it("picks the closest above the cap, not the biggest, when nothing fits", () => {
    const out = pickBestRelease(
      [c("Kestrel.2010.4320p.WEB-DL"), c("Kestrel.2010.2160p.WEB-DL")],
      prefs({ maxResolution: "1080p" }),
      FILM,
    );
    expect(out?.chosen.name).toBe("Kestrel.2010.2160p.WEB-DL");
    expect(out?.overCap).toBe(true);
  });

  it("lets a requirement beat a higher resolution", () => {
    const out = pickBestRelease(
      [c("Kestrel.2010.2160p.WEB-DL"), c("Kestrel.2010.1080p.WEB-DL.Atmos")],
      prefs({ require: ["atmos"] }),
      FILM,
    );
    expect(out?.chosen.name).toBe("Kestrel.2010.1080p.WEB-DL.Atmos");
    expect(out?.relaxed).toEqual([]);
  });

  it("reports a relaxed requirement rather than refusing", () => {
    const out = pickBestRelease([c("Kestrel.2010.1080p.BluRay.x264")], prefs({ require: ["atmos"] }), FILM);
    expect(out?.chosen.name).toBe("Kestrel.2010.1080p.BluRay.x264");
    expect(out?.relaxed).toEqual(["atmos"]);
  });

  it("breaks a full tie deterministically by name", () => {
    const a = c("Kestrel.2010.1080p.WEB-DL.AAA", 100, 5);
    const b = c("Kestrel.2010.1080p.WEB-DL.BBB", 100, 5);
    expect(pickBestRelease([b, a], NO_PREFS, FILM)?.chosen.name).toBe(a.name);
  });

  it("ranks a release with no stated resolution below one that has it, but still picks it alone", () => {
    const out = pickBestRelease(
      [c("Kestrel.2010.BluRay.x264", 90_000), c("Kestrel.2010.720p.BluRay.x264", 1_000)],
      NO_PREFS,
      FILM,
    );
    expect(out?.chosen.name).toBe("Kestrel.2010.720p.BluRay.x264");
    expect(pickBestRelease([c("Kestrel.2010.BluRay.x264")], NO_PREFS, FILM)?.chosen.name)
      .toBe("Kestrel.2010.BluRay.x264");
  });
});

describe("rankReleases", () => {
  it("returns every survivor best-first, and pickBestRelease is its head", () => {
    const list = [c("Kestrel.2010.720p.WEB-DL"), c("Kestrel.2010.2160p.WEB-DL"), c("Kestrel.2010.1080p.WEB-DL")];
    const ranked = rankReleases(list, NO_PREFS, FILM);
    expect(ranked.map((r) => r.chosen.name)).toEqual([
      "Kestrel.2010.2160p.WEB-DL",
      "Kestrel.2010.1080p.WEB-DL",
      "Kestrel.2010.720p.WEB-DL",
    ]);
    expect(pickBestRelease(list, NO_PREFS, FILM)).toEqual(ranked[0]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/util/releasePick.test.ts -t "pickBestRelease"`
Expected: FAIL — `rankReleases` is not exported.

- [ ] **Step 3: Implement**

Append to `src/util/releasePick.ts`:

```ts
/** What the caller is trying to watch. Decides how packs rank against episodes. */
export type PickIntent =
  | { kind: "film" }
  | { kind: "episode"; season: number; episode: number };

export interface Pick<T> {
  chosen: T;
  parsed: ParsedRelease;
  /** Requirements dropped to find a candidate. Empty when the preference was met. */
  relaxed: FeatureId[];
  /** True when no candidate was at or under the cap, so the cap was ignored. */
  overCap: boolean;
  /**
   * True when the intent named an episode but the chosen release does not name
   * that episode — a season pack, a series pack, or an unbanded release. The
   * caller must then select the file inside it (`nextEpisodeIndex`) rather than
   * playing the first one.
   */
  fromPack: boolean;
}

// 0 = names the exact episode, 1 = a pack covering it, 2 = everything else.
//
// A complete-series pack ("S01-S05") parses as `season: 1` — the parser takes
// the first number of a range rather than reporting the span. So such a pack
// bands as a season-1 pack (band 1) and, for any other season, as band 2. That
// is conservative in the right direction: it is genuinely a season-1 pack, and
// for season 3 it drops to last resort rather than being wrongly promoted.
function bandFor(parsed: ParsedRelease, intent: PickIntent): number {
  if (intent.kind === "film") return 0;
  if (parsed.season !== intent.season) return 2;
  if (parsed.episode === intent.episode) return 0;
  return parsed.episode === undefined ? 1 : 2;
}

export function rankReleases<T extends PickableResult>(
  candidates: readonly T[],
  prefs: QualityPrefs,
  intent: PickIntent,
): Pick<T>[] {
  const { survivors, relaxed, overCap } = filterCandidates(candidates, prefs);

  // An unknown resolution ranks LAST among known ones. Note the deliberate
  // asymmetry with the cap in `filterCandidates`, which treats unknown as
  // under: optimistic for inclusion, pessimistic for ranking, so such a release
  // is never excluded but is only chosen when nothing states a resolution.
  //
  // -1 is correct in BOTH directions, and the `overCap` case cannot arise:
  // `filterCandidates` counts an unknown resolution as under the cap, so a
  // single unknown-resolution survivor is enough to keep `overCap` false.
  // `overCap === true` therefore implies every survivor states a height.
  const heightRank = (p: ParsedRelease): number => resolutionHeight(p.resolution) ?? -1;

  const ranked = survivors.slice().sort((a, b) => {
    const ha = heightRank(a.parsed);
    const hb = heightRank(b.parsed);
    if (ha !== hb) return overCap ? ha - hb : hb - ha;
    const ba = bandFor(a.parsed, intent);
    const bb = bandFor(b.parsed, intent);
    if (ba !== bb) return ba - bb;
    if (a.item.sizeBytes !== b.item.sizeBytes) return b.item.sizeBytes - a.item.sizeBytes;
    if (a.item.seeders !== b.item.seeders) return b.item.seeders - a.item.seeders;
    return a.item.name.localeCompare(b.item.name);
  });

  return ranked.map((s) => ({
    chosen: s.item,
    parsed: s.parsed,
    relaxed,
    overCap,
    fromPack: intent.kind === "episode" && bandFor(s.parsed, intent) !== 0,
  }));
}

/**
 * The winner, or null. Exactly `rankReleases(...)[0] ?? null`.
 *
 * `rankReleases` is exported alongside it because spec C walks the ranking:
 * Real-Debrid has no cache-check endpoint, so neither "is it cached" nor "has
 * it been taken down" can be answered without trying a candidate. Returning
 * only a winner would force that loop to re-rank or reimplement the ordering.
 */
export function pickBestRelease<T extends PickableResult>(
  candidates: readonly T[],
  prefs: QualityPrefs,
  intent: PickIntent,
): Pick<T> | null {
  return rankReleases(candidates, prefs, intent)[0] ?? null;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/util/releasePick.test.ts`
Expected: PASS — all of Tasks 2, 3 and 4.

- [ ] **Step 5: Verify the browser bundle still builds**

Run: `npm run build`
Expected: succeeds. This is the only check that `releasePick.ts` pulled in no `node:*`.

- [ ] **Step 6: Commit**

```bash
git add src/util/releasePick.ts src/util/releasePick.test.ts
git commit -m "feat: rank releases by resolution, intent, then size"
```

---

### Task 5: Config fields and sanitisation

**Files:**
- Modify: `src/config/config.ts` — the `Config` interface (after `favourites`, ~line 59) and the `loadConfig` sanitisation block (`:174-194`)
- Test: `src/config/config.test.ts` (create if absent)

**Interfaces:**
- Consumes: `MaxResolution`, `FeatureId`, `isMaxResolution`, `isFeatureId`, `QualityPrefs`, `NO_PREFS` from `src/util/releasePick.ts`.
- Produces: `Config.maxResolution?: MaxResolution`, `Config.requireFeatures?: FeatureId[]`, `Config.excludeFeatures?: FeatureId[]`, and `function qualityPrefsFrom(config: Config): QualityPrefs`.

- [ ] **Step 1: Write the failing test**

Add to `src/config/config.test.ts` (if the file does not exist, create it with `import { describe, it, expect } from "vitest";` at the top):

```ts
import { qualityPrefsFrom, sanitiseQualityPrefs } from "./config";
import type { Config } from "./config";

describe("sanitiseQualityPrefs", () => {
  it("keeps a valid preference", () => {
    const out = sanitiseQualityPrefs({
      maxResolution: "1080p", requireFeatures: ["atmos"], excludeFeatures: ["dv"],
    });
    expect(out).toEqual({ maxResolution: "1080p", requireFeatures: ["atmos"], excludeFeatures: ["dv"] });
  });

  it("drops an invalid resolution", () => {
    expect(sanitiseQualityPrefs({ maxResolution: "8k" }).maxResolution).toBeUndefined();
  });

  it("drops unknown feature ids and non-strings", () => {
    const out = sanitiseQualityPrefs({ requireFeatures: ["atmos", "laserdisc", 7] as unknown as string[] });
    expect(out.requireFeatures).toEqual(["atmos"]);
  });

  it("collapses duplicates", () => {
    expect(sanitiseQualityPrefs({ requireFeatures: ["hdr", "hdr"] }).requireFeatures).toEqual(["hdr"]);
  });

  it("resolves a require/exclude collision in favour of exclude", () => {
    const out = sanitiseQualityPrefs({ requireFeatures: ["dv", "hdr"], excludeFeatures: ["dv"] });
    expect(out.excludeFeatures).toEqual(["dv"]);
    expect(out.requireFeatures).toEqual(["hdr"]);
  });
});

describe("qualityPrefsFrom", () => {
  it("returns empty lists when nothing is configured", () => {
    expect(qualityPrefsFrom({} as Config)).toEqual({ require: [], exclude: [] });
  });

  it("carries the configured preference through", () => {
    expect(qualityPrefsFrom({ maxResolution: "720p", requireFeatures: ["dd"] } as Config))
      .toEqual({ maxResolution: "720p", require: ["dd"], exclude: [] });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/config/config.test.ts`
Expected: FAIL — `sanitiseQualityPrefs` is not exported.

- [ ] **Step 3: Implement**

In `src/config/config.ts`, add the import:

```ts
import {
  isFeatureId, isMaxResolution, NO_PREFS,
  type FeatureId, type MaxResolution, type QualityPrefs,
} from "../util/releasePick";
```

Add to the `Config` interface, after `favourites`:

```ts
  // Ceiling for auto-picked releases. Absent = no ceiling. Note that with no
  // ceiling set the highest resolution available wins, which will usually be a
  // remux — that is the intended reading of "best available", not a bug.
  maxResolution?: MaxResolution;
  // Features an auto-picked release should have. SOFT: when nothing has them,
  // the pick falls back and reports which requirements it dropped.
  requireFeatures?: FeatureId[];
  // Features an auto-picked release must not have. HARD: never chosen.
  excludeFeatures?: FeatureId[];
```

Add near `isFavouriteItem`:

```ts
interface RawQualityPrefs {
  maxResolution?: unknown;
  requireFeatures?: unknown;
  excludeFeatures?: unknown;
}

function featureList(v: unknown): FeatureId[] {
  return Array.isArray(v) ? [...new Set(v.filter(isFeatureId))] : [];
}

/**
 * Drop anything a hand-edited config — or an older build with a different
 * feature set — could put here. A preference that names an id this build does
 * not know would silently match nothing, which reads as a broken picker rather
 * than a bad config.
 *
 * A collision resolves in favour of EXCLUDE. Excluding is the hard rule and
 * requiring is the soft one, so honouring the hard one loses less.
 */
export function sanitiseQualityPrefs(raw: RawQualityPrefs): {
  maxResolution?: MaxResolution;
  requireFeatures: FeatureId[];
  excludeFeatures: FeatureId[];
} {
  const excludeFeatures = featureList(raw.excludeFeatures);
  const requireFeatures = featureList(raw.requireFeatures).filter((id) => !excludeFeatures.includes(id));
  const out: { maxResolution?: MaxResolution; requireFeatures: FeatureId[]; excludeFeatures: FeatureId[] } = {
    requireFeatures,
    excludeFeatures,
  };
  if (isMaxResolution(raw.maxResolution)) out.maxResolution = raw.maxResolution;
  return out;
}

/** The picker's view of the config. */
export function qualityPrefsFrom(config: Config): QualityPrefs {
  const clean = sanitiseQualityPrefs(config);
  const out: QualityPrefs = {
    ...NO_PREFS,
    require: clean.requireFeatures,
    exclude: clean.excludeFeatures,
  };
  return clean.maxResolution ? { ...out, maxResolution: clean.maxResolution } : out;
}
```

In `loadConfig`, after the `cfg.favourites = …` block, add:

```ts
    const quality = sanitiseQualityPrefs(parsed);
    cfg.maxResolution = quality.maxResolution;
    cfg.requireFeatures = quality.requireFeatures;
    cfg.excludeFeatures = quality.excludeFeatures;
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/config/config.test.ts && npx vitest run src/util`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts src/config/config.test.ts
git commit -m "feat: store and sanitise the quality preference in config"
```

---

### Task 6: Terminal plumbing — `autoPlayTitle` on the store

Both panes need "search this title, pick, play". `ContinueWatching.tsx` reads `useStore()` and takes no props, so the action has to be a store field; `ForYou.tsx` is prop-driven and receives it from `App.tsx`.

**Files:**
- Modify: `src/ui/store.ts` (the `Store` interface, near `openStreamHistory` at `:104-106`)
- Modify: `src/ui/testHarness.ts:140-201` (`makeTestStore`)
- Modify: `scripts/render-previews-impl.tsx:95-161` (`makeStore`)
- Modify: `src/ui/App.tsx` — implement and pass into the store value
- Test: `src/ui/store.test.ts`

**Interfaces:**
- Consumes: `PickIntent`, `Pick`, `pickBestRelease` and `pickStatusLine` from `src/util/releasePick.ts`; `qualityPrefsFrom` from `src/config/config.ts`.
- Produces: `Store.autoPlayTitle: (title: string, intent: PickIntent, fallback?: () => void) => void`.

**Do Task 7 first.** Step 5 below calls `pickStatusLine`, which Task 7 adds. Task 7 is self-contained and touches only `releasePick.ts`, so running it out of order costs nothing; the numbering keeps the pure module's tasks together.

`fallback` is what Continue Watching passes so a fruitless search resumes the stored torrent instead of failing.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/store.test.ts`:

```ts
import { makeTestStore } from "./testHarness";

describe("Store.autoPlayTitle", () => {
  it("is present on the store shape", () => {
    const store = makeTestStore();
    expect(typeof store.autoPlayTitle).toBe("function");
  });

  it("can be overridden for a test", () => {
    const calls: string[] = [];
    const store = makeTestStore({ autoPlayTitle: (title) => calls.push(title) });
    store.autoPlayTitle("Kestrel", { kind: "film" });
    expect(calls).toEqual(["Kestrel"]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/ui/store.test.ts -t "autoPlayTitle"`
Expected: FAIL — `autoPlayTitle` is not a property of `Store`.

- [ ] **Step 3: Add the field to the interface and both mirrors**

In `src/ui/store.ts`, after `removeStreamHistory`:

```ts
  /**
   * Search for `title`, choose a release with the user's quality preference,
   * and play it. `fallback` runs when nothing usable was found — Continue
   * Watching passes its existing resume action so an offline or aged-out title
   * still does something.
   */
  autoPlayTitle: (title: string, intent: PickIntent, fallback?: () => void) => void;
```

with `import type { PickIntent } from "../util/releasePick";` at the top.

In `src/ui/testHarness.ts`, add to the object returned by `makeTestStore`, before `...overrides`:

```ts
    autoPlayTitle: noop,
```

In `scripts/render-previews-impl.tsx`, add to the object returned by `makeStore`, before `...overrides`:

```ts
    autoPlayTitle: () => {},
```

- [ ] **Step 4: Run the test and the preview script**

Run: `npx vitest run src/ui/store.test.ts && npm run typecheck && npm run previews`
Expected: all pass. If `npm run previews` fails, `makeStore` was missed.

- [ ] **Step 5: Implement it in `App.tsx`**

**The search in this app is a React hook, and a hook cannot be called imperatively.** `submitQuery` (`App.tsx:1721`) is fire-and-forget — it sets `query` state and returns nothing; the actual fetching happens in `useConcurrentSearch`, which `Results.tsx:223` calls. So `autoPlayTitle` cannot "reuse the existing search". It calls the same core function the hook calls:

- `runSearch(query, sources, opts): Promise<SearchSnapshot>` from `src/core/search.ts:114`. `SearchSnapshot` has `{ results, perSource, done, total }`.
- `enabledSources(disabled, adultEnabled): Source[]` from `src/sources/registry.ts:56` — build the source list exactly as the hook does, from `config.disabledSources` and `config.adultContent`.

Playback reuses `streamResult(input: DownloadInput)` (`App.tsx:1320`), which already owns the whole Real-Debrid / torrent-stream routing and the one-at-a-time guard. `DownloadInput` (`App.tsx:138`) is `{ id, name, magnet, source?, sizeBytes? }`.

Add `autoPlayTitle` next to `streamResult` in `src/ui/App.tsx`:

```tsx
  // Search, pick, play. Calls `runSearch` directly rather than going through
  // `submitQuery`: that only sets query state, and the fetch lives in
  // `useConcurrentSearch`, which a callback cannot invoke. This is the same
  // core entry point the hook uses, so results are identical to what the
  // Results pane would have shown.
  // Cancels any auto-play already in flight. `runSearch`'s per-source timeout
  // is 25 SECONDS, so without this a user who hits Enter and then moves on gets
  // a player for a title they left, and a double Enter runs two searches whose
  // second `streamResult` bounces off "Stop the current stream first". Note the
  // guards inside `streamResult` cannot help: they are evaluated after the
  // await, when nothing is streaming yet. `useConcurrentSearch` aborts the same
  // way on cleanup; this is the keypress path's equivalent.
  const autoPlayRef = useRef<AbortController | null>(null);

  const autoPlayTitle = useCallback(
    (title: string, intent: PickIntent, fallback?: () => void) => {
      if (!config) return;
      // Cancel-and-replace rather than ignore-while-busy: pressing Enter on a
      // different row is a clear statement about what the user now wants.
      autoPlayRef.current?.abort();
      const ctrl = new AbortController();
      autoPlayRef.current = ctrl;
      void (async () => {
        setNotice(`Finding a release for ${title}…`);
        const sources = enabledSources(config.disabledSources ?? [], config.adultContent ?? false);
        const snap = await runSearch(title, sources, { signal: ctrl.signal });
        // An aborted search RESOLVES rather than rejecting, with whatever the
        // snapshot held when the abort landed — usually empty
        // (src/core/search.ts:108-111 documents this, and requires callers to
        // treat an abort as a discard). So no try/catch: the identity check
        // below is what discards it, and it must come before anything that
        // reads `snap`, or a superseded search would report "no release found"
        // over the newer one's status line.
        if (autoPlayRef.current !== ctrl) return;
        autoPlayRef.current = null;
        const prefs = qualityPrefsFrom(config);
        const pick = pickBestRelease(snap.results, prefs, intent);
        if (!pick) {
          // Continue Watching passes its existing resume action here, so an
          // offline or aged-out title still does something.
          if (fallback) fallback();
          else setNotice(`No release found for ${title}.`);
          return;
        }
        setNotice(pickStatusLine(pick, prefs.maxResolution));
        streamResult({
          id: pick.chosen.infoHash,
          name: pick.chosen.name,
          magnet: pick.chosen.magnet,
          source: pick.chosen.source,
          sizeBytes: pick.chosen.sizeBytes,
        });
      })();
    },
    [config, streamResult],
  );
```

`autoPlayTitle` must be defined AFTER `streamResult` (it is in the dependency array), and added to the store value object alongside `openStreamHistory`.

**One gap this leaves, and it is deliberate for now:** `pick.fromPack` is not yet threaded into file selection, so a season pack plays via `streamResult`'s normal file picker rather than jumping to the episode. Wiring `nextEpisodeIndex` into that path touches `streamResult`'s prompt flow, which is Task 9's territory — Task 9 owns the Continue Watching case where `fromPack` actually matters. Leave a `TODO(task-9)` comment on the `streamResult` call naming this.

`pickStatusLine` and `pickBestRelease` come from `src/util/releasePick.ts`; `qualityPrefsFrom` from `src/config/config.ts`. Check whether `setNotice` is the right status channel in this file — `App.tsx` uses `setNotice` for transient messages; if a more specific status setter is in use nearby, prefer it.

- [ ] **Step 6: Run the full check**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS (with the one known `react-hooks/exhaustive-deps` warning).

- [ ] **Step 7: Commit**

```bash
git add src/ui/store.ts src/ui/testHarness.ts scripts/render-previews-impl.tsx src/ui/App.tsx src/ui/store.test.ts
git commit -m "feat: add autoPlayTitle to the terminal store"
```

---

### Task 7: The status copy for a pick

Shared by both front ends, so it is a pure module rather than a string built twice.

**Files:**
- Modify: `src/util/releasePick.ts`
- Test: `src/util/releasePick.test.ts`

**Interfaces:**
- Consumes: `Pick`, `FEATURES`.
- Produces: `function pickStatusLine<T extends PickableResult>(pick: Pick<T>, maxResolution?: MaxResolution): string`.

The cap is a second argument because `Pick` does not carry it — `overCap` records only *that* the cap was ignored, not what it was, and the message reads far better naming the number the user chose.

- [ ] **Step 1: Write the failing test**

Append to `src/util/releasePick.test.ts`:

```ts
import { pickStatusLine } from "./releasePick";

describe("pickStatusLine", () => {
  it("names the release when the preference was met", () => {
    const pick = pickBestRelease([c("Kestrel.2010.1080p.BluRay.x264")], NO_PREFS, FILM)!;
    expect(pickStatusLine(pick)).toBe("Playing Kestrel.2010.1080p.BluRay.x264");
  });

  it("says which requirement gave way", () => {
    const pick = pickBestRelease([c("Kestrel.2010.1080p.BluRay.x264")], prefs({ require: ["atmos"] }), FILM)!;
    expect(pickStatusLine(pick)).toContain("no Atmos release");
  });

  it("names the cap it could not meet", () => {
    const pick = pickBestRelease([c("Kestrel.2010.2160p.WEB-DL")], prefs({ maxResolution: "720p" }), FILM)!;
    expect(pickStatusLine(pick, "720p")).toContain("nothing at 720p or below");
  });

  it("falls back to generic wording when the cap is not passed", () => {
    const pick = pickBestRelease([c("Kestrel.2010.2160p.WEB-DL")], prefs({ maxResolution: "720p" }), FILM)!;
    expect(pickStatusLine(pick)).toContain("your resolution limit");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/util/releasePick.test.ts -t "pickStatusLine"`
Expected: FAIL — `pickStatusLine` is not exported.

- [ ] **Step 3: Implement**

Append to `src/util/releasePick.ts`:

```ts
/**
 * One line naming what was chosen and, when the preference was not met, what
 * gave way. Shared so the terminal and the browser say the same thing — the
 * copy-then-drift bug this codebase has hit four times.
 */
export function pickStatusLine<T extends PickableResult>(
  pick: Pick<T>,
  maxResolution?: MaxResolution,
): string {
  const notes: string[] = [];
  if (pick.overCap) {
    notes.push(
      maxResolution ? `nothing at ${maxResolution} or below` : "nothing under your resolution limit",
    );
  }
  for (const id of pick.relaxed) notes.push(`no ${FEATURES[id].label} release`);
  const head = `Playing ${pick.chosen.name}`;
  return notes.length ? `${head} — ${notes.join(", ")}` : head;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/util/releasePick.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/releasePick.ts src/util/releasePick.test.ts
git commit -m "feat: shared status copy for an auto-picked release"
```

---

### Task 7b: Surface the medium on an OMDb lookup

Auto-play needs to know whether a For You pick is a film. **reccd does not say** — `Recommendation` is `{ imdbId, title, year, score, reasons }` — and the pane's type filter defaults to `"all"` (`useRecommendations.ts:38`), so gating on the filter alone would mean Enter auto-plays nothing until the user presses `t`.

OMDb's response carries `Type: "movie" | "series"`. `src/recc/omdb.ts` sends `type` as a *request* parameter but never reads it back.

**Files:**
- Modify: `src/recc/omdb.ts` — `OmdbResponse` (`:16-22`), `FetchTitleMetaResult` (`:8-10`), `request()` (`:56`)
- Test: `src/recc/omdb.test.ts`

**Interfaces:**
- Produces: `FetchTitleMetaResult`'s ok branch gains **`type?: OmdbType | null`** — OPTIONAL, not required.

**Why optional.** `request()` always sets it, so a real lookup always carries it. But `FetchTitleMetaResult` is the type of ~15 hand-written stubs in `src/web/routes.test.ts` (`fetchTitleMetaByNameImpl: async () => ({ ok: true, imdbId, plot, posterUrl })`) plus mocks in `src/ui/components/Results.test.tsx`. A required field breaks every one of them at typecheck for no benefit — none of those tests care about the medium. Optional is additive, exactly as Task 1's `ParsedRelease` fields were.

**The one unavoidable ripple:** `src/recc/omdb.test.ts` asserts the whole object with `toEqual` in three places (lines ~23, ~31, ~59). Those exercise the real function, so they now see `type` and must be updated. `toEqual` is right for them — do not weaken them to `toMatchObject` to dodge the edit.

- [ ] **Step 1: Write the failing test**

The file's fetch helper is `jsonImpl(status, body)`, returning `{ impl, urls }` — there is no `fakeJson`. Add:

```ts
it("reports the medium OMDb returned", async () => {
  const { impl } = jsonImpl(200, { Response: "True", imdbID: "tt1", Type: "movie", Plot: "x", Poster: "N/A" });
  const res = await fetchTitleMeta("tt1", "KEY", { fetchImpl: impl });
  expect(res).toEqual({ ok: true, type: "movie", imdbId: "tt1", plot: "x", posterUrl: null });
});

it("reports null when OMDb sends a medium it does not model", async () => {
  // OMDb also returns "episode" and "game"; neither is one of ours.
  const { impl } = jsonImpl(200, { Response: "True", imdbID: "tt1", Type: "game" });
  const res = await fetchTitleMeta("tt1", "KEY", { fetchImpl: impl });
  expect(res).toEqual({ ok: true, type: null, imdbId: "tt1", plot: null, posterUrl: null });
});
```

Then update the three existing `toEqual({ ok: true, … })` assertions to include the `type` the real function now returns. Work out the right value for each from its fixture body rather than guessing — a fixture with no `Type` field yields `null`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/recc/omdb.test.ts -t "medium"`
Expected: FAIL — `type` is not on the result.

- [ ] **Step 3: Implement**

Add `Type?: string;` to `OmdbResponse`. Add `type?: OmdbType | null;` to the ok branch of `FetchTitleMetaResult`. In `request()`, replace the success return with:

```ts
    // OMDb also returns "episode" and "game"; anything but the two we model
    // becomes null rather than being coerced into one of them.
    const type: OmdbType | null =
      body.Type === "movie" || body.Type === "series" ? body.Type : null;
    return { ok: true, type, imdbId: clean(body.imdbID), plot: clean(body.Plot), posterUrl: clean(body.Poster) };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/recc && npm run typecheck && npx vitest run src/web/routes.test.ts src/ui/components/Results.test.tsx`
Expected: PASS everywhere. Because `type` is optional, the stub literals in `routes.test.ts` and `Results.test.tsx` must still compile untouched — if you find yourself editing them, the field was declared required by mistake.

- [ ] **Step 5: Commit**

```bash
git add src/recc/omdb.ts src/recc/omdb.test.ts
git commit -m "feat: report the medium on an OMDb title lookup"
```

---

### Task 7c: The film rule, in one place

Both front ends must answer "can this For You row be auto-played?" identically, and `src/web` may not import `src/ui`. `src/util/` is the one directory both can reach, so the rule lives there — not copied into each.

**Files:**
- Create: `src/util/autoPlayableFilm.ts`
- Test: `src/util/autoPlayableFilm.test.ts`

**Interfaces:**
- Produces: `type ReccMedium = "movie" | "series"`, `type ReccFilter = "all" | "movie" | "tv"`, and `function autoPlayableFilm(omdbType: ReccMedium | null | undefined, filter: ReccFilter): boolean`.

**Its own file, not appended to `releasePick.ts`.** `releasePick.ts` ranks candidate releases for a title already chosen; this rule answers whether a For You *row* is playable at all, which is a different question upstream of any ranking. `resultSort.ts` and `resultFilter.ts` are the established pattern for exactly this — a small standalone `src/util` module importing nothing.

- [ ] **Step 1: Write the failing test**

Append to `src/util/releasePick.test.ts`:

Create `src/util/autoPlayableFilm.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { autoPlayableFilm } from "./autoPlayableFilm";

describe("autoPlayableFilm", () => {
  it("trusts OMDb's medium over the filter", () => {
    expect(autoPlayableFilm("movie", "all")).toBe(true);
    expect(autoPlayableFilm("series", "movie")).toBe(false);
  });

  it("falls back to the filter when OMDb said nothing", () => {
    expect(autoPlayableFilm(null, "movie")).toBe(true);
    expect(autoPlayableFilm(undefined, "all")).toBe(false);
    expect(autoPlayableFilm(null, "tv")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/util/autoPlayableFilm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/util/autoPlayableFilm.ts`:

```ts
// Whether a For You row can be auto-played. IMPORTS NOTHING, like its
// siblings `resultSort.ts` and `resultFilter.ts`, and for the same reason:
// `src/web/static/` is bundled with `platform: "browser"`, so a module both
// front ends share cannot reach anything Node-shaped.

/**
 * What OMDb says a title is.
 *
 * Restated rather than imported from `src/recc/omdb.ts`. A type-only import
 * would in fact be safe — it is erased at build time, which is how
 * `release.ts` gets `OmdbType` — but this module has no imports at all, and
 * keeping it that way is the property that makes it obviously bundle-safe.
 */
export type ReccMedium = "movie" | "series";
/** The For You pane's type filter, in both front ends. */
export type ReccFilter = "all" | "movie" | "tv";

/**
 * Whether a For You row can be auto-played. Only a film has an unambiguous
 * intent — a show needs the season/episode picker (spec D).
 *
 * `omdbType` is per-item and wins when known. The pane's filter is the
 * fallback for when there is no OMDb key, and it can only ever say "yes,
 * film": "all" means the medium is genuinely unknown, because reccd sends no
 * per-item type (`useRecommendations.ts:38` starts the filter at "all").
 *
 * HERE rather than in either front end because both need it and `src/web`
 * may not import `src/ui` (eslint.config.js:78). Two copies of one rule is
 * the copy-then-drift bug this codebase has hit four times.
 */
export function autoPlayableFilm(
  omdbType: ReccMedium | null | undefined,
  filter: ReccFilter,
): boolean {
  if (omdbType) return omdbType === "movie";
  return filter === "movie";
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/util/autoPlayableFilm.test.ts && npm run build`
Expected: PASS, and the build confirms the browser bundle is still clean.

- [ ] **Step 5: Commit**

```bash
git add src/util/autoPlayableFilm.ts src/util/autoPlayableFilm.test.ts
git commit -m "feat: one shared rule for whether a For You row is an auto-playable film"
```

---

### Task 8: For You — auto-play a film

**Files:**
- Modify: `src/ui/hooks/useTitlePreview.ts` — add `type` to `TitlePreview` and populate it
- Modify: `src/ui/components/ForYou.tsx` — props (`:15-29`) and the `useInput` handler (`:89-119`)
- Modify: `src/ui/App.tsx` — pass `autoPlayTitle` into `<ForYou />`
- Test: `src/ui/components/ForYou.test.tsx`

**Interfaces:**
- Consumes: `Store.autoPlayTitle` (Task 6).
- Produces: `ForYouProps.autoPlayTitle?: (title: string, intent: PickIntent) => void`.

**Behaviour.** On a **film** row, `Enter` calls `autoPlayTitle(title, { kind: "film" })`. On a **series** row or a row of unknown medium, `Enter` is unchanged — `setSection` + `submitQuery`. `s` always does the unchanged thing. A For You series must never reach the picker: guessing season 1 episode 1 is what spec D exists to replace, and shipping the guess means users see it introduced and reversed.

**Determining the medium.** Two sources, in order:

1. **OMDb's `type`** for that pick (Task 7b), which is per-item and correct whatever the filter says. For You already fetches OMDb metadata for the highlighted row via `useTitlePreview` (`src/ui/hooks/useTitlePreview.ts`), keyed by `imdbId`; reuse that result rather than issuing a second lookup.
2. **The pane's filter**, when there is no OMDb key or the lookup has not resolved: `recs.type === "movie"` means film, anything else means do not auto-play.

This ordering is why Task 7b exists. `useRecommendations.ts:38` starts the filter at `"all"` and reccd sends no per-item type, so filter-only gating would mean Enter auto-plays nothing until the user presses `t`.

The rule itself is `autoPlayableFilm` from `src/util/autoPlayableFilm.ts` (Task 7c) — import it, do not restate it here. It is already tested there, so this task's tests cover only the wiring.

- [ ] **Step 1: Write the failing test**

**Two things about this test file, both verified — do not write against the plan's guesses:**

- **There is no `type` prop on `ForYou`.** The filter lives inside `useRecommendations` as internal state, reachable only by pressing `t` (`all → movie → tv`). Do not invent a prop; cycle it with real keystrokes.
- **There is no `baseProps` object.** The file renders inline, e.g.
  `render(<ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />)`,
  with module constants `CONFIG = { reccUrl, reccToken }`, `REC = { imdbId: "tt1", title: "Windmere", year: 2019, score: 33.4, reasons: [...] }`, and stub factories `fetchStub()`, `fetchStubWithPlot(plot)`, `fetchStubFull(plot)` each returning `{ impl, urls }`. Follow that idiom.
- **The fixture title is `Windmere`, not `Kestrel`.** It is an invented title already established in this file, so it stays — assert on `"Windmere"`. Do not rename the existing fixture, and do not introduce `Kestrel` here just to match the plan's other examples.

Add to `src/ui/components/ForYou.test.tsx`, reusing the existing `flush()` helper at `:34`:

```tsx
it("auto-plays on Enter once the filter is on films", async () => {
  const played: { title: string; intent: unknown }[] = [];
  const { impl } = fetchStub();
  const { stdin } = render(
    <ForYou reccConfig={CONFIG} visible active fetchImpl={impl}
      setSection={vi.fn()} submitQuery={vi.fn()}
      autoPlayTitle={(title, intent) => played.push({ title, intent })} />,
  );
  await flush();
  stdin.write("t"); // all -> movie
  await flush();
  stdin.write("\r");
  await flush();
  expect(played).toEqual([{ title: "Windmere", intent: { kind: "film" } }]);
});

it("does not auto-play with the default 'all' filter and no OMDb medium", async () => {
  const played: string[] = [];
  const submitted: string[] = [];
  const { impl } = fetchStub();
  const { stdin } = render(
    <ForYou reccConfig={CONFIG} visible active fetchImpl={impl} setSection={vi.fn()}
      autoPlayTitle={(t) => played.push(t)} submitQuery={(q) => submitted.push(q)} />,
  );
  await flush();
  stdin.write("\r");
  await flush();
  expect(played).toEqual([]);
  expect(submitted).toEqual(["Windmere"]);
});

it("does not auto-play a show — that needs the episode picker", async () => {
  const played: string[] = [];
  const submitted: string[] = [];
  const { impl } = fetchStub();
  const { stdin } = render(
    <ForYou reccConfig={CONFIG} visible active fetchImpl={impl} setSection={vi.fn()}
      autoPlayTitle={(t) => played.push(t)} submitQuery={(q) => submitted.push(q)} />,
  );
  await flush();
  stdin.write("t"); // all -> movie
  await flush();
  stdin.write("t"); // movie -> tv
  await flush();
  stdin.write("\r");
  await flush();
  expect(played).toEqual([]);
  expect(submitted).toEqual(["Windmere"]);
});

it("s searches the title without playing", async () => {
  const played: string[] = [];
  const submitted: string[] = [];
  const { impl } = fetchStub();
  const { stdin } = render(
    <ForYou reccConfig={CONFIG} visible active fetchImpl={impl} setSection={vi.fn()}
      autoPlayTitle={(t) => played.push(t)} submitQuery={(q) => submitted.push(q)} />,
  );
  await flush();
  stdin.write("t");
  await flush();
  stdin.write("s");
  await flush();
  expect(played).toEqual([]);
  expect(submitted).toEqual(["Windmere"]);
});
```

Note that `t` refetches, so each `stdin.write("t")` needs its own `flush()`. `fetchStub()` returns the same `REC` whatever the filter, so `Windmere` is what comes back at every filter value — which is what makes the assertions above valid after cycling.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/ui/components/ForYou.test.tsx -t "auto-plays"`
Expected: FAIL — `autoPlayTitle` is not a prop and Enter still submits a query.

- [ ] **Step 3: Implement**

Import `autoPlayableFilm` from `../../util/autoPlayableFilm`, and add to `ForYouProps`:

```ts
  /** Absent means the pane behaves exactly as it did before. */
  autoPlayTitle?: (title: string, intent: PickIntent) => void;
```

Replace the `key.return` branch in the `useInput` handler, and add an `s` branch:

```tsx
      else if (input === "s") {
        if (selectedItem) {
          setSection(TYPE_SECTION[recs.type]);
          submitQuery(selectedItem.title);
        }
      }
      else if (key.return) {
        if (!selectedItem) return;
        // Only a film has an unambiguous intent. A series needs the season and
        // episode picker (spec D); until then Enter does what it always did
        // rather than guessing season 1 episode 1. `preview.type` is OMDb's
        // per-item answer and wins; the pane's filter is the fallback when
        // there is no OMDb key, and "all" means genuinely unknown.
        if (autoPlayTitle && autoPlayableFilm(preview.type, recs.type)) {
          autoPlayTitle(selectedItem.title, { kind: "film" });
        } else {
          setSection(TYPE_SECTION[recs.type]);
          submitQuery(selectedItem.title);
        }
      }
```

`preview` is the existing `useTitlePreview` result for the highlighted row (`ForYou.tsx:72-81`). Three facts, all verified:

- **`TitlePreview` (`src/ui/hooks/useTitlePreview.ts:19`) is `{ imdbId, plot, posterRows }` — it has no `type`.** Add `type: ReccMedium | null | undefined` to that interface and populate it from the `fetchTitleMeta` result the hook already receives. Do NOT issue a second OMDb call.
- **The fetch is not gated on the preview pane being open.** `ForYou.tsx:74` passes `enabled: omdbApiKey !== ""`, and only `posterEnabled: showPreview` gates the expensive poster render. So with a key configured, the medium is available for the highlighted row whether or not the user has pressed `p`. This is what makes OMDb a usable signal here rather than a rare one.
- **It is debounced 150ms and only covers the selected row.** Pressing Enter immediately after moving the cursor can therefore find `type` still `undefined`. That is fine and must not be "fixed" by awaiting: pass it through as-is and let `autoPlayableFilm`'s filter fallback decide. Never block a keypress on a network call.

In `App.tsx`, pass `autoPlayTitle={store.autoPlayTitle}` to `<ForYou />` (the element is at `App.tsx:2610-2618`).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/ui/components/ForYou.test.tsx`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/ForYou.tsx src/ui/App.tsx src/ui/components/ForYou.test.tsx
git commit -m "feat: auto-play a For You film on Enter"
```

---

### Task 9: Continue Watching — auto-play the next episode

**Files:**
- Modify: `src/ui/components/ContinueWatching.tsx:16-29`
- Modify: `src/ui/App.tsx` — thread the pack intent into the file picker (see below)
- Test: `src/ui/components/ContinueWatching.test.tsx` (create)

**Interfaces:**
- Consumes: `Store.autoPlayTitle` (Task 6), `nextEpisode` from `src/core/streamHistory.ts:116`.
- Produces: no new exports.

### Also in this task: make `fromPack` actually select the episode

Task 6 left a `TODO(task-9)` on its `streamResult` call. This is it.

`openStreamPicker` (`App.tsx:1174`) already chooses the picker's opening position:

```tsx
      setStreamPreselect(
        nextEpisodeIndex(candidates, {
          next: recorded ? nextEpisode(recorded) : null,
          watched: watchedFor(config?.favourites ?? [], input.id),
        }),
      );
```

`recorded` is the history row *this* play just wrote — which, for a season pack, is the pack. `nextEpisode()` on a pack row returns **null** (a pack parses to a season with no episode), so the preselect falls back to `watched` and will not land on the episode the user asked for. Auto-play knows the answer exactly; the picker just is not being told.

Fix: let `autoPlayTitle` hand its intent down as an override. Keep it small — a ref set immediately before `streamResult` and consumed once by `openStreamPicker`:

```tsx
  // The episode auto-play is actually after, when it had to settle for a pack.
  // Beats `nextEpisode(recorded)` because the pack's own history row has no
  // episode to derive one from. Keyed by infohash and cleared on use.
  const packTargetRef = useRef<{ infoHash: string; next: EpisodeRef } | null>(null);
```

In `autoPlayTitle`, before calling `streamResult`:

```tsx
        packTargetRef.current =
          pick.fromPack && intent.kind === "episode"
            ? { infoHash: pick.chosen.infoHash, next: { season: intent.season, episode: intent.episode } }
            : null;
```

And in `openStreamPicker`, consume it only for the torrent it was set for:

```tsx
      // KEYED BY INFOHASH, not just cleared on read. `openStreamPicker` runs
      // only when a MULTI-FILE torrent actually resolves, so every other path
      // leaves the ref set: `streamResult` bailing on its guard, the
      // torrent-stream ack prompt being cancelled, an RD resolve failing, or a
      // single-file torrent. Without the key, a stale target from an abandoned
      // play preselects the wrong episode in a later, unrelated picker.
      const pending = packTargetRef.current;
      const packTarget = pending?.infoHash === input.id ? pending.next : null;
      if (packTarget) packTargetRef.current = null;
      setStreamPreselect(
        nextEpisodeIndex(candidates, {
          next: packTarget ?? (recorded ? nextEpisode(recorded) : null),
          watched: watchedFor(config?.favourites ?? [], input.id),
        }),
      );
```

A ref rather than state on purpose: this must be readable synchronously by the time the picker opens, and it must not trigger a re-render. `EpisodeRef` comes from `src/util/episode.ts`.

**Test the staleness guard, not just the happy path:** set a pack target for one infohash, open the picker for a different one, and assert the preselect fell back to `nextEpisode(recorded)`. That is the case the infohash key exists for, and it is invisible without a test.

### Also in this task: the `s` key on Continue Watching

Task 10 adds `{ keys: "s", label: "Search" }` to this pane's footer and help group. **Nothing else adds the handler**, and Task 10's tests assert on `footerHints`, not on the component — so without this, Task 10 ships a footer advertising a key that does nothing, and its own tests still pass.

Add it to `ContinueWatching.tsx`'s `useInput`, mirroring `ForYou.tsx`:

```tsx
      else if (input === "s") {
        const item = streamHistory[clamped];
        if (item) {
          setSection("all");
          submitQuery(item.title);
        }
      }
```

`setSection` and `submitQuery` come from `useStore()` — add them to the destructure. Cover it with a test that `s` searches and does NOT play.

Remove Task 6's `TODO(task-9)` comment as part of this.

**Behaviour.** On a row where `nextEpisode(item)` is non-null, `Enter` calls `autoPlayTitle(item.title, { kind: "episode", … }, () => openStreamHistory(item))`. Where it is **null**, `Enter` is unchanged.

`nextEpisode` returns null for a film *and* for a series watched via a season pack — `Harrowgate.S03` parses to a season with no episode, and guessing episode 1 would point at something already watched (`streamHistory.ts:111-114`). There is no honest thing to search for, so do not invent one.

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/ContinueWatching.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ContinueWatching } from "./ContinueWatching";
import { makeTestStore } from "../testHarness";
import type { StreamHistoryItem } from "../../core/streamHistory";

const item = (over: Partial<StreamHistoryItem>): StreamHistoryItem => ({
  key: "k", title: "Kepler", rawName: "Kepler.S02E04.1080p.WEB-DL",
  infoHash: "abc", startedAt: 0, type: "series", season: 2, episode: 4, ...over,
});

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); };

// `vi.mock` is HOISTED above the imports; `vi.doMock` is not, and would be a
// no-op here because `ContinueWatching` resolves `useStore` at module load.
// The mock therefore reads a mutable holder that each test reassigns.
let store = makeTestStore();
vi.mock("../store", () => ({ useStore: () => store }));

function renderWith(overrides: Parameters<typeof makeTestStore>[0]) {
  store = makeTestStore({ region: "content", section: "continueWatching", ...overrides });
  return render(<ContinueWatching />);
}

describe("ContinueWatching Enter", () => {
  it("auto-plays the next episode", async () => {
    const played: unknown[] = [];
    const { stdin } = renderWith({
      streamHistory: [item({})],
      autoPlayTitle: (title, intent) => played.push({ title, intent }),
    });
    await flush();
    stdin.write("\r");
    await flush();
    expect(played).toEqual([{ title: "Kepler", intent: { kind: "episode", season: 2, episode: 5 } }]);
  });

  it("resumes the stored torrent when there is no honest next episode", async () => {
    const played: unknown[] = [];
    const resumed: string[] = [];
    const { stdin } = renderWith({
      // A season pack: type series, season known, episode unknown.
      streamHistory: [item({ rawName: "Harrowgate.S03.1080p.WEB-DL", title: "Harrowgate", season: 3, episode: undefined })],
      autoPlayTitle: (t) => played.push(t),
      openStreamHistory: (i) => resumed.push(i.title),
    });
    await flush();
    stdin.write("\r");
    await flush();
    expect(played).toEqual([]);
    expect(resumed).toEqual(["Harrowgate"]);
  });

  it("resumes a film rather than searching", async () => {
    const played: unknown[] = [];
    const resumed: string[] = [];
    const { stdin } = renderWith({
      streamHistory: [item({ title: "Kestrel", type: "movie", season: undefined, episode: undefined })],
      autoPlayTitle: (t) => played.push(t),
      openStreamHistory: (i) => resumed.push(i.title),
    });
    await flush();
    stdin.write("\r");
    await flush();
    expect(played).toEqual([]);
    expect(resumed).toEqual(["Kestrel"]);
  });
});
```

`makeTestStore` must be called before `vi.mock`'s factory runs, which it is — the factory is lazy and only executes when `../store` is first imported. If the hoisting still bites, add an optional props escape hatch to `ContinueWatching` mirroring `ForYou`'s prop-driven shape rather than fighting the mock, keeping the store as the default source.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/ui/components/ContinueWatching.test.tsx`
Expected: FAIL — Enter still calls `openStreamHistory` for the first case.

- [ ] **Step 3: Implement**

In `ContinueWatching.tsx`, add `autoPlayTitle` to the `useStore()` destructure, import `nextEpisode` alongside `nextLabel`, and replace the `key.return` branch:

```tsx
      else if (key.return) {
        const item = streamHistory[clamped];
        if (!item) return;
        const next = nextEpisode(item);
        // Null for a film AND for a series watched via a season pack — see
        // streamHistory.ts. There is nothing honest to search for, so Enter
        // keeps doing exactly what it did before.
        if (!next) {
          openStreamHistory(item);
          return;
        }
        autoPlayTitle(item.title, { kind: "episode", ...next }, () => openStreamHistory(item));
      }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/ui/components/ContinueWatching.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/ContinueWatching.tsx src/ui/components/ContinueWatching.test.tsx
git commit -m "feat: auto-play the next episode from continue watching"
```

---

### Task 10: Keymap — both halves

**Files:**
- Modify: `src/ui/keymap.ts` — the For You help group (`:63-78`), the Continue Watching footer (`:145-153`), the For You footer (`:161-175`), and a new Continue Watching help group
- Test: `src/ui/keymap.test.ts`

**Interfaces:** none exported beyond the existing `HELP_GROUPS` and `footerHints`.

There is currently **no** Continue Watching help group — the pane only appears in `footerHints`. A new key needs both halves, so add the group.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/keymap.test.ts`:

```ts
it("documents s in the For You help group", () => {
  const group = HELP_GROUPS.find((g) => g.title === "For You")!;
  expect(group.hints.map((h) => h.keys)).toContain("s");
});

it("has a Continue Watching help group covering play and search", () => {
  const group = HELP_GROUPS.find((g) => g.title === "Continue watching");
  expect(group).toBeDefined();
  expect(group!.hints.map((h) => h.keys)).toEqual(expect.arrayContaining(["↵", "s", "x"]));
});

it("offers s in both footers", () => {
  expect(footerHints("content", "forYou").map((h) => h.keys)).toContain("s");
  expect(footerHints("content", "continueWatching").map((h) => h.keys)).toContain("s");
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/ui/keymap.test.ts`
Expected: FAIL — no `s` hint, no Continue watching group.

- [ ] **Step 3: Implement**

In the For You help group, change the `↵` label and add `s`:

```ts
      { keys: "↵", label: "Play the best release (films) / search the title (shows)" },
      { keys: "s", label: "Search this title instead of playing it" },
```

Add a new group after "For You":

```ts
  {
    title: "Continue watching",
    hints: [
      { keys: "↑ ↓", label: "Move between titles" },
      { keys: "↵", label: "Play the next episode" },
      { keys: "s", label: "Search this title instead of playing it" },
      { keys: "x", label: "Remove from the list" },
    ],
  },
```

In `footerHints`, add `{ keys: "s", label: "Search" }` to both returns, and change the For You `↵` label to `"Play"`:

```ts
  if (section === "continueWatching") {
    return [NAVIGATE, { keys: "↵", label: "Play" }, { keys: "s", label: "Search" }, REMOVE, SWITCH, ALWAYS];
  }
```

```ts
      { keys: "↵", label: "Play" },
      { keys: "s", label: "Search" },
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/ui/keymap.test.ts && npx vitest run src/ui`
Expected: PASS. The `HelpOverlay` test may assert a group count — update it if so.

- [ ] **Step 5: Commit**

```bash
git add src/ui/keymap.ts src/ui/keymap.test.ts
git commit -m "feat: document the play and search keys in help and footers"
```

---

### Task 11: Terminal settings — the quality prompt

**Files:**
- Create: `src/ui/components/QualityPrompt.tsx`
- Modify: `src/ui/App.tsx` — open it from the config pane, save on close
- Modify: `src/ui/keymap.ts` — the "Navigate" help group (`:13-31`), for the key that opens it
- Test: `src/ui/components/QualityPrompt.test.tsx`

**Interfaces:**
- Consumes: `FEATURE_IDS`, `FEATURES`, `MAX_RESOLUTIONS`, `MaxResolution`, `FeatureId` from `src/util/releasePick.ts`.
- Produces: `QualityPrompt(props)` and `export function cycleResolution(current: MaxResolution | undefined): MaxResolution | undefined`.

Follow `SourcesPrompt.tsx` — a cursor over a flat list, space to toggle, escape to close. Rows: one resolution row that cycles, then one row per feature with a three-state cell (off / require / exclude), which avoids two parallel lists that can contradict each other.

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/QualityPrompt.test.tsx`:

```ts
import { describe, it, expect } from "vitest";
import { cycleResolution } from "./QualityPrompt";

describe("cycleResolution", () => {
  it("cycles none -> 2160p -> 1080p -> 720p -> 480p -> none", () => {
    const seq: (string | undefined)[] = [];
    let r = cycleResolution(undefined);
    for (let i = 0; i < 5; i++) { seq.push(r); r = cycleResolution(r); }
    expect(seq).toEqual(["2160p", "1080p", "720p", "480p", undefined]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/ui/components/QualityPrompt.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/ui/components/QualityPrompt.tsx`:

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, ICON } from "../theme";
import { FEATURE_IDS, FEATURES, MAX_RESOLUTIONS, type FeatureId, type MaxResolution } from "../../util/releasePick";

/** none -> highest -> … -> lowest -> none. `undefined` is "no ceiling". */
export function cycleResolution(current: MaxResolution | undefined): MaxResolution | undefined {
  if (current === undefined) return MAX_RESOLUTIONS[0];
  const i = MAX_RESOLUTIONS.indexOf(current);
  return i === MAX_RESOLUTIONS.length - 1 ? undefined : MAX_RESOLUTIONS[i + 1];
}

// Off -> require -> exclude -> off. One three-state cell per feature rather
// than two parallel lists, so a feature cannot be required and excluded at once.
type FeatureState = "off" | "require" | "exclude";
const NEXT_STATE: Record<FeatureState, FeatureState> = { off: "require", require: "exclude", exclude: "off" };
const MARK: Record<FeatureState, string> = { off: "·", require: "✓", exclude: "✗" };

export interface QualityPromptProps {
  width: number;
  maxResolution?: MaxResolution;
  require: readonly FeatureId[];
  exclude: readonly FeatureId[];
  onChange: (next: { maxResolution?: MaxResolution; require: FeatureId[]; exclude: FeatureId[] }) => void;
  onCancel: () => void;
}

export function QualityPrompt({ width, maxResolution, require, exclude, onChange, onCancel }: QualityPromptProps) {
  const [cursor, setCursor] = useState(0);
  const rows = 1 + FEATURE_IDS.length;
  const clamped = Math.min(cursor, rows - 1);

  const stateOf = (id: FeatureId): FeatureState =>
    exclude.includes(id) ? "exclude" : require.includes(id) ? "require" : "off";

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.upArrow) setCursor(wrapStep(clamped, -1, rows));
    else if (key.downArrow) setCursor(wrapStep(clamped, 1, rows));
    else if (input === " " || key.return) {
      if (clamped === 0) {
        onChange({ maxResolution: cycleResolution(maxResolution), require: [...require], exclude: [...exclude] });
        return;
      }
      const id = FEATURE_IDS[clamped - 1]!;
      const next = NEXT_STATE[stateOf(id)];
      onChange({
        maxResolution,
        require: next === "require" ? [...require, id] : require.filter((x) => x !== id),
        exclude: next === "exclude" ? [...exclude, id] : exclude.filter((x) => x !== id),
      });
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="playback quality" width={width} focused>
        <Box>
          <Text color={clamped === 0 ? COLOR.accent : undefined}>{clamped === 0 ? `${ICON.pointer} ` : "  "}</Text>
          <Text>max resolution </Text>
          <Text color={COLOR.accent}>{maxResolution ?? "no limit"}</Text>
        </Box>
        {FEATURE_IDS.map((id, i) => {
          const selected = clamped === i + 1;
          const state = stateOf(id);
          return (
            <Box key={id}>
              <Text color={selected ? COLOR.accent : undefined}>{selected ? `${ICON.pointer} ` : "  "}</Text>
              <Text color={state === "require" ? COLOR.good : state === "exclude" ? COLOR.bad : undefined}>
                {MARK[state]}
              </Text>
              <Text dimColor={state === "off"}>{` ${FEATURES[id].label}`}</Text>
            </Box>
          );
        })}
      </Panel>
      <Text dimColor>
        With nothing set, the best resolution available wins — then the largest file.
      </Text>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↑↓</Text><Text dimColor> move</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>space</Text><Text dimColor> off / require / exclude</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text><Text dimColor> done</Text>
      </Box>
    </Box>
  );
}
```

In `App.tsx`, follow the `SourcesPrompt` pattern exactly — it is the closest analogue and all four pieces are verified:

1. **State:** `const [editingQuality, setEditingQuality] = useState(false);` beside `editingSources` (`:250`).
2. **Open it** from the global key handler, next to the `o` / `S` cases (`:1984-1996`).
3. **Suppress other input while open:** `editingQuality` must be added to the guard list at `:1901` and given an early return at `:2018` alongside `if (editingSources) return; // the sources panel owns input`. Miss this and keystrokes leak to the pane behind the prompt.
4. **Render** beside the other prompts (`:2320`):

```tsx
        {editingQuality ? (
          <Box marginTop={1}>
            <QualityPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              maxResolution={store.config.maxResolution}
              require={store.config.requireFeatures ?? []}
              exclude={store.config.excludeFeatures ?? []}
              onChange={setQualityPrefs}
              onCancel={() => setEditingQuality(false)}
            />
          </Box>
        ) : null}
```

5. **Persist** with the same functional-update-then-save shape as `toggleSource` (`:659`), which avoids writing back a stale snapshot:

```tsx
  const setQualityPrefs = useCallback(
    (next: { maxResolution?: MaxResolution; require: FeatureId[]; exclude: FeatureId[] }) => {
      setConfigState((prev) => {
        if (!prev) return prev;
        const updated = {
          ...prev,
          maxResolution: next.maxResolution,
          requireFeatures: next.require,
          excludeFeatures: next.exclude,
        };
        void saveConfig(updated);
        return updated;
      });
    },
    [],
  );
```

**Use `P`, not `q`.** `q` is Quit (`keymap.ts:29`, `App.tsx:2076`). The global config keys in this app are uppercase — `S` sources, `D` DNS, `L` limits, `V` VPN, `shift+w`, `shift+x` — and `P` is unbound. Add it to the **"Navigate"** help group (`keymap.ts:13-31`), which is where those global keys live; there is no "Accounts" entry for them.

```ts
      { keys: "P", label: "Playback quality (resolution and features)" },
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/ui && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/QualityPrompt.tsx src/ui/components/QualityPrompt.test.tsx src/ui/App.tsx src/ui/keymap.ts
git commit -m "feat: edit the quality preference from the terminal"
```

---

### Task 12: Web — wire type, read and write routes

**Files:**
- Modify: `src/web/wire.ts` — add `PublicQualityPrefs`, extend the `/api/sources` response type
- Modify: `src/web/routes.ts` — extend the sources payload; add `preferencesAction`; register it in the dispatch chain (~`:1473`)
- Test: `src/web/routes.test.ts`

**Interfaces:**
- Consumes: `qualityPrefsFrom`, `sanitiseQualityPrefs` (Task 5); `isFeatureId`, `isMaxResolution` (Task 2).
- Produces:
  - `interface PublicQualityPrefs { maxResolution: MaxResolution | null; require: FeatureId[]; exclude: FeatureId[] }`
  - `interface PreferencesRequest { action: "set"; preferences: PublicQualityPrefs }`
  - `interface PreferencesResponse { preferences: PublicQualityPrefs }`
  - `GET /api/sources` gains `preferences: PublicQualityPrefs`
  - `POST /api/preferences`
  - **`PublicTitleMeta` gains `type?: "movie" | "series" | null`**, populated by `titleMeta()` from Task 7b's new field.

**Why the title-meta change belongs here and not in Task 14.** Task 14 gates the browser's Play button on the item's medium, which it can only get from `/api/title`. That is this task's file (`routes.ts`) and this task's type (`wire.ts`). Adding it in Task 14 would make that task's diff span three layers, two of which its reviewer has no brief for. Add it now, with a test that `GET /api/title` echoes the medium through.

Keep it OPTIONAL, for the same reason Task 7b's field is optional: `PublicTitleMeta` is constructed in several tests, and a required field breaks them for no benefit.

**Deviation from the spec, deliberate:** the spec says `PUT /api/preferences`. There are no `PUT` routes in this codebase — every mutation is `POST` with an `action` discriminator (`savedSearchesAction`, `libraryAction`, `continueWatchingAction`). Follow the codebase. Reading joins `/api/sources`, which is already the capability-and-config payload the browser fetches at boot, so no second round trip.

- [ ] **Step 1: Write the failing test**

This file has established helpers — use them, do not invent fixtures:

- `deps(over: Partial<WebDeps> = {}): WebDeps` is a **function**, not an object. Call `deps({...})`, never `{...deps, ...}`.
- `AUTH` is the auth header constant (`"Bearer secret"`).
- `searchConfig(over: Partial<Config> = {}): Config` builds a config over `defaultConfig`.
- **`deps()`'s default `saveConfigImpl` THROWS on purpose** (`routes.test.ts:50-52`), so a write test that forgets to inject a save seam fails loudly instead of editing the developer's real `~/.config/torlnk/config.json`. Always pass `saveConfigImpl`.

```ts
describe("POST /api/preferences", () => {
  async function post(body: unknown, over: Partial<WebDeps> = {}) {
    return handleWebApi(deps(over), "POST", "/api/preferences", new URLSearchParams(), AUTH, JSON.stringify(body));
  }

  it("saves a valid preference and echoes it back", async () => {
    let saved: Config | null = null;
    const res = await post(
      { action: "set", preferences: { maxResolution: "1080p", require: ["atmos"], exclude: ["dv"] } },
      { loadConfigImpl: async () => searchConfig(), saveConfigImpl: async (c) => { saved = c; } },
    );
    expect(res.status).toBe(200);
    expect(saved!.maxResolution).toBe("1080p");
    expect(saved!.requireFeatures).toEqual(["atmos"]);
    expect(saved!.excludeFeatures).toEqual(["dv"]);
    expect((res.json as PreferencesResponse).preferences).toEqual({
      maxResolution: "1080p", require: ["atmos"], exclude: ["dv"],
    });
  });

  it("drops an unknown feature id rather than storing it", async () => {
    let saved: Config | null = null;
    await post(
      { action: "set", preferences: { maxResolution: null, require: ["laserdisc"], exclude: [] } },
      { loadConfigImpl: async () => searchConfig(), saveConfigImpl: async (c) => { saved = c; } },
    );
    expect(saved!.requireFeatures).toEqual([]);
    expect(saved!.maxResolution).toBeUndefined();
  });

  it("rejects a body with no action", async () => {
    expect((await post({})).status).toBe(400);
  });

  it("rejects a body whose preferences is not an object", async () => {
    expect((await post({ action: "set", preferences: [] })).status).toBe(400);
  });

  it("re-reads config so a concurrent change to another field is not clobbered", async () => {
    let saved: Config | null = null;
    await post(
      { action: "set", preferences: { maxResolution: "720p", require: [], exclude: [] } },
      {
        // Simulates the TUI having added a saved search since the page loaded.
        loadConfigImpl: async () => searchConfig({ savedSearches: ["kestrel"] }),
        saveConfigImpl: async (c) => { saved = c; },
      },
    );
    expect(saved!.savedSearches).toEqual(["kestrel"]);
  });
});

describe("preferences round trip", () => {
  // The write path sanitises with `sanitiseQualityPrefs` and the read path
  // projects with `qualityPrefsFrom` — two different functions doing
  // overlapping validation. This is the only test that makes them agree on the
  // same config object rather than on two independently-stubbed ones.
  it("what POST stores is what GET reports", async () => {
    let saved: Config | null = null;
    const written = await handleWebApi(
      deps({ loadConfigImpl: async () => searchConfig(), saveConfigImpl: async (c) => { saved = c; } }),
      "POST", "/api/preferences", new URLSearchParams(), AUTH,
      JSON.stringify({ action: "set", preferences: { maxResolution: "1080p", require: ["atmos"], exclude: ["dv"] } }),
    );
    const read = await handleWebApi(
      deps({ loadConfigImpl: async () => saved! }),
      "GET", "/api/sources", new URLSearchParams(), AUTH, "",
    );
    expect((read.json as SourcesResponse).preferences)
      .toEqual((written.json as PreferencesResponse).preferences);
  });
});

describe("GET /api/sources preferences", () => {
  it("reports the stored preference", async () => {
    const res = await handleWebApi(
      deps({ loadConfigImpl: async () => searchConfig({ maxResolution: "720p", requireFeatures: ["hdr"] }) }),
      "GET", "/api/sources", new URLSearchParams(), AUTH, "",
    );
    expect((res.json as SourcesResponse).preferences).toEqual({
      maxResolution: "720p", require: ["hdr"], exclude: [],
    });
  });
});

describe("GET /api/title medium", () => {
  it("echoes the medium OMDb reported", async () => {
    // `titleDeps` and `OK` are this file's existing title-route helpers — read
    // how the neighbouring /api/title tests build their stubs and follow that,
    // returning `type: "movie"` from the stub.
  });
});
```

The `/api/title` case is deliberately left as a description rather than code: that route's tests use their own `titleDeps`/`OK` helpers whose exact shape you must read from the file. Write it in that file's idiom, asserting the medium survives into `PublicTitleMeta`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/web/routes.test.ts -t "preferences"`
Expected: FAIL — 404 for the route, and `preferences` absent from the sources payload.

- [ ] **Step 3: Implement**

In `src/web/wire.ts`:

```ts
import type { FeatureId, MaxResolution } from "../util/releasePick";

/**
 * The viewing preference, over the wire. `maxResolution` is `null` rather than
 * absent so the browser round-trips "no limit" explicitly — the same reason
 * `/api/recommendations` sends `type=all` rather than omitting it.
 */
export interface PublicQualityPrefs {
  maxResolution: MaxResolution | null;
  require: FeatureId[];
  exclude: FeatureId[];
}

export interface PreferencesRequest {
  action: "set";
  preferences: PublicQualityPrefs;
}

export interface PreferencesResponse {
  preferences: PublicQualityPrefs;
}
```

Add `preferences: PublicQualityPrefs;` to the `/api/sources` response interface.

In `src/web/routes.ts`, add a converter and the action:

```ts
function toPublicQualityPrefs(config: Config): PublicQualityPrefs {
  const prefs = qualityPrefsFrom(config);
  return {
    maxResolution: prefs.maxResolution ?? null,
    require: [...prefs.require],
    exclude: [...prefs.exclude],
  };
}

async function preferencesAction(deps: WebDeps, bodyText: string): Promise<WebResponse> {
  const body = parseObjectBody(bodyText);
  if (!body) return { status: 400, json: { error: "invalid JSON body" } };
  if (body.action !== "set") return { status: 400, json: { error: "invalid action" } };

  const raw = body.preferences;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: 400, json: { error: "missing preferences" } };
  }
  const incoming = raw as Record<string, unknown>;

  // Sanitised with the same helper `loadConfig` uses, so a value the browser
  // sends can never be stored in a form the terminal would reject.
  const clean = sanitiseQualityPrefs({
    maxResolution: incoming.maxResolution,
    requireFeatures: incoming.require,
    excludeFeatures: incoming.exclude,
  });

  // Re-read, per routes.ts:799-805: `serve --web` is a separate process from
  // any TUI, so writing back a snapshot would revert the user's other edits.
  const config = await (deps.loadConfigImpl ?? loadConfig)();
  const next: Config = {
    ...config,
    maxResolution: clean.maxResolution,
    requireFeatures: clean.requireFeatures,
    excludeFeatures: clean.excludeFeatures,
  };
  await (deps.saveConfigImpl ?? saveConfig)(next);

  const out: PreferencesResponse = { preferences: toPublicQualityPrefs(next) };
  return { status: 200, json: out };
}
```

Add `preferences: toPublicQualityPrefs(config)` to the `/api/sources` handler's response object, and register the route beside the other POSTs (~`:1473`):

```ts
  if (method === "POST" && urlPath === "/api/preferences") {
    return preferencesAction(deps, bodyText);
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/web/routes.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/wire.ts src/web/routes.ts src/web/routes.test.ts
git commit -m "feat: read and write the quality preference over the web API"
```

---

### Task 13: Web — the `pickModel` decision module

Every decision about what to show and what to send lives here. `app.ts` is DOM wiring only — a conditional in `app.ts` that decides *what to show* or *what to send* has been caught in review twice.

**Files:**
- Create: `src/web/static/pickModel.ts`
- Test: `src/web/static/pickModel.test.ts`

**Interfaces:**
- Consumes: `pickBestRelease`, `pickStatusLine`, `PickIntent`, `QualityPrefs` from `src/util/releasePick.ts`; `PublicQualityPrefs`, `PublicStreamHistoryItem`, `PublicRecommendation` from `src/web/wire.ts`.
- Produces:
  - `function prefsFromWire(p: PublicQualityPrefs): QualityPrefs`
  - `function prefsToWire(p: QualityPrefs): PublicQualityPrefs`
  - `function intentForHistoryRow(item: PublicStreamHistoryItem): PickIntent | null`
  - Nothing for the film rule — **`autoPlayableFilm` is re-exported from `src/util/autoPlayableFilm.ts`, not reimplemented.** See the note under Task 7c.
  - `type PickPhase = { kind: "idle" } | { kind: "searching"; title: string } | { kind: "playing"; note: string } | { kind: "none"; title: string }`
  - `function createPickController(fx: PickEffects): PickController`

- [ ] **Step 1: Write the failing test**

Create `src/web/static/pickModel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { prefsFromWire, prefsToWire, intentForHistoryRow } from "./pickModel";
import type { PublicStreamHistoryItem } from "../wire";

const row = (over: Partial<PublicStreamHistoryItem>): PublicStreamHistoryItem => ({
  key: "k", title: "Kepler", rawName: "Kepler.S02E04.1080p.WEB-DL",
  infoHash: "abc", startedAt: 0, next: { season: 2, episode: 5 }, ...over,
});

describe("prefs round-trip", () => {
  it("maps null to absent and back", () => {
    expect(prefsFromWire({ maxResolution: null, require: [], exclude: [] }))
      .toEqual({ require: [], exclude: [] });
    expect(prefsToWire({ require: [], exclude: [] }))
      .toEqual({ maxResolution: null, require: [], exclude: [] });
  });

  it("carries a cap and features through unchanged", () => {
    const wire = { maxResolution: "1080p" as const, require: ["atmos" as const], exclude: ["dv" as const] };
    expect(prefsToWire(prefsFromWire(wire))).toEqual(wire);
  });
});

describe("intentForHistoryRow", () => {
  it("builds an episode intent from next", () => {
    expect(intentForHistoryRow(row({}))).toEqual({ kind: "episode", season: 2, episode: 5 });
  });

  it("returns null when there is no honest next episode", () => {
    // A film, and a series watched via a season pack, both send next: null.
    expect(intentForHistoryRow(row({ next: null }))).toBeNull();
  });
});

// `autoPlayableFilm` is NOT tested again here — it lives in
// `src/util/autoPlayableFilm.ts` and is covered by its own tests (Task 7c). This
// module only re-exports it so callers in this directory have one import site.
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/web/static/pickModel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/web/static/pickModel.ts` with the four pure functions above, plus a `createPickController` following `createReccController`'s shape (`reccModel.ts:129-198`): closure-held state, an `fx.render(state)` call, and a monotonic counter so a slow search that resolves after a newer one is discarded.

```ts
import {
  pickBestRelease, pickStatusLine,
  type PickIntent, type QualityPrefs,
} from "../../util/releasePick";
import type { PublicQualityPrefs, PublicStreamHistoryItem } from "../wire";

export function prefsFromWire(p: PublicQualityPrefs): QualityPrefs {
  const out: QualityPrefs = { require: [...p.require], exclude: [...p.exclude] };
  return p.maxResolution ? { ...out, maxResolution: p.maxResolution } : out;
}

export function prefsToWire(p: QualityPrefs): PublicQualityPrefs {
  return { maxResolution: p.maxResolution ?? null, require: [...p.require], exclude: [...p.exclude] };
}

/**
 * The episode a Continue Watching row is up to, or null when there is nothing
 * honest to offer. `next` is computed server-side by `nextEpisode`
 * (routes.ts:824) and is null for a film AND for a series watched via a season
 * pack. The browser must NOT import `src/core/streamHistory.ts` to recompute
 * it — that pulls in `node:fs` and breaks the bundle (see savedModel.ts:285).
 */
export function intentForHistoryRow(item: PublicStreamHistoryItem): PickIntent | null {
  return item.next ? { kind: "episode", season: item.next.season, episode: item.next.episode } : null;
}

// The film rule lives in `src/util/releasePick.ts` (Task 7c) because both
// front ends need it and `src/web` may not import `src/ui`. Re-export it so
// callers in this directory have one import site:
export { autoPlayableFilm } from "../../util/autoPlayableFilm";
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/web/static/pickModel.test.ts && npm run build`
Expected: PASS, and the build confirms no `node:*` reached the bundle.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/pickModel.ts src/web/static/pickModel.test.ts
git commit -m "feat: pure decision module for web auto-play"
```

---

### Task 14: Web — the header disclosure and DOM wiring

**Files:**
- Modify: `src/web/static/index.html` — a `<details>` block after `</header>` (~`:31`)
- Modify: `src/web/static/app.ts` — bind the controls, add the play buttons
- Modify: `src/web/static/styles.css`

**Interfaces:**
- Consumes: everything from Task 13, and `POST /api/preferences` from Task 12.
- Produces: no new exports. **All logic stays in `pickModel.ts`.**

**Why the header and not a pane:** the preference affects For You *and* Continue Watching, and Continue Watching lives under *saved*. A block inside one pane would be invisible from the other and would read as a per-pane setting. A fifth nav tab is ruled out by the comment at `index.html:20` — five tabs is where the nav stops working on a phone.

- [ ] **Step 1: Add the markup**

After `</header>` in `index.html`:

```html
    <!-- Playback preference. Outside every pane on purpose: it changes what
         Play does on For You AND on the Continue Watching rows under Saved, so
         it belongs to neither. A fifth nav tab is not an option — see the note
         on #views above. Checkbox rows are built by app.ts from FEATURES, so
         the terminal and the browser cannot drift apart. -->
    <details id="prefs" class="card prefs">
      <summary>playback preferences</summary>
      <label class="control" for="pref-res">
        <span>max resolution</span>
        <select id="pref-res">
          <option value="" selected>no limit</option>
          <option value="2160p">2160p</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
        </select>
      </label>
      <div id="pref-features" class="pref-features"></div>
      <p class="hint">With nothing set, the best resolution available wins — then the largest file.</p>
    </details>
```

- [ ] **Step 2: Wire it in `app.ts`**

Read the initial value from the `preferences` field of `GET /api/sources`, which the client already fetches at boot. Build the rows with `createElement` + `textContent` — never `innerHTML`. The labels are ours, but the rule is absolute in this directory and there is no lint rule to catch a violation.

```ts
import { FEATURE_IDS, FEATURES } from "../../util/releasePick";
import { prefsFromWire, prefsToWire } from "./pickModel";
import type { PublicQualityPrefs, PreferencesResponse } from "../wire";

// Off -> require -> exclude -> off, matching the terminal's three-state cell.
// One control per feature rather than two checkbox lists, so a feature cannot
// be required and excluded at the same time.
const NEXT_STATE = { off: "require", require: "exclude", exclude: "off" } as const;
const MARK = { off: "·", require: "✓", exclude: "✗" } as const;
type FeatureState = keyof typeof NEXT_STATE;

let prefs: PublicQualityPrefs = { maxResolution: null, require: [], exclude: [] };

function stateOf(id: (typeof FEATURE_IDS)[number]): FeatureState {
  if (prefs.exclude.includes(id)) return "exclude";
  if (prefs.require.includes(id)) return "require";
  return "off";
}

async function savePrefs(next: PublicQualityPrefs): Promise<void> {
  const res = await api("/api/preferences", {
    method: "POST",
    body: JSON.stringify({ action: "set", preferences: next }),
  });
  // Trust the server's echo, not the local guess: it re-reads and sanitises,
  // so an id this build sent but the server rejected must not linger in the UI.
  prefs = ((await res.json()) as PreferencesResponse).preferences;
  renderPrefs();
}

function renderPrefs(): void {
  const box = document.getElementById("pref-features")!;
  box.replaceChildren();
  const res = document.getElementById("pref-res") as HTMLSelectElement;
  res.value = prefs.maxResolution ?? "";
  for (const id of FEATURE_IDS) {
    const state = stateOf(id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pref-feature";
    btn.dataset.state = state;
    btn.textContent = `${MARK[state]} ${FEATURES[id].label}`;
    btn.setAttribute("aria-label", `${FEATURES[id].label}: ${state}`);
    btn.addEventListener("click", () => {
      const next = NEXT_STATE[state];
      void savePrefs({
        maxResolution: prefs.maxResolution,
        require: next === "require" ? [...prefs.require, id] : prefs.require.filter((x) => x !== id),
        exclude: next === "exclude" ? [...prefs.exclude, id] : prefs.exclude.filter((x) => x !== id),
      });
    });
    box.appendChild(btn);
  }
}

document.getElementById("pref-res")!.addEventListener("change", (e) => {
  const value = (e.target as HTMLSelectElement).value;
  void savePrefs({ ...prefs, maxResolution: (value || null) as PublicQualityPrefs["maxResolution"] });
});
```

`api(...)` is whatever authenticated fetch helper `app.ts` already uses — reuse it, do not add a second one. `prefsFromWire`/`prefsToWire` are needed where a pick is actually made (Step 3), not here.

- [ ] **Step 3: Add the play buttons**

Gate both on `pickModel`, never on a conditional written inline here.

```ts
// For You card. The whole decision is `autoPlayableFilm` in pickModel — this
// function only looks up its two inputs and builds a node. A conditional here
// that decided what to show would be the thing review has caught twice.
//
// `medium` is whatever `fetchReccPoster` already learned for this card, or
// `undefined` when it has not resolved (see below) — never a fresh request.
function addReccPlay(card: HTMLElement, item: PublicRecommendation, medium: ReccMedium | undefined, filter: ReccType): void {
  if (!autoPlayableFilm(medium, filter)) return;
  const play = document.createElement("button");
  play.type = "button";
  play.textContent = "Play";
  play.addEventListener("click", () => void autoPlay(item.title, { kind: "film" }));
  card.appendChild(play);
}

// Continue Watching row. Null intent means a film or a season pack: there is
// no honest next episode, so no Play button and the resume action stands alone.
function addHistoryPlay(row: HTMLElement, item: PublicStreamHistoryItem): void {
  const intent = intentForHistoryRow(item);
  if (!intent) return;
  const play = document.createElement("button");
  play.type = "button";
  play.textContent = "Play next";
  play.addEventListener("click", () => void autoPlay(item.title, intent, () => resume(item)));
  row.prepend(play);
}
```

`autoPlay(title, intent, fallback?)` searches via the existing search path, calls `pickBestRelease(results, prefsFromWire(prefs), intent)`, shows `pickStatusLine(pick, prefs.maxResolution ?? undefined)`, and hands the winner to `streamFlow.ts` unchanged — passing `intent` on when `pick.fromPack` is true so the file inside the pack is selected. `resume(item)` is the existing continue-watching action.

**There is no `posterMetaFor` helper, and you must not build a metadata cache to create one.** Verified: recc cards get their metadata from `fetchReccPoster(imdbId)` (`app.ts:1415`), which fetches `/api/title?imdb=…`, reads `PublicTitleMeta`, uses `posterUrl`, and **discards the rest of the response**. `resultPosters.ts`'s cache is keyed by *release name* and serves search results, not recc cards — it is the wrong structure and the wrong key.

So the minimal, correct change: have `fetchReccPoster` carry `meta.type` out alongside its existing outcome, and hand it to `addReccPlay` when the card paints. Task 12 already added `type` to `PublicTitleMeta`, so the field is on the response — this task only reads it, and must not touch `wire.ts` or `routes.ts`.

**A sibling field, not a fourth variant.** `ReccPosterOutcome` (`src/web/static/reccModel.ts:372`) is a three-way union — `{kind:"poster",url}` | `{kind:"no-key"}` | `{kind:"none"}` — and it describes *what happened to the artwork*. The medium is orthogonal: a title with no poster still has a type, and a `no-key` response has neither. Adding `medium` to each variant, or a fourth variant, would conflate two independent facts. Widen the return instead:

```ts
async function fetchReccPoster(imdbId: string): Promise<{
  poster: ReccPosterOutcome;
  medium: ReccMedium | null;
}>
```

`medium` is `null` on every early return (`!metaRes.ok`, `no-key`, a thrown fetch) — those genuinely learned nothing — and `meta.type ?? null` once the response parsed. Update the call sites, which currently destructure the outcome directly.

`ReccMedium` comes from `src/util/autoPlayableFilm.ts`. `reccPosterNote` and `reccPosterHint` still take a plain `ReccPosterOutcome` and must not change.

**Import `autoPlayableFilm` from `./pickModel`, not from `src/util/autoPlayableFilm.ts` directly.** Task 13 re-exports it there precisely so every pick-related decision this file needs — `prefsFromWire`, `prefsToWire`, `intentForHistoryRow`, `autoPlayableFilm` — arrives from one module. Importing around the re-export would leave it dead code for a reviewer to flag.

**Before that fetch resolves, pass `undefined`.** `autoPlayableFilm` falls back to the filter, exactly as the terminal does with its debounce race. Never block a click on a network round trip, and do not add a synchronous cache just so the button can render a moment earlier — a Play button that appears when the poster does is fine.

- [ ] **Step 4: Style it**

Add `.prefs` and `.pref-features` rules to `styles.css`, following the existing `.controls` / `.control` patterns. Confirm both light and dark render, and that the block does not overflow horizontally on a narrow viewport.

- [ ] **Step 5: Run it and check by hand**

**Build first, or you will be testing the old bundle.** `README.md:296` warns that the dashboard is served from `dist/web`, **not** `src` — edit `src/web/static/` and reload without rebuilding and you get silently stale assets that read exactly like a browser cache bug. So:

```bash
npm run build && npm run dev -- serve --web
```

Rebuild after every change you want to see. If a check below appears to fail, rebuild and retry before concluding anything — and if a check appears to *pass* on a stale bundle, that is a false positive, which is worse.

There is no jsdom, deliberately — wiring is verified by running it. Check:
- The disclosure opens; changing the resolution persists across a reload.
- A feature cell cycles off → require → exclude → off, and the change survives a reload.
- A For You **film** card shows Play; a **show** card does not. With an OMDb key this is right on the default "all" filter; without one, only after switching the filter to films.
- A Continue Watching row with a next episode shows Play; a film row does not.
- A pick that relaxed a requirement shows the note from `pickStatusLine`.

- [ ] **Step 6: Run the full check**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/static/index.html src/web/static/app.ts src/web/static/styles.css
git commit -m "feat: playback preferences and play buttons in the browser UI"
```

---

### Task 15: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: the web UI's own limitations list (find it in `README.md` or `index.html` and confirm it is still true now that the browser can edit this setting)

- [ ] **Step 1: Document the preference**

Cover: what the three settings do; that with nothing set the best resolution available wins, then the largest file; that Enter/Play works on For You **films** and on Continue Watching rows with a next episode, with shows waiting on the episode picker; and the season-pack consequence — **watching one episode can fetch a whole season**, because resolution outranks the episode-versus-pack preference, with `maxResolution` as the lever.

- [ ] **Step 2: Correct two README claims this feature falsifies**

Both are in the web UI's limitations list and both are now wrong. Located and verified:

- **`README.md:291`** — "**No subtitles, no scrubber, no automatic next-episode playback.** Continue watching (above) remembers *what* you were watching and, when it can, names what's next…". Continue Watching's Enter now *does* automatically play the next episode. Rewrite this bullet so it still covers subtitles and the scrubber but no longer denies next-episode playback; say what it actually does now.
- **`README.md:292`** — "**No settings UI.** Tokens, sources, limits and folders are set in the TUI only — the browser reads that config but has no page for it. It does write three things: your saved searches, your library, …". The browser now has a settings control (the header disclosure) and writes a **fourth** thing: the playback preference. Update both halves of that sentence — the count and the "no page for it" claim.

Re-read the surrounding bullets before editing so the corrected ones keep the list's voice.

- [ ] **Step 3: Run everything**

```bash
npm test && npm run typecheck && npm run lint && npm run build && npm run previews
```

Expected: all pass, with only the known `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx`.

- [ ] **Step 4: Check for stale fixture references**

The rename traps in `CLAUDE.md` apply to any new test. Confirm no new test asserts on a substring of a fixture name that a later rename would silently break, and that every `not.toContain` added still names something the test actually puts in play.

```bash
grep -rn "not.toContain\|not.toBe(" src/util/releasePick.test.ts src/web/static/pickModel.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe the quality preference and one-click play"
```

---

## Self-Review

**Spec coverage.** OMDb medium → Task 7b. Config fields and sanitisation → Task 5. The feature table → Task 2. `rankReleases`/`pickBestRelease` and the eight ranking steps → Tasks 3–4. Over-cap ascending → Task 4. Status copy → Task 7. Terminal For You → Task 8. Terminal Continue Watching → Task 9. Keymap both halves → Task 10. Terminal settings → Task 11. Web wire and routes → Task 12. Web pure module → Task 13. Web DOM → Task 14. README and limitations → Task 15. Every test case listed in the spec's Testing section appears in Tasks 2–5 and 12–13.

**Two deliberate deviations from the spec, both recorded at the task that makes them:**

1. **Task 2** — the spec implies an enum `Resolution` shared by the cap and the ranking. Verified parser output makes that wrong: it emits `"4k"` (for both `4K` and `UHD`), `"1080i"` and `"576p"`, and does not recognise `8K`/`2K`. `resolutionHeight()` is used instead, and `MaxResolution` stays a closed set only because it is a user-facing choice.
2. **Task 12** — the spec says `PUT /api/preferences`. This codebase has no `PUT` routes; every mutation is `POST` with an `action` discriminator. Follow the codebase.

**One thing the spec left undefined, decided here:** it referred to a "web settings pane", which does not exist. Task 14 puts the controls in a header `<details>` block, because the preference affects two panes and `index.html:20` rules out a fifth nav tab.

**One thing the code decided, not the spec:** For You's type filter starts at `"all"` (`useRecommendations.ts:38`) and reccd sends no per-item type, so gating auto-play on the filter alone would mean Enter plays nothing until the user presses `t`. Task 7b surfaces OMDb's `Type` — which `omdb.ts` requests but never parses — so a film is recognised per item, with the filter as the fallback when there is no OMDb key. The spec's "For You, film" row therefore means "OMDb says film, or the filter is explicitly films".

**Known soft spots.** Three steps are not literal, all for the same reason — the existing call sites were not read while writing this plan:

1. **Task 6 Step 5** names `searchAllSources` and `startStream` as placeholders for whatever `App.tsx` already uses. It is 96 KB; find the real entry points rather than adding new paths.
2. **Task 8 Step 3** assumes `useTitlePreview` can surface Task 7b's `type` for the highlighted row. If it cannot cheaply, pass `undefined` and let the filter fallback handle it — never block Enter on a network call.
3. **Task 14 Step 3** assumes something in `resultPosters.ts` / `previewModel.ts` exposes fetched title metadata per `imdbId`. If it carries no `type`, thread it through `/api/title` the same way.

None of the three change a decision; each is a lookup the implementer must do.
