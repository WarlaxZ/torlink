import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ImportSourcePrompt } from "./ImportSourcePrompt";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`; // down-arrow escape sequence
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe("ImportSourcePrompt", () => {
  it("lists Netflix and Trakt", () => {
    const { lastFrame } = render(
      <ImportSourcePrompt width={50} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(lastFrame()).toContain("Netflix");
    expect(lastFrame()).toContain("Trakt");
  });

  it("selects Netflix (first item) on enter", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ImportSourcePrompt width={50} onSelect={onSelect} onCancel={vi.fn()} />);
    await flush();
    stdin.write("\r"); // enter
    await flush();
    expect(onSelect).toHaveBeenCalledWith("netflix");
  });

  it("selects Trakt after moving down", async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<ImportSourcePrompt width={50} onSelect={onSelect} onCancel={vi.fn()} />);
    await flush();
    stdin.write(DOWN);
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSelect).toHaveBeenCalledWith("trakt");
  });

  it("cancels on escape", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<ImportSourcePrompt width={50} onSelect={vi.fn()} onCancel={onCancel} />);
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
  });
});
