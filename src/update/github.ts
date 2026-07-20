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
