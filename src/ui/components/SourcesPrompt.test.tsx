import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { SourcesPrompt } from "./SourcesPrompt";
import { SOURCES } from "../../sources/registry";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const ESC = String.fromCharCode(27);

// Adult sources are gated behind the adultEnabled flag, so the default panel
// shows one fewer count than the full registry.
const NON_ADULT = SOURCES.filter((s) => !s.adult).length;
const ADULT = SOURCES.length - NON_ADULT;

describe("SourcesPrompt", () => {
  it("renders every non-adult source with an on/off count", () => {
    const { lastFrame } = render(
      <SourcesPrompt width={60} disabled={[]} adultEnabled={false} onToggle={() => {}} onCancel={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(`${NON_ADULT}/${NON_ADULT}`);
    // A couple of the source labels show up.
    expect(frame).toContain("YTS");
    expect(frame).toContain("Nyaa");
    // The Porn group is hidden while adult content is disabled.
    expect(frame).not.toContain("Porn");
  });

  it("includes adult sources and the Porn group when adult content is enabled", () => {
    expect(ADULT).toBeGreaterThan(0);
    const { lastFrame } = render(
      <SourcesPrompt width={60} disabled={[]} adultEnabled onToggle={() => {}} onCancel={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(`${SOURCES.length}/${SOURCES.length}`);
    expect(frame).toContain("Porn");
  });

  it("reflects a disabled source in the count", () => {
    const { lastFrame } = render(
      <SourcesPrompt width={60} disabled={["yts"]} adultEnabled={false} onToggle={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame() ?? "").toContain(`${NON_ADULT - 1}/${NON_ADULT}`);
  });

  it("toggles the highlighted source when space is pressed", async () => {
    const onToggle = vi.fn();
    const { stdin } = render(
      <SourcesPrompt width={60} disabled={[]} adultEnabled={false} onToggle={onToggle} onCancel={() => {}} />,
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
      <SourcesPrompt width={60} disabled={[]} adultEnabled={false} onToggle={() => {}} onCancel={onCancel} />,
    );
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
