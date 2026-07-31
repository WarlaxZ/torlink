# reccd `{ results: [...] }` Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse reccd's new `{ results: [...] }` response envelope on `/recommendations` and `/search`, rejecting the old bare-array format.

**Architecture:** One shared `resultsOf` unwrap helper in `src/recc/client.ts`, applied at the two response-parse sites. The exported result types don't change, so every consumer — the For You hook, the title-suggest hook, and the whole browser surface via `src/web/routes.ts` — is fixed without being touched.

**Tech Stack:** TypeScript, Vitest, Node `fetch` injected as `FetchImpl`.

**Spec:** `docs/superpowers/specs/2026-07-31-reccd-results-envelope-design.md`

## Global Constraints

- **Strict envelope.** A bare array is rejected. There is no backwards-compatible fallback — this was the repo owner's explicit call. torlink and reccd deploy together.
- **One error string for every shape problem:** `"unexpected response from reccd"`. No version-specific message was wanted.
- **Unknown top-level keys are ignored, not rejected.** `attribution` is why the envelope exists.
- **Do not implement `plot`, `plotSource`, `attribution` or `/similar`.** torlink takes plots from OMDb and never sends `plot=true`. This is an API-compatibility fix, not the plot feature.
- **Only `src/recc/client.ts` changes in `src/`.** No edits to `src/ui/`, `src/web/`, or `src/util/` source files — only their tests.
- **Test fixtures never name a real film or show** (`CLAUDE.md`). Reuse the existing fixtures: `Windmere`, `Kestrel`, `Kepler`, `Ashfall`, `Harrowgate`, `Tin Rivers`.
- **Conventional Commits.** Commit at the end of each task; each commit leaves the full suite green.
- **Definition of done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One pre-existing lint warning (`react-hooks/exhaustive-deps` in `src/ui/App.tsx`) is expected — leave it.

---

### Task 1: The envelope for `/recommendations`

Adds the shared `resultsOf` helper and applies it to `fetchRecommendations`. `src/ui/components/ForYou.test.tsx` stubs reccd's HTTP body directly, so its stubs are rewrapped in this same task — otherwise this commit lands with a red suite.

**Files:**
- Modify: `src/recc/client.ts` — new helper above `fetchRecommendations`; parse site at lines 133-137
- Test: `src/recc/client.test.ts` — the `describe("fetchRecommendations")` block, lines 90-144
- Test: `src/ui/components/ForYou.test.tsx` — stub helpers at lines 45-95 and an inline stub at line 153

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `function resultsOf(body: unknown): unknown[] | null` — module-private in `src/recc/client.ts`, **not exported**. Task 2 calls it. Returns the `results` array when `body` is a non-null, non-array object whose `results` is an array; returns `null` otherwise.
- Unchanged and relied on downstream: `fetchRecommendations(config, query, opts): Promise<{ ok: true; items: Recommendation[] } | { ok: false; error: string }>`.

- [ ] **Step 1: Write the failing tests**

In `src/recc/client.test.ts`, add these five tests inside `describe("fetchRecommendations", ...)`, immediately after the existing `it("returns ok with parsed items on 200", ...)`. `fakeFetch`, `CONFIG` and `REC` already exist in the file at lines 70-88 — do not redefine them.

```ts
  it("reads the items out of reccd's results envelope", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { results: [REC] } }));
    const res = await fetchRecommendations(CONFIG, { limit: 5 }, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, items: [REC] });
  });

  // The envelope exists so an attribution block can accompany plot text. torlink
  // never asks for plots, but a parser that demanded EXACTLY `results` would
  // break the day it did — so unknown siblings are ignored, not rejected.
  it("ignores an attribution block sitting beside the results", async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: {
        attribution: {
          source: "reccd",
          licence: "CC BY-SA 4.0",
          licenceUrl: "https://example.invalid/licence",
          modified: true,
        },
        results: [REC],
      },
    }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, items: [REC] });
  });

  // reccd's previous wire format. Accepting it would let torlink run against a
  // reccd too old to send the envelope, which is deliberately not supported.
  it("rejects a bare array, the wire format reccd used before the envelope", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [REC] }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });

  it("rejects an envelope whose results is not an array", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { results: "nope" } }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });

  it("rejects an object with no results key at all", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: {} }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/recc/client.test.ts -t "fetchRecommendations"`

Expected: the three new positive/negative envelope tests fail. Specifically `reads the items out of reccd's results envelope` and `ignores an attribution block` fail with `{ ok: false, error: "unexpected response from reccd" }` (the current code requires a top-level array), and `rejects a bare array` fails with `ok: true` (the current code accepts one). `rejects an envelope whose results is not an array` and `rejects an object with no results key` already pass — that is fine and expected, they are there to pin the helper's edges.

