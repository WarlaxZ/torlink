import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { DnsPrompt } from "./DnsPrompt";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const ESC = String.fromCharCode(27);
const CTRL_X = String.fromCharCode(24);

describe("DnsPrompt", () => {
  it("renders the current resolver value", () => {
    const { lastFrame } = render(
      <DnsPrompt
        width={60}
        value="cloudflare"
        envOverride={false}
        onSubmit={() => {}}
        onClear={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cloudflare");
  });

  it("submits the typed value on enter", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <DnsPrompt
        width={60}
        value=""
        envOverride={false}
        onSubmit={onSubmit}
        onClear={() => {}}
        onCancel={() => {}}
      />,
    );
    await flush();
    stdin.write("quad9");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("quad9");
  });

  it("clears on ctrl+x when a value is set", async () => {
    const onClear = vi.fn();
    const { stdin } = render(
      <DnsPrompt
        width={60}
        value="cloudflare"
        envOverride={false}
        onSubmit={() => {}}
        onClear={onClear}
        onCancel={() => {}}
      />,
    );
    await flush();
    stdin.write(CTRL_X);
    await flush();
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("cancels on escape", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      <DnsPrompt
        width={60}
        value=""
        envOverride={false}
        onSubmit={() => {}}
        onClear={() => {}}
        onCancel={onCancel}
      />,
    );
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("notes when the value is pinned by the TORLINK_DNS env var", () => {
    const { lastFrame } = render(
      <DnsPrompt
        width={60}
        value="1.1.1.1"
        envOverride
        onSubmit={() => {}}
        onClear={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("TORLINK_DNS");
  });
});
