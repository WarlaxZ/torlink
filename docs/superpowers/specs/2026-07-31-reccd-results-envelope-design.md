# reccd's `{ results: [...] }` envelope

**Date:** 2026-07-31
**Status:** approved, ready for implementation

## The change upstream

reccd has made a breaking change to three endpoints. `/recommendations`, `/search` and
`/similar` now return an object rather than a bare array, so that a response-level
attribution block can accompany plot text:

```
GET /recommendations
→ { "results": [ { imdbId, title, year, score, reasons } ] }

GET /recommendations?plot=true
→ { "attribution": { source, licence, licenceUrl, modified },
    "results": [ { …, plot, plotSource } ] }
```

Error responses are unchanged.

## What torlink actually consumes

Narrower than the announcement suggests. A grep across `src/` for `/similar`, `plot=true`,
`plotSource` and `attribution` returns nothing outside an unrelated test comment.

- **`/recommendations`** — `fetchRecommendations` in `src/recc/client.ts`, feeding the For You
  tab through `src/ui/hooks/useRecommendations.ts` and the browser through `src/web/routes.ts`.
- **`/search`** — `fetchTitleSuggestions` in the same file, feeding title autocomplete in both
  front ends.
- **`/similar`** — not used. Nothing in the repo constructs that path.
- **Plot text** — not taken from reccd. Plots and posters come from OMDb via
  `src/recc/omdb.ts` and `src/ui/hooks/useTitlePreview.ts`. torlink never sends `plot=true`,
  so it never receives `plot`, `plotSource` or `attribution`.

So the whole change is two response-parse sites in one file.

## Decision: strict envelope, no bare-array fallback

**A bare array is rejected.** The client requires `{ results: [...] }`.

The alternative considered was accepting both shapes, which would let torlink and reccd deploy
independently — the pattern `fetchTitleSuggestions` already follows for a 404, where "a reccd
older than the /search endpoint" is treated as a missing feature rather than a fault. That was
put to the repo owner explicitly and declined in favour of the sharper contract.

**Consequence, stated plainly: torlink and reccd must deploy together.** A torlink build
carrying this change, pointed at a reccd that still sends bare arrays, will show
`"unexpected response from reccd"` in For You, and title autocomplete will show nothing at all
(that surface renders every error as "no suggestions", by design — an error banner per
keystroke is worse than silence).

A third option — requiring the envelope but detecting a bare array to emit a version-specific
message such as "this reccd is older than torlink expects" — was also offered and declined.
The generic error stands.

## Design

All changes in `src/recc/client.ts`. No other source file moves.

### A shared unwrap helper

```
function resultsOf(body: unknown): unknown[] | null
```

Returns `body.results` when `body` is a non-null, non-array object whose `results` is an array;
returns `null` for everything else — including a bare array, `null`, a primitive, and an object
whose `results` is present but not an array.

Sibling keys are ignored rather than rejected. `attribution` is the reason the envelope exists,
and although torlink does not request `plot=true` today, a validator that demanded *exactly*
`results` would break the moment it did.

### `fetchRecommendations`

Replace the current check at the parse site in `fetchRecommendations`:

```
if (!Array.isArray(body) || !body.every(isRecommendation)) {
  return { ok: false, error: "unexpected response from reccd" };
}
return { ok: true, items: body };
```

with an unwrap through `resultsOf`, keeping `isRecommendation` as the per-item validator and
`"unexpected response from reccd"` as the single error for both a bad envelope and a bad item.
The all-or-nothing stance is deliberate and preserved: a body we only half understand is a
contract change, and rendering the half we parsed would hide it.

### `fetchTitleSuggestions`

The same substitution at the parse site in `fetchTitleSuggestions`, keeping:

- the 401 branch (`"reccd rejected the token — check reccToken"`),
- the 404 branch (`"this reccd has no title search"`) — this is about a *missing endpoint*, not
  a response shape, and is unaffected,
