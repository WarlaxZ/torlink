import { log } from "../util/logger";
import type { FetchImpl } from "../util/net";
import type { ReccClientConfig } from "./client";
export { formatImportSummary } from "./importSummary";

// ~900 KiB of CSV text per chunk, comfortably under reccd's 1 MiB multipart
// cap once the boundary/part-header overhead is added.
export const CHUNK_BUDGET_BYTES = 900 * 1024;

// Splits a Netflix viewing-activity CSV into chunks whose serialized size stays
// under `budgetBytes`. Line 0 is the `Title,Date` header, which reccd skips; it
// is prepended to every chunk so each upload is a valid standalone CSV. A single
// row larger than the budget is emitted alone rather than dropped.
export function chunkNetflixCsv(csvText: string, budgetBytes = CHUNK_BUDGET_BYTES): string[] {
  const lines = csvText.split(/\r?\n/);
  const header = lines[0] ?? "";
  const rows = lines.slice(1).filter((r) => r.trim() !== "");
  if (rows.length === 0) return [];

  const headerBytes = Buffer.byteLength(`${header}\n`, "utf8");
  const chunks: string[] = [];
  let current: string[] = [];
  let size = headerBytes;

  for (const row of rows) {
    const rowBytes = Buffer.byteLength(`${row}\n`, "utf8");
    if (current.length > 0 && size + rowBytes > budgetBytes) {
      chunks.push([header, ...current].join("\n"));
      current = [];
      size = headerBytes;
    }
    current.push(row);
    size += rowBytes;
  }
  if (current.length > 0) chunks.push([header, ...current].join("\n"));

  const oversized = chunks.filter((c) => Buffer.byteLength(c, "utf8") > budgetBytes).length;
  if (oversized > 0) {
    log.debug(`netflix import: ${oversized} chunk(s) exceed the ${budgetBytes}B budget (single oversized rows)`);
  }
  return chunks;
}

export interface NetflixImportResult {
  imported: number;
  resolved: number;
  unresolved: number;
  unresolvedTitles: string[];
  chunks: number;
}

export type NetflixImportOutcome =
  | { ok: true; result: NetflixImportResult }
  | { ok: false; error: string; partial?: NetflixImportResult };

export interface UploadNetflixOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  budgetBytes?: number;
  onProgress?: (done: number, total: number) => void;
}

interface RawImportResponse {
  imported?: number;
  resolved?: number;
  unresolved?: number;
  unresolvedTitles?: string[];
}

// Uploads a Netflix CSV to reccd, one <1 MiB multipart chunk at a time. Unlike
// the fire-and-forget postEvent, the user is waiting on this, so failures are
// surfaced as a discriminated outcome (with any partial progress) rather than
// swallowed. reccd's import is idempotent (keyed on source+user+raw_name), so
// re-uploading the same file — or a failed run's earlier chunks — updates in
// place instead of double-counting.
export async function uploadNetflixCsv(
  config: ReccClientConfig,
  csvText: string,
  opts: UploadNetflixOptions = {},
): Promise<NetflixImportOutcome> {
  if (!config.reccUrl) return { ok: false, error: "reccd is not linked — set it up in Accounts first" };
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  const chunks = chunkNetflixCsv(csvText, opts.budgetBytes);
  if (chunks.length === 0) return { ok: false, error: "no rows found in the CSV" };

  const agg: NetflixImportResult = {
    imported: 0,
    resolved: 0,
    unresolved: 0,
    unresolvedTitles: [],
    chunks: chunks.length,
  };
  const seen = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    const where = `chunk ${i + 1}/${chunks.length}`;
    const form = new FormData();
    form.set("file", new Blob([chunks[i]!], { type: "text/csv" }), "netflix.csv");

    let res: Response;
    try {
      res = await fetchImpl(`${config.reccUrl}/import/netflix`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.reccToken ?? ""}` },
        body: form,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
      });
    } catch (err) {
      log.debug(`netflix import: ${where} failed to reach ${config.reccUrl}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: `couldn't reach reccd (${where})`, partial: agg };
    }

    if (res.status === 401) return { ok: false, error: "reccd rejected the token — check reccToken", partial: agg };
    if (!res.ok) return { ok: false, error: `import failed (HTTP ${res.status}, ${where})`, partial: agg };

    const body = (await res.json().catch(() => ({}))) as RawImportResponse;
    // Coerce defensively: the fields are typed but come off the wire untrusted,
    // and `+=` on a stray string would silently corrupt the accumulator.
    agg.imported += Number(body.imported) || 0;
    agg.resolved += Number(body.resolved) || 0;
    agg.unresolved += Number(body.unresolved) || 0;
    for (const t of body.unresolvedTitles ?? []) {
      if (typeof t === "string" && !seen.has(t)) {
        seen.add(t);
        agg.unresolvedTitles.push(t);
      }
    }
    opts.onProgress?.(i + 1, chunks.length);
  }

  return { ok: true, result: agg };
}
