import path from "node:path";
import { createHash } from "node:crypto";

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
