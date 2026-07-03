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