- the narrowing map that drops the genres, rating and votes torlink does not render.

### Nothing downstream changes

`FetchRecommendationsResult` and `FetchTitleSuggestionsResult` keep their shapes, so
`useRecommendations`, `useTitleSuggest`, `src/util/titleSuggest.ts`, `src/web/routes.ts` and
`src/web/wire.ts` are all untouched. This is why one edit satisfies the repo's
"a feature ships in both front ends" rule without touching `src/ui/` or `src/web/static/` — the
browser reaches reccd *through* this client, not around it.

## Testing

Test-first: each new test must be observed failing against the current `Array.isArray(body)`
check before the client is edited.

### New tests, both `describe` blocks in `src/recc/client.test.ts`

1. Parses `{ results: [ …valid item… ] }` and returns `ok: true` with the items.
2. Rejects a bare array — the previous wire format — with `"unexpected response from reccd"`.
3. Parses an envelope carrying an unknown sibling key (use `attribution`), proving unknown
   top-level keys are ignored rather than fatal.
4. Rejects `{ results: "not an array" }` and `{}`.

### Rewrapping existing tests

Every happy-path test that stubs a bare array must be rewrapped — that is most of both
`describe` blocks, including the query-string tests, the AKA test, the both-types test and the
field-narrowing test, since each asserts on parsed output.

### The vacuous-assertion audit

`CLAUDE.md` records that a mechanical rewrite can leave a negative assertion passing for the
wrong reason while the suite stays green. Four existing tests are negative assertions over
response bodies and each must be re-read individually to confirm it still names a body the
**new** code rejects:

- `rejects a malformed body` (fetchRecommendations)
- `rejects a body that is not an array` (fetchTitleSuggestions) — the name itself is now
  misleading; a non-array object is the *valid* shape. Rename and re-point it.
- `rejects the whole array when one member is malformed`
- `rejects a hit whose type is neither movie nor tv`

For each: does the stubbed body fail for the reason the test claims, or merely happen to return
`ok: false`? An item-level validation test that stubs a bare array now fails at the envelope
check instead, and would pass without `isRecommendation`/`isTitleSuggestion` existing at all.

### Suite

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

Three UI test files also stub reccd's HTTP body directly and will fail until rewrapped. Each has
a single stub helper, so each is a one-line fix:

- `src/ui/components/ForYou.test.tsx` — `fetchStub`, `fetchStubWithPlot`, `fetchStubFull`, and an
  inline stub, all serving `[REC]` on the recommendations URL.
- `src/ui/views/Splash.test.tsx` — `suggestStub`, serving `items`.
- `src/ui/components/Results.test.tsx` — `suggestStub`, serving `items`.

`src/web/routes.test.ts` does **not** need changing: it injects `fetchRecommendationsImpl` /
`fetchTitleSuggestionsImpl` at the client boundary rather than stubbing HTTP, so it never sees a
wire body. It must still be run, as the browser path's regression check.

## Documentation

`README.md` describes what reccd gives the user (a For You tab, title autocomplete, Netflix and
Trakt import) and never states a wire format or a version, so the original conclusion here was
that no README change is needed. That answered the wrong question: it's true the README doesn't
document a wire format, but the strict envelope means torlink and reccd must now be upgraded
together, and that user-facing prerequisite had nowhere durable to live — a PR body isn't read by
someone setting up torlink months later. The README's Recommendations section now says so
directly: this build expects reccd's `results` envelope, the two should be upgraded together, and
what an older reccd looks like from the user's side (For You reports an error, title suggestions
stay empty).

## PR body must state

- Which endpoints torlink actually calls, and that `/similar` is unused.
- That `plot`, `plotSource` and `attribution` are deliberately not consumed — plots come from
  OMDb — and that this is an API-compatibility fix, not the plot feature.
- That the strict envelope means this build **requires a reccd new enough to send it**, and the
  two deploy together.
