import { describe, expect, it } from "vitest";
import type { FavouriteItem } from "../config/config";
import {
  toggleFavourite,
  removeFavourite,
  isFavourited,
  watchedFor,
  markWatched,
} from "./favourites";

const fav = (id: string, extra: Partial<FavouriteItem> = {}): FavouriteItem => ({
  id,
  name: `name-${id}`,
  magnet: `magnet-${id}`,
  addedAt: 0,
  ...extra,
});

describe("toggleFavourite", () => {
  it("adds, removes by id, and caps at the limit", () => {
    expect(toggleFavourite([], fav("a")).map((f) => f.id)).toEqual(["a"]);
    expect(toggleFavourite([fav("a")], fav("a"))).toEqual([]);
    // Prepends and caps.
    expect(toggleFavourite([fav("a"), fav("b")], fav("c"), 2).map((f) => f.id)).toEqual(["c", "a"]);
  });

  it("removes by id even when other fields differ", () => {
    expect(toggleFavourite([fav("a", { name: "old" })], fav("a", { name: "new" }))).toEqual([]);
  });
});

describe("removeFavourite / isFavourited / watchedFor", () => {
  it("removes and reports membership", () => {
    expect(removeFavourite([fav("a"), fav("b")], "a").map((f) => f.id)).toEqual(["b"]);
    expect(isFavourited([fav("a")], "a")).toBe(true);
    expect(isFavourited([fav("a")], "z")).toBe(false);
  });

  it("returns the item's watched list or an empty array", () => {
    expect(watchedFor([fav("a", { watched: ["ep1"] })], "a")).toEqual(["ep1"]);
    expect(watchedFor([fav("a")], "a")).toEqual([]);
    expect(watchedFor([fav("a")], "z")).toEqual([]);
  });
});

describe("markWatched", () => {
  it("adds a filename to the item's watched list", () => {
    const next = markWatched([fav("a", { watched: ["ep1"] })], "a", "ep2");
    expect(watchedFor(next, "a")).toEqual(["ep1", "ep2"]);
  });

  it("dedupes and returns the same reference when unchanged", () => {
    const current = [fav("a", { watched: ["ep1"] })];
    expect(markWatched(current, "a", "ep1")).toBe(current);
  });

  it("is a no-op (same reference) when the id is absent", () => {
    const current = [fav("a")];
    expect(markWatched(current, "z", "ep1")).toBe(current);
  });
});
