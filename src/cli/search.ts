import type { SearchCategory } from "./args";
import { SOURCES, sourcesByGroup } from "../sources/registry";
import { runSearch as runConcurrentSearch } from "../core/search";
import type { Source, SourceGroup, SourceId, TorrentResult } from "../sources/types";

type OutputCategory = SearchCategory | "all";

interface SourceOutcome {
  ok: boolean;
  count: number;
  error: string | null;
  code: string | null;
}

export interface SearchDocument {
  query: string;
  category: OutputCategory;
  count: number;
  sources: Partial<Record<SourceId, SourceOutcome>>;
  results: TorrentResult[];
}

export interface SearchExecution {
  document: SearchDocument;
  exitCode: 0 | 1;
}

const GROUPS: Record<SearchCategory, SourceGroup> = {
  games: "Games",
  movies: "Movies",
  tv: "TV",
  anime: "Anime",
};

function selectSources(category: OutputCategory): readonly Source[] {
  if (category === "all") return SOURCES;
  return sourcesByGroup().find(({ group }) => group === GROUPS[category])?.sources ?? [];
}

// Reuses the same concurrent-search machinery as the TUI and browser UI (source
// health/benching, per-source timeouts, dedupe and default ordering), so a
// headless `search` reports exactly what an interactive search would.
export async function runSearch(options: {
  query: string;
  category?: SearchCategory;
  signal?: AbortSignal;
}): Promise<SearchExecution> {
  const category = options.category ?? "all";
  // A fresh health map every call: this process exits after one search, so
  // there is no later request for a benched source's cooldown to protect —
  // unlike the TUI/daemon, which share `sourceHealth` across a long-running
  // session.
  const snapshot = await runConcurrentSearch(options.query, selectSources(category), {
    signal: options.signal,
    health: new Map(),
  });

  const sources: Partial<Record<SourceId, SourceOutcome>> = {};
  for (const [id, state] of Object.entries(snapshot.perSource) as Array<
    [SourceId, (typeof snapshot.perSource)[SourceId]]
  >) {
    sources[id] = {
      ok: state.error === null,
      count: state.count,
      error: state.error,
      code: state.code,
    };
  }

  return {
    document: {
      query: options.query,
      category,
      count: snapshot.results.length,
      sources,
      results: snapshot.results,
    },
    exitCode: Object.values(sources).some((s) => s?.ok) ? 0 : 1,
  };
}
