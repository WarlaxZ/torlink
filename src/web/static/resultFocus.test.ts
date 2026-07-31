import { describe, expect, it } from "vitest";
import { focusTargetAfterRender } from "./resultFocus";

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
