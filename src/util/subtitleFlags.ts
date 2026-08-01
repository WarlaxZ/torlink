/**
 * How to tell each media player to side-load a subtitle.
 *
 * Kept apart from ./player.ts so the table is testable without spawning
 * anything, and dependency-free so it stays that way.
 *
 * An unknown command gets no flag at all. The configured player may be a user's
 * own wrapper script that takes arguments we cannot guess, and inventing one
 * would break a launch that works today — the caller says the subtitle was not
 * attached rather than risking that.
 */

// Matched against the command's basename, lowercased, extension stripped — the
// configured value is as often "/Applications/VLC.app/Contents/MacOS/VLC" or
// "vlc.exe" as it is "vlc".
const FLAGS: Record<string, string> = {
  mpv: "--sub-file",
  mpvnet: "--sub-file",
  "mpv.net": "--sub-file",
  iina: "--mpv-sub-file",
  "iina-cli": "--mpv-sub-file",
  vlc: "--input-slave",
  vlccli: "--input-slave",
};

function commandKey(command: string): string {
  const slash = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  const base = (slash >= 0 ? command.slice(slash + 1) : command).toLowerCase();
  return base.replace(/\.(exe|app|com|bat|cmd)$/, "");
}

/** The extra argv for a subtitle, or `[]` when we should not pass one. */
export function subtitleArgs(command: string, subtitleUrl: string): string[] {
  if (!subtitleUrl) return [];
  const flag = FLAGS[commandKey(command)];
  return flag ? [`${flag}=${subtitleUrl}`] : [];
}
