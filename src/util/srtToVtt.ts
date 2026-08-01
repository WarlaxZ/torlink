/**
 * SRT text to WebVTT text.
 *
 * `<track>` accepts WebVTT and nothing else, so this is what makes a sibling
 * .srt showable in a browser. The two formats are near-identical: the
 * differences that matter are a required header, `.` instead of `,` as the
 * millisecond separator, and cue index lines that WebVTT does not use.
 *
 * DEPENDENCY-FREE, like ./subtitleFiles.ts and for the same reason — it is
 * bundled for the browser as well as run in Node. No `node:*`, and note that
 * `Buffer` is a node global: decodeSubtitle uses TextDecoder, which both have.
 */

const TIMESTAMP_RE = /^(.*\d)[,.](\d{1,3})(\s*-->\s*)(.*\d)[,.](\d{1,3})(.*)$/;

/** True for a line that is only digits — a candidate SRT cue index. */
function isIndexLine(line: string): boolean {
  return /^\d+$/.test(line.trim());
}

function isTimestampLine(line: string): boolean {
  return line.includes("-->");
}

/**
 * Convert, or pass through if it is already WebVTT.
 *
 * A cue index is dropped only when the NEXT line is a timestamp. A bare number
 * anywhere else is dialogue — a cue whose text is "1998" is not an index, and
 * dropping it would silently delete a subtitle line.
 */
export function srtToVtt(text: string): string {
  const clean = text.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
  if (/^WEBVTT/.test(clean)) return clean;
  if (clean.trim() === "") return "WEBVTT\n";

  const lines = clean.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isIndexLine(line) && isTimestampLine(lines[i + 1] ?? "")) continue;
    const m = TIMESTAMP_RE.exec(line);
    out.push(m ? `${m[1]}.${m[2]}${m[3]}${m[4]}.${m[5]}${m[6]}` : line);
  }
  return `WEBVTT\n\n${out.join("\n").replace(/^\n+/, "")}`;
}

/**
 * Decode subtitle bytes to text.
 *
 * UTF-8 first, strictly: `fatal: true` makes an invalid sequence throw rather
 * than produce U+FFFD. That distinction is the whole point — .srt files are
 * frequently Windows-1252, and a subtitle full of replacement characters is
 * worse than one decoded by the right fallback. latin1 cannot fail, so this
 * always returns something.
 */
export function decodeSubtitle(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
