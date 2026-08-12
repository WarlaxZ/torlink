# Adult-result detail pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an adult ("Porn" group) result is highlighted, show a detail pane with the full untruncated release name plus a parsed breakdown (studio, year, resolution, source, codec, group) — built from local data, no network lookup — in both the TUI and the web UI.

**Architecture:** A new pure `src/util/releaseBreakdown.ts` turns a release name into ordered breakdown fields and a one-line summary, reusing the existing `parseRelease` wrapper over `parse-torrent-title` plus a best-effort `[bracket]` studio heuristic. Both front ends gain a *local* preview path that renders from that summary without calling OMDb. The existing OMDb gate (`previewApplies` / `previewSection`) is left meaning "OMDb applies", so adult cards still fetch no posters; a new sibling predicate (`adultPreviewApplies` / an `adultSection` flag) switches on the local pane.

**Tech Stack:** TypeScript, Vitest, `parse-torrent-title`; web bundle is `src/web/static` (no `node:*`); TUI is Ink + React under `src/ui`.

## Global Constraints

- **Feature ships in BOTH front ends in this change** (`CLAUDE.md`): TUI (`src/ui`) and web (`src/web/static`). This is a non-secret, user-facing behaviour, so it is not TUI-only.
- **`src/web` must not import from `src/ui`; `src/util` imports from neither.** The shared breakdown logic lives in `src/util/`.
- **No `innerHTML`/`insertAdjacentHTML`/`outerHTML`/`document.write` in `src/web/static`.** Release names are strangers' strings — every node is `createElement` + `textContent`. (The web preview elements already exist; we only set `.textContent`.)
- **No real titles/studios/performers in any fixture, doc, or copy.** Reuse the `CLAUDE.md` cast words in adult-release *shapes* and use INVENTED studio names (e.g. `Meridian Studios`). Never a real brand.
- **`src/web/static/app.ts` is DOM wiring only** — any "what to show / what to send" decision lives in a pure module with tests.
- **Config writes are not involved** — this feature reads only. No `loadConfig`/`saveConfig`.
- **Before done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all pass (the one pre-existing `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx` is allowed to remain). `npm run build` is the check that `src/web/static` pulls in no `node:*`.

---

### Task 1: Expose `source` and `group` on `ParsedRelease`

`parseRelease` today returns resolution/codec/year but not the release's *source* (WEB-DL/BluRay) or *group* — both of which `parse-torrent-title` already parses and the breakdown needs. Add them, so the breakdown consumes the single ptt wrapper rather than re-parsing (the codebase's copy-then-drift rule).

**Files:**
- Modify: `src/util/release.ts` (interface `ParsedRelease` ~lines 26-33; population block ~lines 110-114)
- Test: `src/util/release.test.ts` (append to `describe("parseRelease quality fields")`)

**Interfaces:**
- Produces: `ParsedRelease.source?: string` (raw parser vocabulary, e.g. `"web-dl"`, `"bluray"`), `ParsedRelease.group?: string` (e.g. `"GROUP"`, `"P2P"`).

- [ ] **Step 1: Write the failing test**

Append to `src/util/release.test.ts`:

```ts
describe("parseRelease source and group", () => {
  it("exposes the source and release group when the name states them", () => {
    const p = parseRelease("Ashfall.1999.1080p.WEB-DL.x264-GROUP");
    expect(p?.source).toBe("web-dl");
    expect(p?.group).toBe("GROUP");
  });

  it("leaves source and group undefined when the name states none", () => {
    const p = parseRelease("Ashfall.1999.1080p");
    expect(p?.source).toBeUndefined();
    expect(p?.group).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/util/release.test.ts -t "source and group"`
Expected: FAIL (`source`/`group` are `undefined` / not on the type).

- [ ] **Step 3: Add the fields**

In `src/util/release.ts`, add to the `ParsedRelease` interface (after `remux?: boolean;`):

```ts
  /** Raw parser vocabulary for the medium the release came from ("web-dl", "bluray", …). */
  source?: string;
  /** The release group / P2P tag, as the parser read it ("GROUP", "P2P"). */
  group?: string;
```

