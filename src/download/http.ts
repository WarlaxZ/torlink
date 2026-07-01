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
 *
 * Resume behaviour: if a partial file exists on disk, a Range request is sent.
 * If the server responds 206 the download continues from the offset; if it
 * responds 200 the file is overwritten from scratch. A fully-downloaded file
 * is skipped entirely. On abort, partials are kept when the reason is "pause"
 * (so the next run can resume) and deleted for any other reason.
 */
export async function downloadFiles(
  files: ResolvedFile[],
  destDir: string,
  opts: DownloadFilesOptions = {},
): Promise<string[]> {
  const { onProgress, signal, fetchImpl = fetch as FetchImpl, nowImpl = Date.now } = opts;
  await fs.mkdir(destDir, { recursive: true });

  const total = files.reduce((sum, f) => sum + (f.bytes || 0), 0);
  const destPaths = files.map((f) => path.join(destDir, sanitizeFilename(f.filename)));
  const startedAt = nowImpl();
  let doneBytes = 0;

  // A pause abort keeps partial files (so resume can continue); any other abort
  // or error deletes this torrent's files. Distinguished by the signal reason.
  const bail = async (e: unknown): Promise<never> => {
    if (signal?.reason !== "pause") await cleanup(destPaths);
    throw e;
  };

  const report = (downloaded: number): void => {
    const elapsed = (nowImpl() - startedAt) / 1000;
    onProgress?.({ downloaded, total, speed: elapsed > 0 ? downloaded / elapsed : 0 });
  };

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const dest = destPaths[i]!;

    let existing = 0;
    try {
      existing = (await fs.stat(dest)).size;
    } catch {
      existing = 0;
    }

    // Already fully on disk — count it and move on without a request.
    if (f.bytes > 0 && existing >= f.bytes) {
      doneBytes += f.bytes;
      report(doneBytes);
      continue;
    }

    if (signal?.aborted) return bail(abortError());

    const wantRange = existing > 0;
    let res: Response;
    try {
      const init: RequestInit = {};
      if (signal) init.signal = signal;
      if (wantRange) init.headers = { Range: `bytes=${existing}-` };
      res = await fetchImpl(f.url, init);
    } catch (e) {
      return bail(e);
    }
    if (!res.ok || !res.body) {
      return bail(new Error(`Download failed for ${f.filename} (HTTP ${res.status}).`));
    }

    // Resume only if the server honored the range (206); a 200 means it's
    // sending the whole file, so restart this one from scratch (truncate).
    const append = wantRange && res.status === 206;
    let fileBytes = append ? existing : 0;

    const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    source.on("data", (chunk: Buffer) => {
      fileBytes += chunk.length;
      report(doneBytes + fileBytes);
    });

    try {
      await pipeline(source, createWriteStream(dest, { flags: append ? "a" : "w" }));
    } catch (e) {
      return bail(e);
    }
    doneBytes += fileBytes;
  }

  return destPaths;
}
