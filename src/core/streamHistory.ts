// What the user streamed, so a Continue-watching list can exist. Lives in
// src/core because both front ends write it and eslint forbids src/web
// importing src/ui — this is the front-end-agnostic middle they share.
//
// Deliberately NOT src/download/history.ts, which is completed downloads.
import { promises as fs } from "node:fs";
import { streamHistoryFile } from "../config/paths";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";
import { parseRelease } from "../util/release";
import type { SourceId } from "../sources/types";

/**
 * One title the user streamed. ONE ENTRY PER TITLE, not per stream: the list
 * answers "what am I part-way through", and twenty rows of one series is the
 * opposite of that.
 */
export interface StreamHistoryItem {
  /** `parseRelease`'s key — the group and dedupe key. */
  key: string;
  /** "Kepler", never "Kepler.S02E04.1080p.WEB-DL-GROUP". */
  title: string;
  year?: number;
  type?: "movie" | "series";
  /**
   * The HIGHEST season/episode seen for this title. Independent of each other:
   * a season pack names a season and no episode.
   */
  season?: number;
  episode?: number;
  /** The release it came from, so a fallback search has something specific to ask. */
  rawName: string;
  infoHash: string;
  magnet: string;
  source?: SourceId;
  /** Epoch ms of the most recent stream of this title. */
  startedAt: number;
}

export const STREAM_HISTORY_CAP = 200;

/**
 * Build an entry from whatever a front end holds when a stream starts.
 *
 * Returns null when the release name carries no title — a name that is only
 * quality noise ("1080p.WEB-DL.x265") gives no row worth drawing, and this list
 * exists precisely so the user sees titles rather than release names.
 */
export function historyItemFor(
  input: { id: string; name: string; magnet: string; source?: SourceId },
  now: number,
): StreamHistoryItem | null {
  const parsed = parseRelease(input.name);
  if (!parsed) return null;
  // parse-torrent-title has no notion of "no title": given only quality noise
  // it hands back the leftover token as the title ("1080p.WEB-DL.x265" ->
  // "1080p"). A title that is just a resolution marker is not a title.
  if (/^\d{3,4}p$/i.test(parsed.title)) return null;
  const out: StreamHistoryItem = {
    key: parsed.key,
    title: parsed.title,
    rawName: input.name,
    infoHash: input.id,
    magnet: input.magnet,
    startedAt: now,
  };
  if (parsed.year !== undefined) out.year = parsed.year;
  if (parsed.type !== undefined) out.type = parsed.type;
  if (parsed.season !== undefined) out.season = parsed.season;
  if (parsed.episode !== undefined) out.episode = parsed.episode;
  if (input.source !== undefined) out.source = input.source;
  return out;
}

/** True when `next` is further through the series than `prev`. */
function isLaterThan(next: StreamHistoryItem, prev: StreamHistoryItem): boolean {
  const ns = next.season ?? 0;
  const ps = prev.season ?? 0;
  if (ns !== ps) return ns > ps;
  return (next.episode ?? 0) > (prev.episode ?? 0);
}

/**
 * Fold a stream into the list: newest title first, one entry per title.
 *
 * THE EPISODE IS A HIGH-WATER MARK, not the last thing played. Rewatching
 * S02E02 after S02E05 must leave "next" at S02E06 — otherwise finishing a
 * series and dipping back into an early episode silently rewinds your progress.
 * Everything else (startedAt, the torrent, the raw name) DOES take the new
 * value, because the row should rise to the top and point at the torrent that
 * actually worked.
 */
export function recordStream(
  current: readonly StreamHistoryItem[],
  item: StreamHistoryItem,
  limit = STREAM_HISTORY_CAP,
): StreamHistoryItem[] {
  const prev = current.find((e) => e.key === item.key);
  const merged: StreamHistoryItem = prev && !isLaterThan(item, prev)
    ? { ...item, ...(prev.season !== undefined ? { season: prev.season } : {}),
        ...(prev.episode !== undefined ? { episode: prev.episode } : {}) }
    : item;
  return [merged, ...current.filter((e) => e.key !== item.key)].slice(0, limit);
}

/**
 * The episode to offer next, or null when there is nothing honest to offer.
 *
 * A SUGGESTION, never a claim the episode exists — nothing here has asked a
 * tracker. Null for a film, and null for a SEASON PACK: "Harrowgate.S03" parses
 * to a season with no episode, and guessing episode 1 would point the user at
 * something they may have already watched.
 */
export function nextEpisode(item: StreamHistoryItem): { season: number; episode: number } | null {
  if (item.type !== "series") return null;
  if (item.season === undefined || item.episode === undefined) return null;
  return { season: item.season, episode: item.episode + 1 };
}

export function removeStreamHistory(
  current: readonly StreamHistoryItem[],
  key: string,
): StreamHistoryItem[] {
  return current.filter((e) => e.key !== key);
}

const write = serializeWrites();

export function saveStreamHistory(items: readonly StreamHistoryItem[]): Promise<void> {
  return write(() => writeJsonAtomic(streamHistoryFile, items.slice(0, STREAM_HISTORY_CAP)));
}

/** An unreadable or corrupt file is an empty list, exactly as `loadHistory` treats one. */
export async function loadStreamHistory(): Promise<StreamHistoryItem[]> {
  let raw: string;
  try {
    raw = await fs.readFile(streamHistoryFile, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStreamHistoryItem).slice(0, STREAM_HISTORY_CAP);
  } catch {
    return [];
  }
}

/** Drops hand-edited junk before it reaches a UI, mirroring `isFavouriteItem`. */
function isStreamHistoryItem(v: unknown): v is StreamHistoryItem {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.key === "string" && r.key.length > 0 &&
    typeof r.title === "string" && r.title.length > 0 &&
    typeof r.infoHash === "string" && r.infoHash.length > 0 &&
    typeof r.startedAt === "number"
  );
}