In `parseRelease`, after the `if (p.remux === true) result.remux = true;` line:

```ts
  if (typeof p.source === "string") result.source = p.source;
  if (typeof p.group === "string") result.group = p.group;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/util/release.test.ts`
Expected: PASS (existing cases still green).

- [ ] **Step 5: Commit**

```bash
git add src/util/release.ts src/util/release.test.ts
git commit -m "feat(release): expose source and group on ParsedRelease"
```

---

### Task 2: `releaseBreakdown` pure module

The shared, tested core: name → ordered breakdown fields → one-line summary, plus the best-effort studio heuristic. Lives in `src/util/` so both front ends import it.

**Files:**
- Create: `src/util/releaseBreakdown.ts`
- Test: `src/util/releaseBreakdown.test.ts`

**Interfaces:**
- Consumes: `parseRelease` (Task 1) for year/resolution/source/codec/group.
- Produces:
  - `interface BreakdownField { label: string; value: string; }`
  - `studioFromName(name: string): string | undefined` — first `[bracket]`, trailing year stripped; `undefined` when no bracket.
  - `releaseBreakdown(name: string): BreakdownField[]` — ordered Studio, Year, Resolution, Source, Codec, Group; empties dropped.
  - `breakdownSummary(name: string): string` — the fields joined `label: value` by ` · `, or a fallback sentence when there are none.

- [ ] **Step 1: Write the failing test**

Create `src/util/releaseBreakdown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { studioFromName, releaseBreakdown, breakdownSummary } from "./releaseBreakdown";

describe("studioFromName", () => {
  it("takes the first bracketed segment and strips a trailing year", () => {
    expect(studioFromName("Kestrel [Meridian Studios 2026] XXX WEB-DL 1080p")).toBe("Meridian Studios");
  });
  it("returns the bracket as-is when it carries no year", () => {
    expect(studioFromName("Kestrel [Vantage Media] 1080p")).toBe("Vantage Media");
  });
  it("returns undefined when there is no bracket", () => {
    expect(studioFromName("Ashfall.1999.1080p.WEB-DL.x264-GROUP")).toBeUndefined();
  });
});

describe("releaseBreakdown", () => {
  it("builds ordered fields from a bracketed adult release", () => {
    const f = releaseBreakdown("Kestrel [Meridian Studios 2026] XXX WEB-DL 1080p SPLIT SCENES MP4-P2P");
    expect(f).toEqual([
      { label: "Studio", value: "Meridian Studios" },
      { label: "Year", value: "2026" },
      { label: "Resolution", value: "1080p" },
      { label: "Source", value: "WEB-DL" },
      { label: "Group", value: "P2P" },
    ]);
  });
  it("includes codec and omits an absent studio", () => {
    const f = releaseBreakdown("Ashfall.1999.1080p.WEB-DL.x264-GROUP");
    expect(f).toEqual([
      { label: "Year", value: "1999" },
      { label: "Resolution", value: "1080p" },
      { label: "Source", value: "WEB-DL" },
      { label: "Codec", value: "x264" },
      { label: "Group", value: "GROUP" },
    ]);
  });
  it("returns no fields when the name carries nothing parseable beyond a bare word", () => {
    expect(releaseBreakdown("Ashfall")).toEqual([]);
  });
});

describe("breakdownSummary", () => {
  it("joins the fields with a middot", () => {
    expect(breakdownSummary("Ashfall.1999.1080p.WEB-DL.x264-GROUP")).toBe(
      "Year: 1999 · Resolution: 1080p · Source: WEB-DL · Codec: x264 · Group: GROUP",
    );
  });
  it("falls back to an honest sentence when there are no fields", () => {
    expect(breakdownSummary("Ashfall")).toBe("No further details in the release name.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/util/releaseBreakdown.test.ts`
Expected: FAIL ("Failed to resolve import './releaseBreakdown'").

- [ ] **Step 3: Write the implementation**

Create `src/util/releaseBreakdown.ts`:

