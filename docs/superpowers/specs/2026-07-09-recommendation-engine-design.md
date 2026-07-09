# Recommendation Engine (`reccd`) — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorm complete)
**Scope:** Standalone, self-hosted recommendation service for movies + TV (incl. anime), with torlink as its first client. Personal use only — licensing constraints of upstream data sources are accepted on that basis.

## Goals

- Track what a single user watches, likes, favourites, starts, and abandons.
- Maintain a local, auto-updating catalog of the universe of movies/TV.
- Return "you should check out these items" via an HTTP API, biased toward newer releases but still surfacing unseen high-quality classics.
- Run 24/7 on low-power hardware; occasional heavy jobs run on a beefier machine and ship their outputs over.
- No frontend. API responses carry only IDs, title, year, score, and reasons — downstream clients fetch artwork/details themselves.

## Non-goals (v1)

- Music and book recommendations.
- Multi-user cohorts (the scoring pipeline leaves room for it as a future component).
- Any UI beyond torlink's minimal event hooks.
- Redistribution of upstream metadata via the API.

## Decisions made during brainstorm

| Decision | Choice |
|---|---|
| Where it lives | Standalone service, own repo; torlink is a client |
| Signals | Implicit events + explicit like/dislike keypress in torlink |
| Hardware | Low-power always-on host; beefy machine for offline jobs |
| Content scope | Movies + TV (anime included); music/books out of scope |
| Stack | TypeScript/Node HTTP service; Python offline jobs; SQLite everywhere |
| API payload | IDs + title only; no metadata redistribution |

## Architecture

```
beefy machine (occasional)                 always-on box (24/7)
┌──────────────────────────┐   scp/rsync   ┌─────────────────────────────┐
│ build_cf.py → cf.db      │ ────────────▶ │ reccd (Node/TS HTTP API)    │
│ build_embeddings.py →    │               │  catalog.db  activity.db    │
│   vectors.db             │               │  cf.db*  vectors.db*        │
└──────────────────────────┘               └─────────────▲───────────────┘
                                             POST /events │ GET /recommendations
                                           ┌──────────────┴──────────────┐
                                           │ torlink (event client)      │
                                           └─────────────────────────────┘
* optional — missing model files zero-out their score component
```

## Components

### 1. Catalog (`catalog.db`)

The universe of content, in SQLite:

- **Skeleton — IMDb non-commercial TSVs** (`title.basics`, `title.ratings`): every movie/TV title with `imdb_id`, title, year, runtime, genres (≤3, coarse), rating, vote count. A nightly job downloads the dumps, rebuilds into a fresh table, and atomically swaps. Adult titles and non-movie/TV title types are filtered out at import. ~1–2 GB.
- **Enrichment — TMDB**: keywords, plot overview, popularity, `tmdb_id`↔`imdb_id` mapping. Applied only to the *active subset*: titles above a configurable vote-count threshold plus anything the user interacts with (order of a few hundred thousand titles). Kept fresh incrementally via TMDB's `/changes` feed; initial fill is a rate-limited batch crawl.
- **Candidate pool**: recommendations are scored over the enriched/pruned subset, not all ~12M rows, keeping runtime cheap.

### 2. Activity store (`activity.db`)

Append-only event log. Event: `{type, raw_name, resolved_imdb_id?, confidence?, ts, source}` where `type ∈ {started, watched, favourited, unfavourited, liked, disliked, abandoned}`.

**Canonicalizer:** parses the raw torrent release name into title + year (release-name parsing library / logic shared with the torlink ecosystem), then resolves against the catalog by exact-then-fuzzy title+year match, storing the IMDb ID and a confidence score. Unresolved events are retained and retried after catalog refreshes — never dropped.

**TV handling:** resolution targets the *show*; episode-level watches aggregate into show-level engagement (many episodes ≈ strong like; one episode then nothing ≈ mild negative).

**Backfill:** on first run, an importer ingests torlink's existing `history.json` and `config.json` favourites (including per-episode `watched` lists) so the engine starts with the user's existing taste.

