import { readFile } from "node:fs/promises";
import { loadConfig, resolveReccConfig } from "../config/config";
import { uploadNetflixCsv, formatImportSummary } from "../recc/netflixImport";

// Headless `torlnk import-netflix <file>`. Throws on any failure so index.tsx's
// failHeadless prints the message and exits non-zero.
export async function runImportNetflix(filePath: string): Promise<void> {
  const config = await loadConfig();
  const reccConfig = resolveReccConfig(config);
  if (!reccConfig.reccUrl) {
    throw new Error(
      "reccd is not linked. Set TORLINK_RECC_URL / TORLINK_RECC_TOKEN, or configure it in the TUI Accounts pane.",
    );
  }

  let csvText: string;
  try {
    csvText = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`could not read file: ${filePath}`);
  }

  const outcome = await uploadNetflixCsv(reccConfig, csvText, {
    onProgress: (done, total) => {
      if (total > 1) console.log(`uploading chunk ${done}/${total}…`);
    },
  });

  if (!outcome.ok) {
    if (outcome.partial) console.log(`${formatImportSummary(outcome.partial)} (partial)`);
    throw new Error(outcome.error);
  }

  console.log(formatImportSummary(outcome.result));
  const unmatched = outcome.result.unresolvedTitles;
  if (unmatched.length > 0) {
    console.log(`\nunmatched titles (${unmatched.length}):`);
    for (const title of unmatched) console.log(`  ${title}`);
  }
}