```ts
// A human-readable breakdown of a torrent release name, for surfaces that have
// no richer metadata than the name itself — chiefly the adult ("Porn") group,
// which OMDb cannot describe. Reuses parseRelease (the one wrapper over
// parse-torrent-title) so "source"/"codec"/"group" mean exactly what they mean
// on a result-row badge, and adds a best-effort studio the parser can't give.
//
// Bundled for the browser: no node:* imports.
import { parseRelease } from "./release";

export interface BreakdownField {
  label: string;
  value: string;
}

/**
 * The studio/site, guessed from the first `[bracket]` — the shape adult
 * releases use ("[Meridian Studios 2026]"). Best-effort by design: a trailing
 * year is stripped, and a name with no bracket yields `undefined` rather than a
 * wrong guess from, say, a leading word that might be the title.
 */
export function studioFromName(name: string): string | undefined {
  const m = name.match(/\[([^\]]+)\]/);
  if (!m) return undefined;
  const studio = m[1].replace(/\s*\b(?:19|20)\d{2}\b\s*$/, "").trim();
  return studio === "" ? undefined : studio;
}

/**
 * Ordered breakdown fields. Empty fields are dropped, so the pane never renders
 * a blank row. Order is fixed: identity (studio, year) before quality
 * (resolution, source, codec) before provenance (group).
 */
export function releaseBreakdown(name: string): BreakdownField[] {
  const parsed = parseRelease(name);
  const fields: BreakdownField[] = [];
  const studio = studioFromName(name);
  if (studio) fields.push({ label: "Studio", value: studio });
  if (parsed?.year) fields.push({ label: "Year", value: String(parsed.year) });
  if (parsed?.resolution) fields.push({ label: "Resolution", value: parsed.resolution });
  if (parsed?.source) fields.push({ label: "Source", value: parsed.source.toUpperCase() });
  if (parsed?.codec) fields.push({ label: "Codec", value: parsed.codec });
  if (parsed?.group) fields.push({ label: "Group", value: parsed.group });
  return fields;
}

/** The breakdown as one line, or an honest sentence when the name says nothing. */
export function breakdownSummary(name: string): string {
  const text = releaseBreakdown(name)
    .map((f) => `${f.label}: ${f.value}`)
    .join(" · ");
  return text || "No further details in the release name.";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/util/releaseBreakdown.test.ts`
Expected: PASS. If a `Source`/`Group` value differs from the expectation, print `parse('<name>')` in a scratch node REPL to confirm the parser's exact output and adjust the *test expectation* to match the parser (the parser is the source of truth), not the other way round.

- [ ] **Step 5: Commit**

```bash
git add src/util/releaseBreakdown.ts src/util/releaseBreakdown.test.ts
git commit -m "feat(util): releaseBreakdown for name-only result details"
```

---

### Task 3: `adultPreviewApplies` predicate (web)

The sibling of `previewApplies`, kept separate so widening the local pane never widens the OMDb poster/title fetch.

**Files:**
- Modify: `src/web/static/searchModel.ts` (after `previewApplies`, ~line 557)
- Test: `src/web/static/searchModel.test.ts` (near the existing `previewApplies` tests)

**Interfaces:**
- Produces: `adultPreviewApplies(group: string): boolean` — `true` only for `"Porn"`.

- [ ] **Step 1: Write the failing test**

Add to `src/web/static/searchModel.test.ts` (find the existing `previewApplies` describe block and add alongside it; if none, add a new block near the other pure-predicate tests). First add `adultPreviewApplies` to the existing import from `./searchModel`.

```ts
describe("adultPreviewApplies", () => {
  it("is true only for the adult group", () => {
    expect(adultPreviewApplies("Porn")).toBe(true);
    expect(adultPreviewApplies("Movies")).toBe(false);
    expect(adultPreviewApplies("All")).toBe(false);
  });
  it("never overlaps previewApplies (OMDb vs local are exclusive)", () => {
    for (const g of ["All", "Movies", "TV", "Anime", "Porn", "Games"]) {
      expect(previewApplies(g) && adultPreviewApplies(g)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/static/searchModel.test.ts -t adultPreviewApplies`
