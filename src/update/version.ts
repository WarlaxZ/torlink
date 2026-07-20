import { type FetchImpl } from "../util/net";
import { readManifest } from "./manifest";
import { parseRepoSlug, fetchLatestRelease } from "./github";

// Compare two dotted versions numerically. Pre-release / build suffixes (-rc.1,
// +build) are dropped before comparing; torlink ships plain x.y.z releases, and
// a half-parsed suffix is worse than ignoring it. Returns <0, 0, >0 like a
// sort comparator (a older, equal, a newer).
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(/[-+]/, 1)[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isNewer(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0;
}

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
