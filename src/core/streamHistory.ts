// What the user streamed, so a Continue-watching list can exist. Lives in
// src/core because both front ends write it and eslint forbids src/web
// importing src/ui — this is the front-end-agnostic middle they share.
//
// Deliberately NOT src/download/history.ts, which is completed downloads.
import { promises as fs } from "node:fs";
import path from "node:path";
import { streamHistoryFile, streamHistoryDir } from "../config/paths";
import { OWNER_PROFILE, isOwnerProfile } from "./profile";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";
import { parseRelease } from "../util/release";
import type { EpisodeRef } from "../util/episode";
// The key lives in src/util so the BROWSER can derive one too — this module
// imports node:fs, and src/web/static/** may not reach a Node builtin even
// transitively. Re-exported here because this is where every existing caller
// looks for it, and where its own doc comment explains what it is a key for.
import { historyKeyFor } from "../util/streamHistoryKey";
export { historyKeyFor };
import type { SourceId } from "../sources/types";

/**
 * One title the user streamed. ONE ENTRY PER TITLE, not per stream: the list
 * answers "what am I part-way through", and twenty rows of one series is the
 * opposite of that.
 */
export interface StreamHistoryItem {
  /** The group and dedupe key — see {@link historyKeyFor}. */
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
  const out: StreamHistoryItem = {
    key: historyKeyFor(parsed),
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
 * Advance a title's position from the file a player ACTUALLY opened.
 *
 * `historyItemFor` parses the TORRENT's name, so streaming E03 out of
 * "Harrowgate.S03.COMPLETE" stored a season and no episode — and `nextEpisode`
 * returns null without one, so there was nothing to offer. The season tree made
 * that the likely path rather than a corner case: a collapsed season row
 * resolves to its best season pack.
 *
 * Called from the hook both front ends already fire when a player launches
 * (`markPlayed` in the TUI, the `"watched"` action in the browser), so a failed
 * or cancelled stream never moves the mark.
 *
 * SAME HIGH-WATER RULE as `recordStream`, for the same reason: replaying an
 * early episode must not rewind your progress.
 *
 * Returns the SAME ARRAY REFERENCE when nothing changed. Callers use that as
 * their write gate, exactly as `markWatched` (src/util/favouriteList.ts) does —
 * this fires on every player launch, and churning the file on every re-watch is
 * what that avoids.
 */
export function recordPlayedFile(
  current: readonly StreamHistoryItem[],
  infoHash: string,
  filename: string,
): StreamHistoryItem[] {
  const item = current.find((e) => e.infoHash === infoHash);
  if (!item) return current as StreamHistoryItem[];
  const parsed = parseRelease(filename);
  if (parsed?.season === undefined || parsed.episode === undefined) {
    return current as StreamHistoryItem[];
  }
  const season = parsed.season;
  const episode = parsed.episode;
  const later =
    season !== (item.season ?? 0) ? season > (item.season ?? 0) : episode > (item.episode ?? 0);
  if (!later) return current as StreamHistoryItem[];
  return current.map((e) => (e.infoHash === infoHash ? { ...e, season, episode } : e));
}

/**
 * The episode to offer next, or null when there is nothing honest to offer.
 *
 * A SUGGESTION, never a claim the episode exists — nothing here has asked a
 * tracker. Null for a film, and null for a SEASON PACK: "Harrowgate.S03" parses
 * to a season with no episode, and guessing episode 1 would point the user at
 * something they may have already watched.
 */
export function nextEpisode(item: StreamHistoryItem): EpisodeRef | null {
  if (item.type !== "series") return null;
  if (item.season === undefined || item.episode === undefined) return null;
  return { season: item.season, episode: item.episode + 1 };
}

/**
 * "next S02E05", or "" when there is nothing honest to offer (see
 * `nextEpisode`). Shared by both front ends' Continue-watching UI so the
 * label is identical everywhere — `src/web` cannot import `src/ui`, and this
 * is the front-end-agnostic middle both may import instead.
 */
export function nextLabel(item: StreamHistoryItem): string {
  const next = nextEpisode(item);
  if (!next) return "";
  return `next S${String(next.season).padStart(2, "0")}E${String(next.episode).padStart(2, "0")}`;
}

export function removeStreamHistory(
  current: readonly StreamHistoryItem[],
  key: string,
): StreamHistoryItem[] {
  return current.filter((e) => e.key !== key);
}

/**
 * Forget one row: RE-READ the file, drop the key, write the rest back.
 *
 * The re-read is the whole point. The TUI holds `streamHistory` in React state
 * from startup, and `serve --web` is a SEPARATE PROCESS writing the same file —
 * so a remover that saved its own snapshot would silently delete every row the
 * browser recorded since the TUI loaded. `serializeWrites()` cannot help; it
 * orders writes within one process. Same rule as config writes from the web:
 * never hold a snapshot across a write.
 *
 * Rejects rather than swallowing (and never writes) when the read fails —
 * a caller in a TUI process must wrap this, or an unhandled rejection can take
 * the terminal down with it.
 */
export async function forgetStreamHistory(
  key: string,
  profileId: string = OWNER_PROFILE,
  deps: {
    load?: () => Promise<StreamHistoryItem[]>;
    save?: (items: readonly StreamHistoryItem[]) => Promise<void>;
  } = {},
): Promise<StreamHistoryItem[]> {
  const next = removeStreamHistory(await (deps.load ?? (() => loadStreamHistory(profileId)))(), key);
  await (deps.save ?? ((items) => saveStreamHistory(items, profileId)))(next);
  return next;
}

const write = serializeWrites();

// The owner keeps the legacy flat file; a friend gets its own file in a directory,
// so the feature never touches the owner's data on disk.
function fileFor(profileId: string): string {
  return isOwnerProfile(profileId) ? streamHistoryFile : path.join(streamHistoryDir, `${profileId}.json`);
}

export function saveStreamHistory(
  items: readonly StreamHistoryItem[],
  profileId: string = OWNER_PROFILE,
): Promise<void> {
  const file = fileFor(profileId);
  return write(async () => {
    // The per-friend directory does not exist until the first friend streams.
    if (!isOwnerProfile(profileId)) await fs.mkdir(streamHistoryDir, { recursive: true }).catch(() => {});
    await writeJsonAtomic(file, items.slice(0, STREAM_HISTORY_CAP));
  });
}

/** An unreadable or corrupt file is an empty list, exactly as `loadHistory` treats one. */
export async function loadStreamHistory(profileId: string = OWNER_PROFILE): Promise<StreamHistoryItem[]> {
  let raw: string;
  try {
    raw = await fs.readFile(fileFor(profileId), "utf8");
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