Expected: FAIL (`adultPreviewApplies` is not exported).

- [ ] **Step 3: Implement**

In `src/web/static/searchModel.ts`, directly after the `previewApplies` function:

```ts
/**
 * Whether a group gets the LOCAL detail pane instead of the OMDb one.
 *
 * The adult ("Porn") group has no OMDb metadata, so its pane is built entirely
 * from the result row — the full release name and a parsed breakdown, no lookup.
 * Deliberately disjoint from `previewApplies`: widening the local pane must never
 * widen the OMDb poster/title fetch (`postersApply` stays gated on
 * `previewApplies` alone).
 */
export function adultPreviewApplies(group: string): boolean {
  return group === "Porn";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/web/static/searchModel.test.ts -t adultPreviewApplies`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/searchModel.ts src/web/static/searchModel.test.ts
git commit -m "feat(web): adultPreviewApplies predicate for the local pane"
```

---

### Task 4: Local preview in the controller (`previewModel.ts`)

Add `localPreviewCopy`, a `"local"` `PreviewState`, and a `selectLocal` controller method that renders from the name with no fetch, no timer.

**Files:**
- Modify: `src/web/static/previewModel.ts` (the `PreviewState` union ~lines 34-40; the `PreviewController` interface ~lines 58-66; `createPreviewController` ~lines 92-164; add `localPreviewCopy` near `previewCopy`)
- Test: `src/web/static/previewModel.test.ts`

**Interfaces:**
- Consumes: `breakdownSummary` (Task 2); `PreviewCopy` (existing).
- Produces:
  - `PreviewState` gains `| { kind: "local"; release: string; copy: PreviewCopy }`.
  - `PreviewController` gains `selectLocal(release: string | null, group: string): void`.
  - `localPreviewCopy(name: string): PreviewCopy` — `heading` = full name, `sub` = `""`, `body` = `breakdownSummary(name)`, `imdbUrl`/`posterUrl` = `null`, `posterNote` = `"Adult content"`.

- [ ] **Step 1: Write the failing test**

Add to `src/web/static/previewModel.test.ts` (extend the import to include `localPreviewCopy`):

```ts
describe("localPreviewCopy", () => {
  it("uses the full name as the heading and a breakdown as the body, no poster/imdb", () => {
    const copy = localPreviewCopy("Kestrel [Meridian Studios 2026] XXX WEB-DL 1080p MP4-P2P");
    expect(copy.heading).toBe("Kestrel [Meridian Studios 2026] XXX WEB-DL 1080p MP4-P2P");
    expect(copy.body).toContain("Studio: Meridian Studios");
    expect(copy.posterUrl).toBeNull();
    expect(copy.imdbUrl).toBeNull();
  });
});

