import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { HelpOverlay, helpContentHeight } from "./HelpOverlay";
import { StoreContext, type Store } from "../store";

// The overlay only reads `cols` from the store, so a cast partial is enough.
function renderAt(cols: number, props: { maxRows?: number; scroll?: number }) {
  return render(
    <StoreContext.Provider value={{ cols } as unknown as Store}>
      <HelpOverlay {...props} />
    </StoreContext.Provider>,
  );
}

describe("helpContentHeight", () => {
  it("is taller stacked (narrow) than in columns (wide)", () => {
    expect(helpContentHeight(40)).toBeGreaterThan(helpContentHeight(1000));
  });
});

describe("HelpOverlay", () => {
  it("shows everything and no scroll hint when it fits", () => {
    const { lastFrame } = renderAt(40, { maxRows: 200, scroll: 0 });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Navigate");
    expect(frame).toContain("Seeding");
    expect(frame).toContain("Press ? or esc to close");
    expect(frame).not.toContain("scroll");
  });

  it("clips overflow and pages through it with scroll", () => {
    // Narrow terminal stacks the groups into one tall column.
    const top = renderAt(40, { maxRows: 6, scroll: 0 }).lastFrame() ?? "";
    expect(top).toContain("Keyboard"); // header pinned
    expect(top).toContain("Navigate"); // first group in view
    expect(top).not.toContain("Seeding"); // last group clipped below
    expect(top).toContain("↑↓ scroll"); // hint appears when scrollable

    const bottom = renderAt(40, { maxRows: 6, scroll: 999 }).lastFrame() ?? "";
    expect(bottom).toContain("Keyboard"); // header still pinned
    expect(bottom).toContain("Seeding"); // scrolled to the last group
    expect(bottom).not.toContain("Navigate"); // first group scrolled off
  });
});