### 3. Scoring engine

For every unseen candidate:

```
score = w1·content_match        # genre/keyword/people overlap with taste profile
      + w2·cf_similarity        # MovieLens-derived item-item ("liked X → try Y"), movies only
      + w3·embedding_similarity # plot/keyword vector closeness to taste vector
      + w4·recency_prior        # newer release date → boost
      + w5·quality_prior        # rating × log(votes) — the cult-classic gate
      − penalties               # already seen; similar to disliked/abandoned items
```

- **Taste profile:** weighted feature counts (genres, keywords, people) from events — likes/favourites/rewatches weigh positive, dislikes/abandons negative — with time decay so taste can drift.
- **Weights** (`w1..w5`, penalty magnitudes, recency half-life) live in config; the newness bias is tuned by editing one number.
- **Diversity pass:** a simple MMR-style re-rank so the top N spans genres rather than returning fifteen near-identical titles.
- **Explainability:** every recommendation returns human-readable `reasons` (e.g. "because you liked Heat and Ronin; high rating; unseen").
- **Graceful degradation:** each component reads its own data file; a missing `cf.db`/`vectors.db` (or un-enriched title) contributes 0 rather than erroring. Phase 1 ships with only `content_match + recency + quality`.

### 4. HTTP API

Bearer-token auth, JSON, deliberately small:

| Endpoint | Purpose |
|---|---|
| `POST /events` | Ingest one or more activity events (fire-and-forget from clients) |
| `GET /recommendations?type=movie\|tv&genre=…&limit=…` | Ranked `[{imdb_id, tmdb_id?, title, year, score, reasons[]}]` |
| `GET /profile` | Inferred taste summary (top genres/keywords/people) — sanity-checking |
| `GET /resolve?name=…` | Dry-run canonicalization of a release name — debugging |

### 5. Offline jobs (Python, beefy machine)

- **`build_cf.py`** (one-off): MovieLens ml-32M ratings → item-item similarity (top-K per title) → `cf.db`, keyed to IMDb IDs via MovieLens `links.csv`. Movies only; dataset snapshot ends 2023, which is acceptable because CF is one component among several.
- **`build_embeddings.py`** (roughly monthly): sentence-transformers over `overview + keywords + genres` for the enriched subset → vectors stored via sqlite-vec in `vectors.db`.

Outputs are copied to the always-on box; the service picks them up on restart (or file-watch).

### 6. torlink integration

A small client module inside torlink:

- POSTs events on stream start/finish, favourite toggle, and queue-item removal (abandon signal).
- One new keypress pair offering like/dislike after a stream ends.
- Config additions: `reccUrl`, `reccToken`. Unconfigured or unreachable service = silent no-op; torlink behaviour never degrades.

## Phasing

1. **Phase 1 — useful on its own:** service skeleton, IMDb catalog + nightly refresh, event ingestion + canonicalizer, content-based scoring with recency/quality priors, torlink event client + like/dislike keys, backfill importer.
2. **Phase 2 — biggest quality jump:** TMDB enrichment (keywords/popularity/overviews, ID mapping) + embedding pipeline and score component.
3. **Phase 3:** MovieLens CF table and score component.
4. **Later, maybe:** multi-user cohorts as an additional score component; a "Recommended for you" view in torlink.

## Testing

- **Vitest** unit coverage for the scoring pipeline (fixture catalog + synthetic event histories → assert ranking properties: recency bias works, seen items excluded, cult-classic gate admits old-but-great titles).
- **Canonicalizer** gets the heaviest fixture suite — real-world release-name strings are where bugs will live.
- Offline jobs validated by spot-checking known-similar pairs (e.g. Heat → Ronin) in their output tables.
- API integration tests against a temp SQLite fixture set.

## Failure posture

- Catalog refresh failure → keep serving from the previous snapshot; log and retry next night.
- TMDB unreachable → enrichment pauses; skeleton catalog still serves.
- Model files absent/corrupt → component disabled, warning logged, recommendations still returned.
- Event ingestion is fire-and-forget from the client side; the service persists events before acking.
