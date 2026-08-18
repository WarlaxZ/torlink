import { describe, it, expect } from "vitest";
import { buildPlayedIndex, playedStateFor, seriesPosition } from "./playedState";

// Structural rows standing in for StreamHistoryItem / PublicStreamHistoryItem.
const film = (key: string) => ({ key, type: "movie" as const });
const ep = (key: string, season: number, episode: number) => ({
  key,
  type: "series" as const,
  season,
  episode,
});

describe("buildPlayedIndex + playedStateFor", () => {
  it("marks a film played when its derived key is in history", () => {
    // historyKeyFor for a film is the parser's full key: normalisedTitle|year|movie.
    const idx = buildPlayedIndex([film("kestrel|2010|movie")]);
    expect(playedStateFor("Kestrel.2010.1080p.BluRay.x264-GROUP", idx).played).toBe(true);
  });

  it("does not mark an unrelated film", () => {
    const idx = buildPlayedIndex([film("kestrel|2010|movie")]);
    expect(playedStateFor("Ashfall.1999.1080p", idx).played).toBe(false);
  });

  it("marks a series episode played and reports the high-water episode", () => {
    const idx = buildPlayedIndex([ep("kepler|series", 2, 4)]);
    const state = playedStateFor("Kepler.S02E04.1080p.WEB-DL", idx);
    expect(state.played).toBe(true);
    expect(state.upTo).toEqual({ season: 2, episode: 4 });
  });

  it("marks a later episode of a watched series played (title-level)", () => {
    const idx = buildPlayedIndex([ep("kepler|series", 2, 4)]);
    // A different episode of the same show still counts as watched at title level.
    expect(playedStateFor("Kepler.S02E07.1080p.WEB-DL", idx).played).toBe(true);
  });

  it("exposes series position by show key for the TUI's season rows", () => {
    const idx = buildPlayedIndex([ep("harrowgate|series", 3, 5)]);
    expect(seriesPosition("harrowgate", idx)).toEqual({ season: 3, episode: 5 });
    expect(seriesPosition("kestrel", idx)).toBeNull();
  });

  it("degrades to not-played on an empty index", () => {
    const idx = buildPlayedIndex([]);
    expect(playedStateFor("Kestrel.2010.1080p.BluRay.x264-GROUP", idx).played).toBe(false);
  });
});
