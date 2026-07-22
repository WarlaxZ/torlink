import { fetchResilient, HttpError, USER_AGENT } from "../../util/net";
import { unescapeEntities } from "../rss";
import { normalizeInfoHash } from "../magnet";
import type {
  SearchOptions,
  Source,
  SourceGroup,
  SourceId,
  TorrentResult,
} from "../types";
import {
  AuthRequiredError,
  decodeCp1251,
  getSession,
  loadSession,
  RUTRACKER_HOSTS,
} from "./session";

export { AuthRequiredError } from "./session";

const MAX_DETAILS = 12;

interface Row {
  topicId: string;
  name: string;
  group: RutrackerGroup;
  seeders: number;
  leechers: number;
  sizeBytes: number;
  added?: number;
}

// RuTracker never feeds the adult category, so drop "Porn" from its group set.
type RutrackerGroup = Exclude<SourceGroup, "Porn">;

const SECTION_GROUP: Record<string, RutrackerGroup> = {
  "Сериалы": "TV",
  "Игры": "Games",
  "Кино, Видео и ТВ": "Movies",
  "Документалистика и юмор": "Movies",
  "Книги и журналы": "Books",
  "Обучение иностранным языкам": "Books",
  "Аудиокниги": "Books",
  "Музыка": "Music",
};

const ANIME_RE = /аниме|anime|манга|manga|ранобэ/i;

const KEYWORD_RULES: { group: RutrackerGroup; re: RegExp }[] = [
  { group: "Anime", re: ANIME_RE },
  { group: "TV", re: /сериал|телесериал/i },
  { group: "Games", re: /игр|game|консол|playstation|xbox|nintendo|ps[2345]|repack/i },
  { group: "Movies", re: /кино|фильм|видео|мультфильм|movie/i },
  { group: "Books", re: /книг|журнал|литератур|аудиокниг|учебник/i },
  { group: "Music", re: /музык|рок|джаз|классик|саундтрек|lossless|flac/i },
];

const GROUP_SOURCE: Record<RutrackerGroup, SourceId> = {
  Games: "rt-games",
  Movies: "rt-movies",
  TV: "rt-tv",
  Anime: "rt-anime",
  Music: "rt-music",
  Books: "rt-books",
};

interface ForumNode {
  name: string;
  parent?: number;
  section: string;
}

export function buildGroupMap(html: string): Map<number, RutrackerGroup> {
  const sel = html.match(/<select[^>]*name="f\[\]"[\s\S]*?<\/select>/i)?.[0];
  if (!sel) return new Map();

  const nodes = new Map<number, ForumNode>();
  const re = /<optgroup label="([^"]*)"|<option[^>]*value="(-?\d+)"[^>]*class='([^']*)'[^>]*>([\s\S]*?)<\/option>/g;
  let section = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(sel))) {
    if (m[1] !== undefined) {
      section = stripTags(m[1]);
      continue;
    }

    const id = Number(m[2]);
    if (id < 0) continue;

    const parent = m[3]!.match(/fp-(\d+)/);
    const name = stripTags(m[4]!).replace(/^\|-\s*/, "");

    nodes.set(id, { name, parent: parent ? Number(parent[1]) : undefined, section });
  }

  const isAnime = (id: number): boolean => {
    let cur: number | undefined = id;
    for (let i = 0; cur !== undefined && i < 12; i++) {
      const node = nodes.get(cur);
      if (!node) break;
      if (ANIME_RE.test(node.name)) return true;
      cur = node.parent;
    }

    return false;
  };

  const out = new Map<number, RutrackerGroup>();
  for (const [id, node] of nodes) {
    const group =
      node.section === "Сериалы"
        ? "TV"
        : isAnime(id)
          ? "Anime"
          : SECTION_GROUP[node.section];
    if (group) out.set(id, group);
  }

  return out;
}

function keywordGroup(forum: string): RutrackerGroup | null {
  for (const r of KEYWORD_RULES) if (r.re.test(forum)) return r.group;
  return null;
}

