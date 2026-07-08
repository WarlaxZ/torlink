import type { FavouriteItem } from "../config/config";

// Add the item if its id is absent (prepended, most-recent first), or remove it
// if already present — the toggle behind the `b` favourite key.
export function toggleFavourite(
  current: readonly FavouriteItem[],
  item: FavouriteItem,
  limit = 100,
): FavouriteItem[] {
  return current.some((f) => f.id === item.id)
    ? current.filter((f) => f.id !== item.id)
    : [item, ...current].slice(0, limit);
}

export function removeFavourite(current: readonly FavouriteItem[], id: string): FavouriteItem[] {
  return current.filter((f) => f.id !== id);
}

export function isFavourited(current: readonly FavouriteItem[], id: string): boolean {
  return current.some((f) => f.id === id);
}

// The watched episode filenames for a favourite, or an empty list when absent.
export function watchedFor(current: readonly FavouriteItem[], id: string): string[] {
  return current.find((f) => f.id === id)?.watched ?? [];
}

// Record an episode as watched for a favourite (deduped). Returns the same array
// reference when nothing changes (id absent, or already watched) so callers can
// skip a redundant write.
export function markWatched(
  current: readonly FavouriteItem[],
  id: string,
  filename: string,
): FavouriteItem[] {
  const item = current.find((f) => f.id === id);
  if (!item) return current as FavouriteItem[];
  if ((item.watched ?? []).includes(filename)) return current as FavouriteItem[];
  return current.map((f) =>
    f.id === id ? { ...f, watched: [...(f.watched ?? []), filename] } : f,
  );
}
