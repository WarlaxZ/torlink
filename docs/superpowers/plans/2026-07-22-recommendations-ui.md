# "For You" Recommendations UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "For You" section to torlink that fetches ranked picks from the reccd service (`GET /recommendations`) and lets the user launch a torrent search for any pick, closing the loop with the existing event-posting integration.

**Architecture:** A blocking `fetchRecommendations` client method (sibling to the fire-and-forget `postEvent`) returns a discriminated result. A `useRecommendations` hook owns fetch state + filters. A presentational `ForYou` component renders the list, cycles filters, and on Enter calls `setSection` + `submitQuery` to start a torrent search. A small `GenrePrompt` handles free-text genre entry. A `resolveReccConfig` helper adds env overrides and replaces the six inline reccd-config literals in `App.tsx`.

**Tech Stack:** TypeScript, React + Ink (terminal UI), Vitest, `ink-testing-library`, `undici` fetch. Tests run with `npx vitest run <path>`; typecheck with `npx tsc --noEmit`.

**Working directory:** `/home/ash/projects/torlink/.claude/worktrees/squishy-snuggling-bengio` (branch `docs/recommendation-engine-spec`). Run all commands there.

**Spec:** `docs/superpowers/specs/2026-07-22-recommendations-ui-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/recc/client.ts` (modify) | Add `Recommendation`, `RecommendationQuery`, `FetchRecommendationsResult` types + `fetchRecommendations`. |
| `src/recc/client.test.ts` (modify) | Tests for `fetchRecommendations`. |
| `src/config/config.ts` (modify) | Add `resolveReccConfig(config)` with env overrides. |
| `src/config/config.test.ts` (modify) | Tests for `resolveReccConfig`. |
| `src/ui/components/GenrePrompt.tsx` (create) | Free-text genre filter prompt. |
| `src/ui/components/GenrePrompt.test.tsx` (create) | Tests for GenrePrompt. |
| `src/ui/hooks/useRecommendations.ts` (create) | Fetch state + filters for the For You view. |
| `src/ui/components/ForYou.tsx` (create) | Presentational recommendations list + input handling. |
| `src/ui/components/ForYou.test.tsx` (create) | Tests for ForYou (also exercises the hook). |
| `src/ui/store.ts` (modify) | Add `"forYou"` to `Section`; exclude it in `isCategory`. |
| `src/ui/components/Sidebar.tsx` (modify) | Add "For You" nav item. |
| `src/ui/App.tsx` (modify) | Render `<ForYou/>`; replace inline reccd-config literals with `resolveReccConfig`. |
| `src/ui/keymap.ts` (modify) | For You footer hints + help group. |

---

## Task 1: `fetchRecommendations` client method

**Files:**
- Modify: `src/recc/client.ts`
- Test: `src/recc/client.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/recc/client.test.ts` (keep existing imports; add `fetchRecommendations` to the import from `./client` and add `import type { FetchImpl } from "../util/net";` if not present):

