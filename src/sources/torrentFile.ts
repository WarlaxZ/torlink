import { promises as fs } from "node:fs";
import parseTorrent from "parse-torrent";
import { buildMagnet, type ParsedMagnet } from "./magnet";

// A .torrent is metadata, not payload: even a torrent with tens of thousands of
// pieces stays in the low megabytes. The cap is what keeps a mis-named disk
// image dropped in the watch folder from being pulled into memory whole.
const MAX_TORRENT_BYTES = 16 * 1024 * 1024;

export async function magnetFromTorrentFile(path: string): Promise<ParsedMagnet | null> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TORRENT_BYTES) return null;
    return await magnetFromTorrentBytes(new Uint8Array(await fs.readFile(path)));
  } catch {
    return null;
  }
}

// The parse/validate/build-magnet core, over bytes rather than a path: the watch
// folder and `torlnk <file>.torrent` reach it through the file above, the web
// upload route hands it the bytes it received. Keeping it in one place is why a
// dragged .torrent behaves the same in the terminal and the browser.
export async function magnetFromTorrentBytes(bytes: Uint8Array): Promise<ParsedMagnet | null> {
  try {
    if (bytes.length === 0 || bytes.length > MAX_TORRENT_BYTES) return null;
    const parsed = await parseTorrent(bytes);
    const infoHash = parsed?.infoHash?.toLowerCase();
    // Require the decoded info dictionary, not just an infoHash: parse-torrent
    // reads a bare 20-byte buffer (or a magnet/hex string) as a raw infohash, so
    // without this a dropped non-torrent file would be "added" under its own
    // bytes rather than rejected. A real .torrent always carries `info`.
    if (!infoHash || !parsed.info) return null;
    const name = parsed.name || infoHash;
    // Carry the file's own announce list into the magnet. Without it a torrent
    // that isn't on the public DHT — a private tracker, a small private swarm —
    // sits at zero peers forever, and on a private tracker the passkey that
    // makes an announce work at all lives in that URL.
    const announce = Array.isArray(parsed.announce)
      ? parsed.announce.filter((url): url is string => typeof url === "string")
      : [];
    return { infoHash, name, magnet: buildMagnet(infoHash, name, announce) };
  } catch {
    return null;
  }
}