describe("selectLocal", () => {
  it("renders a local state synchronously and never fetches", () => {
    const { controller, rendered, asked } = harness();
    controller.selectLocal("Ashfall.1999.1080p.WEB-DL.x264-GROUP", "Porn");
    expect(asked).toEqual([]); // no OMDb request scheduled or sent
    const last = rendered[rendered.length - 1];
    expect(last.kind).toBe("local");
    if (last.kind === "local") {
      expect(last.copy.heading).toBe("Ashfall.1999.1080p.WEB-DL.x264-GROUP");
    }
  });

  it("hides the pane when release is null", () => {
    const { controller, rendered } = harness();
    controller.selectLocal(null, "Porn");
    expect(rendered[rendered.length - 1].kind).toBe("hidden");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/static/previewModel.test.ts -t "selectLocal"`
Expected: FAIL (`localPreviewCopy` / `selectLocal` not exported).

- [ ] **Step 3: Implement**

In `src/web/static/previewModel.ts`:

Add the import at the top (next to the existing `parseRelease` import):

```ts
import { breakdownSummary } from "../../util/releaseBreakdown";
```

Extend the `PreviewState` union (after the `"ready"` member):

```ts
  /** Built entirely from the release name — the adult group, which OMDb can't describe. No fetch. */
  | { kind: "local"; release: string; copy: PreviewCopy };
```

Extend the `PreviewController` interface (after `select`):

```ts
  /**
   * Like `select`, but renders a LOCAL pane from the name with no OMDb request —
   * for groups `adultPreviewApplies` covers. Synchronous; `release` null hides.
   */
  selectLocal(release: string | null, group: string): void;
```

Inside `createPreviewController`, add before the `return {` statement:

```ts
  const selectLocal = (release: string | null, group: string): void => {
    if (release === null || release.trim() === "") {
      cancelPending();
      current = null;
      fx.render({ kind: "hidden" });
      return;
    }
    const key = cacheKey(release, group);
    if (key === current) return;
    current = key;
    cancelPending(); // a local selection cancels any in-flight OMDb debounce
    fx.render({ kind: "local", release, copy: localPreviewCopy(release) });
  };
```

Add `selectLocal` to the returned object:

```ts
  return {
    select,
    selectLocal,
    reset(): void {
```

Add `localPreviewCopy` immediately after `previewCopy`:

```ts
/**
 * The pane's text for a result we have no OMDb data for — the adult group. The
 * heading is the FULL release name (the list truncates it; this is where it is
 * shown in full — `.preview-title` wraps), and the body is the parsed breakdown.
 * No poster, no IMDb link: there is nothing to link to and nothing to load.
 */
export function localPreviewCopy(name: string): PreviewCopy {
  return {
    heading: name,
    sub: "",
    body: breakdownSummary(name),
    imdbUrl: null,
    posterUrl: null,
    posterNote: "Adult content",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/web/static/previewModel.test.ts`
Expected: PASS (existing controller tests still green — `selectLocal` shares `current`/`cancelPending` with `select`, so switching between an OMDb row and an adult row still cancels correctly).

- [ ] **Step 5: Commit**

```bash
git add src/web/static/previewModel.ts src/web/static/previewModel.test.ts
git commit -m "feat(web): local (no-lookup) preview copy and selectLocal"
```

---

### Task 5: Wire the local pane into the web app (`app.ts`)

Pure pieces exist; this is DOM wiring only — a render branch and a routing choice among the tested predicates.

**Files:**
- Modify: `src/web/static/app.ts` (`renderPreview` ~lines 3175-3208; `selectResult` ~line 2871; the import of `previewApplies` from `./searchModel`)

**Interfaces:**
- Consumes: `adultPreviewApplies`, `previewApplies` (searchModel); `preview.selectLocal` (Task 4); `PreviewState` `"local"` (Task 4).

- [ ] **Step 1: Add `adultPreviewApplies` to the searchModel import**

Find the existing `import { … previewApplies … } from "./searchModel";` in `app.ts` and add `adultPreviewApplies` to it.

- [ ] **Step 2: Add the `"local"` branch to `renderPreview`**

In `renderPreview`, immediately after the `if (state.kind === "loading") { … return; }` block and before `const copy = previewCopy(state.release, state.meta);`:

```ts
  if (state.kind === "local") {
    const copy = state.copy;
    previewTitle.textContent = copy.heading;
    previewSub.textContent = copy.sub;
    previewBody.textContent = copy.body;
    previewImdb.hidden = true;
    posterPlaceholder(copy.posterNote);
    return;
  }
```

- [ ] **Step 3: Route the selection in `selectResult`**

Replace the single `preview.select(...)` line in `selectResult` with:

```ts
  const group = searchView.group;
  if (previewApplies(group)) {
    preview.select(result.name, group);
  } else if (adultPreviewApplies(group)) {
    preview.selectLocal(result.name, group);
  } else {
    preview.select(null, group);
  }
```

(The filtered-away branch at ~line 2863 and `clearSelection` at ~line 2881 keep calling `preview.select(null, …)` — that hides the pane in either mode, so they need no change.)

- [ ] **Step 4: Typecheck, then verify by running**

Run: `npm run typecheck`
Expected: no errors.

Then run the web UI and confirm by hand (there is no jsdom):

```bash
npm run dev -- serve --web
```

With adult content enabled, open the web UI, run a search on the **Porn** tab, and:
- Highlight a result → the preview pane appears showing the FULL name (wrapped, not truncated) and a breakdown line; no poster, no IMDb button.
- Highlight a **Movies/All** result → the pane still shows the OMDb poster/plot as before (no regression).
- Confirm the browser issues **no `/api/title` request** when highlighting an adult result (Network tab).

- [ ] **Step 5: Commit**

```bash
git add src/web/static/app.ts
git commit -m "feat(web): show local detail pane for adult results"
```

---

### Task 6: TUI local pane (`PreviewPane.tsx` + `Results.tsx`)

Mirror the behaviour in the terminal: a `local` mode on the presentational pane (wrap the title, drop the poster/"no plot" lines), and an adult branch in `Results.tsx` that feeds it the name + breakdown with no OMDb call and no key requirement.

**Files:**
- Modify: `src/ui/components/PreviewPane.tsx`
- Modify: `src/ui/components/Results.tsx` (`previewSection`/`showPreview` ~lines 530-535; `useTitlePreview` `enabled` ~line 581; the `<PreviewPane .../>` call ~lines 1108-1118; add a `breakdownSummary` import)

**Interfaces:**
- Consumes: `breakdownSummary` (Task 2).
- Produces: `PreviewPane` gains `local?: boolean`.

- [ ] **Step 1: Add the `local` prop to `PreviewPane`**

In `src/ui/components/PreviewPane.tsx`, add to `PreviewPaneProps`:

```ts
  // Local (no-lookup) mode for name-only results (the adult group): the title
  // WRAPS to show a long release name in full, there is no poster region, and
  // the plot slot always renders (no "No plot available." — nothing was looked up).
  local?: boolean;
```

Update the component to branch on it. Replace the function body's JSX with:

```tsx
export function PreviewPane({ width, height, focused, title, year, plot, posterRows, note, local }: PreviewPaneProps) {
  return (
    <Panel title="Preview" width={width} focused={focused} height={height}>
      {local ? null : posterRows === undefined ? (
        <Text dimColor>Loading poster…</Text>
      ) : posterRows === null ? (
        <Text dimColor>No poster available.</Text>
      ) : (
        <Box flexDirection="column">
          {posterRows.map((row, i) => (
            <Text key={i}>{row}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={local ? 0 : 1} flexDirection="column">
        <Text bold color={COLOR.accent} wrap={local ? "wrap" : "truncate-end"}>
          {cleanText(title)}
          {year ? <Text dimColor>{` (${year})`}</Text> : null}
        </Text>
        <Box marginTop={1}>
          {local ? (
            <Text dimColor wrap="wrap">{cleanText(plot ?? "")}</Text>
          ) : plot === undefined ? (
            <Text dimColor>Loading…</Text>
          ) : plot === null ? (
            <Text dimColor>No plot available.</Text>
          ) : (
            <Text dimColor wrap="wrap">{cleanText(plot)}</Text>
          )}
        </Box>
        {note ? (
          <Box marginTop={1}>
            <Text color={COLOR.alt} wrap="truncate-end">{cleanText(note)}</Text>
          </Box>
        ) : null}
      </Box>
    </Panel>
  );
}
```

- [ ] **Step 2: Add the adult branch in `Results.tsx`**

Add the import (next to the existing release-related imports):

```ts
import { breakdownSummary } from "../../util/releaseBreakdown";
```

Replace the `previewSection`/`showPreview` block (~lines 530-535) with:

```ts
  const previewGroup = useMemo(() => CATEGORIES.find((c) => c.key === section)?.group, [section]);
  // OMDb pane: film/TV, needs a key. `!previewGroup` is the "All" section.
  const previewSection = !previewGroup || previewGroup === "Movies" || previewGroup === "TV" || previewGroup === "Anime";
  // Local pane: the adult group has no OMDb metadata, so it is built from the
  // release name — no key, no lookup.
  const adultSection = previewGroup === "Porn";
  const showPreview =
    previewOn &&
    mode !== "detail" &&
    contentWidth >= PREVIEW_MIN_WIDTH &&
    (adultSection || (previewSection && omdbApiKey !== ""));
```

Change the `useTitlePreview` `enabled` so OMDb never runs for the adult pane (~line 581):

```ts
    enabled: showPreview && !adultSection,
```

Replace the `<PreviewPane .../>` call (~lines 1108-1118) with:

```tsx
        {showPreview && selectedResult ? (
          <PreviewPane
            width={previewWidth}
            height={panelOuter}
            focused={focused && mode === "list"}
            local={adultSection}
            title={adultSection ? selectedResult.name : (parsed?.title ?? cleanText(selectedResult.name))}
            year={adultSection ? undefined : parsed?.year}
            plot={adultSection ? breakdownSummary(selectedResult.name) : preview.plot}
            posterRows={adultSection ? null : preview.posterRows}
          />
        ) : null}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`PreviewPane` renders from `title` + `plot` alone, verified in the source, so `local` mode needs no poster/OMDb inputs.)

- [ ] **Step 4: Verify by running the TUI**

```bash
npm run dev
```

With adult content enabled and NO OMDb key required: switch to the Porn section, highlight a result, and confirm the Preview pane shows the full (wrapped) release name and the breakdown line, with no poster area and no "No plot available." A Movies/TV/All section with a key still shows the poster/plot pane unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/PreviewPane.tsx src/ui/components/Results.tsx
git commit -m "feat(tui): show local detail pane for adult results"
```

---

### Task 7: Docs and full verification

**Files:**
- Modify: `README.md` (the web UI's limitations/parity list — re-check the "adult results show only a title" claim is no longer true)

- [ ] **Step 1: Update the README**

Search the README for where the web UI's limitations or the adult/Porn behaviour is described:

```bash
grep -ni "porn\|adult\|only a title\|no poster" README.md
```

If a line states adult results show only a title / have no detail, update it to note that highlighting an adult result now shows the full release name and a parsed breakdown (no artwork). If there is no such line, add a one-line mention next to the other preview-pane description. Keep the house style (calm, no invented titles).

- [ ] **Step 2: Run the full verification suite**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```

Expected: all pass. The only allowed lint warning is the pre-existing `react-hooks/exhaustive-deps` in `src/ui/App.tsx`. `npm run build` passing confirms `releaseBreakdown.ts` (via `previewModel.ts` and the TUI) pulled no `node:*` into the web bundle.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note adult-result detail pane in the web UI parity list"
```

---

## Self-Review

**Spec coverage:**
- Full untruncated name on highlight → Task 4 (`localPreviewCopy.heading`), Task 5 (web render), Task 6 (`local` title wrap). ✓
- Parsed breakdown (studio/year/resolution/source/codec/group) → Task 1 (source+group), Task 2 (`releaseBreakdown`). ✓
- No network lookup → Task 4 `selectLocal` (no `fetch`, asserted), Task 6 `enabled: … && !adultSection`. ✓
- Poster gate untouched for adult → `postersApply` still keys off `previewApplies`; `adultPreviewApplies` is disjoint (Task 3 test). ✓
- Ships in both surfaces → web Tasks 3-5, TUI Task 6. ✓
- Shared logic in `src/util` (layering) → Task 2. ✓
- Fixtures use invented studios / cast shapes → Tasks 1, 2, 4 fixtures. ✓
- Follow-on thumbnail spec is out of scope here (its own doc). ✓

**Placeholder scan:** No TBD/TODO; every code step carries real code. ✓

**Type consistency:** `BreakdownField`, `studioFromName`, `releaseBreakdown`, `breakdownSummary`, `localPreviewCopy`, `selectLocal`, `PreviewState "local"`, `adultPreviewApplies`, `PreviewPane.local` are named identically at definition and every call site across tasks. `breakdownSummary` (not `breakdownText`) is the single summary function used by both surfaces. ✓
