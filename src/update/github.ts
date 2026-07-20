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
