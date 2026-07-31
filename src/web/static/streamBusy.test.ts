import { describe, expect, it } from "vitest";
import { BUSY_LABEL, controlState, isBusy, type FlowState } from "./streamBusy";

const idle: FlowState = { prepare: null, picking: null };
const preparing: FlowState = {
  prepare: { key: "abc", title: "Harrowgate.S03.1080p.WEB-DL" },
  picking: null,
};
const picking: FlowState = { prepare: null, picking: "Kestrel" };

describe("controlState", () => {
  it("leaves every control alone when nothing is in flight", () => {
    expect(controlState(idle, "abc", "play")).toEqual({
      disabled: false,
      busy: false,
      label: "play",
    });
    expect(controlState(idle, "Kestrel", "Play next")).toEqual({
      disabled: false,
      busy: false,
      label: "Play next",
    });
  });

  it("marks the control that started the flow as busy", () => {
    expect(controlState(preparing, "abc", "play")).toEqual({
      disabled: true,
      busy: true,
      label: BUSY_LABEL,
    });
  });

  // The point of the whole module. A Play button that stays enabled while a
  // prepare runs, and silently does nothing when pressed, is what taught users
  // to hammer it — one prepare at a time is the terminal's rule
  // (src/ui/App.tsx's `if (preparing || streamFiles || activeStream) return`)
  // and this is that rule, rendered.
  it("disables every OTHER control rather than letting it no-op silently", () => {
    expect(controlState(preparing, "def", "play")).toEqual({
      disabled: true,
      busy: false,
      label: "play",
    });
    expect(controlState(preparing, "Kestrel", "Play")).toEqual({
      disabled: true,
      busy: false,
      label: "Play",
    });
  });

  it("treats a pick search exactly as it treats a prepare", () => {
    expect(controlState(picking, "Kestrel", "Play")).toEqual({
      disabled: true,
      busy: true,
      label: BUSY_LABEL,
    });
    expect(controlState(picking, "abc", "play")).toEqual({
      disabled: true,
      busy: false,
      label: "play",
    });
  });

  // A pick hands off to a prepare, so both can be set for one tick. The row
  // actually resolving is the more specific truth and wins; without this the
  // title's button would claim to be busy while the row's did the work.
  it("prefers the prepare when a pick has already handed off to one", () => {
    const both: FlowState = { prepare: { key: "abc", title: "Kestrel" }, picking: "Kestrel" };
    expect(controlState(both, "abc", "play").busy).toBe(true);
    expect(controlState(both, "Kestrel", "Play")).toEqual({
      disabled: true,
      busy: false,
      label: "Play",
    });
  });

  // Info hashes and titles are two namespaces and are never compared across.
  // A key from the wrong one simply never matches, which lands it in the
  // disabled branch — the correct answer for it anyway.
  it("never mistakes a title for an info hash", () => {
    expect(controlState(preparing, "Harrowgate.S03.1080p.WEB-DL", "Play").busy).toBe(false);
  });
});

describe("isBusy", () => {
  it("is the one-at-a-time gate the terminal has and the browser did not", () => {
    expect(isBusy(idle)).toBe(false);
    expect(isBusy(preparing)).toBe(true);
    expect(isBusy(picking)).toBe(true);
  });
});
