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
//
// mpv/mpv.net are MEASURED (VLC 3.0.11's box, a real http:// subtitle URL,
// mpv's own IPC track-list): `--sub-file=<url>` loads it as
// `{"type":"sub","external":true,"selected":true}`. IINA is NOT measured —
// its `--mpv-sub-file` entry is inferred from the fact that IINA wraps mpv
// and forwards `--mpv-`-prefixed options, but nobody has run this against a
// real IINA build.
//
// VLC has no entry, and deliberately so — there is no CLI flag that side-loads
// a subtitle from a URL in VLC 3. Measured: `--input-slave=<url>` loads the
// file, but as an AUDIO track (`loading audio-es slave: ...`), not a subtitle
// one. `--sub-file=<url>` reaches the right track category but VLC resolves
// the argument as a local path, producing garbage
// (`file:///.../http%3A//host/...`). Also tried and also wrong:
// `--input-slave=subtitle:<url>`, `--input-slave=<url>#subtitle`, and
// `:input-slave=<url>` — all load as audio-es. Passing either flag would look
// like it worked (VLC starts, no error) while silently doing the wrong thing,
// which is worse than passing nothing — hence no entry, so `subtitleArgs`
// returns `[]` and the caller says the subtitle was not attached.
const FLAGS: Record<string, string> = {
  mpv: "--sub-file",
  mpvnet: "--sub-file",
  "mpv.net": "--sub-file",
  iina: "--mpv-sub-file",
  "iina-cli": "--mpv-sub-file",
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
