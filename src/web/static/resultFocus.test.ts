import { describe, expect, it } from "vitest";
import { focusTargetAfterRender, nextRowKey, rovingRowKey } from "./resultFocus";

describe("focusTargetAfterRender", () => {
  it("returns focus to the same control on the same row", () => {
    const before = { rowKey: "b2", control: "name" };
    expect(focusTargetAfterRender(before, ["a1", "b2", "c3"])).toEqual(before);
  });

  it("does nothing when focus was not in the list", () => {
    // The search box, the sort select, a queue row — none of those may be stolen
    // just because the results list re-rendered underneath them, and it
    // re-renders on every streamed frame.
    expect(focusTargetAfterRender(null, ["a1"])).toBeNull();
  });

  it("falls back to the nearest surviving row when the focused row is gone", () => {
    // A filter, or a group collapsing over it, can remove the row under focus.
    // Focus must land somewhere in the list rather than on <body>.
    const target = focusTargetAfterRender({ rowKey: "b2", control: "name" }, ["a1", "c3"]);
    expect(target).toEqual({ rowKey: "a1", control: "name" });
  });

  it("gives up when the list is empty", () => {
    expect(focusTargetAfterRender({ rowKey: "b2", control: "name" }, [])).toBeNull();
  });

  it("keeps the control, so a re-render does not move focus between a row's buttons", () => {
    const target = focusTargetAfterRender({ rowKey: "b2", control: "play" }, ["a1", "b2"]);
    expect(target?.control).toBe("play");
  });
});

describe("rovingRowKey", () => {
  it("makes the selected row the tabbable one", () => {
    expect(rovingRowKey(["a1", "b2", "c3"], "b2")).toBe("b2");
  });

  it("falls back to the first row when nothing is selected", () => {
    // Exactly one control in a listbox is tabbable, so Tab lands somewhere
    // sensible on a fresh search rather than walking all 210 rows.
    expect(rovingRowKey(["a1", "b2"], null)).toBe("a1");
  });

  it("falls back to the first row when the selection is not on screen", () => {
    expect(rovingRowKey(["a1", "b2"], "gone")).toBe("a1");
  });

  it("has nothing to offer for an empty list", () => {
    expect(rovingRowKey([], "a1")).toBeNull();
  });
});

describe("nextRowKey", () => {
  const keys = ["a1", "b2", "c3"];

  it("steps down and up", () => {
    expect(nextRowKey(keys, "b2", "down")).toBe("c3");
    expect(nextRowKey(keys, "b2", "up")).toBe("a1");
  });

  it("stops at the ends rather than wrapping", () => {
    // Deliberately unlike the TUI's j/k, which wrap. A browser list has a
    // scrollbar: wrapping from the last row teleports the viewport, and nothing
    // on screen explains why.
    expect(nextRowKey(keys, "c3", "down")).toBe("c3");
    expect(nextRowKey(keys, "a1", "up")).toBe("a1");
  });

  it("jumps to the ends", () => {
    expect(nextRowKey(keys, "b2", "home")).toBe("a1");
    expect(nextRowKey(keys, "b2", "end")).toBe("c3");
  });

  it("starts at the first row when the current row is unknown", () => {
    expect(nextRowKey(keys, null, "down")).toBe("a1");
  });

  it("has nothing to offer for an empty list", () => {
    expect(nextRowKey([], null, "down")).toBeNull();
  });
});
