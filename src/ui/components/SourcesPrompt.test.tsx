import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { SourcesPrompt } from "./SourcesPrompt";
import { SOURCES } from "../../sources/registry";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const ESC = String.fromCharCode(27);

describe("SourcesPrompt", () => {
  it("renders every source with an on/off count", () => {
    const { lastFrame } = render(
      <SourcesPrompt width={60} disabled={[]} onToggle={() => {}} onCancel={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(`${SOURCES.length}/${SOURCES.length}`);
    // A couple of the source labels show up.
    expect(frame).toContain("YTS");
    expect(frame).toContain("Nyaa");
  });

  it("reflects a disabled source in the count", () => {
    const { lastFrame } = render(
      <SourcesPrompt width={60} disabled={["yts"]} onToggle={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame() ?? "").toContain(`${SOURCES.length - 1}/${SOURCES.length}`);
  });

  it("toggles the highlighted source when space is pressed", async () => {
    const onToggle = vi.fn();
    const { stdin } = render(
      <SourcesPrompt width={60} disabled={[]} onToggle={onToggle} onCancel={() => {}} />,
    );
    await flush();
    stdin.write(" ");
    await flush();
    // Cursor starts on the first source in the grouped display.
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(SOURCES[0]!.id);
  });

  it("cancels on escape", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      <SourcesPrompt width={60} disabled={[]} onToggle={() => {}} onCancel={onCancel} />,
    );
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