```ts
import { describe, it, expect } from "vitest";
import { fetchRecommendations } from "./client";
import type { FetchImpl } from "../util/net";

function fakeFetch(
  handler: (url: string) => { status: number; body?: unknown; throwErr?: boolean },
): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    const r = handler(String(url));
    if (r.throwErr) throw new Error("network down");
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, urls };
}

const CONFIG = { reccUrl: "http://host:4100", reccToken: "tok" };
const REC = { imdbId: "tt1", title: "Chernobyl", year: 2019, score: 33.4, reasons: ["highly rated classic"] };

describe("fetchRecommendations", () => {
  it("returns ok with parsed items on 200", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [REC] }));
    const res = await fetchRecommendations(CONFIG, { limit: 5 }, { fetchImpl: impl });
    expect(res).toEqual({ ok: true, items: [REC] });
  });

  it("builds the query string from provided filters", async () => {
    const { impl, urls } = fakeFetch(() => ({ status: 200, body: [] }));
    await fetchRecommendations(CONFIG, { type: "movie", genre: "Western", explore: true, limit: 5 }, { fetchImpl: impl });
    expect(urls[0]).toContain("/recommendations?");
    expect(urls[0]).toContain("type=movie");
    expect(urls[0]).toContain("genre=Western");
    expect(urls[0]).toContain("explore=true");
    expect(urls[0]).toContain("limit=5");
  });

  it("omits type/genre/explore when unset and defaults limit to 20", async () => {
    const { impl, urls } = fakeFetch(() => ({ status: 200, body: [] }));
    await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(urls[0]).not.toContain("type=");
    expect(urls[0]).not.toContain("genre=");
    expect(urls[0]).not.toContain("explore=");
    expect(urls[0]).toContain("limit=20");
  });

  it("maps 401 to a token error", async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "reccd rejected the token — check reccToken" });
  });

  it("maps other non-2xx to an unavailable error", async () => {
    const { impl } = fakeFetch(() => ({ status: 500 }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "recommendations unavailable (HTTP 500)" });
  });

  it("maps a network throw to an unreachable error", async () => {
    const { impl } = fakeFetch(() => ({ status: 0, throwErr: true }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "couldn't reach reccd" });
  });

  it("rejects a malformed body", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [{ imdbId: 1 }] }));
    const res = await fetchRecommendations(CONFIG, {}, { fetchImpl: impl });
    expect(res).toEqual({ ok: false, error: "unexpected response from reccd" });
  });

  it("returns a not-configured error when reccUrl is missing", async () => {
    const res = await fetchRecommendations({ reccToken: "t" }, {});
    expect(res).toEqual({ ok: false, error: "recommendations not configured" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/recc/client.test.ts`
Expected: FAIL — `fetchRecommendations` is not exported.

- [ ] **Step 3: Implement `fetchRecommendations`**

Append to `src/recc/client.ts` (after `postEvent`; `FetchImpl` is already imported at the top):

