import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { PreviewPane } from "./PreviewPane";

const base = { width: 40, height: 24, focused: true, title: "Chernobyl", year: 2019 };

describe("PreviewPane", () => {
  it("renders the title, year, plot and reason", () => {
    const f = render(
      <PreviewPane {...base} plot="A nuclear disaster." posterRows={null} note="because you liked Paradise" />,
    ).lastFrame() ?? "";
    expect(f).toContain("Chernobyl (2019)");
    expect(f).toContain("A nuclear disaster.");
    expect(f).toContain("because you liked Paradise");
  });

  it("shows loading and empty states", () => {
    const loading = render(<PreviewPane {...base} plot={undefined} posterRows={undefined} />).lastFrame() ?? "";
    expect(loading).toContain("Loading poster…");
    const none = render(<PreviewPane {...base} plot={null} posterRows={null} />).lastFrame() ?? "";
    expect(none).toContain("No poster available.");
    expect(none).toContain("No plot available.");
  });

  it("emits poster rows verbatim (truecolor half-blocks)", () => {
    const rows = ["\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m▀\x1b[0m"];
    const f = render(<PreviewPane {...base} plot={null} posterRows={rows} />).lastFrame() ?? "";
    expect(f).toContain("38;2;1;2;3");
  });
});
