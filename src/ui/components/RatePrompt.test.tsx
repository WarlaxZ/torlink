import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { RatePrompt } from "./RatePrompt";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const ESC = String.fromCharCode(27);

describe("RatePrompt", () => {
  it("calls onLike when 'l' is pressed", async () => {
    const onLike = vi.fn();
    const onDislike = vi.fn();
    const onDismiss = vi.fn();
    const { stdin } = render(
      <RatePrompt name="The Matrix" onLike={onLike} onDislike={onDislike} onDismiss={onDismiss} />,
    );
    await flush();
    stdin.write("l");
    await flush();
    expect(onLike).toHaveBeenCalled();
  });

  it("calls onDislike when 'd' is pressed", async () => {
    const onLike = vi.fn();
    const onDislike = vi.fn();
    const onDismiss = vi.fn();
    const { stdin } = render(
      <RatePrompt name="The Matrix" onLike={onLike} onDislike={onDislike} onDismiss={onDismiss} />,
    );
    await flush();
    stdin.write("d");
    await flush();
    expect(onDislike).toHaveBeenCalled();
  });

  it("calls onDismiss on escape", async () => {
    const onLike = vi.fn();
    const onDislike = vi.fn();
    const onDismiss = vi.fn();
    const { stdin } = render(
      <RatePrompt name="The Matrix" onLike={onLike} onDislike={onDislike} onDismiss={onDismiss} />,
    );
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("shows the watched affordance and calls onWatched when 'w' is pressed (when onWatched given)", async () => {
    const onWatched = vi.fn();
    const { stdin, lastFrame } = render(
      <RatePrompt name="The Matrix" onLike={vi.fn()} onDislike={vi.fn()} onWatched={onWatched} onDismiss={vi.fn()} />,
    );
    await flush();
    expect(lastFrame()).toContain("watched");
    stdin.write("w");
    await flush();
    expect(onWatched).toHaveBeenCalled();
  });

  it("does not render the watched affordance when onWatched is omitted", async () => {
    const { lastFrame } = render(
      <RatePrompt name="The Matrix" onLike={vi.fn()} onDislike={vi.fn()} onDismiss={vi.fn()} />,
    );
    await flush();
    expect(lastFrame()).not.toContain("watched");
  });

  it("uses a custom title when provided", async () => {
    const { lastFrame } = render(
      <RatePrompt name="The Matrix" title="Rate this pick" onLike={vi.fn()} onDislike={vi.fn()} onDismiss={vi.fn()} />,
    );
    await flush();
    expect(lastFrame()).toContain("Rate this pick");
  });
});
