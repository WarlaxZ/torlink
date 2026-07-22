import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ReccdPrompt } from "./ReccdPrompt";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const ESC = String.fromCharCode(27);

describe("ReccdPrompt", () => {
  it("renders URL and Token fields and the status line", () => {
    const { lastFrame } = render(
      <ReccdPrompt width={60} url="" token="" status={{ state: "unconfigured" }} onSubmit={() => {}} onCancel={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("URL");
    expect(frame).toContain("Token");
    expect(frame).toContain("Not configured");
  });

  it("cancels on escape", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      <ReccdPrompt width={60} url="" token="" status={null} onSubmit={() => {}} onCancel={onCancel} />,
    );
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
  });

  it("submits the entered url and token", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <ReccdPrompt width={60} url="" token="" status={null} onSubmit={onSubmit} onCancel={() => {}} />,
    );
    await flush();
    stdin.write("http://h:4100"); // typed into the focused URL field
    await flush();
    stdin.write("\r"); // enter on URL advances to the Token field
    await flush();
    stdin.write("tok"); // typed into the Token field
    await flush();
    stdin.write("\r"); // enter on Token submits
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("http://h:4100", "tok");
  });
});
