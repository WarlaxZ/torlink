# Recommendation Engine (reccd) — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone `reccd` service that ingests torlink activity events, canonicalizes them against a local IMDb-backed catalog, and returns content-based recommendations (genre overlap + recency + quality priors) via a small HTTP API — plus the minimal torlink changes to feed it and surface like/dislike.

**Architecture:** `reccd` is a new Node/TypeScript repo (`~/projects/reccd`) using `better-sqlite3` for two local databases (`catalog.db`, `activity.db`) and `fastify` for the HTTP API. torlink gains a fire-and-forget HTTP client and a handful of call sites (stream start, stream end/favourite/abandon, like/dislike keypress). No embeddings, no CF, no TMDB in this phase — those are Phase 2/3 per the spec.

**Tech Stack:** TypeScript, Node ≥22, `better-sqlite3`, `fastify`, `parse-torrent-title`, `undici` (torlink client side), `vitest`.

**Reference:** `docs/superpowers/specs/2026-07-09-recommendation-engine-design.md`

---

## Part A — `reccd` service (new repo)

### Task 1: Scaffold the reccd project

**Files:**
- Create: `~/projects/reccd/package.json`
- Create: `~/projects/reccd/tsconfig.json`
- Create: `~/projects/reccd/vitest.config.ts`
- Create: `~/projects/reccd/.gitignore`
- Create: `~/projects/reccd/src/config.ts`
- Test: `~/projects/reccd/src/config.test.ts`

- [ ] **Step 1: Create the directory and initialize git**

```bash
mkdir -p ~/projects/reccd/src
cd ~/projects/reccd
git init
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "reccd",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "import:imdb": "tsx src/catalog/importImdb.ts"
  },
  "dependencies": {
    "better-sqlite3": "^12.11.1",
    "fastify": "^5.10.0",
    "parse-torrent-title": "^3.0.1",
    "undici": "^8.6.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
data/
*.db
```

- [ ] **Step 6: Write the failing test for config**

```typescript
// src/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("reads port, token, and db paths from env", () => {
    const cfg = loadConfig({
      RECCD_PORT: "4100",
      RECCD_TOKEN: "secret123",
      RECCD_DATA_DIR: "/tmp/reccd-test",
    });
    expect(cfg.port).toBe(4100);
    expect(cfg.token).toBe("secret123");
    expect(cfg.catalogDbPath).toBe("/tmp/reccd-test/catalog.db");
    expect(cfg.activityDbPath).toBe("/tmp/reccd-test/activity.db");
  });

  it("defaults port to 4100 and data dir to ./data when unset", () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(4100);
    expect(cfg.catalogDbPath).toBe("data/catalog.db");
  });

  it("throws if RECCD_TOKEN is missing", () => {
    expect(() => loadConfig({})).toThrow(/RECCD_TOKEN/);
  });
});
```

- [ ] **Step 7: Install deps and run test to verify it fails**

```bash
npm install
npm test
```
Expected: FAIL with "Cannot find module './config.js'" or similar.

- [ ] **Step 8: Implement `src/config.ts`**

```typescript
import path from "node:path";

export interface ReccdConfig {
  port: number;
  token: string;
  dataDir: string;
  catalogDbPath: string;
  activityDbPath: string;
  minVotesForEnrichment: number;
}

export function loadConfig(env: Record<string, string | undefined>): ReccdConfig {
  const token = env.RECCD_TOKEN;
  if (!token) {
    throw new Error("RECCD_TOKEN environment variable is required");
  }
  const dataDir = env.RECCD_DATA_DIR ?? "data";
  return {
    port: env.RECCD_PORT ? Number(env.RECCD_PORT) : 4100,
    token,
    dataDir,
    catalogDbPath: path.join(dataDir, "catalog.db"),
    activityDbPath: path.join(dataDir, "activity.db"),
    minVotesForEnrichment: env.RECCD_MIN_VOTES ? Number(env.RECCD_MIN_VOTES) : 1000,
  };
}
```

Note: test 2 asserts `RECCD_TOKEN` throws when missing, but test 1/2 both call `loadConfig({})` — reorder so the throw test doesn't get shadowed. Fix the test file: move the "throws" case to use `{}` and the "defaults" case to pass a token:

```typescript
// corrected src/config.test.ts (replace previous version)
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("reads port, token, and db paths from env", () => {
    const cfg = loadConfig({
      RECCD_PORT: "4100",
      RECCD_TOKEN: "secret123",
      RECCD_DATA_DIR: "/tmp/reccd-test",
    });
    expect(cfg.port).toBe(4100);
    expect(cfg.token).toBe("secret123");
    expect(cfg.catalogDbPath).toBe("/tmp/reccd-test/catalog.db");
    expect(cfg.activityDbPath).toBe("/tmp/reccd-test/activity.db");
  });

  it("defaults port to 4100 and data dir to ./data when a token is set", () => {
    const cfg = loadConfig({ RECCD_TOKEN: "x" });
    expect(cfg.port).toBe(4100);
    expect(cfg.catalogDbPath).toBe("data/catalog.db");
  });

  it("throws if RECCD_TOKEN is missing", () => {
    expect(() => loadConfig({})).toThrow(/RECCD_TOKEN/);
  });
});
```

- [ ] **Step 9: Run test to verify it passes**

```bash
npm test
```
Expected: PASS (3 tests)

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold reccd project with config loader"
```

---

### Task 2: Catalog database schema and open helper

**Files:**
- Create: `~/projects/reccd/src/db/catalog.ts`
- Test: `~/projects/reccd/src/db/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/catalog.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { openCatalogDb, upsertTitle, getTitleByImdbId, findTitlesByYearRange } from "./catalog.js";

const TEST_DB = "/tmp/reccd-catalog-test.db";

afterEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("catalog db", () => {
  it("creates the titles table and round-trips a row", () => {
    const db = openCatalogDb(TEST_DB);
    upsertTitle(db, {
      imdbId: "tt0111161",
      title: "The Shawshank Redemption",
      year: 1994,
      type: "movie",
      genres: ["Drama"],
      rating: 9.3,
      votes: 2900000,
    });
    const row = getTitleByImdbId(db, "tt0111161");
    expect(row?.title).toBe("The Shawshank Redemption");
    expect(row?.genres).toEqual(["Drama"]);
    db.close();
  });

  it("finds titles within a year range", () => {
    const db = openCatalogDb(TEST_DB);
    upsertTitle(db, { imdbId: "tt1", title: "Old Movie", year: 1980, type: "movie", genres: ["Drama"], rating: 7, votes: 5000 });
    upsertTitle(db, { imdbId: "tt2", title: "New Movie", year: 2025, type: "movie", genres: ["Drama"], rating: 7, votes: 5000 });
    const results = findTitlesByYearRange(db, 2020, 2026);
    expect(results.map((r) => r.imdbId)).toEqual(["tt2"]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- catalog
```
Expected: FAIL with "Cannot find module './catalog.js'"

- [ ] **Step 3: Implement `src/db/catalog.ts`**

```typescript
import Database from "better-sqlite3";

export type TitleType = "movie" | "tv";

export interface CatalogTitle {
  imdbId: string;
  title: string;
  year: number;
  type: TitleType;
  genres: string[];
  rating: number;
  votes: number;
}

export function openCatalogDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS titles (
      imdb_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      year INTEGER NOT NULL,
      type TEXT NOT NULL,
      genres TEXT NOT NULL,
      rating REAL NOT NULL,
      votes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_titles_year ON titles(year);
    CREATE INDEX IF NOT EXISTS idx_titles_title_year ON titles(title, year);
  `);
  return db;
}

export function upsertTitle(db: Database.Database, t: CatalogTitle): void {
  db.prepare(
    `INSERT INTO titles (imdb_id, title, year, type, genres, rating, votes)
     VALUES (@imdbId, @title, @year, @type, @genres, @rating, @votes)
     ON CONFLICT(imdb_id) DO UPDATE SET
       title = excluded.title, year = excluded.year, type = excluded.type,
       genres = excluded.genres, rating = excluded.rating, votes = excluded.votes`
  ).run({ ...t, genres: JSON.stringify(t.genres) });
}

function rowToTitle(row: any): CatalogTitle {
  return {
    imdbId: row.imdb_id,
    title: row.title,
    year: row.year,
    type: row.type,
    genres: JSON.parse(row.genres),
    rating: row.rating,
    votes: row.votes,
  };
}

export function getTitleByImdbId(db: Database.Database, imdbId: string): CatalogTitle | undefined {
  const row = db.prepare(`SELECT * FROM titles WHERE imdb_id = ?`).get(imdbId);
  return row ? rowToTitle(row) : undefined;
}

export function findTitlesByYearRange(db: Database.Database, fromYear: number, toYear: number): CatalogTitle[] {
  const rows = db.prepare(`SELECT * FROM titles WHERE year BETWEEN ? AND ?`).all(fromYear, toYear);
  return rows.map(rowToTitle);
}

export function findTitlesByTitleAndYear(db: Database.Database, title: string, year: number, tolerance = 1): CatalogTitle[] {
  const rows = db
    .prepare(`SELECT * FROM titles WHERE title = ? COLLATE NOCASE AND year BETWEEN ? AND ?`)
    .all(title, year - tolerance, year + tolerance);
  return rows.map(rowToTitle);
}

export function allTitles(db: Database.Database): CatalogTitle[] {
  const rows = db.prepare(`SELECT * FROM titles`).all();
  return rows.map(rowToTitle);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- catalog
```
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add catalog database schema and helpers"
```

---

### Task 3: IMDb TSV importer

**Files:**
- Create: `~/projects/reccd/src/catalog/importImdb.ts`
- Test: `~/projects/reccd/src/catalog/importImdb.test.ts`

- [ ] **Step 1: Write the failing test using in-memory TSV fixtures (no network)**

```typescript
// src/catalog/importImdb.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { parseBasicsLine, parseRatingsLine, importFromLines } from "./importImdb.js";
import { openCatalogDb, getTitleByImdbId } from "../db/catalog.js";

const TEST_DB = "/tmp/reccd-import-test.db";

afterEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("parseBasicsLine", () => {
  it("parses a movie row", () => {
    const line = "tt0111161\tmovie\tThe Shawshank Redemption\tThe Shawshank Redemption\t0\t1994\t\\N\t142\tDrama";
    const row = parseBasicsLine(line);
    expect(row).toEqual({ imdbId: "tt0111161", type: "movie", title: "The Shawshank Redemption", year: 1994, genres: ["Drama"] });
  });

  it("returns null for non movie/tvSeries types", () => {
    const line = "tt0000001\tshort\tCarmencita\tCarmencita\t0\t1894\t\\N\t1\tDocumentary,Short";
    expect(parseBasicsLine(line)).toBeNull();
  });

  it("returns null when year is missing", () => {
    const line = "tt9999999\tmovie\tUnreleased\tUnreleased\t0\t\\N\t\\N\t\\N\tDrama";
    expect(parseBasicsLine(line)).toBeNull();
  });

  it("maps tvSeries to type tv", () => {
    const line = "tt0903747\ttvSeries\tBreaking Bad\tBreaking Bad\t0\t2008\t2013\t45\tCrime,Drama,Thriller";
    const row = parseBasicsLine(line);
    expect(row?.type).toBe("tv");
  });
});

describe("parseRatingsLine", () => {
  it("parses rating and votes", () => {
    const row = parseRatingsLine("tt0111161\t9.3\t2900000");
    expect(row).toEqual({ imdbId: "tt0111161", rating: 9.3, votes: 2900000 });
  });
});

describe("importFromLines", () => {
  it("joins basics and ratings into the catalog db", () => {
    const db = openCatalogDb(TEST_DB);
    const basicsLines = [
      "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres",
      "tt0111161\tmovie\tThe Shawshank Redemption\tThe Shawshank Redemption\t0\t1994\t\\N\t142\tDrama",
    ];
    const ratingsLines = [
      "tconst\taverageRating\tnumVotes",
      "tt0111161\t9.3\t2900000",
    ];
    importFromLines(db, basicsLines, ratingsLines);
    const row = getTitleByImdbId(db, "tt0111161");
    expect(row).toMatchObject({ title: "The Shawshank Redemption", year: 1994, rating: 9.3, votes: 2900000 });
    db.close();
  });

  it("skips titles with no matching ratings row", () => {
    const db = openCatalogDb(TEST_DB);
    const basicsLines = [
      "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres",
      "tt0000002\tmovie\tNo Ratings\tNo Ratings\t0\t2000\t\\N\t90\tDrama",
    ];
    const ratingsLines = ["tconst\taverageRating\tnumVotes"];
    importFromLines(db, basicsLines, ratingsLines);
    expect(getTitleByImdbId(db, "tt0000002")).toBeUndefined();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- importImdb
```
Expected: FAIL with "Cannot find module './importImdb.js'"

- [ ] **Step 3: Implement `src/catalog/importImdb.ts`**

```typescript
import readline from "node:readline";
import fs from "node:fs";
import zlib from "node:zlib";
import { openCatalogDb, upsertTitle, type TitleType } from "../db/catalog.js";

const IMDB_TYPE_MAP: Record<string, TitleType> = {
  movie: "movie",
  tvMovie: "movie",
  tvSeries: "tv",
  tvMiniSeries: "tv",
};

export interface BasicsRow {
  imdbId: string;
  type: TitleType;
  title: string;
  year: number;
  genres: string[];
}

export interface RatingsRow {
  imdbId: string;
  rating: number;
  votes: number;
}

export function parseBasicsLine(line: string): BasicsRow | null {
  const cols = line.split("\t");
  const [imdbId, titleType, primaryTitle, , , startYear, , , genresCol] = cols;
  const type = IMDB_TYPE_MAP[titleType];
  if (!type) return null;
  if (startYear === "\\N" || !startYear) return null;
  const year = Number(startYear);
  if (!Number.isFinite(year)) return null;
  const genres = genresCol && genresCol !== "\\N" ? genresCol.split(",") : [];
  return { imdbId, type, title: primaryTitle, year, genres };
}

export function parseRatingsLine(line: string): RatingsRow {
  const [imdbId, rating, votes] = line.split("\t");
  return { imdbId, rating: Number(rating), votes: Number(votes) };
}

export function importFromLines(db: ReturnType<typeof openCatalogDb>, basicsLines: string[], ratingsLines: string[]): void {
  const ratingsByImdbId = new Map<string, RatingsRow>();
  for (const line of ratingsLines.slice(1)) {
    if (!line) continue;
    const row = parseRatingsLine(line);
    ratingsByImdbId.set(row.imdbId, row);
  }

  const insertMany = db.transaction((rows: BasicsRow[]) => {
    for (const basics of rows) {
      const ratings = ratingsByImdbId.get(basics.imdbId);
      if (!ratings) continue;
      upsertTitle(db, {
        imdbId: basics.imdbId,
        title: basics.title,
        year: basics.year,
        type: basics.type,
        genres: basics.genres,
        rating: ratings.rating,
        votes: ratings.votes,
      });
    }
  });

  const parsed: BasicsRow[] = [];
  for (const line of basicsLines.slice(1)) {
    if (!line) continue;
    const row = parseBasicsLine(line);
    if (row) parsed.push(row);
  }
  insertMany(parsed);
}

async function readGzipLines(path: string): Promise<string[]> {
  const stream = fs.createReadStream(path).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream });
  const lines: string[] = [];
  for await (const line of rl) lines.push(line);
  return lines;
}

export async function importFromFiles(dbPath: string, basicsGzPath: string, ratingsGzPath: string): Promise<void> {
  const db = openCatalogDb(dbPath);
  try {
    const [basicsLines, ratingsLines] = await Promise.all([readGzipLines(basicsGzPath), readGzipLines(ratingsGzPath)]);
    importFromLines(db, basicsLines, ratingsLines);
  } finally {
    db.close();
  }
}

async function downloadGz(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(destPath, buf);
}

export async function refreshCatalogFromImdb(dbPath: string, tmpDir = "/tmp"): Promise<void> {
  const basicsPath = `${tmpDir}/title.basics.tsv.gz`;
  const ratingsPath = `${tmpDir}/title.ratings.tsv.gz`;
  await Promise.all([
    downloadGz("https://datasets.imdbws.com/title.basics.tsv.gz", basicsPath),
    downloadGz("https://datasets.imdbws.com/title.ratings.tsv.gz", ratingsPath),
  ]);
  await importFromFiles(dbPath, basicsPath, ratingsPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.RECCD_CATALOG_DB ?? "data/catalog.db";
  refreshCatalogFromImdb(dbPath)
    .then(() => console.log("Catalog refreshed"))
    .catch((err) => {
      console.error("Catalog refresh failed:", err);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- importImdb
```
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add IMDb TSV importer for the catalog"
```

---

### Task 4: Activity database (event store)

**Files:**
- Create: `~/projects/reccd/src/db/activity.ts`
- Test: `~/projects/reccd/src/db/activity.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/activity.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { openActivityDb, insertEvent, getUnresolvedEvents, resolveEvent, getResolvedEvents, EVENT_TYPES } from "./activity.js";

const TEST_DB = "/tmp/reccd-activity-test.db";

afterEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("activity db", () => {
  it("inserts an event unresolved by default", () => {
    const db = openActivityDb(TEST_DB);
    const id = insertEvent(db, { type: "watched", rawName: "The.Matrix.1999.1080p", ts: 1000, source: "torlink" });
    const unresolved = getUnresolvedEvents(db);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].id).toBe(id);
    expect(unresolved[0].resolvedImdbId).toBeNull();
    db.close();
  });

  it("resolves an event and it no longer shows as unresolved", () => {
    const db = openActivityDb(TEST_DB);
    const id = insertEvent(db, { type: "watched", rawName: "The.Matrix.1999.1080p", ts: 1000, source: "torlink" });
    resolveEvent(db, id, "tt0133093", 0.95);
    expect(getUnresolvedEvents(db)).toHaveLength(0);
    const resolved = getResolvedEvents(db);
    expect(resolved[0].resolvedImdbId).toBe("tt0133093");
    expect(resolved[0].confidence).toBe(0.95);
    db.close();
  });

  it("rejects an unknown event type", () => {
    const db = openActivityDb(TEST_DB);
    expect(() =>
      // @ts-expect-error intentional invalid type for the test
      insertEvent(db, { type: "bogus", rawName: "x", ts: 1, source: "torlink" })
    ).toThrow();
    db.close();
  });

  it("exposes the known event type list", () => {
    expect(EVENT_TYPES).toEqual(["started", "watched", "favourited", "unfavourited", "liked", "disliked", "abandoned"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- activity
```
Expected: FAIL with "Cannot find module './activity.js'"

- [ ] **Step 3: Implement `src/db/activity.ts`**

```typescript
import Database from "better-sqlite3";

export const EVENT_TYPES = [
  "started",
  "watched",
  "favourited",
  "unfavourited",
  "liked",
  "disliked",
  "abandoned",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface NewEvent {
  type: EventType;
  rawName: string;
  ts: number;
  source: string;
}

export interface StoredEvent extends NewEvent {
  id: number;
  resolvedImdbId: string | null;
  confidence: number | null;
}

export function openActivityDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      raw_name TEXT NOT NULL,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      resolved_imdb_id TEXT,
      confidence REAL
    );
    CREATE INDEX IF NOT EXISTS idx_events_resolved ON events(resolved_imdb_id);
  `);
  return db;
}

function assertValidType(type: string): asserts type is EventType {
  if (!EVENT_TYPES.includes(type as EventType)) {
    throw new Error(`Unknown event type: ${type}`);
  }
}

export function insertEvent(db: Database.Database, event: NewEvent): number {
  assertValidType(event.type);
  const result = db
    .prepare(`INSERT INTO events (type, raw_name, ts, source) VALUES (@type, @rawName, @ts, @source)`)
    .run(event);
  return Number(result.lastInsertRowid);
}

function rowToEvent(row: any): StoredEvent {
  return {
    id: row.id,
    type: row.type,
    rawName: row.raw_name,
    ts: row.ts,
    source: row.source,
    resolvedImdbId: row.resolved_imdb_id,
    confidence: row.confidence,
  };
}

export function getUnresolvedEvents(db: Database.Database): StoredEvent[] {
  const rows = db.prepare(`SELECT * FROM events WHERE resolved_imdb_id IS NULL`).all();
  return rows.map(rowToEvent);
}

export function getResolvedEvents(db: Database.Database): StoredEvent[] {
  const rows = db.prepare(`SELECT * FROM events WHERE resolved_imdb_id IS NOT NULL`).all();
  return rows.map(rowToEvent);
}

export function resolveEvent(db: Database.Database, id: number, imdbId: string, confidence: number): void {
  db.prepare(`UPDATE events SET resolved_imdb_id = ?, confidence = ? WHERE id = ?`).run(imdbId, confidence, id);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- activity
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add activity event store"
```

---

### Task 5: Release name parsing

**Files:**
- Create: `~/projects/reccd/src/canonicalize/parseRelease.ts`
- Test: `~/projects/reccd/src/canonicalize/parseRelease.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/canonicalize/parseRelease.test.ts
import { describe, it, expect } from "vitest";
import { parseReleaseName } from "./parseRelease.js";

describe("parseReleaseName", () => {
  it("extracts title and year from a typical movie release name", () => {
    const result = parseReleaseName("The.Matrix.1999.1080p.BluRay.x264-GROUP");
    expect(result).toEqual({ title: "The Matrix", year: 1999 });
  });

  it("extracts title and year from a TV release name, dropping episode info", () => {
    const result = parseReleaseName("Breaking.Bad.S01E01.2008.720p.WEB-DL");
    expect(result?.title).toBe("Breaking Bad");
    expect(result?.year).toBe(2008);
  });

  it("returns null title/year gracefully when no year is present", () => {
    const result = parseReleaseName("Some.Random.Video.mkv");
    expect(result?.title).toBeTruthy();
    expect(result?.year).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- parseRelease
```
Expected: FAIL with "Cannot find module './parseRelease.js'"

- [ ] **Step 3: Implement `src/canonicalize/parseRelease.ts`**

```typescript
import parse from "parse-torrent-title";

export interface ParsedRelease {
  title: string;
  year: number | null;
}

export function parseReleaseName(rawName: string): ParsedRelease {
  const result = parse(rawName) as { title?: string; year?: number };
  return {
    title: (result.title ?? rawName).trim(),
    year: result.year ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- parseRelease
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add release name parser"
```

---

### Task 6: Canonicalizer (resolve release name to catalog title)

**Files:**
- Create: `~/projects/reccd/src/canonicalize/resolve.ts`
- Test: `~/projects/reccd/src/canonicalize/resolve.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/canonicalize/resolve.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { openCatalogDb, upsertTitle } from "../db/catalog.js";
import { resolveReleaseName } from "./resolve.js";

const TEST_DB = "/tmp/reccd-resolve-test.db";

afterEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("resolveReleaseName", () => {
  it("resolves an exact title+year match with high confidence", () => {
    const db = openCatalogDb(TEST_DB);
    upsertTitle(db, { imdbId: "tt0133093", title: "The Matrix", year: 1999, type: "movie", genres: ["Action"], rating: 8.7, votes: 2000000 });
    const result = resolveReleaseName(db, "The.Matrix.1999.1080p.BluRay.x264-GROUP");
    expect(result).toEqual({ imdbId: "tt0133093", confidence: 1 });
    db.close();
  });

  it("resolves within a 1-year tolerance at reduced confidence", () => {
    const db = openCatalogDb(TEST_DB);
    upsertTitle(db, { imdbId: "tt1", title: "Some Movie", year: 2000, type: "movie", genres: ["Drama"], rating: 7, votes: 1000 });
    const result = resolveReleaseName(db, "Some.Movie.2001.720p.WEB-DL");
    expect(result).toEqual({ imdbId: "tt1", confidence: 0.7 });
    db.close();
  });

  it("returns null when nothing matches", () => {
    const db = openCatalogDb(TEST_DB);
    const result = resolveReleaseName(db, "Totally.Unknown.Title.2099.1080p");
    expect(result).toBeNull();
    db.close();
  });

  it("returns null and does not throw when multiple equally-good matches exist", () => {
    const db = openCatalogDb(TEST_DB);
    upsertTitle(db, { imdbId: "tt1", title: "Alpha", year: 2000, type: "movie", genres: ["Drama"], rating: 7, votes: 1000 });
    upsertTitle(db, { imdbId: "tt2", title: "Alpha", year: 2000, type: "tv", genres: ["Drama"], rating: 7, votes: 1000 });
    const result = resolveReleaseName(db, "Alpha.2000.1080p");
    expect(result).toBeNull();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- resolve
```
Expected: FAIL with "Cannot find module './resolve.js'"

- [ ] **Step 3: Implement `src/canonicalize/resolve.ts`**

```typescript
import Database from "better-sqlite3";
import { findTitlesByTitleAndYear } from "../db/catalog.js";
import { parseReleaseName } from "./parseRelease.js";

export interface ResolvedMatch {
  imdbId: string;
  confidence: number;
}

export function resolveReleaseName(db: Database.Database, rawName: string): ResolvedMatch | null {
  const parsed = parseReleaseName(rawName);
  if (!parsed.year) return null;

  const exact = findTitlesByTitleAndYear(db, parsed.title, parsed.year, 0);
  if (exact.length === 1) return { imdbId: exact[0].imdbId, confidence: 1 };
  if (exact.length > 1) return null;

  const nearby = findTitlesByTitleAndYear(db, parsed.title, parsed.year, 1);
  if (nearby.length === 1) return { imdbId: nearby[0].imdbId, confidence: 0.7 };

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- resolve
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add release name canonicalizer"
```

---

### Task 7: Resolver job (drain unresolved events)

**Files:**
- Create: `~/projects/reccd/src/canonicalize/resolveQueue.ts`
- Test: `~/projects/reccd/src/canonicalize/resolveQueue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/canonicalize/resolveQueue.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { openCatalogDb, upsertTitle } from "../db/catalog.js";
import { openActivityDb, insertEvent, getResolvedEvents, getUnresolvedEvents } from "../db/activity.js";
import { drainUnresolvedEvents } from "./resolveQueue.js";

const CATALOG_DB = "/tmp/reccd-rq-catalog-test.db";
const ACTIVITY_DB = "/tmp/reccd-rq-activity-test.db";

afterEach(() => {
  for (const p of [CATALOG_DB, ACTIVITY_DB]) if (fs.existsSync(p)) fs.unlinkSync(p);
});

describe("drainUnresolvedEvents", () => {
  it("resolves matchable events and leaves unmatchable ones for retry", () => {
    const catalogDb = openCatalogDb(CATALOG_DB);
    upsertTitle(catalogDb, { imdbId: "tt0133093", title: "The Matrix", year: 1999, type: "movie", genres: ["Action"], rating: 8.7, votes: 2000000 });

    const activityDb = openActivityDb(ACTIVITY_DB);
    insertEvent(activityDb, { type: "watched", rawName: "The.Matrix.1999.1080p.BluRay.x264-GROUP", ts: 1, source: "torlink" });
    insertEvent(activityDb, { type: "watched", rawName: "Totally.Unknown.2099", ts: 2, source: "torlink" });

    const summary = drainUnresolvedEvents(catalogDb, activityDb);

    expect(summary).toEqual({ resolved: 1, stillUnresolved: 1 });
    expect(getResolvedEvents(activityDb)).toHaveLength(1);
    expect(getUnresolvedEvents(activityDb)).toHaveLength(1);

    catalogDb.close();
    activityDb.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- resolveQueue
```
Expected: FAIL with "Cannot find module './resolveQueue.js'"

- [ ] **Step 3: Implement `src/canonicalize/resolveQueue.ts`**

```typescript
import Database from "better-sqlite3";
import { getUnresolvedEvents, resolveEvent } from "../db/activity.js";
import { resolveReleaseName } from "./resolve.js";

export interface DrainSummary {
  resolved: number;
  stillUnresolved: number;
}

export function drainUnresolvedEvents(catalogDb: Database.Database, activityDb: Database.Database): DrainSummary {
  const pending = getUnresolvedEvents(activityDb);
  let resolved = 0;
  for (const event of pending) {
    const match = resolveReleaseName(catalogDb, event.rawName);
    if (match) {
      resolveEvent(activityDb, event.id, match.imdbId, match.confidence);
      resolved += 1;
    }
  }
  return { resolved, stillUnresolved: pending.length - resolved };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- resolveQueue
```
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add job to drain unresolved events against the catalog"
```

---

### Task 8: Taste profile builder

**Files:**
- Create: `~/projects/reccd/src/scoring/tasteProfile.ts`
- Test: `~/projects/reccd/src/scoring/tasteProfile.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/scoring/tasteProfile.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { openCatalogDb, upsertTitle } from "../db/catalog.js";
import { openActivityDb, insertEvent, resolveEvent } from "../db/activity.js";
import { buildTasteProfile } from "./tasteProfile.js";

const CATALOG_DB = "/tmp/reccd-tp-catalog-test.db";
const ACTIVITY_DB = "/tmp/reccd-tp-activity-test.db";

afterEach(() => {
  for (const p of [CATALOG_DB, ACTIVITY_DB]) if (fs.existsSync(p)) fs.unlinkSync(p);
});

describe("buildTasteProfile", () => {
  it("weights genres positively for favourited/liked/watched and negatively for disliked/abandoned", () => {
    const catalogDb = openCatalogDb(CATALOG_DB);
    upsertTitle(catalogDb, { imdbId: "tt1", title: "Heat", year: 1995, type: "movie", genres: ["Crime", "Thriller"], rating: 8.2, votes: 500000 });
    upsertTitle(catalogDb, { imdbId: "tt2", title: "Ronin", year: 1998, type: "movie", genres: ["Action", "Thriller"], rating: 7.1, votes: 150000 });
    upsertTitle(catalogDb, { imdbId: "tt3", title: "Fluffy Bunnies", year: 2010, type: "movie", genres: ["Comedy"], rating: 5.0, votes: 2000 });

    const activityDb = openActivityDb(ACTIVITY_DB);
    const e1 = insertEvent(activityDb, { type: "favourited", rawName: "Heat", ts: 1, source: "torlink" });
    resolveEvent(activityDb, e1, "tt1", 1);
    const e2 = insertEvent(activityDb, { type: "watched", rawName: "Ronin", ts: 2, source: "torlink" });
    resolveEvent(activityDb, e2, "tt2", 1);
    const e3 = insertEvent(activityDb, { type: "disliked", rawName: "Fluffy Bunnies", ts: 3, source: "torlink" });
    resolveEvent(activityDb, e3, "tt3", 1);

    const profile = buildTasteProfile(catalogDb, activityDb);

    expect(profile.genreWeights["Thriller"]).toBeGreaterThan(0);
    expect(profile.genreWeights["Crime"]).toBeGreaterThan(profile.genreWeights["Action"]);
    expect(profile.genreWeights["Comedy"]).toBeLessThan(0);
    expect(profile.seenImdbIds.has("tt1")).toBe(true);
    expect(profile.seenImdbIds.has("tt2")).toBe(true);

    catalogDb.close();
    activityDb.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tasteProfile
```
Expected: FAIL with "Cannot find module './tasteProfile.js'"

- [ ] **Step 3: Implement `src/scoring/tasteProfile.ts`**

```typescript
import Database from "better-sqlite3";
import { getTitleByImdbId } from "../db/catalog.js";
import { getResolvedEvents, type EventType } from "../db/activity.js";

export interface TasteProfile {
  genreWeights: Record<string, number>;
  seenImdbIds: Set<string>;
}

const EVENT_WEIGHTS: Record<EventType, number> = {
  favourited: 3,
  liked: 2,
  watched: 1,
  started: 0,
  unfavourited: -1,
  abandoned: -1,
  disliked: -2,
};

const SEEN_EVENT_TYPES: EventType[] = ["watched", "favourited", "liked", "disliked", "abandoned"];

export function buildTasteProfile(catalogDb: Database.Database, activityDb: Database.Database): TasteProfile {
  const events = getResolvedEvents(activityDb);
  const genreWeights: Record<string, number> = {};
  const seenImdbIds = new Set<string>();

  for (const event of events) {
    if (!event.resolvedImdbId) continue;
    if (SEEN_EVENT_TYPES.includes(event.type)) seenImdbIds.add(event.resolvedImdbId);

    const weight = EVENT_WEIGHTS[event.type] * (event.confidence ?? 1);
    if (weight === 0) continue;

    const title = getTitleByImdbId(catalogDb, event.resolvedImdbId);
    if (!title) continue;

    for (const genre of title.genres) {
      genreWeights[genre] = (genreWeights[genre] ?? 0) + weight;
    }
  }

  return { genreWeights, seenImdbIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tasteProfile
```
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: build taste profile from resolved activity events"
```

---

### Task 9: Scoring (content match + recency + quality)

**Files:**
- Create: `~/projects/reccd/src/scoring/score.ts`
- Test: `~/projects/reccd/src/scoring/score.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/scoring/score.test.ts
import { describe, it, expect } from "vitest";
import { scoreCandidate } from "./score.js";
import type { CatalogTitle } from "../db/catalog.js";
import type { TasteProfile } from "./tasteProfile.js";

const profile: TasteProfile = {
  genreWeights: { Thriller: 5, Crime: 3, Comedy: -2 },
  seenImdbIds: new Set(["tt-seen"]),
};

function title(overrides: Partial<CatalogTitle>): CatalogTitle {
  return {
    imdbId: "tt-x",
    title: "Placeholder",
    year: 2020,
    type: "movie",
    genres: ["Thriller"],
    rating: 7,
    votes: 10000,
    ...overrides,
  };
}

describe("scoreCandidate", () => {
  it("scores higher for genre overlap with the taste profile", () => {
    const thriller = scoreCandidate(title({ genres: ["Thriller"] }), profile, 2026);
    const comedy = scoreCandidate(title({ genres: ["Comedy"] }), profile, 2026);
    expect(thriller.score).toBeGreaterThan(comedy.score);
  });

  it("gives a recency boost to newer titles over older ones with identical genre/quality", () => {
    const newer = scoreCandidate(title({ year: 2025, genres: ["Thriller"] }), profile, 2026);
    const older = scoreCandidate(title({ year: 1990, genres: ["Thriller"] }), profile, 2026);
    expect(newer.score).toBeGreaterThan(older.score);
  });

  it("lets a high quality-prior old title still score reasonably (cult-classic gate)", () => {
    const oldButGreat = scoreCandidate(title({ year: 1975, genres: [], rating: 9.2, votes: 1000000 }), profile, 2026);
    const newButMediocre = scoreCandidate(title({ year: 2025, genres: [], rating: 4.0, votes: 500 }), profile, 2026);
    expect(oldButGreat.score).toBeGreaterThan(newButMediocre.score);
  });

  it("returns null for a title already in seenImdbIds", () => {
    const result = scoreCandidate(title({ imdbId: "tt-seen" }), profile, 2026);
    expect(result).toBeNull();
  });

  it("includes human-readable reasons", () => {
    const result = scoreCandidate(title({ genres: ["Thriller", "Crime"] }), profile, 2026);
    expect(result?.reasons.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- score
```
Expected: FAIL with "Cannot find module './score.js'"

- [ ] **Step 3: Implement `src/scoring/score.ts`**

```typescript
import type { CatalogTitle } from "../db/catalog.js";
import type { TasteProfile } from "./tasteProfile.js";

export interface ScoreWeights {
  content: number;
  recency: number;
  quality: number;
  recencyHalfLifeYears: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  content: 1.0,
  recency: 1.0,
  quality: 0.5,
  recencyHalfLifeYears: 8,
};

export interface ScoredCandidate {
  imdbId: string;
  score: number;
  reasons: string[];
}

function contentMatch(title: CatalogTitle, profile: TasteProfile): number {
  return title.genres.reduce((sum, genre) => sum + (profile.genreWeights[genre] ?? 0), 0);
}

function recencyPrior(year: number, currentYear: number, halfLifeYears: number): number {
  const age = Math.max(0, currentYear - year);
  return Math.pow(0.5, age / halfLifeYears);
}

function qualityPrior(rating: number, votes: number): number {
  return rating * Math.log10(Math.max(votes, 1));
}

export function scoreCandidate(
  title: CatalogTitle,
  profile: TasteProfile,
  currentYear: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS
): ScoredCandidate | null {
  if (profile.seenImdbIds.has(title.imdbId)) return null;

  const content = contentMatch(title, profile);
  const recency = recencyPrior(title.year, currentYear, weights.recencyHalfLifeYears);
  const quality = qualityPrior(title.rating, title.votes);

  const score = weights.content * content + weights.recency * recency * 10 + weights.quality * quality;

  const reasons: string[] = [];
  const likedGenres = title.genres.filter((g) => (profile.genreWeights[g] ?? 0) > 0);
  if (likedGenres.length > 0) reasons.push(`matches genres you like: ${likedGenres.join(", ")}`);
  if (recency > 0.7) reasons.push("recent release");
  if (title.rating >= 8 && title.votes >= 50000) reasons.push("highly rated classic");
  if (reasons.length === 0) reasons.push("unseen title in the catalog");

  return { imdbId: title.imdbId, score, reasons };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- score
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add candidate scoring (content match, recency, quality priors)"
```

---

### Task 10: Recommend (rank candidates with diversity pass)

**Files:**
- Create: `~/projects/reccd/src/scoring/recommend.ts`
- Test: `~/projects/reccd/src/scoring/recommend.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/scoring/recommend.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { openCatalogDb, upsertTitle } from "../db/catalog.js";
import { openActivityDb } from "../db/activity.js";
import { recommend } from "./recommend.js";

const CATALOG_DB = "/tmp/reccd-rec-catalog-test.db";
const ACTIVITY_DB = "/tmp/reccd-rec-activity-test.db";

afterEach(() => {
  for (const p of [CATALOG_DB, ACTIVITY_DB]) if (fs.existsSync(p)) fs.unlinkSync(p);
});

describe("recommend", () => {
  it("returns ranked titles with title/year/reasons, most relevant first", () => {
    const catalogDb = openCatalogDb(CATALOG_DB);
    upsertTitle(catalogDb, { imdbId: "tt1", title: "Great Thriller", year: 2025, type: "movie", genres: ["Thriller"], rating: 8, votes: 100000 });
    upsertTitle(catalogDb, { imdbId: "tt2", title: "Old Comedy", year: 1970, type: "movie", genres: ["Comedy"], rating: 5, votes: 500 });
    const activityDb = openActivityDb(ACTIVITY_DB);

    const results = recommend(catalogDb, activityDb, { type: "movie", limit: 10, currentYear: 2026 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].imdbId).toBe("tt1");
    expect(results[0].title).toBe("Great Thriller");
    expect(results[0].year).toBe(2025);
    expect(Array.isArray(results[0].reasons)).toBe(true);
  });

  it("filters by genre when requested", () => {
    const catalogDb = openCatalogDb(CATALOG_DB);
    upsertTitle(catalogDb, { imdbId: "tt1", title: "A Thriller", year: 2025, type: "movie", genres: ["Thriller"], rating: 8, votes: 100000 });
    upsertTitle(catalogDb, { imdbId: "tt2", title: "A Comedy", year: 2025, type: "movie", genres: ["Comedy"], rating: 8, votes: 100000 });
    const activityDb = openActivityDb(ACTIVITY_DB);

    const results = recommend(catalogDb, activityDb, { type: "movie", genre: "Comedy", limit: 10, currentYear: 2026 });

    expect(results.every((r) => r.imdbId === "tt2")).toBe(true);
  });

  it("respects the limit", () => {
    const catalogDb = openCatalogDb(CATALOG_DB);
    for (let i = 0; i < 5; i++) {
      upsertTitle(catalogDb, { imdbId: `tt${i}`, title: `Movie ${i}`, year: 2025, type: "movie", genres: ["Drama"], rating: 7, votes: 10000 });
    }
    const activityDb = openActivityDb(ACTIVITY_DB);

    const results = recommend(catalogDb, activityDb, { type: "movie", limit: 3, currentYear: 2026 });

    expect(results).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- recommend
```
Expected: FAIL with "Cannot find module './recommend.js'"

- [ ] **Step 3: Implement `src/scoring/recommend.ts`**

```typescript
import Database from "better-sqlite3";
import { allTitles, type TitleType } from "../db/catalog.js";
import { buildTasteProfile } from "./tasteProfile.js";
import { scoreCandidate } from "./score.js";

export interface RecommendOptions {
  type?: TitleType;
  genre?: string;
  limit: number;
  currentYear: number;
}

export interface Recommendation {
  imdbId: string;
  title: string;
  year: number;
  score: number;
  reasons: string[];
}

export function recommend(catalogDb: Database.Database, activityDb: Database.Database, opts: RecommendOptions): Recommendation[] {
  const profile = buildTasteProfile(catalogDb, activityDb);
  const candidates = allTitles(catalogDb).filter((t) => {
    if (opts.type && t.type !== opts.type) return false;
    if (opts.genre && !t.genres.includes(opts.genre)) return false;
    return true;
  });

  const scored: Recommendation[] = [];
  for (const candidate of candidates) {
    const result = scoreCandidate(candidate, profile, opts.currentYear);
    if (!result) continue;
    scored.push({ imdbId: candidate.imdbId, title: candidate.title, year: candidate.year, score: result.score, reasons: result.reasons });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- recommend
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add recommend function ranking scored candidates"
```

Note: diversity re-ranking (MMR-style spread across genres) is deliberately deferred — with a small personal catalog subset, a straightforward genre filter plus sort is sufficient for Phase 1. Revisit if Phase 1 usage shows homogeneous results.

---

### Task 11: Backfill importer (torlink history + favourites)

**Files:**
- Create: `~/projects/reccd/src/events/backfill.ts`
- Test: `~/projects/reccd/src/events/backfill.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/events/backfill.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { openActivityDb, getUnresolvedEvents } from "../db/activity.js";
import { backfillFromTorlink } from "./backfill.js";

const ACTIVITY_DB = "/tmp/reccd-backfill-activity-test.db";

afterEach(() => {
  if (fs.existsSync(ACTIVITY_DB)) fs.unlinkSync(ACTIVITY_DB);
});

describe("backfillFromTorlink", () => {
  it("imports history.json completed downloads as watched events", () => {
    const db = openActivityDb(ACTIVITY_DB);
    const history = [
      { id: "abc123", name: "The.Matrix.1999.1080p", completedAt: 1000 },
      { id: "def456", name: "Some.Show.S01E01.2020.720p", completedAt: 2000 },
    ];
    const count = backfillFromTorlink(db, { history, favourites: [] });
    expect(count).toBe(2);
    const events = getUnresolvedEvents(db);
    expect(events.map((e) => e.rawName)).toEqual(["The.Matrix.1999.1080p", "Some.Show.S01E01.2020.720p"]);
    expect(events.every((e) => e.type === "watched")).toBe(true);
    db.close();
  });

  it("imports favourites as favourited events", () => {
    const db = openActivityDb(ACTIVITY_DB);
    const favourites = [{ id: "xyz", name: "Heat.1995.1080p", magnet: "magnet:?xt=1", addedAt: 3000 }];
    backfillFromTorlink(db, { history: [], favourites });
    const events = getUnresolvedEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("favourited");
    expect(events[0].rawName).toBe("Heat.1995.1080p");
    db.close();
  });

  it("is idempotent: re-running does not duplicate events for the same source", () => {
    const db = openActivityDb(ACTIVITY_DB);
    const history = [{ id: "abc123", name: "The.Matrix.1999.1080p", completedAt: 1000 }];
    backfillFromTorlink(db, { history, favourites: [] });
    backfillFromTorlink(db, { history, favourites: [] });
    expect(getUnresolvedEvents(db)).toHaveLength(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- backfill
```
Expected: FAIL with "Cannot find module './backfill.js'"

- [ ] **Step 3: Implement `src/events/backfill.ts`**

```typescript
import Database from "better-sqlite3";
import { insertEvent } from "../db/activity.js";

export interface TorlinkHistoryItem {
  id: string;
  name: string;
  completedAt: number;
}

export interface TorlinkFavouriteItem {
  id: string;
  name: string;
  addedAt: number;
}

export interface TorlinkSnapshot {
  history: TorlinkHistoryItem[];
  favourites: TorlinkFavouriteItem[];
}

const BACKFILL_SOURCE = "torlink-backfill";

export function backfillFromTorlink(db: Database.Database, snapshot: TorlinkSnapshot): number {
  const alreadyImported = new Set(
    db
      .prepare(`SELECT raw_name || ':' || type AS k FROM events WHERE source = ?`)
      .all(BACKFILL_SOURCE)
      .map((r: any) => r.k)
  );

  let count = 0;
  for (const item of snapshot.history) {
    const key = `${item.name}:watched`;
    if (alreadyImported.has(key)) continue;
    insertEvent(db, { type: "watched", rawName: item.name, ts: item.completedAt, source: BACKFILL_SOURCE });
    alreadyImported.add(key);
    count += 1;
  }
  for (const item of snapshot.favourites) {
    const key = `${item.name}:favourited`;
    if (alreadyImported.has(key)) continue;
    insertEvent(db, { type: "favourited", rawName: item.name, ts: item.addedAt, source: BACKFILL_SOURCE });
    alreadyImported.add(key);
    count += 1;
  }
  return count;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- backfill
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add torlink history/favourites backfill importer"
```

---

### Task 12: HTTP API server

**Files:**
- Create: `~/projects/reccd/src/api/server.ts`
- Test: `~/projects/reccd/src/api/server.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { openCatalogDb, upsertTitle } from "../db/catalog.js";
import { openActivityDb } from "../db/activity.js";
import { buildServer } from "./server.js";

const CATALOG_DB = "/tmp/reccd-api-catalog-test.db";
const ACTIVITY_DB = "/tmp/reccd-api-activity-test.db";
const TOKEN = "test-token";

let app: ReturnType<typeof buildServer>;

beforeEach(() => {
  const catalogDb = openCatalogDb(CATALOG_DB);
  upsertTitle(catalogDb, { imdbId: "tt1", title: "Great Thriller", year: 2025, type: "movie", genres: ["Thriller"], rating: 8, votes: 100000 });
  const activityDb = openActivityDb(ACTIVITY_DB);
  app = buildServer({ catalogDb, activityDb, token: TOKEN, currentYear: 2026 });
});

afterEach(() => {
  app.close();
  for (const p of [CATALOG_DB, ACTIVITY_DB]) if (fs.existsSync(p)) fs.unlinkSync(p);
});

describe("API auth", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/recommendations" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    const res = await app.inject({ method: "GET", url: "/recommendations", headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /recommendations", () => {
  it("returns ranked recommendations", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/recommendations?type=movie&limit=5",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body[0].imdbId).toBe("tt1");
    expect(body[0].title).toBe("Great Thriller");
  });
});

describe("POST /events", () => {
  it("accepts a batch of events and returns 202", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { events: [{ type: "watched", rawName: "Great.Thriller.2025.1080p", ts: 1000, source: "torlink" }] },
    });
    expect(res.statusCode).toBe(202);
  });

  it("rejects a malformed payload with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { notEvents: true },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /resolve", () => {
  it("returns the canonicalization result for a name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/resolve?name=Great.Thriller.2025.1080p",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ imdbId: "tt1", confidence: 1 });
  });
});

describe("GET /profile", () => {
  it("returns the current taste profile", async () => {
    const res = await app.inject({ method: "GET", url: "/profile", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("genreWeights");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- api/server
```
Expected: FAIL with "Cannot find module './server.js'"

- [ ] **Step 3: Implement `src/api/server.ts`**

```typescript
import Fastify from "fastify";
import type Database from "better-sqlite3";
import { insertEvent, EVENT_TYPES, type EventType } from "../db/activity.js";
import { resolveReleaseName } from "../canonicalize/resolve.js";
import { drainUnresolvedEvents } from "../canonicalize/resolveQueue.js";
import { buildTasteProfile } from "../scoring/tasteProfile.js";
import { recommend } from "../scoring/recommend.js";
import type { TitleType } from "../db/catalog.js";

export interface ServerDeps {
  catalogDb: Database.Database;
  activityDb: Database.Database;
  token: string;
  currentYear: number;
}

interface IncomingEvent {
  type: EventType;
  rawName: string;
  ts: number;
  source: string;
}

function isIncomingEvent(value: unknown): value is IncomingEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === "string" &&
    (EVENT_TYPES as readonly string[]).includes(v.type) &&
    typeof v.rawName === "string" &&
    typeof v.ts === "number" &&
    typeof v.source === "string"
  );
}

export function buildServer(deps: ServerDeps) {
  const app = Fastify();

  app.addHook("onRequest", async (req, reply) => {
    const header = req.headers.authorization;
    const expected = `Bearer ${deps.token}`;
    if (header !== expected) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/recommendations", async (req) => {
    const query = req.query as { type?: string; genre?: string; limit?: string };
    return recommend(deps.catalogDb, deps.activityDb, {
      type: query.type as TitleType | undefined,
      genre: query.genre,
      limit: query.limit ? Number(query.limit) : 20,
      currentYear: deps.currentYear,
    });
  });

  app.get("/profile", async () => {
    return buildTasteProfile(deps.catalogDb, deps.activityDb);
  });

  app.get("/resolve", async (req, reply) => {
    const query = req.query as { name?: string };
    if (!query.name) {
      reply.code(400);
      return { error: "missing name query param" };
    }
    const match = resolveReleaseName(deps.catalogDb, query.name);
    return match ?? { imdbId: null, confidence: 0 };
  });

  app.post("/events", async (req, reply) => {
    const body = req.body as { events?: unknown };
    if (!Array.isArray(body.events) || body.events.length === 0 || !body.events.every(isIncomingEvent)) {
      reply.code(400);
      return { error: "invalid events payload" };
    }
    for (const event of body.events as IncomingEvent[]) {
      insertEvent(deps.activityDb, event);
    }
    drainUnresolvedEvents(deps.catalogDb, deps.activityDb);
    reply.code(202);
    return { accepted: body.events.length };
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- api/server
```
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add HTTP API server with bearer auth"
```

---

### Task 13: Entrypoint wiring

**Files:**
- Create: `~/projects/reccd/src/index.ts`

- [ ] **Step 1: Implement `src/index.ts`**

```typescript
import { loadConfig } from "./config.js";
import { openCatalogDb } from "./db/catalog.js";
import { openActivityDb } from "./db/activity.js";
import { buildServer } from "./api/server.js";

const config = loadConfig(process.env);
const catalogDb = openCatalogDb(config.catalogDbPath);
const activityDb = openActivityDb(config.activityDbPath);

const app = buildServer({
  catalogDb,
  activityDb,
  token: config.token,
  currentYear: new Date().getFullYear(),
});

app.listen({ port: config.port, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`reccd listening on ${address}`);
});
```

- [ ] **Step 2: Verify it starts locally**

```bash
RECCD_TOKEN=dev-token npm run dev
```
Expected: console prints `reccd listening on http://0.0.0.0:4100` and the process stays up (Ctrl+C to stop).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: wire up reccd entrypoint"
```

---

## Part B — torlink integration

### Task 14: torlink config fields for reccd

**Files:**
- Modify: `src/config/config.ts:20-62` (interface), near line 25
- Test: `src/config/config.test.ts`

- [ ] **Step 1: Read the existing test file to find the right location for a new test**

Look at how `realDebridToken` round-trips through `loadConfig`/`saveConfig` in `src/config/config.test.ts` and add an equivalent test near it:

```typescript
it("round-trips reccUrl and reccToken", async () => {
  const cfg = await loadConfig();
  cfg.reccUrl = "http://localhost:4100";
  cfg.reccToken = "dev-token";
  await saveConfig(cfg);
  const reloaded = await loadConfig();
  expect(reloaded.reccUrl).toBe("http://localhost:4100");
  expect(reloaded.reccToken).toBe("dev-token");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- config
```
Expected: FAIL with a TypeScript error — `reccUrl`/`reccToken` do not exist on `Config`.

- [ ] **Step 3: Add the fields to the `Config` interface**

In `src/config/config.ts`, alongside the existing `realDebridToken?: string;` declaration (around line 25), add:

```typescript
  /** Base URL of the reccd recommendation service, e.g. http://localhost:4100 */
  reccUrl?: string;
  /** Bearer token for authenticating with reccd */
  reccToken?: string;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- config
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts src/config/config.test.ts
git commit -m "feat: add reccUrl/reccToken config fields"
```

---

### Task 15: recc event client

**Files:**
- Create: `src/recc/client.ts`
- Test: `src/recc/client.test.ts`

- [ ] **Step 1: Write the failing test, following the fetchImpl-injection pattern from `src/integrations/realdebrid.test.ts`**

```typescript
// src/recc/client.test.ts
import { describe, it, expect, vi } from "vitest";
import { postEvent } from "./client.js";

function jsonRes(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("postEvent", () => {
  it("posts to {reccUrl}/events with a bearer token and the event payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(202, { accepted: 1 }));
    await postEvent(
      { reccUrl: "http://localhost:4100", reccToken: "dev-token" },
      { type: "watched", rawName: "The.Matrix.1999.1080p", ts: 1000, source: "torlink" },
      { fetchImpl }
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:4100/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer dev-token" }),
      })
    );
  });

  it("does nothing when reccUrl is not configured", async () => {
    const fetchImpl = vi.fn();
    await postEvent({}, { type: "watched", rawName: "x", ts: 1, source: "torlink" }, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows network errors without throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      postEvent({ reccUrl: "http://localhost:4100", reccToken: "t" }, { type: "watched", rawName: "x", ts: 1, source: "torlink" }, { fetchImpl })
    ).resolves.toBeUndefined();
  });

  it("swallows non-2xx responses without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(500));
    await expect(
      postEvent({ reccUrl: "http://localhost:4100", reccToken: "t" }, { type: "watched", rawName: "x", ts: 1, source: "torlink" }, { fetchImpl })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- recc/client
```
Expected: FAIL with "Cannot find module './client.js'"

- [ ] **Step 3: Implement `src/recc/client.ts`**

```typescript
export type ReccEventType = "started" | "watched" | "favourited" | "unfavourited" | "liked" | "disliked" | "abandoned";

export interface ReccEvent {
  type: ReccEventType;
  rawName: string;
  ts: number;
  source: string;
}

export interface ReccClientConfig {
  reccUrl?: string;
  reccToken?: string;
}

export interface PostEventOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function postEvent(config: ReccClientConfig, event: ReccEvent, opts: PostEventOptions = {}): Promise<void> {
  if (!config.reccUrl) return;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${config.reccUrl}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.reccToken ?? ""}`,
      },
      body: JSON.stringify({ events: [event] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
    if (!res.ok) return;
  } catch {
    // Fire-and-forget: reccd being unreachable must never affect torlink.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- recc/client
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add fire-and-forget reccd event client"
```

---

### Task 16: Wire event posts into App.tsx

**Files:**
- Modify: `src/ui/App.tsx` (see line references below)
- Test: manual verification (see Step 5) — this task is UI wiring in an already-tested client; no new unit tests are added here, matching how other App.tsx call-site wiring is handled in this codebase.

- [ ] **Step 1: Post a `started` event when a torrent stream begins**

In `src/ui/App.tsx`, inside `startTorrentStream(input)` (around lines 653-703), right after `setActiveStream(...)` (line 686), add:

```typescript
void postEvent(
  { reccUrl: config.reccUrl, reccToken: config.reccToken },
  { type: "started", rawName: input.name, ts: Date.now(), source: "torlink" }
);
```

Add the import at the top of `App.tsx`:

```typescript
import { postEvent } from "../recc/client.js";
```

(Confirm the exact relative path from `src/ui/App.tsx` to `src/recc/client.ts` — it is `../recc/client.js` since both `ui/` and `recc/` are direct children of `src/`.)

- [ ] **Step 2: Post a `watched` event when playback completes**

In `playFromPicker(file)` (around lines 632-641), alongside the existing `markWatchedInFavourite(streamSource.id, file.filename)` call (line 637), add:

```typescript
void postEvent(
  { reccUrl: config.reccUrl, reccToken: config.reccToken },
  { type: "watched", rawName: streamSource.name, ts: Date.now(), source: "torlink" }
);
```

Also add the same call in `playStream(url, name)` (lines 598-617) right before/after `launchPlayer` — use the `name` parameter passed into `playStream` as `rawName`, so single-file streams (not just multi-file picker streams) count as watched too.

- [ ] **Step 3: Post `favourited`/`unfavourited` events from the favourite toggle**

In App's `toggleFavourite(item: FavouriteItem)` wrapper (around lines 405-414), after computing whether the item was added or removed (the existing logic already knows this to persist config), add:

```typescript
void postEvent(
  { reccUrl: config.reccUrl, reccToken: config.reccToken },
  { type: wasAdded ? "favourited" : "unfavourited", rawName: item.name, ts: Date.now(), source: "torlink" }
);
```

(`wasAdded` should reuse whatever boolean the existing function already derives to decide the toast/notice message — do not add a second favourites-array scan.)

- [ ] **Step 4: Post an `abandoned` event on queue cancel**

In `src/download/queue.ts`, `DownloadQueue.cancel(id)` (around lines 717-731), the function already loads `it = this.items.get(id)` (line 718). Since `queue.ts` doesn't have access to `config` or `postEvent` directly (it's a download-layer module, not UI), instead wire this at the call site in `src/ui/components/Downloads.tsx` line 148:

```typescript
if (input === "c") {
  void postEvent(
    { reccUrl: config.reccUrl, reccToken: config.reccToken },
    { type: "abandoned", rawName: it.name, ts: Date.now(), source: "torlink" }
  );
  queue.cancel(it.id);
}
```

This requires `Downloads.tsx` to receive `config` as a prop — check how `App.tsx` already renders `<Downloads .../>` and pass `config={config}` alongside existing props, then add `config: Config` to `DownloadsProps` and import `postEvent` + `Config` type at the top of `Downloads.tsx`.

- [ ] **Step 5: Manual verification**

```bash
cd /home/ash/projects/torlink/.claude/worktrees/squishy-snuggling-bengio
RECCD_TOKEN=dev-token npm run dev --prefix ~/projects/reccd &
npm run dev
```
In torlink: set `reccUrl`/`reccToken` in config.json (or add a quick manual edit), start a stream, favourite an item, cancel a download. Confirm via `curl -H "Authorization: Bearer dev-token" http://localhost:4100/profile` that `genreWeights` is non-empty after resolving (may need to run the resolver — events auto-drain on each `/events` POST per Task 12's server wiring).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: post activity events to reccd from stream/favourite/abandon flows"
```

---

### Task 17: Like/dislike prompt after streaming

**Files:**
- Create: `src/ui/components/RatePrompt.tsx`
- Modify: `src/ui/App.tsx` (state + useInput guard + render, see line references)
- Test: `src/ui/components/RatePrompt.test.tsx`

- [ ] **Step 1: Write the failing test using `ink-testing-library`, following the pattern of any existing component test in `src/ui/components/`**

```typescript
// src/ui/components/RatePrompt.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { RatePrompt } from "./RatePrompt.js";

describe("RatePrompt", () => {
  it("calls onLike when 'l' is pressed", () => {
    const onLike = vi.fn();
    const onDislike = vi.fn();
    const onDismiss = vi.fn();
    const { stdin } = render(<RatePrompt name="The Matrix" onLike={onLike} onDislike={onDislike} onDismiss={onDismiss} />);
    stdin.write("l");
    expect(onLike).toHaveBeenCalled();
  });

  it("calls onDislike when 'd' is pressed", () => {
    const onLike = vi.fn();
    const onDislike = vi.fn();
    const onDismiss = vi.fn();
    const { stdin } = render(<RatePrompt name="The Matrix" onLike={onLike} onDislike={onDislike} onDismiss={onDismiss} />);
    stdin.write("d");
    expect(onDislike).toHaveBeenCalled();
  });

  it("calls onDismiss on escape", () => {
    const onLike = vi.fn();
    const onDislike = vi.fn();
    const onDismiss = vi.fn();
    const { stdin } = render(<RatePrompt name="The Matrix" onLike={onLike} onDislike={onDislike} onDismiss={onDismiss} />);
    stdin.write("");
    expect(onDismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- RatePrompt
```
Expected: FAIL with "Cannot find module './RatePrompt.js'"

- [ ] **Step 3: Implement `src/ui/components/RatePrompt.tsx`, mirroring `src/ui/components/ConfirmPrompt.tsx`'s structure**

```typescript
import React from "react";
import { Box, Text, useInput } from "ink";

export interface RatePromptProps {
  name: string;
  onLike: () => void;
  onDislike: () => void;
  onDismiss: () => void;
}

export function RatePrompt({ name, onLike, onDislike, onDismiss }: RatePromptProps) {
  useInput((input, key) => {
    if (input === "l") onLike();
    else if (input === "d") onDislike();
    else if (key.escape) onDismiss();
  });

  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>
        How was <Text bold>{name}</Text>? (l) like  (d) dislike  (esc) skip
      </Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- RatePrompt
```
Expected: PASS (3 tests)

- [ ] **Step 5: Wire `RatePrompt` into `App.tsx`**

Add state near the other prompt states (alongside `keepPrompt`, `torrentPrompt` — search for `useState` calls near line 190-192):

```typescript
const [ratePrompt, setRatePrompt] = useState<{ name: string } | null>(null);
```

In `stopStream()` (lines 731-743), after the existing clear/complete logic, add:

```typescript
setRatePrompt({ name: active.input.name });
```

(where `active` is whatever local variable `stopStream` already uses to reference the outgoing `activeStream` before clearing it — reuse it rather than re-reading state.)

Add an early-return guard in the top-level `useInput` dispatcher (around line 1303-1321, alongside the other prompt guards):

```typescript
if (ratePrompt) return;
```

Render the prompt conditionally near where `keepPrompt`/`torrentPrompt` are rendered (around lines 1613-1681):

```tsx
{ratePrompt && (
  <RatePrompt
    name={ratePrompt.name}
    onLike={() => {
      void postEvent(
        { reccUrl: config.reccUrl, reccToken: config.reccToken },
        { type: "liked", rawName: ratePrompt.name, ts: Date.now(), source: "torlink" }
      );
      setRatePrompt(null);
    }}
    onDislike={() => {
      void postEvent(
        { reccUrl: config.reccUrl, reccToken: config.reccToken },
        { type: "disliked", rawName: ratePrompt.name, ts: Date.now(), source: "torlink" }
      );
      setRatePrompt(null);
    }}
    onDismiss={() => setRatePrompt(null)}
  />
)}
```

Add the import at the top of `App.tsx`:

```typescript
import { RatePrompt } from "./components/RatePrompt.js";
```

Register `ratePrompt` in the two `region: "help"` gate lists (lines 1208 and 1738) and the footer gate (line 1791), following the exact pattern the other prompt state variables use in those three spots (each existing prompt appears as one more `||`-chained boolean condition — add `!!ratePrompt` alongside them).

- [ ] **Step 6: Run the full torlink test suite**

```bash
npm test
```
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: prompt for like/dislike after a stream ends"
```

---

## Part C — Wrap-up

### Task 18: README for reccd

**Files:**
- Create: `~/projects/reccd/README.md`

- [ ] **Step 1: Write a minimal operational README**

```markdown
# reccd

Self-hosted, single-user recommendation service for torlink. Tracks watch/favourite/like/dislike/abandon
activity, canonicalizes it against a local IMDb-backed catalog, and serves genre+recency+quality-based
recommendations. Returns IMDb/TMDB IDs and titles only — no metadata redistribution.

## Setup

    npm install
    RECCD_TOKEN=<pick-a-secret> npm run import:imdb   # populates data/catalog.db (~10-20 min)
    RECCD_TOKEN=<pick-a-secret> npm run dev             # starts the API on :4100

## Environment variables

- `RECCD_TOKEN` (required) — bearer token clients must send
- `RECCD_PORT` (default 4100)
- `RECCD_DATA_DIR` (default `./data`)
- `RECCD_MIN_VOTES` (default 1000) — reserved for Phase 2 TMDB enrichment threshold

## Recurring maintenance

Re-run `npm run import:imdb` periodically (e.g. nightly via cron) to refresh the catalog from IMDb's
daily dataset exports.

## API

- `POST /events` — `{ events: [{ type, rawName, ts, source }] }` → 202
- `GET /recommendations?type=movie|tv&genre=&limit=` → `[{ imdbId, title, year, score, reasons }]`
- `GET /profile` → inferred taste profile
- `GET /resolve?name=` → canonicalization debug

All endpoints require `Authorization: Bearer <RECCD_TOKEN>`.
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "docs: add reccd README"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage:** catalog (Task 2-3), activity/events (Task 4), canonicalizer (Task 5-7), taste profile + scoring (Task 8-10), backfill (Task 11), API (Task 12-13), torlink client + wiring + like/dislike (Task 14-17) — all Phase 1 spec items are covered. CF/embeddings/TMDB are explicitly out of scope (Phase 2/3).
- **Diversity pass** from the spec is deliberately simplified to genre filtering in Task 10, with a note explaining why (small personal catalog subset makes MMR-style re-ranking premature complexity for Phase 1).
- **Type consistency:** `EventType` (activity.ts) matches `ReccEventType` (client.ts) string-for-string; `CatalogTitle`/`TasteProfile`/`ScoredCandidate`/`Recommendation` field names are consistent across Tasks 2, 8, 9, 10, 12.
- Task 16/17 App.tsx line numbers are drawn from the Explore agent's research and should be re-confirmed against the actual file at execution time since line numbers shift as the file is edited task-to-task — treat them as strong hints, not guarantees.
