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