- [ ] **Step 3: Add the `resultsOf` helper**

In `src/recc/client.ts`, insert this immediately above the `fetchRecommendations` doc comment (which begins `// A blocking read, unlike the fire-and-forget postEvent:`, around line 109):

```ts
// reccd wraps its list endpoints in an object so a response-level `attribution`
// block can ride alongside plot text. Unknown siblings are ignored rather than
// rejected: torlink does not send `plot=true` today, and a parser that demanded
// exactly `results` would break the day it did.
//
// A bare array — reccd's format before the envelope — is deliberately NOT
// accepted. This build requires a reccd new enough to send the envelope; the two
// deploy together.
function resultsOf(body: unknown): unknown[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const r = (body as Record<string, unknown>).results;
  return Array.isArray(r) ? r : null;
}
```

- [ ] **Step 4: Apply it in `fetchRecommendations`**

In `src/recc/client.ts`, replace these lines (currently 133-137):

```ts
    const body: unknown = await res.json();
    if (!Array.isArray(body) || !body.every(isRecommendation)) {
      return { ok: false, error: "unexpected response from reccd" };
    }
    return { ok: true, items: body };
```

with:

```ts
    const body: unknown = await res.json();
    const results = resultsOf(body);
    if (results === null || !results.every(isRecommendation)) {
      return { ok: false, error: "unexpected response from reccd" };
    }
    return { ok: true, items: results };
```

Note on typing: `Array.prototype.every` has a type-guard overload (`predicate: (v: T) => v is S` narrows to `S[]`), which is how the original line narrowed `body` to `Recommendation[]`. The same narrowing should apply to `results`. If `npm run typecheck` disagrees, split the condition rather than reaching for a cast:

```ts
    if (results === null) return { ok: false, error: "unexpected response from reccd" };
    if (!results.every(isRecommendation)) return { ok: false, error: "unexpected response from reccd" };
    return { ok: true, items: results };
```

- [ ] **Step 5: Rewrap the recommendations tests that stub a bare array**

Still in `src/recc/client.test.ts`, four existing tests stub the old format and must be rewrapped. Change **only** the `body:` value in each.

`it("returns ok with parsed items on 200")` (line 92):
```ts
    const { impl } = fakeFetch(() => ({ status: 200, body: { results: [REC] } }));
```

`it("builds the query string from provided filters")` (line 98) and `it("omits type/genre/explore when unset and defaults limit to 20")` (line 108) — both currently `body: []`:
```ts
    const { impl, urls } = fakeFetch(() => ({ status: 200, body: { results: [] } }));
```

`it("rejects a malformed body")` (line 135) — **this is the vacuous-assertion case.** It stubs `[{ imdbId: 1 }]` to prove `isRecommendation` rejects an item with a wrong-typed field. Left as a bare array it would now fail at the envelope check instead, and would still pass with `isRecommendation` deleted entirely. Rewrap it so it tests what its name claims, and rename it for precision:

```ts
  // Item-level validation, not envelope-level: the envelope here is valid, so
  // the only thing that can reject this body is isRecommendation.
  it("rejects an envelope whose items are malformed", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { results: [{ imdbId: 1 }] } }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });
```

Leave `maps 401`, `maps other non-2xx`, `maps a network throw` and `returns a not-configured error` untouched — none of them reaches the body parse.

- [ ] **Step 6: Run the recommendations tests**

Run: `npx vitest run src/recc/client.test.ts -t "fetchRecommendations"`
Expected: PASS, all tests in the block.

- [ ] **Step 7: Rewrap the ForYou stubs**

`src/ui/components/ForYou.test.tsx` drives the real `fetchRecommendations` through injected `fetch`, so its stubs now serve an invalid body. Four edits, all serving `[REC]` on the recommendations URL:

Line 49, in `fetchStub`:
```ts
    return { ok: true, status: 200, json: async () => ({ results: [REC] }) } as unknown as Response;
```

Line 59-61, in `fetchStubWithPlot` — the OMDb branch is a different API and must NOT be wrapped:
```ts
    const body = String(url).includes("omdbapi.com")
      ? { Response: "True", Plot: plot }
      : { results: [REC] };
```

Line 89-91, in `fetchStubFull` — again, only the reccd branch:
```ts
    const body = u.includes("omdbapi.com")
      ? { Response: "True", Plot: plot, Poster: posterUrl }
      : { results: [REC] };
```