```ts
export interface Recommendation {
  imdbId: string;
  title: string;
  year: number;
  score: number;
  reasons: string[];
}

export interface RecommendationQuery {
  type?: "movie" | "tv";
  genre?: string;
  explore?: boolean;
  limit?: number;
}

export type FetchRecommendationsResult =
  | { ok: true; items: Recommendation[] }
  | { ok: false; error: string };

function isRecommendation(v: unknown): v is Recommendation {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.imdbId === "string" &&
    typeof r.title === "string" &&
    typeof r.year === "number" &&
    typeof r.score === "number" &&
    Array.isArray(r.reasons) &&
    r.reasons.every((x) => typeof x === "string")
  );
}

// A blocking read, unlike the fire-and-forget postEvent: the user is waiting on
// these results, so failures are surfaced as a discriminated result rather than
// swallowed. reccd returns no magnet — the caller starts a torrent search from
// the returned title.
export async function fetchRecommendations(
  config: ReccClientConfig,
  query: RecommendationQuery,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<FetchRecommendationsResult> {
  if (!config.reccUrl) return { ok: false, error: "recommendations not configured" };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.genre && query.genre.trim()) params.set("genre", query.genre.trim());
  if (query.explore) params.set("explore", "true");
  params.set("limit", String(query.limit ?? 20));
  try {
    const res = await fetchImpl(`${config.reccUrl}/recommendations?${params.toString()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.reccToken ?? ""}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
    });
    if (res.status === 401) return { ok: false, error: "reccd rejected the token — check reccToken" };
    if (!res.ok) return { ok: false, error: `recommendations unavailable (HTTP ${res.status})` };
    const body: unknown = await res.json();
    if (!Array.isArray(body) || !body.every(isRecommendation)) {
      return { ok: false, error: "unexpected response from reccd" };
    }
    return { ok: true, items: body };
  } catch {
    return { ok: false, error: "couldn't reach reccd" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/recc/client.test.ts`
Expected: PASS (all `fetchRecommendations` tests + existing `postEvent` tests).

- [ ] **Step 5: Commit**

```bash
git add src/recc/client.ts src/recc/client.test.ts
git commit -m "feat(recc): add blocking fetchRecommendations client method"
```

---

## Task 2: `resolveReccConfig` env-aware helper

**Files:**
- Modify: `src/config/config.ts`
- Test: `src/config/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/config/config.test.ts` (add `resolveReccConfig` to the existing import from `./config`):

```ts
describe("resolveReccConfig", () => {
  const base = { downloadDir: "/tmp/dl", trackers: [] as string[] };

  it("uses config values when no env override is set", () => {
    delete process.env.TORLINK_RECC_URL;
    delete process.env.TORLINK_RECC_TOKEN;
    expect(resolveReccConfig({ ...base, reccUrl: "http://host:4100", reccToken: "tok" })).toEqual({
      reccUrl: "http://host:4100",
      reccToken: "tok",
    });
  });

  it("prefers env vars over config values", () => {
    process.env.TORLINK_RECC_URL = "http://env:4100";
    process.env.TORLINK_RECC_TOKEN = "envtok";
    try {
      expect(resolveReccConfig({ ...base, reccUrl: "http://host:4100", reccToken: "tok" })).toEqual({
        reccUrl: "http://env:4100",
        reccToken: "envtok",
      });
    } finally {
      delete process.env.TORLINK_RECC_URL;
      delete process.env.TORLINK_RECC_TOKEN;
    }
  });

  it("returns undefined fields when neither env nor config is set", () => {
    delete process.env.TORLINK_RECC_URL;
    delete process.env.TORLINK_RECC_TOKEN;
    expect(resolveReccConfig({ ...base })).toEqual({ reccUrl: undefined, reccToken: undefined });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/config/config.test.ts`
Expected: FAIL — `resolveReccConfig` is not exported.

- [ ] **Step 3: Implement `resolveReccConfig`**

Add to `src/config/config.ts`. At the top with the other imports:

```ts
import type { ReccClientConfig } from "../recc/client";
```

After the existing `resolveDnsServers` function (near line 112), add:

```ts
const RECC_URL_ENV = "TORLINK_RECC_URL";
const RECC_TOKEN_ENV = "TORLINK_RECC_TOKEN";

// The effective reccd connection (env wins over config, matching the other
// resolve* helpers). An undefined reccUrl means "recommendations not
// configured" — the For You view then shows a setup hint instead of fetching.
export function resolveReccConfig(config: Config): ReccClientConfig {
  const url = process.env[RECC_URL_ENV]?.trim() || config.reccUrl?.trim() || undefined;
  const token = process.env[RECC_TOKEN_ENV]?.trim() || config.reccToken?.trim() || undefined;
  return { reccUrl: url, reccToken: token };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/config/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts src/config/config.test.ts
git commit -m "feat(config): add resolveReccConfig with env overrides"
```

---

## Task 3: `GenrePrompt` component

**Files:**
- Create: `src/ui/components/GenrePrompt.tsx`
- Test: `src/ui/components/GenrePrompt.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/GenrePrompt.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { GenrePrompt } from "./GenrePrompt";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const ESC = String.fromCharCode(27);

describe("GenrePrompt", () => {
  it("submits the typed genre on enter", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(<GenrePrompt width={40} value="" onSubmit={onSubmit} onCancel={onCancel} />);
    await flush();
    stdin.write("Western");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("Western");
  });

  it("cancels on escape", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(<GenrePrompt width={40} value="" onSubmit={onSubmit} onCancel={onCancel} />);
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/components/GenrePrompt.test.tsx`
Expected: FAIL — cannot find `./GenrePrompt`.

- [ ] **Step 3: Implement `GenrePrompt`**

Create `src/ui/components/GenrePrompt.tsx` (mirrors `FolderPrompt.tsx`):

```tsx
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { PromptHints } from "./PromptHints";
import { COLOR, ICON } from "../theme";

interface GenrePromptProps {
  width: number;
  value: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

// Free-text genre filter for the For You view. reccd treats genre as an open
// string, so this is a plain text field; an empty submission clears the filter.
export function GenrePrompt({ width, value, onSubmit, onCancel }: GenrePromptProps) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="filter by genre" width={width} focused height={2}>
        <Box>
          <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
          <Box flexGrow={1} minWidth={0}>
            <TextField defaultValue={value} placeholder="e.g. Western — empty clears" onSubmit={onSubmit} />
          </Box>
        </Box>
      </Panel>
      <Box marginTop={1}>
        <PromptHints submitLabel="filter" />
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/components/GenrePrompt.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/GenrePrompt.tsx src/ui/components/GenrePrompt.test.tsx
git commit -m "feat(ui): add GenrePrompt free-text filter component"
```

---

## Task 4: `useRecommendations` hook + `ForYou` view

**Files:**
- Create: `src/ui/hooks/useRecommendations.ts`
- Create: `src/ui/components/ForYou.tsx`
- Test: `src/ui/components/ForYou.test.tsx` (drives the hook through the component)

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/ForYou.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ForYou } from "./ForYou";
import type { FetchImpl } from "../../util/net";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const REC = { imdbId: "tt1", title: "Chernobyl", year: 2019, score: 33.4, reasons: ["highly rated classic"] };
const CONFIG = { reccUrl: "http://host:4100", reccToken: "tok" };

function fetchStub(): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => [REC] } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, urls };
}

describe("ForYou", () => {
  it("fetches and renders picks once active", async () => {
    const { impl } = fetchStub();
    const { lastFrame } = render(
      <ForYou reccConfig={CONFIG} active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    expect(lastFrame()).toContain("Chernobyl");
    expect(lastFrame()).toContain("2019");
  });

  it("shows a setup hint when reccUrl is unset", async () => {
    const { impl } = fetchStub();
    const { lastFrame } = render(
      <ForYou reccConfig={{}} active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    expect(lastFrame()).toContain("set up");
  });

  it("cycles the type filter with 't' and refetches", async () => {
    const { impl, urls } = fetchStub();
    const { stdin } = render(
      <ForYou reccConfig={CONFIG} active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    stdin.write("t");
    await flush();
    expect(urls.some((u) => u.includes("type=movie"))).toBe(true);
  });

  it("searches the selected title on enter", async () => {
    const { impl } = fetchStub();
    const setSection = vi.fn();
    const submitQuery = vi.fn();
    const { stdin } = render(
      <ForYou reccConfig={CONFIG} active setSection={setSection} submitQuery={submitQuery} fetchImpl={impl} />,
    );
    await flush();
    stdin.write("\r");
    await flush();
    expect(submitQuery).toHaveBeenCalledWith("Chernobyl");
    expect(setSection).toHaveBeenCalledWith("all");
  });

  it("shows an error when the fetch fails", async () => {
    const impl = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as FetchImpl;
    const { lastFrame } = render(
      <ForYou reccConfig={CONFIG} active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    expect(lastFrame()).toContain("unavailable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/components/ForYou.test.tsx`
Expected: FAIL — cannot find `./ForYou`.

- [ ] **Step 3: Implement the hook**

Create `src/ui/hooks/useRecommendations.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { FetchImpl } from "../../util/net";
import {
  fetchRecommendations,
  type ReccClientConfig,
  type Recommendation,
  type RecommendationQuery,
} from "../../recc/client";

export type ReccType = "all" | "movie" | "tv";

export interface RecommendationsState {
  items: Recommendation[];
  loading: boolean;
  error: string | null;
  type: ReccType;
  genre: string;
  explore: boolean;
  refresh: () => void;
  setType: (t: ReccType) => void;
  setGenre: (g: string) => void;
  toggleExplore: () => void;
}

// Owns the For You view's fetch state and filters. Fetches lazily — only once
// the section is first visited (`enabled`), then again on refresh or any filter
// change. A request counter guards against an older in-flight response landing
// after a newer one.
export function useRecommendations(
  config: ReccClientConfig,
  enabled: boolean,
  fetchImpl?: FetchImpl,
): RecommendationsState {
  const [items, setItems] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [type, setTypeState] = useState<ReccType>("all");
  const [genre, setGenreState] = useState("");
  const [explore, setExplore] = useState(false);
  const loadedRef = useRef(false);
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!config.reccUrl) {
      setItems([]);
      setError(null);
      return;
    }
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    const query: RecommendationQuery = {
      type: type === "all" ? undefined : type,
      genre: genre.trim() || undefined,
      explore,
      limit: 20,
    };
    const result = await fetchRecommendations(config, query, { fetchImpl });
    if (req !== reqRef.current) return; // superseded by a newer request
    if (result.ok) {
      setItems(result.items);
      setError(null);
    } else {
      setItems([]);
      setError(result.error);
    }
    setLoading(false);
  }, [config, type, genre, explore, fetchImpl]);

  // Lazy first load: once, on first activation.
  useEffect(() => {
    if (enabled && !loadedRef.current && config.reccUrl) {
      loadedRef.current = true;
      void load();
    }
  }, [enabled, config.reccUrl, load]);

  // Refetch on filter change, but only after the first load has happened.
  useEffect(() => {
    if (loadedRef.current) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, genre, explore]);

  const refresh = useCallback(() => void load(), [load]);
  const setType = useCallback((t: ReccType) => setTypeState(t), []);
  const setGenre = useCallback((g: string) => setGenreState(g), []);
  const toggleExplore = useCallback(() => setExplore((v) => !v), []);

  return { items, loading, error, type, genre, explore, refresh, setType, setGenre, toggleExplore };
}
```

- [ ] **Step 4: Implement the `ForYou` component**

Create `src/ui/components/ForYou.tsx`:

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FetchImpl } from "../../util/net";
import type { ReccClientConfig } from "../../recc/client";
import type { Section } from "../store";
import { useRecommendations, type ReccType } from "../hooks/useRecommendations";
import { GenrePrompt } from "./GenrePrompt";
import { COLOR, ICON } from "../theme";
import { cleanText, truncate } from "../../util/format";

interface ForYouProps {
  reccConfig: ReccClientConfig;
  active: boolean;
  setSection: (s: Section) => void;
  submitQuery: (q: string) => void;
  fetchImpl?: FetchImpl;
  width?: number;
}

const NEXT_TYPE: Record<ReccType, ReccType> = { all: "movie", movie: "tv", tv: "all" };
const TYPE_SECTION: Record<ReccType, Section> = { all: "all", movie: "movies", tv: "tv" };

export function ForYou({ reccConfig, active, setSection, submitQuery, fetchImpl, width = 60 }: ForYouProps) {
  const recs = useRecommendations(reccConfig, active, fetchImpl);
  const [selected, setSelected] = useState(0);
  const [editingGenre, setEditingGenre] = useState(false);

  const configured = Boolean(reccConfig.reccUrl);
  const count = recs.items.length;

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setSelected((i) => (count ? (i - 1 + count) % count : 0));
      else if (key.downArrow || input === "j") setSelected((i) => (count ? (i + 1) % count : 0));
      else if (input === "t") { setSelected(0); recs.setType(NEXT_TYPE[recs.type]); }
      else if (input === "e") { setSelected(0); recs.toggleExplore(); }
      else if (input === "g") setEditingGenre(true);
      else if (input === "r") recs.refresh();
      else if (key.return) {
        const item = recs.items[selected];
        if (item) {
          setSection(TYPE_SECTION[recs.type]);
          submitQuery(item.title);
        }
      }
    },
    { isActive: active && configured && !editingGenre },
  );

  if (editingGenre) {
    return (
      <GenrePrompt
        width={width}
        value={recs.genre}
        onSubmit={(g) => {
          setEditingGenre(false);
          setSelected(0);
          recs.setGenre(g.trim());
        }}
        onCancel={() => setEditingGenre(false)}
      />
    );
  }

  if (!configured) {
    return (
      <Box flexDirection="column">
        <Text color={COLOR.text}>Recommendations aren't set up yet.</Text>
        <Text dimColor>To set up, add reccUrl and reccToken to config.json,</Text>
        <Text dimColor>or set TORLINK_RECC_URL / TORLINK_RECC_TOKEN.</Text>
      </Box>
    );
  }

  const filterLine = `type: ${recs.type}${recs.genre ? ` · genre: ${recs.genre}` : ""}${recs.explore ? " · explore" : ""}`;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={COLOR.alt}>For You  </Text>
        <Text dimColor>{filterLine}</Text>
      </Box>
      {recs.loading ? (
        <Text dimColor>Finding recommendations…</Text>
      ) : recs.error ? (
        <Box flexDirection="column">
          <Text color={COLOR.text}>{recs.error}</Text>
          <Text dimColor>press r to retry</Text>
        </Box>
      ) : count === 0 ? (
        <Text dimColor>No picks yet — stream something and they'll show up here.</Text>
      ) : (
        recs.items.map((item, i) => {
          const tag = item.reasons[0] ?? "";
          const isSel = i === selected;
          return (
            <Box key={item.imdbId}>
              <Box width={2} flexShrink={0}>
                {isSel ? <Text color={COLOR.accent}>{ICON.pointer}</Text> : null}
              </Box>
              <Box flexGrow={1} minWidth={0}>
                <Text color={isSel ? COLOR.accent : COLOR.text} wrap="truncate-end">
                  {truncate(cleanText(item.title), 40)}
                </Text>
              </Box>
              <Text dimColor>{`  ${item.year}  `}</Text>
              <Text dimColor>{tag}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/ui/components/ForYou.test.tsx`
Expected: PASS (all five tests).

- [ ] **Step 6: Commit**

```bash
git add src/ui/hooks/useRecommendations.ts src/ui/components/ForYou.tsx src/ui/components/ForYou.test.tsx
git commit -m "feat(ui): add useRecommendations hook and ForYou view"
```

---

## Task 5: Wire "For You" into navigation, App, and keymap

**Files:**
- Modify: `src/ui/store.ts`
- Modify: `src/ui/components/Sidebar.tsx`
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/keymap.ts`

- [ ] **Step 1: Add `"forYou"` to the `Section` type and exclude it in `isCategory`**

In `src/ui/store.ts`, change the `Section` type (line ~14) to include `"forYou"`:

```ts
export type Section = Category | "watchlist" | "library" | "downloads" | "seeding" | "accounts" | "forYou";
```

And add one line to `isCategory` so the Results view is not shown for it:

```ts
export function isCategory(section: Section): boolean {
  return (
    section !== "watchlist" &&
    section !== "library" &&
    section !== "downloads" &&
    section !== "seeding" &&
    section !== "accounts" &&
    section !== "forYou"
  );
}
```

- [ ] **Step 2: Add the "For You" nav item**

In `src/ui/components/Sidebar.tsx`, add it at the top of the `LIBRARY` array:

```ts
const LIBRARY: NavItem[] = [
  { key: "forYou", label: "For You" },
  { key: "watchlist", label: "Watchlist" },
  { key: "library", label: "Library" },
  { key: "downloads", label: "Downloads" },
  { key: "seeding", label: "Seeding" },
  { key: "accounts", label: "Accounts" },
];
```

- [ ] **Step 3: Render `<ForYou/>` and replace inline reccd-config literals in App.tsx**

In `src/ui/App.tsx`:

(a) Add `resolveReccConfig` to the existing import from `../config/config`, and import the component:

```tsx
import { ForYou } from "./components/ForYou";
```

(b) Replace all six inline `{ reccUrl: config.reccUrl, reccToken: config.reccToken }` literals passed as the first argument to `postEvent(...)` with `resolveReccConfig(config)`. For example the favourite handler becomes:

```tsx
    void postEvent(
      resolveReccConfig(config),
      {
        type: wasFavourited ? "unfavourited" : "favourited",
        rawName: item.name,
        ts: Date.now(),
        source: "torlink",
      },
    );
```

Do the same at the other five call sites (watched, the two `started` sites, and the two RatePrompt like/dislike handlers).

(c) Add a content block immediately after the `library`/`<Favourites />` block:

```tsx
            <Box display={section === "forYou" ? "flex" : "none"} flexDirection="column">
              <ForYou
                reccConfig={resolveReccConfig(store.config)}
                active={store.region === "content" && section === "forYou"}
                setSection={store.setSection}
                submitQuery={store.submitQuery}
              />
            </Box>
```

- [ ] **Step 4: Add For You footer hints and help group in keymap.ts**

In `src/ui/keymap.ts`, add a branch at the start of the `footerHints(region, section, ...)` function body (before the other `section === ...` branches):

```ts
  if (section === "forYou") {
    return [
      NAVIGATE,
      { keys: "↵", label: "Search title" },
      { keys: "t", label: "Type" },
      { keys: "g", label: "Genre" },
      { keys: "e", label: "Explore" },
      { keys: "r", label: "Refresh" },
      SWITCH,
      ALWAYS,
    ];
  }
```

And add a help group to the `HELP_GROUPS` array (after the "Search" group):

```ts
  {
    title: "For You",
    hints: [
      { keys: "↑ ↓", label: "Move between picks" },
      { keys: "↵", label: "Search this title" },
      { keys: "t", label: "Cycle movie / TV / all" },
      { keys: "g", label: "Filter by genre" },
      { keys: "e", label: "Toggle explore mode" },
      { keys: "r", label: "Refresh recommendations" },
    ],
  },
```

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run`
Expected: PASS (whole suite, including the existing Sidebar/keymap tests — update any snapshot/label assertions those tests make about nav items or hints if they now include "For You").

- [ ] **Step 6: Commit**

```bash
git add src/ui/store.ts src/ui/components/Sidebar.tsx src/ui/App.tsx src/ui/keymap.ts
git commit -m "feat(ui): wire For You section into nav, App, and keymap"
```

---

## Task 6: End-to-end verification against the live reccd

**Files:** none (manual verification).

- [ ] **Step 1: Point torlink at the live reccd**

Add `reccUrl`/`reccToken` to the runtime config (NOT the repo — this is a real secret, keep it out of git). Substitute your own reccd host and the bearer token printed by reccd's `user:add`:

```bash
node -e '
const fs=require("fs"),os=require("os"),p=require("path");
const f=p.join(os.homedir(),".config","torlink","config.json");
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.reccUrl="http://<RECCD_HOST>:4100";
c.reccToken="<YOUR_RECCD_TOKEN>";
fs.writeFileSync(f,JSON.stringify(c,null,2));
console.log("updated",f);
'
```

- [ ] **Step 2: Confirm the endpoint answers with the token**

Run:
```bash
curl -s -H "Authorization: Bearer <YOUR_RECCD_TOKEN>" \
  "http://<RECCD_HOST>:4100/recommendations?limit=3"
```
Expected: a JSON array of `{ imdbId, title, year, score, reasons }`.

- [ ] **Step 3: Manual smoke test**

Launch torlink (per the repo's run instructions), open the **For You** section from the sidebar, and confirm:
- Picks render; the footer shows the For You hints.
- `t` cycles type (all → movie → tv) and the list refetches.
- `g` opens the genre prompt; typing a genre filters; empty submission clears it.
- `e` toggles explore.
- `↵` on a pick switches to the matching category and runs a search for that title.
- With `reccUrl` removed, the pane shows the setup hint instead of erroring.

---

## Self-Review

**Spec coverage:**
- reccd client `fetchRecommendations` (blocking, discriminated result, error mapping) → Task 1. ✓
- Env overrides + `resolveReccConfig` → Task 2, wired in Task 5 Step 3b. ✓
- `useRecommendations` hook (filters, lazy load, refetch) → Task 4. ✓
- `ForYou` view (rows, reason tag, states, controls `t`/`g`/`e`/`r`/`↵`/nav) → Task 4. ✓
- Free-text genre prompt → Task 3. ✓
- Selection → search bridge (`setSection` type→category + `submitQuery` title-only) → Task 4 + Task 5. ✓
- Nav entry, `Section`/`isCategory`, App content block, footer hints + help group → Task 5. ✓
- Config-unset setup hint; 401 / network / empty / malformed states → Tasks 1 & 4. ✓
- Group "movie night", `/similar`, setup wizard, caching → explicitly out of scope. ✓

**Type consistency:** `ReccClientConfig`, `Recommendation`, `RecommendationQuery`, `FetchRecommendationsResult` defined in Task 1 and imported unchanged in Tasks 2/4. `ReccType` (`"all"|"movie"|"tv"`) defined in the hook (Task 4) and used by `ForYou`. `TYPE_SECTION` maps to `Category` members (`all`/`movies`/`tv`) that exist in `store.ts`. `Section` gains `"forYou"` in Task 5 before `ForYou` (which imports `Section`) is wired in.

**Placeholder scan:** none — every code and test step contains complete content.

**Note for the implementer:** the hook is unit-tested *through* the `ForYou` component test (Task 4), matching this repo's component-test convention (`ink-testing-library`, no `renderHook` utility); there is intentionally no standalone `useRecommendations.test.ts`.
