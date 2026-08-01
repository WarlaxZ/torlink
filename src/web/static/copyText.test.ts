import { describe, expect, it } from "vitest";
import { copyNotice, copyText, type CopyPorts } from "./copyText";

const STREAM_URL = "http://192.168.1.20:8080/stream/abc";

function ports(over: Partial<CopyPorts> = {}): CopyPorts {
  return { writeAsync: null, writeLegacy: () => false, ...over };
}

describe("copyText", () => {
  it("uses the async clipboard when the browser exposes one", async () => {
    const written: string[] = [];
    let legacyTries = 0;
    const result = await copyText(
      STREAM_URL,
      ports({
        writeAsync: async (text) => {
          written.push(text);
        },
        writeLegacy: () => {
          legacyTries += 1;
          return true;
        },
      }),
    );
    expect(result).toBe("copied");
    expect(written).toEqual([STREAM_URL]);
    expect(legacyTries).toBe(0);
  });

  it("falls back to the legacy copy when there is no async clipboard", () => {
    // The insecure-origin case, which is the normal way this dashboard is
    // reached over a LAN: navigator.clipboard is not merely restricted, it is
    // undefined, so there is nothing to try first.
    const written: string[] = [];
    const result = copyText(
      STREAM_URL,
      ports({
        writeLegacy: (text) => {
          written.push(text);
          return true;
        },
      }),
    );
    expect(result).toBe("copied");
    expect(written).toEqual([STREAM_URL]);
  });

  it("attempts the legacy copy synchronously, without an intervening await", () => {
    // THE POINT OF THIS FILE. document.execCommand("copy") is only permitted
    // inside the task the user's click started; a single await before it hands
    // control back to the event loop and Safari refuses the copy. So the
    // no-async-clipboard path must not return a promise, and must have already
    // called writeLegacy by the time copyText returns.
    let called = false;
    const result = copyText(STREAM_URL, ports({ writeLegacy: () => ((called = true), true) }));
    expect(called).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("asks for the manual field when the legacy copy is refused too", () => {
    expect(copyText(STREAM_URL, ports({ writeLegacy: () => false }))).toBe("manual");
  });

  it("tries the legacy copy when the async clipboard rejects", async () => {
    // A secure origin can still refuse: writeText rejects when the document is
    // not focused, which is easy to hit on a second monitor.
    const result = await copyText(
      STREAM_URL,
      ports({
        writeAsync: () => Promise.reject(new Error("not focused")),
        writeLegacy: () => true,
      }),
    );
    expect(result).toBe("copied");
  });

  it("asks for the manual field when both routes fail", async () => {
    const result = await copyText(
      STREAM_URL,
      ports({ writeAsync: () => Promise.reject(new Error("denied")), writeLegacy: () => false }),
    );
    expect(result).toBe("manual");
  });

  it("still reaches the legacy copy when the async clipboard throws synchronously", async () => {
    // Some hardened browsers throw from writeText rather than rejecting.
    const result = await copyText(
      STREAM_URL,
      ports({
        writeAsync: () => {
          throw new Error("blocked");
        },
        writeLegacy: () => true,
      }),
    );
    expect(result).toBe("copied");
  });
});

describe("copyNotice", () => {
  it("says the same thing however the copy happened", () => {
    // The user does not care which clipboard API worked, and a notice that
    // mentioned the legacy route would only invite the question.
    expect(copyNotice("copied")).toBe("Stream URL copied.");
  });

  it("points at the field it is about to reveal when copying is refused", () => {
    const notice = copyNotice("manual");
    // "the field", not "below": the field renders inside .actions, which sits
    // above the notice. Verified in a browser — an earlier wording said below
    // and pointed the wrong way.
    expect(notice).toContain("field");
    // And it no longer sends the user off to download a .m3u instead, which was
    // the old advice when there was nothing else on offer.
    expect(notice).not.toContain("secure context");
    expect(notice).not.toContain(".m3u");
  });

  /**
   * The dashboard's results list copies a magnet through the same `copyText`,
   * and reveals it in the alert rather than in a field. One function decides
   * the wording for both so they cannot drift into describing the same refusal
   * differently — but it has to name the right place, because sending someone's
   * eyes to a field that does not exist is worse than saying nothing.
   */
  it("names what was copied and where it went", () => {
    expect(copyNotice("copied", "Magnet")).toBe("Magnet copied.");
    expect(copyNotice("manual", "Magnet", "the message below")).toContain("the message below");
    expect(copyNotice("manual", "Magnet", "the message below")).not.toContain("the field");
  });

  it("still defaults to the player page's wording", () => {
    // The player passes neither argument, so its two messages must be byte-for
    // -byte what they were before the parameters existed.
    expect(copyNotice("copied")).toBe("Stream URL copied.");
    expect(copyNotice("manual")).toContain("the field");
  });
});
