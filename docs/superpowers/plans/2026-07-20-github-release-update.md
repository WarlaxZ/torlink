# GitHub-release Update Checking + Bundle Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the update check compare against the fork's GitHub Releases and make `torlnk update` download, verify, and swap a self-contained bundle install in place.

**Architecture:** A new `github.ts` derives the repo slug from `package.json`'s `repository.url` and reads the latest release from the GitHub API; `version.ts`'s `fetchLatestVersion` is rewritten to use it while keeping a stable signature so the banner and CLI keep working. A new `bundle.ts` detects a bundle install, maps the platform to a release asset, verifies its SHA-256, and swaps the extracted runtime into place (Unix atomic move; Windows staged `.cmd` helper). `run.ts` gains a bundle branch ahead of the existing git/npm branches.

**Tech Stack:** TypeScript, Node built-ins (`node:crypto`, `node:fs`, `node:os`, `node:child_process`), `fetchResilient` from `src/util/net.ts`, vitest with injected `fetchImpl`/dependency functions (no real network or shelling in tests).

---

## File Structure

- `src/update/manifest.ts` (modify) — add `repoUrl` to `PackageManifest`, read from `repository.url`.
- `src/update/github.ts` (create) — `parseRepoSlug`, `fetchLatestRelease`, the `GithubRelease` type.
- `src/update/github.test.ts` (create) — tests for the above.
- `src/update/version.ts` (modify) — rewrite `fetchLatestVersion` to use GitHub; keep `compareVersions`/`isNewer`.
- `src/update/version.test.ts` (modify) — replace npm-registry tests with GitHub-backed ones.
- `src/update/bundle.ts` (create) — `assetNameFor`, `isBundleInstall`, `verifySha256`, `swapInPlace`, `applyBundleUpdate`.
- `src/update/bundle.test.ts` (create) — tests for the above.
- `src/update/run.ts` (modify) — branch to `applyBundleUpdate` for bundle installs.
- `src/update/manifest.test.ts` (modify) — cover `repoUrl` parsing.
- `package.json` (modify) — repoint `repository`/`homepage`/`bugs` to `WarlaxZ/torlink`.

---

## Task 1: Add `repoUrl` to the manifest

**Files:**
- Modify: `src/update/manifest.ts`
- Test: `src/update/manifest.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/update/manifest.test.ts` (keep existing tests):

```typescript
import { describe, it, expect } from "vitest";
import { repoUrlOf } from "./manifest";

describe("repoUrlOf", () => {
  it("reads a string repository field", () => {
    expect(repoUrlOf({ repository: "https://github.com/o/r" })).toBe("https://github.com/o/r");
  });
  it("reads the url from an object repository field", () => {
    expect(repoUrlOf({ repository: { url: "git+https://github.com/o/r.git" } })).toBe(
      "git+https://github.com/o/r.git",
    );
  });
  it("returns null when absent or malformed", () => {
    expect(repoUrlOf({})).toBeNull();
    expect(repoUrlOf({ repository: { url: 42 } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/update/manifest.test.ts -t repoUrlOf`
Expected: FAIL — `repoUrlOf` is not exported.

- [ ] **Step 3: Implement `repoUrlOf` and add `repoUrl` to the manifest**

In `src/update/manifest.ts`, add `repoUrl` to the interface:

```typescript
export interface PackageManifest {
  name: string;
  version: string;
  root: string;
  repoUrl: string | null;
}
```

Add the exported helper (place above `readManifest`):

```typescript
// package.json's repository field is either a string or a { type, url } object.
// Returns the raw URL string (unnormalised) or null when absent/malformed.
export function repoUrlOf(pkg: {
  repository?: unknown;
}): string | null {
  const r = pkg.repository;
  if (typeof r === "string") return r;
  if (r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string") {
    return (r as { url: string }).url;
  }
  return null;
}
```

In `readManifest`, widen the parsed shape and populate `repoUrl`:

```typescript
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
        repository?: unknown;
      };
      if (typeof raw.name === "string" && typeof raw.version === "string") {
        return { name: raw.name, version: raw.version, root: dir, repoUrl: repoUrlOf(raw) };
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/update/manifest.test.ts`
Expected: PASS (new and existing tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/update/manifest.ts src/update/manifest.test.ts
git commit -m "feat(update): expose repository URL on the package manifest"
```

---

## Task 2: `parseRepoSlug`

**Files:**
- Create: `src/update/github.ts`
- Test: `src/update/github.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/update/github.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseRepoSlug } from "./github";

