# GitHub-release update checking + one-command bundle update

**Date:** 2026-07-20
**Status:** Approved (design)

## Problem

The fork (`WarlaxZ/torlink`) ships via **GitHub Releases** — `release.yml` builds
self-contained tar/zip bundles (a bundled `node`, `dist/`, `node_modules/`, and a
`torlnk` launcher inside a `torlnk-runtime/` directory) and publishes them with a
`SHA256SUMS` file.

But the merged self-update feature checks the **npm registry** for the package
named `torlnk`, which is *upstream's* (`baairon`) package. So today:

- The update banner compares the fork's running version against upstream's npm
  releases, not the fork's GitHub releases — it can surface wrong/misleading
  "updates".
- `torlnk update` knows only git-checkout and `npm -g` install shapes; it cannot
  update a self-contained bundle install, which is how this fork is actually
  distributed.

## Goals

1. Point the "is there a newer version?" check at the fork's **GitHub Releases**.
2. Keep the existing passive banner UX (a quiet one-liner pointing at
   `torlnk update`).
3. Make `torlnk update` actually update a **bundle install**: download the
   correct platform asset, verify it, and swap it in place.

## Non-goals (YAGNI)

- GitHub auth tokens (the repo is public; an unauthenticated, once-per-launch
  check is far under the 60 requests/hour limit).
- Background/silent auto-apply, TUI-interactive apply, delta updates,
  changelog fetching, or multi-version rollback history.

## Automation level

**Suggest + one-command apply.** The check and banner suggest; the user runs
`torlnk update` to apply. No silent or background application.

## Architecture

### Version source — `src/update/github.ts` (new)

- `parseRepoSlug(repoUrl: string): { owner: string; repo: string } | null`
  Parses `github.com/OWNER/REPO` out of the common `repository.url` forms:
  `git+https://github.com/OWNER/REPO.git`, `https://github.com/OWNER/REPO`,
  `git@github.com:OWNER/REPO.git`. Strips a trailing `.git`. Returns null when
  it isn't a GitHub URL.
- `fetchLatestRelease(opts): Promise<GithubRelease | null>`
  `GET https://api.github.com/repos/{owner}/{repo}/releases/latest`. Returns
  `{ version, assets: { name, url }[], sha256Url }` where `version` is
  `tag_name` with a leading `v` stripped, and `sha256Url` is the asset named
  `SHA256SUMS` (if present). Fail-soft: `retries: 0`, a timeout, a
  `User-Agent` header (GitHub requires one), no auth. Any error / non-200 /
  malformed body → `null`.

### `src/update/version.ts` (modify)

- `fetchLatestVersion()` is rewritten to: read the manifest → `parseRepoSlug`
  the manifest's `repository.url` → `fetchLatestRelease` → return its `version`.
  **The exported name and signature are unchanged**, so the banner effect in
  `App.tsx` and the pre-flight check in `run.ts` need no changes.
- `compareVersions` / `isNewer` are unchanged.

### `src/update/manifest.ts` (modify)

- Extend `PackageManifest` with `repoUrl?: string`, read from the package.json's
  `repository.url` (string, or `{ url }` object form). Everything else is
  unchanged; identity still comes from the nearest package.json at runtime.

### `package.json` (modify)

- Repoint `repository.url`, `homepage`, and `bugs.url` from `baairon` to
  `WarlaxZ/torlink`, so the derived GitHub slug targets the fork. (Also just
  correct for a fork.)

### Bundle apply — `src/update/bundle.ts` (new)

- `isBundleInstall(manifest, execPath = process.execPath): boolean`
  True when `execPath` resolves to a path inside `manifest.root` — i.e. we are
  running the bundled `node` that sits alongside `package.json` in
  `torlnk-runtime/`. A git checkout or npm-global install runs the *system*
  node (execPath outside root), so this cleanly distinguishes the bundle shape.
- `assetNameFor(platform, arch): string | null`
  - `linux` + `x64` → `torlnk-linux-x64.tar.gz`
  - `darwin` + `x64` → `torlnk-macos-x64.tar.gz`
  - `darwin` + `arm64` → `torlnk-macos-arm64.tar.gz`
  - `win32` + `x64` → `torlnk-windows-x64.zip`
  - otherwise → `null` (unsupported; caller stops with a clear message)
