declare module "parse-torrent" {
  interface ParsedTorrent {
    infoHash: string;
    name?: string;
    announce?: string[];
    // The decoded info dictionary. Present only when the input was actual
    // .torrent file metadata; a bare infohash or a 20-byte buffer parses to just
    // an infoHash with no `info`, which is how we tell a real file from junk.
    info?: unknown;
  }
  export default function parseTorrent(
    torrentId: Uint8Array | string,
  ): Promise<ParsedTorrent>;
}