Line 153, the inline stub inside a test:
```ts
      return { ok: true, status: 200, json: async () => ({ results: [REC] }) } as unknown as Response;
```

Leave the 500-status stub at line 161 alone — it never reaches the body parse.

- [ ] **Step 8: Run both affected suites**

Run: `npx vitest run src/recc/client.test.ts src/ui/components/ForYou.test.tsx`
Expected: PASS. `fetchTitleSuggestions` tests still pass at this point because Task 1 did not touch that function.

- [ ] **Step 9: Commit**

```bash
git add src/recc/client.ts src/recc/client.test.ts src/ui/components/ForYou.test.tsx
git commit -m "fix(recc): read /recommendations out of reccd's results envelope"
```

---

### Task 2: The envelope for `/search`

Applies the same helper to `fetchTitleSuggestions`, audits that block's four negative assertions, and rewraps the two UI test files that stub suggestion responses.

**Files:**
- Modify: `src/recc/client.ts` — parse site at lines 201-205 (line numbers shift by roughly +12 after Task 1)
- Test: `src/recc/client.test.ts` — the `describe("fetchTitleSuggestions")` block, lines 146-295
- Test: `src/ui/views/Splash.test.tsx:125` — `suggestStub`
- Test: `src/ui/components/Results.test.tsx:597` — `suggestStub`

**Interfaces:**
- Consumes: `resultsOf(body: unknown): unknown[] | null` from Task 1, module-private in the same file.
- Unchanged and relied on downstream: `fetchTitleSuggestions(config, query, opts): Promise<{ ok: true; items: TitleSuggestion[] } | { ok: false; error: string }>`.

- [ ] **Step 1: Write the failing tests**

In `src/recc/client.test.ts`, add these inside `describe("fetchTitleSuggestions", ...)`, after `it("accepts both of reccd's types in one reply", ...)`. `jsonRes`, `WIRE_HIT` and `HIT` already exist in that block — do not redefine them.

```ts
  it("reads the hits out of reccd's results envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [WIRE_HIT] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: true, items: [HIT] });
  });

  it("ignores an attribution block sitting beside the results", async () => {
    const body = {
      attribution: {
        source: "reccd",
        licence: "CC BY-SA 4.0",
        licenceUrl: "https://example.invalid/licence",
        modified: true,
      },
      results: [WIRE_HIT],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, body));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: true, items: [HIT] });
  });

  // reccd's previous wire format, deliberately unsupported.
  it("rejects a bare array, the wire format reccd used before the envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, [WIRE_HIT]));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });

  it("rejects an envelope whose results is not an array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: "nope" }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/recc/client.test.ts -t "fetchTitleSuggestions"`

Expected: `reads the hits out of reccd's results envelope` and `ignores an attribution block` fail with `{ ok: false, error: "unexpected response from reccd" }`; `rejects a bare array` fails with `ok: true` and the parsed items. `rejects an envelope whose results is not an array` already passes.

- [ ] **Step 3: Apply the helper in `fetchTitleSuggestions`**

In `src/recc/client.ts`, replace:

```ts
    const body: unknown = await res.json();
    if (!Array.isArray(body) || !body.every(isTitleSuggestion)) {
      return { ok: false, error: "unexpected response from reccd" };
    }
    // Narrowed deliberately: reccd also sends genres, rating and votes, and
    // nothing here renders them.
    const items: TitleSuggestion[] = body.map((r) => ({
```

with:

```ts
    const body: unknown = await res.json();
    const results = resultsOf(body);
    if (results === null || !results.every(isTitleSuggestion)) {
      return { ok: false, error: "unexpected response from reccd" };
    }
    // Narrowed deliberately: reccd also sends genres, rating and votes, and
    // nothing here renders them.
    const items: TitleSuggestion[] = results.map((r) => ({
```

Leave the rest of the mapping body, and the 401 and 404 branches, exactly as they are. The 404 branch is about a *missing endpoint* on an older reccd, not a response shape — it is unaffected by this change and must keep returning `"this reccd has no title search"`.

- [ ] **Step 4: Rewrap the happy-path suggestion tests**

Six existing tests in the block stub a bare array. Change only the body argument to `jsonRes`:

`it("accepts both of reccd's types in one reply")` (line 172):
```ts
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [WIRE_HIT, WIRE_SHOW] }));
```

`it("gets {reccUrl}/search with q, limit and a bearer token")` (line 179) and `it("drops the fields torlink does not render")` (line 193):
```ts
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [WIRE_HIT] }));
```

`it("forwards a year in the query verbatim rather than parsing it out")` (line 208), `it("honours an explicit limit")` (line 283) and `it("still fires with an empty bearer token when reccToken is omitted")` (line 290) — all currently `jsonRes(200, [])`:
```ts
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [] }));
```

