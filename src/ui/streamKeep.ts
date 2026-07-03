import path from "node:path";

// WebTorrent lays a multi-file torrent out under <dir>/<torrent.name>/… and a
// single-file torrent directly at <dir>/<file>. We move the top-level entry
// named after the torrent; a single-file torrent's name IS that file.
export function keepMovePlan(args: {
  streamDir: string;
  torrentName: string;
  downloadDir: string;
}): { from: string; to: string } {
  return {
    from: path.join(args.streamDir, args.torrentName),
    to: path.join(args.downloadDir, args.torrentName),
  };
}

// Injected fs seams so the move is unit-testable without touching disk.
export interface KeepFsOps {
  mkdir: (dir: string, opts: { recursive: true }) => Promise<unknown>;
  rename: (from: string, to: string) => Promise<void>;
  cp: (from: string, to: string, opts: { recursive: true }) => Promise<void>;
  rm: (from: string, opts: { recursive: true; force: true }) => Promise<void>;
}

// Move a completed stream's files into the downloads folder. Tries a fast
// rename, falling back to copy+remove across devices. Returns true only if the
// files demonstrably landed at `to`; on failure it does NOT delete the source
// (so a kept download is never lost) and returns false.
export async function moveKeptFiles(
  plan: { from: string; to: string },
  downloadDir: string,
  fs: KeepFsOps,
): Promise<boolean> {
  await fs.mkdir(downloadDir, { recursive: true });
  try {
    await fs.rename(plan.from, plan.to);
    return true;
  } catch {
    // Cross-device or rename-not-permitted: copy then remove the source, but
    // only remove once the copy has succeeded — otherwise leave the source.
    try {
      await fs.cp(plan.from, plan.to, { recursive: true });
    } catch {
      return false; // copy failed: source untouched, nothing kept
    }
    await fs.rm(plan.from, { recursive: true, force: true }).catch(() => {});
    return true;
  }
}