describe("parseRepoSlug", () => {
  it("parses git+https with a .git suffix", () => {
    expect(parseRepoSlug("git+https://github.com/WarlaxZ/torlink.git")).toEqual({
      owner: "WarlaxZ",
      repo: "torlink",
    });
  });
  it("parses a plain https url", () => {
    expect(parseRepoSlug("https://github.com/WarlaxZ/torlink")).toEqual({
      owner: "WarlaxZ",
      repo: "torlink",
    });
  });
  it("parses an ssh url", () => {
    expect(parseRepoSlug("git@github.com:WarlaxZ/torlink.git")).toEqual({
      owner: "WarlaxZ",
      repo: "torlink",
    });
  });
  it("returns null for a non-github url or garbage", () => {
    expect(parseRepoSlug("https://gitlab.com/o/r")).toBeNull();
    expect(parseRepoSlug("not a url")).toBeNull();
    expect(parseRepoSlug(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/update/github.test.ts -t parseRepoSlug`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement `parseRepoSlug`**

Create `src/update/github.ts`:

```typescript
import { fetchResilient, USER_AGENT, type FetchImpl } from "../util/net";

export interface GithubRelease {
  version: string; // tag_name with a leading "v" stripped
  assets: { name: string; url: string }[];
  sha256Url: string | null;
}

// Pull { owner, repo } out of a package.json repository URL. Handles the common
// forms: git+https://github.com/OWNER/REPO.git, https://github.com/OWNER/REPO,
// and git@github.com:OWNER/REPO.git. Returns null for non-GitHub or unparseable
// input so the caller can fail soft.
export function parseRepoSlug(url: string | null | undefined): {
  owner: string;
  repo: string;
} | null {
  if (typeof url !== "string") return null;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/update/github.test.ts -t parseRepoSlug`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/update/github.ts src/update/github.test.ts
git commit -m "feat(update): parse the GitHub owner/repo slug from a repository url"
```

---

## Task 3: `fetchLatestRelease`

**Files:**
- Modify: `src/update/github.ts`
- Test: `src/update/github.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/update/github.test.ts`:

```typescript
import { fetchLatestRelease } from "./github";

describe("fetchLatestRelease", () => {
  const body = {
    tag_name: "v1.5.1",
    assets: [
      { name: "torlnk-linux-x64.tar.gz", browser_download_url: "https://d/l.tar.gz" },
      { name: "SHA256SUMS", browser_download_url: "https://d/SHA256SUMS" },
    ],
  };
  const ok = (): Response =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  it("returns the version, assets, and the SHA256SUMS url", async () => {
    const rel = await fetchLatestRelease({ owner: "WarlaxZ", repo: "torlink", fetchImpl: ok });
    expect(rel).toEqual({
      version: "1.5.1",
      assets: [
        { name: "torlnk-linux-x64.tar.gz", url: "https://d/l.tar.gz" },
        { name: "SHA256SUMS", url: "https://d/SHA256SUMS" },
      ],
      sha256Url: "https://d/SHA256SUMS",
    });
  });
  it("calls the releases/latest endpoint for the slug", async () => {
    const urls: string[] = [];
    await fetchLatestRelease({
      owner: "WarlaxZ",
      repo: "torlink",
      fetchImpl: async (url) => {
        urls.push(url);
        return ok();
      },
    });
    expect(urls).toEqual(["https://api.github.com/repos/WarlaxZ/torlink/releases/latest"]);
  });
  it("returns null on a non-ok response", async () => {
    const rel = await fetchLatestRelease({
      owner: "o",
      repo: "r",
      fetchImpl: async () => ({ ok: false, status: 404 }) as unknown as Response,
    });
    expect(rel).toBeNull();
  });
  it("returns null when the fetch throws (offline/timeout)", async () => {
    const rel = await fetchLatestRelease({
      owner: "o",
      repo: "r",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(rel).toBeNull();
  });
  it("returns null when tag_name is missing", async () => {
    const rel = await fetchLatestRelease({
      owner: "o",
      repo: "r",
      fetchImpl: async () => ({ ok: true, json: async () => ({ assets: [] }) }) as unknown as Response,
    });
    expect(rel).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/update/github.test.ts -t fetchLatestRelease`
Expected: FAIL — `fetchLatestRelease` not exported.

- [ ] **Step 3: Implement `fetchLatestRelease`**

Append to `src/update/github.ts`:

```typescript
// Read the latest published release for a repo. Never throws: this feeds a
// background banner and a re-runnable command, so a flaky moment fails soft.
export async function fetchLatestRelease(opts: {
  owner: string;
  repo: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}): Promise<GithubRelease | null> {
  const { owner, repo, fetchImpl, timeoutMs = 4000 } = opts;
  try {
    const res = await fetchResilient(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      {
        retries: 0,
        headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(timeoutMs),
        fetchImpl,
      },
    );
    if (!res.ok) return null;
    const b = (await res.json()) as {
      tag_name?: unknown;
      assets?: { name?: unknown; browser_download_url?: unknown }[];
    };
    if (typeof b.tag_name !== "string") return null;
    const assets = (b.assets ?? [])
      .filter(
        (a): a is { name: string; browser_download_url: string } =>
          typeof a.name === "string" && typeof a.browser_download_url === "string",
      )
      .map((a) => ({ name: a.name, url: a.browser_download_url }));
    return {
      version: b.tag_name.replace(/^v/i, ""),
      assets,
      sha256Url: assets.find((a) => a.name === "SHA256SUMS")?.url ?? null,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/update/github.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/update/github.ts src/update/github.test.ts
git commit -m "feat(update): read the latest GitHub release for a repo slug"
```

---

## Task 4: Rewrite `fetchLatestVersion` to use GitHub

**Files:**
- Modify: `src/update/version.ts`
- Test: `src/update/version.test.ts`

- [ ] **Step 1: Rewrite the `fetchLatestVersion` tests**

Replace the entire `describe("fetchLatestVersion", ...)` block in `src/update/version.test.ts` with:

```typescript
describe("fetchLatestVersion", () => {
  const release = (tag: string): Response =>
    ({ ok: true, json: async () => ({ tag_name: tag, assets: [] }) }) as unknown as Response;

  it("returns the version from the repo's latest GitHub release", async () => {
    const v = await fetchLatestVersion({
      repoUrl: "https://github.com/WarlaxZ/torlink",
      fetchImpl: async () => release("v1.5.1"),
    });
    expect(v).toBe("1.5.1");
  });
  it("builds the API url from the repository slug", async () => {
    const urls: string[] = [];
    await fetchLatestVersion({
      repoUrl: "git+https://github.com/WarlaxZ/torlink.git",
      fetchImpl: async (url) => {
        urls.push(url);
        return release("v2.0.0");
      },
    });
    expect(urls).toEqual(["https://api.github.com/repos/WarlaxZ/torlink/releases/latest"]);
  });
  it("returns null when the repo url is not a GitHub url", async () => {
    const v = await fetchLatestVersion({
      repoUrl: "https://gitlab.com/o/r",
      fetchImpl: async () => release("v9.9.9"),
    });
    expect(v).toBeNull();
  });
  it("returns null on a non-ok response", async () => {
    const v = await fetchLatestVersion({
      repoUrl: "https://github.com/o/r",
      fetchImpl: async () => ({ ok: false, status: 404 }) as unknown as Response,
    });
    expect(v).toBeNull();
  });
});
```

Keep the existing `compareVersions` and `isNewer` describe blocks unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/update/version.test.ts -t fetchLatestVersion`
Expected: FAIL — current implementation calls npm and ignores `repoUrl`.

- [ ] **Step 3: Rewrite `fetchLatestVersion`**

Replace the `fetchLatestVersion` function (and its npm-specific imports) in `src/update/version.ts`. The top of the file becomes:

```typescript
import { type FetchImpl } from "../util/net";
import { readManifest } from "./manifest";
import { parseRepoSlug, fetchLatestRelease } from "./github";
```

`compareVersions` and `isNewer` stay exactly as they are. Replace the old
`fetchLatestVersion` with:

```typescript
// Ask GitHub for the latest release version of whatever repo this build's
// manifest points at (repository.url). The slug is derived at runtime, never
// hardcoded, so a fork check always targets the fork. Never throws: the caller
// is a background banner or a one-shot command, neither of which should care
// that the network was down.
export async function fetchLatestVersion(
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number; repoUrl?: string } = {},
): Promise<string | null> {
  const repoUrl = opts.repoUrl ?? readManifest()?.repoUrl ?? null;
  const slug = parseRepoSlug(repoUrl);
  if (!slug) return null;
  const release = await fetchLatestRelease({
    owner: slug.owner,
    repo: slug.repo,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  return release?.version ?? null;
}
```

Delete the now-unused `USER_AGENT` / `fetchResilient` imports and the
`readManifest` package-name branch if the editor flags them as unused.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/update/version.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors (fix any unused-import lint hits from the rewrite).

- [ ] **Step 6: Commit**

```bash
git add src/update/version.ts src/update/version.test.ts
git commit -m "feat(update): source the latest version from GitHub releases"
```

---

## Task 5: Repoint package metadata to the fork

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Edit the metadata**

In `package.json`, change these three fields:

```json
  "repository": {
    "type": "git",
    "url": "git+https://github.com/WarlaxZ/torlink.git"
  },
  "homepage": "https://github.com/WarlaxZ/torlink",
  "bugs": {
    "url": "https://github.com/WarlaxZ/torlink/issues"
  },
```

- [ ] **Step 2: Verify the slug resolves**

Run: `npx tsx -e "import {parseRepoSlug} from './src/update/github'; import pkg from './package.json'; console.log(parseRepoSlug(pkg.repository.url))"`
Expected: prints `{ owner: 'WarlaxZ', repo: 'torlink' }`.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS (the manifest-driven update tests now see the fork URL).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: point repository/homepage/bugs at the WarlaxZ fork"
```

---

## Task 6: Bundle detection + asset mapping

**Files:**
- Create: `src/update/bundle.ts`
- Test: `src/update/bundle.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/update/bundle.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import path from "node:path";
import { assetNameFor, isBundleInstall } from "./bundle";

describe("assetNameFor", () => {
  it("maps supported platform/arch pairs to release asset names", () => {
    expect(assetNameFor("linux", "x64")).toBe("torlnk-linux-x64.tar.gz");
    expect(assetNameFor("darwin", "x64")).toBe("torlnk-macos-x64.tar.gz");
    expect(assetNameFor("darwin", "arm64")).toBe("torlnk-macos-arm64.tar.gz");
    expect(assetNameFor("win32", "x64")).toBe("torlnk-windows-x64.zip");
  });
  it("returns null for unsupported combinations", () => {
    expect(assetNameFor("linux", "arm64")).toBeNull();
    expect(assetNameFor("freebsd", "x64")).toBeNull();
  });
});

describe("isBundleInstall", () => {
  const root = path.join("/opt", "torlnk-runtime");
  it("is true when the running node lives inside the manifest root", () => {
    expect(isBundleInstall(root, path.join(root, "node"))).toBe(true);
  });
  it("is false when node is the system node (git/npm install)", () => {
    expect(isBundleInstall(root, "/usr/bin/node")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/update/bundle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `assetNameFor` and `isBundleInstall`**

Create `src/update/bundle.ts`:

```typescript
import path from "node:path";

// Map the running platform/arch to the asset name that release.yml publishes.
// Anything not built by the release workflow returns null so the caller can
// stop with a clear "unsupported platform" message.
export function assetNameFor(
  platform: NodeJS.Platform | string,
  arch: string,
): string | null {
  if (platform === "linux" && arch === "x64") return "torlnk-linux-x64.tar.gz";
  if (platform === "darwin" && arch === "x64") return "torlnk-macos-x64.tar.gz";
  if (platform === "darwin" && arch === "arm64") return "torlnk-macos-arm64.tar.gz";
  if (platform === "win32" && arch === "x64") return "torlnk-windows-x64.zip";
  return null;
}

// A bundle install runs the bundled node that sits inside the runtime dir
// (manifest.root). A git checkout or npm-global install runs the system node,
// whose path is outside root. Comparing the resolved execPath against root
// distinguishes the two without any extra marker file.
export function isBundleInstall(root: string, execPath: string): boolean {
  const rel = path.relative(root, execPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/update/bundle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/update/bundle.ts src/update/bundle.test.ts
git commit -m "feat(update): detect bundle installs and map platform assets"
```

---

## Task 7: SHA-256 verification

**Files:**
- Modify: `src/update/bundle.ts`
- Test: `src/update/bundle.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/update/bundle.test.ts`:

```typescript
import { createHash } from "node:crypto";
import { verifySha256 } from "./bundle";

describe("verifySha256", () => {
  const data = Buffer.from("hello torlink");
  const digest = createHash("sha256").update(data).digest("hex");
  const sums = `${digest}  torlnk-linux-x64.tar.gz\ndeadbeef  other-file\n`;

  it("passes when the file digest matches its SHA256SUMS entry", () => {
    expect(verifySha256(data, "torlnk-linux-x64.tar.gz", sums)).toBe(true);
  });
  it("fails on a digest mismatch", () => {
    expect(verifySha256(Buffer.from("tampered"), "torlnk-linux-x64.tar.gz", sums)).toBe(false);
  });
  it("fails when the file has no entry in SHA256SUMS", () => {
    expect(verifySha256(data, "missing.tar.gz", sums)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/update/bundle.test.ts -t verifySha256`
Expected: FAIL — `verifySha256` not exported.

- [ ] **Step 3: Implement `verifySha256`**

Add to `src/update/bundle.ts` (add `import { createHash } from "node:crypto";` at the top):

```typescript
// A SHA256SUMS file is lines of "<hex>␠␠<filename>". Confirm the downloaded
// bytes hash to the digest recorded for their filename. A missing entry fails
// closed: an unverifiable download is treated as bad.
export function verifySha256(data: Buffer, assetName: string, sums: string): boolean {
  const want = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === assetName)?.[0];
  if (!want) return false;
  const got = createHash("sha256").update(data).digest("hex");
  return got.toLowerCase() === want.toLowerCase();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/update/bundle.test.ts -t verifySha256`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/update/bundle.ts src/update/bundle.test.ts
git commit -m "feat(update): verify a downloaded asset against SHA256SUMS"
```

---

## Task 8: Atomic swap with rollback

**Files:**
- Modify: `src/update/bundle.ts`
- Test: `src/update/bundle.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/update/bundle.test.ts`:

```typescript
import { swapInPlace, type SwapDeps } from "./bundle";

function recordingDeps(overrides: Partial<SwapDeps> = {}): { deps: SwapDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: SwapDeps = {
    rename: (from, to) => {
      calls.push(`rename ${from} -> ${to}`);
    },
    rm: (target) => {
      calls.push(`rm ${target}`);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("swapInPlace", () => {
  it("moves the old runtime aside, moves the new one in, and deletes the old", () => {
    const { deps, calls } = recordingDeps();
    swapInPlace("/opt/torlnk-runtime", "/tmp/stage/torlnk-runtime", 123, deps);
    expect(calls).toEqual([
      "rename /opt/torlnk-runtime -> /opt/torlnk-runtime.old-123",
      "rename /tmp/stage/torlnk-runtime -> /opt/torlnk-runtime",
      "rm /opt/torlnk-runtime.old-123",
    ]);
  });

  it("rolls the old runtime back if moving the new one in fails", () => {
    const calls: string[] = [];
    const deps: SwapDeps = {
      rename: (from, to) => {
        calls.push(`rename ${from} -> ${to}`);
        if (from === "/tmp/stage/torlnk-runtime") throw new Error("cross-device");
      },
      rm: (target) => calls.push(`rm ${target}`),
    };
    expect(() => swapInPlace("/opt/torlnk-runtime", "/tmp/stage/torlnk-runtime", 123, deps)).toThrow();
    expect(calls).toEqual([
      "rename /opt/torlnk-runtime -> /opt/torlnk-runtime.old-123",
      "rename /tmp/stage/torlnk-runtime -> /opt/torlnk-runtime", // failed
      "rename /opt/torlnk-runtime.old-123 -> /opt/torlnk-runtime", // rollback
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/update/bundle.test.ts -t swapInPlace`
Expected: FAIL — `swapInPlace`/`SwapDeps` not exported.

- [ ] **Step 3: Implement `swapInPlace`**

Add to `src/update/bundle.ts`:

```typescript
export interface SwapDeps {
  rename: (from: string, to: string) => void;
  rm: (target: string) => void;
}

// Replace the runtime dir at `root` with `stagedRuntime`. Order matters: the
// old dir is moved aside first so the move-in has a clear target, then deleted
// only after the new dir is in place. If the move-in fails, the old dir is
// rolled back so the install is never left missing. `pid` disambiguates the
// backup dir for concurrent/retried runs.
export function swapInPlace(
  root: string,
  stagedRuntime: string,
  pid: number,
  deps: SwapDeps,
): void {
  const backup = `${root}.old-${pid}`;
  deps.rename(root, backup);
  try {
    deps.rename(stagedRuntime, root);
  } catch (e) {
    deps.rename(backup, root); // roll back
    throw e;
  }
  deps.rm(backup);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/update/bundle.test.ts -t swapInPlace`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/update/bundle.ts src/update/bundle.test.ts
git commit -m "feat(update): atomic runtime swap with rollback"
```

---

## Task 9: `applyBundleUpdate` orchestration

**Files:**
- Modify: `src/update/bundle.ts`
- Test: `src/update/bundle.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/update/bundle.test.ts`:

```typescript
import { applyBundleUpdate, type ApplyDeps } from "./bundle";
import type { GithubRelease } from "./github";

const release: GithubRelease = {
  version: "1.5.1",
  assets: [
    { name: "torlnk-linux-x64.tar.gz", url: "https://d/asset.tar.gz" },
    { name: "SHA256SUMS", url: "https://d/SHA256SUMS" },
  ],
  sha256Url: "https://d/SHA256SUMS",
};

function applyDeps(over: Partial<ApplyDeps> = {}): { deps: ApplyDeps; log: string[] } {
  const log: string[] = [];
  const deps: ApplyDeps = {
    platform: "linux",
    arch: "x64",
    download: async (url) => {
      log.push(`download ${url}`);
      return Buffer.from("archive-bytes");
    },
    readText: async (url) => {
      log.push(`readText ${url}`);
      return "sha  torlnk-linux-x64.tar.gz";
    },
    verify: () => {
      log.push("verify");
      return true;
    },
    extract: async (archive, dest) => {
      log.push(`extract ${archive} -> ${dest}`);
    },
    swap: () => log.push("swap"),
    tmpDir: () => "/tmp/torlnk-upd",
    write: async (p) => log.push(`write ${p}`),
    ...over,
  };
  return { deps, log };
}

describe("applyBundleUpdate", () => {
  it("downloads, verifies, extracts, and swaps in order", async () => {
    const { deps, log } = applyDeps();
    const ok = await applyBundleUpdate(release, "/opt/torlnk-runtime", deps);
    expect(ok).toBe(true);
    expect(log).toEqual([
      "download https://d/asset.tar.gz",
      "write /tmp/torlnk-upd/torlnk-linux-x64.tar.gz",
      "readText https://d/SHA256SUMS",
      "verify",
      "extract /tmp/torlnk-upd/torlnk-linux-x64.tar.gz -> /tmp/torlnk-upd/stage",
      "swap",
    ]);
  });

  it("aborts before swap when verification fails", async () => {
    const { deps, log } = applyDeps({ verify: () => false });
    const ok = await applyBundleUpdate(release, "/opt/torlnk-runtime", deps);
    expect(ok).toBe(false);
    expect(log).not.toContain("swap");
  });

  it("stops when the platform has no published asset", async () => {
    const { deps, log } = applyDeps({ platform: "linux", arch: "arm64" });
    const ok = await applyBundleUpdate(release, "/opt/torlnk-runtime", deps);
    expect(ok).toBe(false);
    expect(log).toEqual([]); // never tried to download
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/update/bundle.test.ts -t applyBundleUpdate`
Expected: FAIL — `applyBundleUpdate`/`ApplyDeps` not exported.

- [ ] **Step 3: Implement `applyBundleUpdate`**

Add to `src/update/bundle.ts` (add `import path from "node:path";` already present; add `import type { GithubRelease } from "./github";`):

```typescript
import type { GithubRelease } from "./github";

export interface ApplyDeps {
  platform: NodeJS.Platform | string;
  arch: string;
  download: (url: string) => Promise<Buffer>;
  readText: (url: string) => Promise<string>;
  verify: (data: Buffer, assetName: string, sums: string) => boolean;
  extract: (archivePath: string, destDir: string) => Promise<void>;
  swap: (root: string, stagedRuntime: string) => void;
  tmpDir: () => string;
  write: (filePath: string, data: Buffer) => Promise<void>;
}

// Orchestrate a bundle update: pick the asset for this platform, download +
// verify it against SHA256SUMS, extract into a staging dir, then swap the
// extracted torlnk-runtime/ into place. Returns false (install untouched)
// whenever a precondition fails; the swap is the last step so a failed
// download/verify/extract can never leave a half-written install.
export async function applyBundleUpdate(
  release: GithubRelease,
  root: string,
  deps: ApplyDeps,
): Promise<boolean> {
  const assetName = assetNameFor(deps.platform, deps.arch);
  if (!assetName) {
    console.error(`No published bundle for ${deps.platform}/${deps.arch}.`);
    return false;
  }
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset || !release.sha256Url) {
    console.error("Release is missing this platform's asset or its checksums.");
    return false;
  }

  const tmp = deps.tmpDir();
  const archivePath = path.join(tmp, assetName);
  const bytes = await deps.download(asset.url);
  await deps.write(archivePath, bytes);

  const sums = await deps.readText(release.sha256Url);
  if (!deps.verify(bytes, assetName, sums)) {
    console.error("Checksum mismatch; the download was not applied.");
    return false;
  }

  const stage = path.join(tmp, "stage");
  await deps.extract(archivePath, stage);
  deps.swap(root, path.join(stage, "torlnk-runtime"));
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/update/bundle.test.ts`
Expected: PASS (all bundle tests).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/update/bundle.ts src/update/bundle.test.ts
git commit -m "feat(update): orchestrate bundle download, verify, extract, swap"
```

---

## Task 10: Real dependency wiring + Unix/Windows apply entrypoint

**Files:**
- Modify: `src/update/bundle.ts`

- [ ] **Step 1: Add the production `applyBundleFromEnv` entrypoint**

This wires real `node:fs`/`node:child_process` behaviour into `applyBundleUpdate`.
It has no unit test of its own (it is thin glue over already-tested units and
the OS); it is exercised manually in Task 12. Add to `src/update/bundle.ts`:

```typescript
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fetchResilient, USER_AGENT } from "../util/net";

async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetchResilient(url, {
    retries: 2,
    headers: { "User-Agent": USER_AGENT },
    // GitHub asset URLs redirect to a CDN; fetch follows redirects by default.
  });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Extract a .tar.gz with system tar, or a .zip on Windows via PowerShell —
// the same tools release.yml packs with, so no runtime dependency is added.
function extractArchive(archivePath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Force -Path "${archivePath}" -DestinationPath "${destDir}"`],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error("unzip failed");
  } else {
    const r = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("tar failed");
  }
}

// Unix: move the running runtime aside and move the new one in (open files keep
// their inode, so the updater's own node keeps running). Windows: node.exe is
// locked, so stage the new runtime next to root and finish the swap on exit via
// a .cmd helper, printing a manual fallback.
function swapRuntime(root: string, stagedRuntime: string): void {
  if (process.platform === "win32") {
    const staged = `${root}.new`;
    fs.rmSync(staged, { recursive: true, force: true });
    fs.renameSync(stagedRuntime, staged);
    const helper = `${root}.swap.cmd`;
    fs.writeFileSync(
      helper,
      [
        "@echo off",
        "timeout /t 2 /nobreak >nul",
        `rmdir /s /q "${root}"`,
        `move "${staged}" "${root}"`,
        `del "%~f0"`,
        "",
      ].join("\r\n"),
    );
    console.log(
      `Staged the update at ${staged}. It will be applied on exit; if not, run:\n  ${helper}`,
    );
    spawnSync("cmd", ["/c", "start", "/min", "", helper], { detached: true, stdio: "ignore" });
    return;
  }
  swapInPlace(root, stagedRuntime, process.pid, {
    rename: (from, to) => fs.renameSync(from, to),
    rm: (target) => fs.rmSync(target, { recursive: true, force: true }),
  });
}

// The production entrypoint used by run.ts. Builds a temp dir and real deps,
// then delegates to the unit-tested applyBundleUpdate.
export async function applyBundleFromEnv(
  release: GithubRelease,
  root: string,
): Promise<boolean> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "torlnk-upd-"));
  return applyBundleUpdate(release, root, {
    platform: process.platform,
    arch: process.arch,
    download: downloadBuffer,
    readText: async (url) => (await downloadBuffer(url)).toString("utf8"),
    verify: verifySha256,
    extract: async (archivePath, destDir) => extractArchive(archivePath, destDir),
    swap: swapRuntime,
    tmpDir: () => tmp,
    write: async (filePath, data) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, data);
    },
  });
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Run the full bundle test file (no regressions)**

Run: `npx vitest run src/update/bundle.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/update/bundle.ts
git commit -m "feat(update): real download/extract/swap wiring incl. Windows staging"
```

---

## Task 11: Wire the bundle branch into `runUpdate`

**Files:**
- Modify: `src/update/run.ts`
- Test: `src/update/run.test.ts` (add a bundle-branch test)

- [ ] **Step 1: Write the failing test**

First inspect the existing `src/update/run.test.ts` to match its harness (it
already mocks `fetchLatestVersion`, `readManifest`, and the git/npm runners).
Add a test asserting the bundle branch is chosen when `isBundleInstall` is true.
Because `runUpdate` currently reads globals (`process.execPath`, `fs.existsSync`),
add the seam described in Step 3 first if the existing tests don't already inject
these; mirror the existing test's mocking style. Example shape:

```typescript
it("applies a bundle update when running from a bundle install", async () => {
  const applied: string[] = [];
  await runUpdate({
    // deps object mirrors the seam added in Step 3
    _deps: {
      manifest: { name: "torlnk", version: "1.5.0", root: "/opt/torlnk-runtime", repoUrl: "https://github.com/WarlaxZ/torlink" },
      latestRelease: { version: "1.5.1", assets: [], sha256Url: null },
      execPath: "/opt/torlnk-runtime/node",
      applyBundle: async () => {
        applied.push("bundle");
        return true;
      },
    },
  });
  expect(applied).toEqual(["bundle"]);
});
```

If the existing `run.test.ts` uses `vi.mock` module mocking instead of a `_deps`
seam, follow that pattern instead: `vi.mock("./bundle", ...)` and
`vi.mock("./github", ...)`, and assert the mocked `applyBundleFromEnv` was called.
Match whatever the existing file already does — do not introduce a second style.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/update/run.test.ts -t bundle`
Expected: FAIL — bundle branch not implemented.

- [ ] **Step 3: Implement the bundle branch**

In `src/update/run.ts`, add imports:

```typescript
import { isBundleInstall, applyBundleFromEnv } from "./bundle";
import { parseRepoSlug, fetchLatestRelease } from "./github";
```

`runUpdate` currently calls `fetchLatestVersion({ packageName: manifest.name })`.
Replace that pre-flight and add the bundle branch. The new body of `runUpdate`
after `readManifest()` becomes:

```typescript
  const slug = parseRepoSlug(manifest.repoUrl);
  const release = slug
    ? await fetchLatestRelease({ owner: slug.owner, repo: slug.repo })
    : null;
  const latest = release?.version ?? null;
  if (!opts.force && latest && !isNewer(VERSION, latest)) {
    console.log(`Already on the latest release (v${latest}). Use --force to reinstall and restart anyway.`);
    return;
  }

  const root = manifest.root;

  // Bundle install (self-contained tarball): download + verify + swap in place.
  if (isBundleInstall(root, process.execPath)) {
    if (!release) {
      console.error("Couldn't reach GitHub to find a release to install.");
      process.exitCode = 1;
      return;
    }
    console.log(opts.force ? "Reinstalling the current release…" : `Updating to v${latest}…`);
    const ok = await applyBundleFromEnv(release, root);
    if (!ok) {
      console.error("Update failed; nothing was restarted.");
      process.exitCode = 1;
      return;
    }
    await restartDaemons();
    console.log("Update complete.");
    return;
  }
```

Leave the existing git-checkout and npm-global branches below this, unchanged.
Remove the now-unused `fetchLatestVersion` import from `run.ts` if it is no
longer referenced (App.tsx still uses it; run.ts no longer does).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/update/run.test.ts`
Expected: PASS (new bundle test + existing git/npm tests).

- [ ] **Step 5: Typecheck + lint + full test suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/update/run.ts src/update/run.test.ts
git commit -m "feat(update): apply bundle updates from torlnk update"
```

---

## Task 12: Manual smoke test + docs

**Files:**
- Modify: `README.md` (only if it documents `torlnk update`; otherwise skip)

- [ ] **Step 1: Manual check — version source**

Exercise the check directly against the live GitHub API:

Run: `npx tsx -e "import {fetchLatestVersion} from './src/update/version'; fetchLatestVersion().then(v => console.log('latest:', v))"`
Expected: prints the latest published GitHub release version (e.g. `latest: 1.5.1`),
confirming the check now hits GitHub, not npm.

- [ ] **Step 2: Manual check — bundle build + detection (Unix)**

Run:
```bash
npm run build
# Simulate a bundle layout and confirm detection:
npx tsx -e "import {isBundleInstall} from './src/update/bundle'; console.log(isBundleInstall('/opt/torlnk-runtime','/opt/torlnk-runtime/node'), isBundleInstall('/opt/torlnk-runtime','/usr/bin/node'))"
```
Expected: `true false`.

- [ ] **Step 3: Update README if needed**

If `README.md` documents `torlnk update`, add a sentence that bundle installs
self-update by downloading the matching release asset and verifying it against
`SHA256SUMS`. If the README does not mention updates, skip this step.

- [ ] **Step 4: Commit (if README changed)**

```bash
git add README.md
git commit -m "docs: note bundle self-update in torlnk update"
```

---

## Definition of Done

- `npm run typecheck`, `npm run lint`, and `npm test` all pass.
- `fetchLatestVersion()` returns the latest **GitHub** release version for the
  fork (verified manually in Task 12).
- `torlnk update` on a bundle install downloads the matching asset, verifies its
  checksum, and swaps it in place (Unix), or stages it for on-exit swap (Windows).
- The banner and `torlnk update` behaviour on git/npm installs are unchanged.
