import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { TraktImportPrompt, type TraktImportView } from "./TraktImportPrompt";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const ESC = String.fromCharCode(27);

describe("TraktImportPrompt", () => {
  it("shows the code and verification URL in the connect phase", () => {
    const state: TraktImportView = {
      phase: "connect",
      connect: { userCode: "AB12-CD34", verificationUrl: "https://trakt.tv/activate" },
    };
    const { lastFrame } = render(<TraktImportPrompt width={60} state={state} onClose={vi.fn()} />);
    expect(lastFrame()).toContain("AB12-CD34");
    expect(lastFrame()).toContain("trakt.tv/activate");
  });

  it("shows the summary in the done phase", () => {
    const state: TraktImportView = {
      phase: "done",
      result: { imported: 9, resolved: 9, unresolved: 0, unresolvedTitles: [] },
    };
    const { lastFrame } = render(<TraktImportPrompt width={60} state={state} onClose={vi.fn()} />);
    expect(lastFrame()).toContain("Imported 9");
  });

  it("shows an error in the done phase", () => {
    const state: TraktImportView = { phase: "done", error: "Trakt isn't enabled on your reccd server" };
    const { lastFrame } = render(<TraktImportPrompt width={60} state={state} onClose={vi.fn()} />);
    expect(lastFrame()).toContain("Trakt isn't enabled");
  });

  it("closes on escape", async () => {
    const onClose = vi.fn();
    const { stdin } = render(<TraktImportPrompt width={60} state={{ phase: "checking" }} onClose={onClose} />);
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onClose).toHaveBeenCalled();
  });
});
