import { loadConfig, resolveReccConfig } from "../config/config";
import { runTraktFlow } from "../recc/traktImport";
import { formatImportSummary } from "../recc/importSummary";

// Headless `torlnk import-trakt`. Interactive: it prints a code + URL to stderr
// and blocks (polling) while the user authorizes at trakt.tv, then imports.
// Throws on failure so index.tsx's failHeadless prints the message and exits
// non-zero.
export async function runImportTrakt(): Promise<void> {
  const config = await loadConfig();
  const reccConfig = resolveReccConfig(config);
  if (!reccConfig.reccUrl) {
    throw new Error(
      "reccd is not linked. Set TORLINK_RECC_URL / TORLINK_RECC_TOKEN, or configure it in the TUI Accounts pane.",
    );
  }

  const outcome = await runTraktFlow(reccConfig, {
    // Prompts and progress go to stderr so stdout carries only the final summary.
    onConnect: (info) => {
      console.error(`\nGo to ${info.verificationUrl} and enter code: ${info.userCode}`);
      console.error("Waiting for you to authorize…");
    },
    onImporting: () => console.error("Authorized. Importing from Trakt…"),
  });

  if (!outcome.ok) throw new Error(outcome.error);

  console.log(formatImportSummary(outcome.result));
  const unmatched = outcome.result.unresolvedTitles;
  if (unmatched.length > 0) {
    console.log(`\nunmatched titles (${unmatched.length}):`);
    for (const title of unmatched) console.log(`  ${title}`);
  }
}