function stripTags(html: string): string {
  return unescapeEntities(
    html
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export function parseRows(html: string, groupMap?: Map<number, RutrackerGroup>): Row[] {
  const map = groupMap ?? buildGroupMap(html);
  const start = html.indexOf("tor-tbl");
  const body = start >= 0 ? html.slice(start) : html;
  const out: Row[] = [];
  for (const tr of body.split(/<tr[\s>]/i).slice(1)) {
    const topic = tr.match(/viewtopic\.php\?t=(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!topic) continue;
    const name = stripTags(topic[2]!);
    if (!name) continue;
    const forumLink = tr.match(/tracker\.php\?f=(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
    const forumId = forumLink ? Number(forumLink[1]) : undefined;
    const group =
      (forumId !== undefined ? map.get(forumId) : undefined) ??
      keywordGroup(stripTags(forumLink?.[2] ?? ""));
    if (!group) continue;
    const sizeBytes = Number(
      tr.match(/class="[^"]*tor-size[^"]*"[^>]*data-ts_text="(\d+)"/i)?.[1] ??
      0,
    );
    const seeders = Number(
      tr.match(/class="[^"]*seedmed[^"]*"[^>]*>\s*(\d+)/i)?.[1] ?? 0,
    );
    const leechers = Number(
      tr.match(/class="[^"]*leechmed[^"]*"[^>]*>\s*(\d+)/i)?.[1] ?? 0,
    );
    const stamps = [...tr.matchAll(/data-ts_text="(\d{9,11})"/gi)].map((mm) =>
      Number(mm[1]),
    );
    const added = stamps
      .reverse()
      .find((n) => n >= 1_000_000_000 && n <= 4_000_000_000);
    out.push({
      topicId: topic[1]!,
      name,
      group,
      seeders,
      leechers,
      sizeBytes,
      added,
    });
  }
  return out;
}

async function fetchText(
  url: string,
  cookie: string,
  opts: SearchOptions,
  retries: number,
): Promise<{ html: string; status: number }> {
  const res = await fetchResilient(url, {
    headers: { "User-Agent": USER_AGENT, Cookie: cookie },
    signal: opts.signal,
    retries,
  });
  const html = decodeCp1251(await res.arrayBuffer());
  return { html, status: res.status };
}

async function topicMagnet(
  base: string,
  cookie: string,
  topicId: string,
  opts: SearchOptions,
): Promise<string | null> {
  try {
    const { html } = await fetchText(
      `${base}/forum/viewtopic.php?t=${topicId}`,
      cookie,
      opts,
      1,
    );
    const raw = html.match(/magnet:\?xt=urn:btih:[^"'<>\s]+/i)?.[0];
    return raw ? unescapeEntities(raw) : null;
  } catch {
    return null;
  }
}

interface FetchEntry {
  at: number;
  cookie: string;
  promise: Promise<TorrentResult[]>;
}
const FETCH_TTL_MS = 60_000;
const inflight = new Map<string, FetchEntry>();

async function fetchAll(
  query: string,
  opts: SearchOptions,
): Promise<TorrentResult[]> {
  await loadSession();
  const session = getSession();
  if (!session) throw new AuthRequiredError();

  const q = query.trim();
  const path = q
    ? `/forum/tracker.php?nm=${encodeURIComponent(q)}`
    : `/forum/tracker.php?nm=`;

  let base = "";
  let html = "";
  let lastError: unknown;
  for (const host of RUTRACKER_HOSTS) {
    try {
      const candidate = `https://${host}`;
      const res = await fetchText(
        `${candidate}${path}`,
        session.cookie,
        opts,
        2,
      );
      if (/id="login-form|name="login_username"/i.test(res.html) && !res.html.includes("tor-tbl")) {
        throw new AuthRequiredError(
          "Rutracker session expired — log in again.",
        );
      }
      html = res.html;
      base = candidate;
      break;
    } catch (e) {
      if (opts.signal?.aborted || e instanceof AuthRequiredError) throw e;
      lastError = e;
    }
  }

  if (!base) {
    throw lastError instanceof Error ? lastError : new HttpError(0, "Rutracker unreachable");
  }

  const rows = parseRows(html, buildGroupMap(html));
  rows.sort((a, b) => b.seeders - a.seeders);
  const top = rows.slice(0, MAX_DETAILS);

  const settled = await Promise.all(
    top.map(async (row): Promise<TorrentResult | null> => {
      const magnet = await topicMagnet(base, session.cookie, row.topicId, opts);
      const infoHash = magnet?.match(/urn:btih:([a-z0-9]+)/i)?.[1];
      if (!magnet || !infoHash) return null;
      return {
        infoHash: normalizeInfoHash(infoHash),
        name: row.name,
        sizeBytes: row.sizeBytes,
        seeders: row.seeders,
        leechers: row.leechers,
        source: GROUP_SOURCE[row.group],
        magnet,
        added: row.added,
      };
    }),
  );
  return settled.filter((r): r is TorrentResult => r !== null);
}

function sharedFetch(
  query: string,
  opts: SearchOptions,
): Promise<TorrentResult[]> {
  const session = getSession();
  const key = query.trim().toLowerCase();
  const hit = inflight.get(key);
  if (
    hit &&
    Date.now() - hit.at < FETCH_TTL_MS &&
    hit.cookie === (session?.cookie ?? "")
  ) {
    return hit.promise;
  }
  const promise = fetchAll(query, opts);
  inflight.set(key, { at: Date.now(), cookie: session?.cookie ?? "", promise });
  promise.catch(() => inflight.delete(key));
  return promise;
}

export function clearRutrackerCache(): void {
  inflight.clear();
}

function makeSource(id: SourceId, group: SourceGroup): Source {
  return {
    id,
    label: "RuTracker",
    groups: [group],
    homepage: "https://rutracker.org",
    reportsHealth: true,
    search: async (query, opts = {}) => {
      const all = await sharedFetch(query, opts);
      return all.filter((r) => r.source === id);
    },
  };
}

export const rutrackerGames = makeSource("rt-games", "Games");
export const rutrackerMovies = makeSource("rt-movies", "Movies");
export const rutrackerTv = makeSource("rt-tv", "TV");
export const rutrackerAnime = makeSource("rt-anime", "Anime");
export const rutrackerMusic = makeSource("rt-music", "Music");
export const rutrackerBooks = makeSource("rt-books", "Books");
