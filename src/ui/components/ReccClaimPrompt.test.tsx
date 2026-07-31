import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ReccClaimPrompt } from "./ReccClaimPrompt";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const ESC = String.fromCharCode(27);
const DOWN = ESC + "[B"; // down-arrow escape sequence

describe("ReccClaimPrompt", () => {
  it("names the account being claimed", () => {
    const { lastFrame } = render(
      <ReccClaimPrompt width={80} accountName="quiet-heron-4f2a" onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain("quiet-heron-4f2a");
  });

  it("explains what claiming gets you, since the account already works", () => {
    const { lastFrame } = render(
      <ReccClaimPrompt width={80} accountName="quiet-heron-4f2a" onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain("sign in");
  });

  it("shows an error from a failed attempt", () => {
    const { lastFrame } = render(
      <ReccClaimPrompt width={80} error="That username is taken — try another." onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain("That username is taken");
  });

  it("says it is working while a claim is in flight", () => {
    const { lastFrame } = render(<ReccClaimPrompt width={80} busy onSubmit={() => {}} onCancel={() => {}} />);
    expect(lastFrame()?.toLowerCase()).toContain("claiming");
  });

  it("masks the password field so typed characters never appear, only the mask glyph", async () => {
    const { lastFrame, stdin } = render(
      <ReccClaimPrompt width={80} onSubmit={() => {}} onCancel={() => {}} />,
    );
    await flush();
    // Move down into the password field and type a secret.
    stdin.write(DOWN);
    await flush();
    stdin.write("hunter2pw");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("hunter2pw");
    expect(frame).toContain("•");
  });

  it("does not submit a second time while busy", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<ReccClaimPrompt width={80} busy onSubmit={onSubmit} onCancel={() => {}} />);
    await flush();
    stdin.write(DOWN);
    await flush();
    stdin.write("\r"); // attempt submit while busy
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels on escape", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<ReccClaimPrompt width={80} onSubmit={() => {}} onCancel={onCancel} />);
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
  });
});
