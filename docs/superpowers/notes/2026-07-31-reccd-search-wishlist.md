# What reccd could add to make title search better

**Date:** 2026-07-31
**Written after** shipping title autocomplete in both torlink front ends against reccd's
`GET /search`. Everything below is grounded in something that actually came up while
building it, not speculation about what an API "should" have.

## First, three things reccd must NOT change

These are load-bearing for torlink's client as shipped. Worth stating before the wishlist,
because a well-meaning cleanup would break a working feature.

1. **`matchedAka` must stay an explicit `null`, never an omitted field.** The primary-title
   branch selects `NULL::text AS matched_aka` (`src/db/titleSearch.ts:139`), so the JSON
   carries `"matchedAka": null`. torlink's type guard accepts `null | string` and rejects
   `undefined` — it is all-or-nothing by design, so omitting the key for primary-title hits
   would make the guard reject **every** primary hit and silently kill the feature. A green
   test suite on reccd's side would not notice.
2. **`q` must keep being parsed for a trailing year server-side.** torlink forwards `q`
   verbatim and deliberately does no client-side year parsing, precisely so the two systems
   cannot disagree about what `"kestrel 2010"` means. The literal-interpretation fallback
   for titles that genuinely end in a year is part of that contract.
3. **`SEARCH_MIN_QUERY_LENGTH` is duplicated in torlink** as `SUGGEST_MIN_QUERY_LENGTH`,
   with a comment pointing at `src/api/server.ts:70`. If it changes, torlink either fires
   requests guaranteed to return `[]` or hides results reccd would have given. Changing it
   is fine — telling us is the ask. See also the capability endpoint below, which would let
   a client stop guessing.

## The wishlist, most valuable first

### 1. A `type=movie|tv` filter

`type` comes back on every hit but cannot be filtered on. Both torlink front ends already
know which the user wants: the browser has category tabs (**movies**, **tv**) and the
terminal has the equivalent sections. So a user who has explicitly narrowed to TV and types
three characters still gets films offered, and there is nothing the client can do about it
short of filtering after the fact — which silently shrinks a `limit`-capped list, sometimes
to nothing.

Cheapest useful change on this list, and the design doc already notes `type` was included
"even though there is no `type` filter".

### 2. Artwork on a hit

torlink's browser suggestions are text-only, and that is the **only** reason: showing a
thumbnail per row would mean a second OMDb round trip per row, on every keystroke. reccd
already holds the `imdbId`; a `posterUrl` (even nullable, even lazily populated) would let
the browser's suggestion rows carry poster art, which is the whole point of that surface.

The terminal cannot use this — no posters in a text field — so it is browser-only value,
but the browser is where autocomplete is most used.

### 3. Typo tolerance on the zero-result case

`tin rivrs` returns nothing. reccd's own design doc already flags a trigram similarity pass
over the zero-result case as purely additive, and it is right — nothing in torlink's client
would need to change, because "some hits" and "some hits after a fuzzy retry" are the same
response shape.

Worth doing because autocomplete is typed fast and loosely. This is the difference between
"the search box is clever" and "the search box is picky".

### 4. Tell a client that a title is a series, and which seasons exist

The sharpest limitation torlink had to document rather than solve: **suggestions are titles,
not releases.** `parseBasicsLine` drops `tvEpisode`, so `Harrowgate S03` can never be
suggested — a user gets `Harrowgate` and has to narrow to a season by hand once torrent
results are in.

reccd need not index episodes to help here. Even a `seasons: number` or
`seasonRange: [1, 4]` on a `type: "tv"` hit would let both front ends offer "which season?"
straight from the suggestion, turning one round of manual narrowing into a click. Full
episode titles would be better still, but the cheap version captures most of the value.

### 5. Accept a release name, not just a partial title

torlink parses release names locally (`parseRelease`) to get a title and year out of
strings like `Kestrel.2010.1080p.BluRay.x264`. reccd has `/resolve` for canonicalising full
release names, but it returns a single best guess with a confidence score — built for
canonicalisation, not for a picker.

If `/search` accepted a release-name-shaped `q` (or `/resolve` gained a `limit` and returned
a ranked list), torlink could canonicalise a filename through the same catalog that powers
its suggestions, and the two systems would stop having independent opinions about what a
release is. Today they can disagree, and when they do there is no way to tell which is right.

### 6. An optional popularity floor, as a client-supplied hint

reccd deliberately applies no hard `minVotes` filter, and that is the right default — an
obscure title stays findable if you type enough of its name. But the measured cost of that
choice lands on the broadest queries: **~311ms for a two-character prefix** on a 2M-row
seed, against ~71ms for a realistic multi-token one.

With torlink's 250ms debounce, a two-character query is roughly 560ms from last keystroke to
first row. An **optional** `minVotes=` that a client can pass for short queries only — and
omit as soon as the query is specific — would let the client trade completeness for latency
exactly where completeness matters least, without changing reccd's default behaviour at all.

Explicitly not asking for the default to change. The design doc's reasoning for no hard
filter is sound, and its analysis of why a votes-based fallback breaks tier ordering is
correct — which is why this should be a client-supplied parameter rather than an internal
heuristic.

### 7. A capability or version endpoint

torlink treats a `404` from `GET /search` as "this reccd predates the endpoint" and silently
degrades to the old search box. That works, but it is inference from an error code, and it
costs one wasted request per debounced keystroke against an older server.

A `GET /capabilities` returning something like
`{ "search": true, "searchMinQueryLength": 2, "resolve": true, "recommendations": true }`
would let a client light up features it knows are present, stop probing for ones that are
not, and read `searchMinQueryLength` instead of hard-coding a copy of it — which retires
constraint 3 above outright.

This is the item with the best ratio of "small change" to "future coupling removed".

## Deliberately not asking for

- **A different `limit` cap.** 25 is plenty; torlink asks for 8.
- **Server-side debouncing or rate limiting on `/search`.** Debouncing is the client's job
  and torlink does it at 250ms. A server-side limiter would be invisible to the user as
  "suggestions sometimes don't appear".
- **Removing the `to_tsquery` metacharacter escaping.** torlink does not sanitise `q` before
  sending, on purpose — the server owning that is correct, and a test on reccd's side already
  pins `"dark & kni"` and `"!"` not erroring.
