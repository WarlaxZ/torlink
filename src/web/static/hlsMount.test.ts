import { describe, expect, it } from "vitest";
import { hlsStrategy } from "./hlsMount";

const yes = (): string => "maybe";
const no = (): string => "";

describe("hlsStrategy", () => {
  it("uses hls.js whenever there is MSE, whatever canPlayType claims", () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Chrome on macOS answers "maybe" for
    // application/vnd.apple.mpegurl and then plays nothing — and fires no error
    // either, so the page sits on a black rectangle until the stall timer. An
    // earlier version preferred native on a non-empty canPlayType and broke
    // every desktop browser exactly that way. Measured in a real Chrome.
    expect(hlsStrategy(yes, true)).toBe("mse");
  });

  it("uses hls.js when there is MSE and no native support", () => {
    expect(hlsStrategy(no, true)).toBe("mse");
  });

  it("uses native HLS when there is no MSE — the iPhone Safari case", () => {
    // iPhone Safari has no Media Source Extensions, so hls.js cannot run there
    // at all, but native HLS genuinely works.
    expect(hlsStrategy(yes, false)).toBe("native");
  });

  it("reports unsupported when there is neither", () => {
    expect(hlsStrategy(no, false)).toBe("unsupported");
  });

  it("treats canPlayType's 'probably' as native too, when there is no MSE", () => {
    // The spec allows "", "maybe" or "probably"; only "" is a no.
    expect(hlsStrategy(() => "probably", false)).toBe("native");
  });

  it("does not even ask canPlayType when MSE is present", () => {
    // Not a style point: the answer is unreliable, so consulting it where it
    // cannot change the outcome is how the wrong branch creeps back in.
    let asked = 0;
    hlsStrategy(() => {
      asked += 1;
      return "probably";
    }, true);
    expect(asked).toBe(0);
  });

  it("asks about the HLS mime type specifically when it does ask", () => {
    const asked: string[] = [];
    hlsStrategy((t) => {
      asked.push(t);
      return "";
    }, false);
    expect(asked).toEqual(["application/vnd.apple.mpegurl"]);
  });
});
