import path from "node:path";
import { createWriteStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { ResolvedFile } from "../integrations/realdebrid";
import type { FetchImpl } from "../util/net";

export interface DownloadProgress {
  downloaded: number;
  total: number;
  speed: number; // bytes per second (cumulative average)
}

export interface DownloadFilesOptions {
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
  nowImpl?: () => number;
}

function abortError(): Error {
  const e = new Error("Download aborted.");
  e.name = "AbortError";
  return e;
}

// Real-Debrid hands us a server-side filename; never trust it as a path. Strip
// any directory components so a crafted name can't escape the download folder.
// Exported so the queue can derive a safe subfolder name from a torrent title.
export function sanitizeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).trim();
  return base && base !== "." && base !== ".." ? base : "download";
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => fs.rm(p, { force: true }).catch(() => {})));
}

/**
 * Stream each resolved Real-Debrid link into `destDir` over HTTP. Reports
 * aggregate byte/throughput progress and aborts via `signal`; on any failure or
 * abort it removes the files it had started writing so no partial junk is left.
 * Returns the list of written file paths on success.
 */
export async function downloadFiles(
  files: ResolvedFile[],
  destDir: string,
  opts: DownloadFilesOptions = {},
): Promise<string[]> {
  const { onProgress, signal, fetchImpl = fetch as FetchImpl, nowImpl = Date.now } = opts;
  await fs.mkdir(destDir, { recursive: true });

  const total = files.reduce((sum, f) => sum + (f.bytes || 0), 0);
  const written: string[] = [];
  const startedAt = nowImpl();
  let doneBytes = 0;

  for (const f of files) {
    if (signal?.aborted) {
      await cleanup(written);
      throw abortError();
    }

    let res: Response;
    try {
      res = await fetchImpl(f.url, signal ? { signal } : {});
    } catch (e) {
      await cleanup(written);
      throw e;
    }
    if (!res.ok || !res.body) {
      await cleanup(written);
      throw new Error(`Download failed for ${f.filename} (HTTP ${res.status}).`);
    }

    const dest = path.join(destDir, sanitizeFilename(f.filename));
    written.push(dest);

    let fileBytes = 0;
    const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    source.on("data", (chunk: Buffer) => {
      fileBytes += chunk.length;
      const elapsed = (nowImpl() - startedAt) / 1000;
      const downloaded = doneBytes + fileBytes;
      onProgress?.({ downloaded, total, speed: elapsed > 0 ? downloaded / elapsed : 0 });
    });

    try {
      await pipeline(source, createWriteStream(dest));
    } catch (e) {
      await cleanup(written);
      throw e;
    }
    doneBytes += fileBytes;
  }

  return written;
}
