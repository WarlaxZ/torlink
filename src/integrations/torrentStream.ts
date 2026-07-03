import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import WebTorrent from "webtorrent";
import type { StreamFile } from "../util/player";

export interface TorrentStreamSession {
  name: string;
  files: StreamFile[];
  dir: string;
  isComplete(): boolean;
  stop(opts?: { keep?: boolean }): Promise<void>;
}

// The minimal structural subset of the WebTorrent client the engine touches,
// so tests can inject a fake without a real swarm.
export interface WebTorrentLike {
  add(magnet: string, opts: { path: string }): TorrentLike;
  createServer(opts?: { hostname?: string; pathname?: string }): ServerLike;
  get(id: string): TorrentLike | null;
  remove(id: string, cb?: (err?: Error) => void): void;
  destroy(cb?: (err?: Error) => void): void;
}
interface TorrentLike {
  infoHash: string;
  name: string;
  done: boolean;
  files: { name: string; path: string; length: number }[];
  on(event: "metadata" | "error", cb: (arg?: unknown) => void): void;
  destroy(cb?: (err?: Error) => void): void;
}
interface ServerLike {
  listen(port?: number, hostname?: string, cb?: () => void): void;
  address(): { port: number } | null;
  close(cb?: () => void): void;
}

export interface StreamTorrentOptions {
  signal?: AbortSignal;
  metadataTimeoutMs?: number;
  createClient?: () => WebTorrentLike;
  tmpBase?: string;
  mkdtemp?: (prefix: string) => Promise<string>;
  rm?: (dir: string) => Promise<void>;
}

const DEFAULT_METADATA_TIMEOUT_MS = 60_000;

function toStreamFiles(
  torrent: TorrentLike,
  host: string,
  port: number,
): StreamFile[] {
  return torrent.files.map((f) => {
    const rel = f.path.replace(/\\/g, "/");
    return {
      url: `http://${host}:${port}/webtorrent/${torrent.infoHash}/${encodeURI(rel)}`,
      filename: f.name,
      bytes: f.length,
    };
  });
}

export async function streamTorrent(
  magnet: string,
  opts: StreamTorrentOptions = {},
): Promise<TorrentStreamSession> {
  const createClient = opts.createClient ?? (() => new WebTorrent() as unknown as WebTorrentLike);
  const mkdtemp = opts.mkdtemp ?? ((prefix) => fs.mkdtemp(prefix));
  const rm = opts.rm ?? ((dir) => fs.rm(dir, { recursive: true, force: true }));
  const timeoutMs = opts.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const host = "localhost";

  const dir = await mkdtemp(path.join(opts.tmpBase ?? os.tmpdir(), "torlink-stream-"));
  const client = createClient();

  const cleanup = async () => {
    try {
      await new Promise<void>((res) => client.destroy(() => res()));
    } catch {
      /* already destroyed, or destroy itself failed — nothing more we can do */
    }
    await rm(dir).catch(() => {});
  };

  return new Promise<TorrentStreamSession>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void cleanup().finally(() =>
        reject(new Error("No peers found — couldn't start the stream (metadata timed out).")),
      );
    }, timeoutMs);

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void cleanup().finally(() => reject(new Error("Stream cancelled.")));
      });
    }

    let torrent: TorrentLike;
    try {
      torrent = client.add(magnet, { path: dir });
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      void cleanup().finally(() => reject(e instanceof Error ? e : new Error(String(e))));
      return;
    }

    torrent.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void cleanup().finally(() =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
    });

    torrent.on("metadata", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const server = client.createServer();
      server.listen(0, host, () => {
        const port = server.address()?.port ?? 0;
        let stopped = false;
        resolve({
          name: torrent.name,
          files: toStreamFiles(torrent, host, port),
          dir,
          isComplete: () => torrent.done === true,
          stop: async ({ keep = false }: { keep?: boolean } = {}) => {
            if (stopped) return;
            stopped = true;
            await new Promise<void>((res) => server.close(() => res()));
            await new Promise<void>((res) => client.destroy(() => res()));
            if (!keep) await rm(dir).catch(() => {});
          },
        });
      });
    });
  });
}
