// The decisions behind "drop a .torrent onto the page", kept out of app.ts so
// they can be tested without a DOM: what a drag is carrying, and which of the
// dropped files (if any) is the torrent to upload. app.ts does the DOM wiring
// and the FileReader work; it asks these two questions.

// A dragover event's dataTransfer.types lists "Files" when the pointer is
// dragging files (as opposed to selected text or a link). Deciding the overlay
// on this — not on the file list, which dragover isn't allowed to read — is why
// it lives here rather than inline.
export function dragHasFiles(types: readonly string[] | undefined): boolean {
  return !!types && types.includes("Files");
}

// The first dropped file whose name ends in .torrent, or null. A drop can carry
// several files; we take one torrent and ignore the rest rather than queueing a
// pile of them from a single gesture.
export function pickTorrentFile<T extends { name: string }>(files: readonly T[]): T | null {
  return files.find((f) => /\.torrent$/i.test(f.name)) ?? null;
}
