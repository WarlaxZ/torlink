import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { GenrePrompt } from "./GenrePrompt";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const ESC = String.fromCharCode(27);

describe("GenrePrompt", () => {
  it("submits the typed genre on enter", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(<GenrePrompt width={40} value="" onSubmit={onSubmit} onCancel={onCancel} />);
    await flush();
    stdin.write("Western");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("Western");
  });

  it("cancels on escape", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(<GenrePrompt width={40} value="" onSubmit={onSubmit} onCancel={onCancel} />);
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
  });
});