- `applyBundleUpdate(release, manifest, deps): Promise<boolean>`
  The apply flow below. `deps` injects the download, extract, and fs operations
  so the logic is unit-testable without real network or shelling.

#### Apply flow (Unix)

1. Resolve the platform asset URL (`assetNameFor`) and the `SHA256SUMS` URL from
   the release; missing/unsupported → stop, install untouched.
2. Download the asset into a fresh temp dir.
3. Download `SHA256SUMS`; compute the asset's SHA-256 (`node:crypto`) and compare
   to the entry for its filename. Mismatch → abort, install untouched.
4. Extract with the system `tar` (`tar -xzf`) — the same tool `release.yml` packs
   with, so no new dependency. Produces `torlnk-runtime/` in a staging dir.
5. **Atomic swap** (root = the `torlnk-runtime/` dir = `manifest.root`):
   move `root` → `root.old-<pid>`; move `staging/torlnk-runtime` → `root`; on
   success delete `root.old-<pid>`; on any error during the swap, roll the
   `.old` dir back into place.
6. Restart any daemon via the existing `restartDaemon` / `listRunDescriptors`.

The swap is the **last** step: a failed download, verify, or extract leaves the
existing install completely untouched. No half-written installs.

#### Windows fallback

`node.exe` is locked while running, so an in-place swap of the running runtime
fails. Instead: extract the new bundle to a sibling `root.new` dir and finish the
swap via a small `.cmd` helper that runs **after** this process exits (swap
`root.new` → `root`), with a printed one-line manual instruction as a fallback.
Flagged as a known limitation; seamless Unix updates are the primary target.

### `src/update/run.ts` (modify)

After the existing pre-flight version check (`fetchLatestVersion` + `isNewer`,
now GitHub-backed), branch on install shape:

- `isBundleInstall(...)` → `applyBundleUpdate(...)`.
- git checkout → existing `gitUpdate` (unchanged).
- npm global → existing `npmGlobalUpdate` (unchanged; noted that the fork isn't
  on npm under its own name).

The `--force` semantics carry over (rebuild/reinstall + restart even when current;
for a bundle, `--force` re-downloads and re-swaps the current version).

### Unchanged

`UpdateBanner.tsx` (still shows `↑ torlink vX available · torlnk update`) and
`src/cli/args.ts` (still parses `update [--force]`).

## Error handling

- **Check path** (banner): silent on any failure — offline, rate-limited, or
  opt-out via `TORLINK_NO_UPDATE_CHECK` just leaves the banner hidden.
- **Apply path** (`torlnk update`): fails loudly with a clear message and leaves
  the install untouched. Verify-before-swap and swap-last guarantee no partial
  state; the `.old` roll-back covers a mid-swap failure.

## Testing (vitest; mock node built-ins per repo convention)

- `github.ts`: `parseRepoSlug` across URL forms (git+https, https, ssh,
  trailing `.git`, non-GitHub → null); `fetchLatestRelease` with mocked fetch —
  success, non-200, malformed body, timeout → null; correct asset/sha256 URL
  extraction.
- `version.ts`: `fetchLatestVersion` end-to-end with mocked fetch + manifest;
  `isNewer` already covered.
- `manifest.ts`: reads `repository.url` from both string and `{ url }` forms.
- `bundle.ts`: `isBundleInstall` true (execPath inside root) and false (system
  node); `assetNameFor` per platform/arch incl. unsupported → null; SHA-256
  verify pass/fail; swap logic with injected fs + extract runners (no real
  shelling), incl. the roll-back-on-failure path.
- `run.ts`: bundle branch selected when `isBundleInstall`; git/npm branches
  unchanged.

## Rollout

Requires a published GitHub release (v1.5.1 was just cut) for the check to have
something to compare against. Because the change re-points the version source
from npm to GitHub, existing bundle users on an older build will only pick up the
new behaviour after their first update to a build that includes it.
