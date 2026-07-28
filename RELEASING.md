# Releasing torlink

Releases are **tag-driven**. Pushing a `vX.Y.Z` tag to `main` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which does three
things automatically:

1. Builds the self-contained bundles for Linux, macOS (x64 + arm64), and Windows.
2. Publishes a GitHub Release with those bundles and a `SHA256SUMS` file.
3. Publishes the package to npm via **Trusted Publishing** (OIDC — no token).

You never run `npm publish` by hand for a normal release. You bump the version,
open a PR, merge it, and push the tag.

## The names

| Thing | Value | Why |
| --- | --- | --- |
| npm package | `torlink` | Matches the repo, the command, `APP_NAME`, and the `TORLINK_*` env vars. Was `torlnk-rd` (`torlnk` itself is upstream's); the unscoped `torlink` name turned out to be free, so we took it. |
| CLI command | `torlink` | What users type. `torlnk` is kept as a second `bin` entry (and a second launcher in `scripts/install.sh`) so existing installs and scripts keep working. |
| GitHub repo | `WarlaxZ/torlink` | Where releases and the update check point. |
| Release assets | `torlnk-<os>-<arch>.*` | Deliberately **not** renamed. Nobody types them, and older pinned copies of `install.sh` fetch them by name. |

## One-time setup (already done — here for the record)

Trusted Publishing is configured on npmjs.com so CI can publish without a stored
token:

- **npmjs.com → `torlink` → Settings → Trusted Publisher → GitHub Actions**
  - Organization or user: `WarlaxZ`
  - Repository: `torlink`
  - Workflow filename: `release.yml`
  - Allowed action: `npm publish`

A brand-new npm name can't be configured this way until it exists, so the very
first publish was a manual bootstrap (`npm login && npm publish --otp=<code>`).
That's done; you shouldn't need a manual publish again.

## Cutting a release

1. **Bump the version.** Edit `version` in `package.json`, then sync the lockfile
   so its `name`/`version` match (CI runs `npm ci`, which fails on a mismatch):

   ```sh
   npm install --package-lock-only
   ```

2. **PR the bump** (`main` is protected). Use a `chore:` title, e.g.
   `chore: bump version to 1.6.1`. Keep it to `package.json` + `package-lock.json`
   unless the release also carries changelog/docs.

3. **Merge** once CI (`ci.yml`: typecheck + test + lint) is green.

4. **Tag `main` and push:**

   ```sh
   git fetch origin
   git tag -a v1.6.1 origin/main -m v1.6.1
   git push origin v1.6.1
   ```

5. **Watch the release run** (`gh run watch` or the Actions tab). All four `build`
   jobs, `publish`, and `publish-npm` should be green. When it's done:

   ```sh
   npm view torlink version            # the new version, tagged latest
   gh release view v1.6.1 --repo WarlaxZ/torlink
   ```

Use plain semver: patch for fixes, minor for backwards-compatible features, major
for anything that retrains an existing key or otherwise breaks muscle memory.

## How this ties into the in-app updater

The tag is the single source of truth, which keeps every install path in step:

- The TUI's update banner reads the **latest GitHub release** for the repo in
  `package.json`'s `repository.url` (see `src/update/version.ts` →
  `src/update/github.ts`), so a new tag makes the banner appear.
- `torlink update` (`src/update/run.ts`) handles three install shapes:
  a self-contained **bundle** (download the matching release asset, verify it
  against `SHA256SUMS`, swap it in place), a **git checkout** (pull + build), and
  an **npm-global** install (`npm i -g torlink@latest` — it uses `package.json`'s
  own `name`, so the rename needs no code change). Because the npm publish
  and the GitHub release ride the same tag, all three see the same version.

## Gotchas (learned the hard way — don't reintroduce these)

- **`bin` path has no leading `./`.** npm 11 rejects `"./dist/cli.cjs"` and
  silently strips the entry, shipping a package with no `torlink` command. Keep it
  `"dist/cli.cjs"` — for both `bin` entries.
- **Keep `package-lock.json` in sync** with `package.json`'s `name` and `version`.
  A stale lock name breaks `npm ci` in the `publish-npm` job. `npm install
  --package-lock-only` after any rename or bump.
- **The npm name can be constrained.** npm's spam filter can block a bare word
  that's close to a popular package. `torlink` publishes fine; if a future rename
  is refused, a scoped name (`@user/x`) or a distinctive unscoped one avoids it.
- **Configure Trusted Publishing before the first tag on any new name**, or the
  `publish-npm` job fails auth (the bundles and GitHub release still succeed; you
  can re-run the job or publish once by hand).
- **Bundle updates stage beside the install root**, not in `/tmp` — a rename
  across filesystems (`/tmp` is often a separate tmpfs) throws `EXDEV`. Windows
  can't overwrite a running `node.exe`, so it stages and swaps via an on-exit
  `.cmd` helper (best-effort; Unix is seamless).