`it("accepts a hit that matched on an AKA")` (line 268-269):
```ts
    const aka = { ...WIRE_HIT, matchedAka: "Ashfall Rising" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [aka] }));
```

- [ ] **Step 5: Audit the four negative assertions**

This is the step `CLAUDE.md` exists to force — a mechanical rewrite can leave a negative assertion green while it no longer tests anything. Handle each individually.

**5a.** `it("rejects a body that is not an array")` (line 245) stubs `{ items: [WIRE_HIT] }`. Under the new contract a non-array object is the *valid* shape, so the name is now actively wrong — but the body still rejects, for the right reason (no `results` key). Rename and re-comment; keep the stub:

```ts
  // The name of the key matters: an object is now the valid shape, and this one
  // carries the hits under the wrong key.
  it("rejects an envelope with no results array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { items: [WIRE_HIT] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });
```

**5b.** `it("rejects the whole array when one member is malformed")` (line 254) — **vacuous if left alone.** It stubs a bare array, which the new code rejects at the envelope check, so it would pass with `isTitleSuggestion` deleted. Rewrap so the envelope is valid and only the item check can reject it:

```ts
  // All-or-nothing, matching isRecommendation: a body we only half understand
  // is a contract change, and silently rendering the half we parsed would hide
  // it until someone noticed rows missing. The envelope here is valid, so
  // isTitleSuggestion is the only thing that can reject this.
  it("rejects the whole list when one member is malformed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [WIRE_HIT, { imdbId: "tt2" }] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });
```

**5c.** `it("rejects a hit whose type is neither movie nor tv")` (line 260) — vacuous for the same reason. Rewrap:

```ts
  it("rejects a hit whose type is neither movie nor tv", async () => {
    const bad = { ...WIRE_HIT, type: "tvEpisode" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, { results: [bad] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res.ok).toBe(false);
  });
```

**5d.** `it("reports any other non-ok status")` (line 239) stubs `jsonRes(500, [])`. Its existing comment explains the design: the body must be one that *would* parse cleanly, so the status check is the only thing that can satisfy the exact error assertion. `[]` is no longer such a body. Rewrap it and update the comment to stay true:

```ts
  // The body is a VALID envelope and the error is asserted exactly, so this can
  // only be satisfied by the status check — delete the `!res.ok` branch and it
  // falls through to a successful parse rather than passing for a shape error.
  it("reports any other non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(500, { results: [] }));
    const res = await fetchTitleSuggestions({ reccUrl: "http://r", reccToken: "t" }, { q: "kes" }, { fetchImpl });
    expect(res).toEqual({ ok: false, error: "title search unavailable (HTTP 500)" });
  });
```

Confirm before moving on: every one of 5a-5d now rejects for the reason its name claims, not merely because it returns `ok: false`.

- [ ] **Step 6: Run the suggestion tests**

Run: `npx vitest run src/recc/client.test.ts`
Expected: PASS, both describe blocks.

- [ ] **Step 7: Rewrap the two UI suggestion stubs**

Both files have one stub helper feeding every test in them, so this is a single line each.

`src/ui/views/Splash.test.tsx`, line 125:
```ts
    return { ok: true, status: 200, json: async () => ({ results: items }) } as unknown as Response;
```

`src/ui/components/Results.test.tsx`, line 597:
```ts
    return { ok: true, status: 200, json: async () => ({ results: items }) } as unknown as Response;
```

Do not change either helper's `items: unknown[] = [KESTREL]` parameter or any call site — the wrapping happens inside the stub, so `suggestStub([KESTREL, KEPLER, ASHFALL, HARROWGATE, TIN_RIVERS])` at `Results.test.tsx:786` keeps working unchanged.

- [ ] **Step 8: Run the affected suites**

Run: `npx vitest run src/recc/client.test.ts src/ui/views/Splash.test.tsx src/ui/components/Results.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/recc/client.ts src/recc/client.test.ts src/ui/views/Splash.test.tsx src/ui/components/Results.test.tsx
git commit -m "fix(recc): read /search out of reccd's results envelope"
```

---

### Task 3: Full verification and sweep

Confirms nothing else in the repo parses a reccd body, and that the browser path still works.

**Files:**
- Modify: none expected. If the sweep finds another raw stub, fix it here.

**Interfaces:**
- Consumes: the finished client from Tasks 1 and 2.
- Produces: nothing.

- [ ] **Step 1: Sweep for any remaining raw reccd body stub**

