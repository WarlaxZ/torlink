import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { StreamFilePrompt } from "./StreamFilePrompt";
import type { ResolvedFile } from "../../integrations/realdebrid";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const UP = `${String.fromCharCode(27)}[A`;

// Deliberately NOT in title order, and deliberately not in size order either:
// the picker sorts for display, so a test that fed it a pre-sorted list would
// prove nothing about which file the cursor is actually on.
const files: ResolvedFile[] = [
  { filename: "Harrowgate.S03E06.1080p.WEB-DL.mkv", bytes: 300, url: "http://x/6" },
  { filename: "Harrowgate.S03E04.1080p.WEB-DL.mkv", bytes: 100, url: "http://x/4" },
  { filename: "Harrowgate.S03E05.1080p.WEB-DL.mkv", bytes: 200, url: "http://x/5" },
];

describe("StreamFilePrompt", () => {
  it("opens on the first file when nothing is preselected", () => {
    const { lastFrame } = render(
      <StreamFilePrompt width={60} files={files} onSelect={() => {}} onCancel={() => {}} />,
    );
    // The count is 1-based over the SORTED list, so "1/3" is the title-order
    // first file — E04 — which is exactly today's behaviour.
    expect(lastFrame() ?? "").toContain("1/3");
  });

  it("plays the first file on enter when nothing is preselected", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <StreamFilePrompt width={60} files={files} onSelect={onSelect} onCancel={() => {}} />,
    );
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "Harrowgate.S03E04.1080p.WEB-DL.mkv" }),
    );
  });

  // The point of the whole change: a Continue-watching row that says "next
  // S03E05" opens the picker on S03E05.
  it("opens on the preselected file, resolving it through the display sort", async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(
      <StreamFilePrompt
        width={60}
        files={files}
        // Index 2 of `files`, which is row 2 of 3 once sorted by title. A cursor
        // that used the index as given would land on E06.
        preselect={2}
        onSelect={onSelect}
        onCancel={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("2/3");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "Harrowgate.S03E05.1080p.WEB-DL.mkv" }),
    );
  });

  // Preselecting a POSITION would move the highlight to a different file the
  // moment the user pressed `s`; preselecting the FILE cannot.
  it("keeps the preselected file highlighted across a re-sort", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <StreamFilePrompt
        width={60}
        files={files}
        preselect={2}
        onSelect={onSelect}
        onCancel={() => {}}
      />,
    );
    await flush();
    stdin.write("s"); // title order -> size order: E06, E05, E04
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "Harrowgate.S03E05.1080p.WEB-DL.mkv" }),
    );
  });

  it("moves off the preselection with the arrow keys", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <StreamFilePrompt
        width={60}
        files={files}
        preselect={2}
        onSelect={onSelect}
        onCancel={() => {}}
      />,
    );
    await flush();
    stdin.write(UP); // up, from E05 to E04
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "Harrowgate.S03E04.1080p.WEB-DL.mkv" }),
    );
  });

  // A preselect out of range, or pointing at nothing, must not strand the cursor.
  it("ignores a preselect it cannot resolve", () => {
    const { lastFrame } = render(
      <StreamFilePrompt
        width={60}
        files={files}
        preselect={99}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("1/3");
  });
});
