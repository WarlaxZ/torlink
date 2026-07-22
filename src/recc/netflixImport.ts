import { log } from "../util/logger";

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