Run:
```bash
grep -rnE "json: async" src/ --include='*.test.ts' --include='*.test.tsx' | cut -c1-140
```

Expected: every remaining hit serves an OMDb body (`{ Response: "True", ... }`) or is already wrapped in `{ results: ... }`. `src/web/routes.test.ts` should produce no hits at all — it injects `fetchRecommendationsImpl` / `fetchTitleSuggestionsImpl` at the client boundary and never stubs HTTP. If a genuinely new reccd stub turns up, wrap it and note it.

- [ ] **Step 2: Confirm no source file outside the client parses a reccd list**

Run:
```bash
grep -rnE "Array\.isArray" src/recc/ src/util/titleSuggest.ts src/web/routes.ts | cut -c1-140
```

Expected: no hit that is validating a `/recommendations` or `/search` response. Hits relating to other data (config, OMDb, filters) are fine and out of scope.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS. Pay attention to `src/web/routes.test.ts` — it is the browser surface's regression check and must be green without having been edited.

- [ ] **Step 4: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: typecheck clean; lint clean apart from the single known pre-existing `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx`, which stays; build clean.

- [ ] **Step 5: Commit anything the sweep changed**

Only if Steps 1-2 turned up a fix:
```bash
git add -A
git commit -m "test(recc): wrap a remaining reccd stub in the results envelope"
```

- [ ] **Step 6: Open the PR**

Base must be pinned — this repo is a fork, and a bare `gh pr create` has previously opened a PR against a stranger's repository:

```bash
gh pr create --repo WarlaxZ/torlink --base main \
  --title "fix(recc): read reccd's { results: [...] } envelope" \
  --body "$(cat <<'EOF'
reccd now wraps `/recommendations`, `/search` and `/similar` in `{ results: [...] }`
so a response-level `attribution` block can accompany plot text. This is the
matching client change.

## Scope

torlink calls two of those three endpoints. Both parse sites are in
`src/recc/client.ts`, behind one shared `resultsOf` helper, so the For You tab
and title autocomplete are fixed in **both** front ends by a single change —
the browser reaches reccd through this client, not around it. No file in
`src/ui/` or `src/web/` needed editing.

## Deliberately not included

- **`/similar`** — torlink never constructs that path.
- **`plot`, `plotSource` and `attribution`** — torlink takes plots and posters
  from OMDb (`src/recc/omdb.ts`, `useTitlePreview`) and never sends
  `plot=true`. Rendering reccd's plot text would mean surfacing its licence
  line in both front ends: a feature, not an API fix, and it deserves its own
  change. Unknown top-level keys are ignored rather than rejected, so an
  `attribution` sibling parses fine if we ever do send `plot=true`.

## Compatibility: this build needs a matching reccd

A bare array is **rejected**, not accepted as a legacy shape. That was a
deliberate call for a sharper contract over independent deploys. Pointed at an
older reccd, For You shows "unexpected response from reccd" and title
autocomplete shows nothing — so **deploy the two together**.

## Tests

New coverage for the envelope, an `attribution` sibling being ignored, and the
bare array now being refused. The four existing negative assertions in
`src/recc/client.test.ts` were each re-pointed so they still fail for the reason
their name claims — left alone, three of them would have passed at the envelope
check while no longer exercising item validation at all.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage.** `resultsOf` semantics → Task 1 Step 3. `fetchRecommendations` → Task 1 Step 4. `fetchTitleSuggestions`, with 401/404 and the narrowing map preserved → Task 2 Step 3. The four new-test cases the spec lists → Task 1 Step 1 and Task 2 Step 1. Rewrapping existing tests → Task 1 Step 5, Task 2 Steps 4 and 7. The vacuous-assertion audit, all four named tests → Task 2 Step 5 (5a-5d), with `rejects a malformed body` handled in Task 1 Step 5 since it lives in the other describe block. Suite commands → Task 3 Step 4. No README change → Task 3 has no docs step, matching the spec. PR body contents → Task 3 Step 6.

**Placeholders.** None; every code step carries the literal code.

**Type consistency.** `resultsOf(body: unknown): unknown[] | null` is used with the identical signature in both tasks. `REC`, `CONFIG`, `fakeFetch`, `jsonRes`, `HIT`, `WIRE_HIT`, `WIRE_SHOW` are all pre-existing in `src/recc/client.test.ts` and referenced, not redefined.

**One thing the spec got wrong, corrected here:** the spec suspected `src/web/routes.test.ts` might need rewrapping. It does not — it injects at the client boundary. Three UI test files do instead (`ForYou`, `Splash`, `Results`), and their rewraps are folded into the task that breaks them so every commit lands green. The spec has been amended to match.
