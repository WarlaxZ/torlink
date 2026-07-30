/**
 * One episode, named as a unit — and nothing else, on purpose.
 *
 * WHY A MODULE OF ITS OWN. This shape was written out six times as an inline
 * `{ season: number; episode: number }`: `nextEpisode`'s return
 * (`src/core/streamHistory.ts`), the picker's hint (`src/util/nextEpisodeFile.ts`),
 * the Continue-watching row on the wire (`src/web/wire.ts`), the browser's play
 * flow twice (`src/web/static/streamFlow.ts`) and its DOM wiring
 * (`src/web/static/app.ts`). Structural typing means those copies can never fail
 * the build if they drift — an added optional field stays assignable everywhere —
 * which is exactly why they can.
 *
 * It is not in `release.ts` (the obvious home) and not in `wire.ts` (a consumer)
 * because `wire.ts` promises to import nothing, so that a browser bundle can
 * reference it and a daemon can implement it with no dependency either way. A
 * file with no imports at all keeps that promise literally true wherever it is
 * pulled in from, so no consumer has to argue about the fence.
 *
 * Both fields are REQUIRED, unlike `ParsedRelease`'s optional pair: this is an
 * episode something has committed to, not a parse that may have found only a
 * season.
 */
export interface EpisodeRef {
  season: number;
  episode: number;
}
