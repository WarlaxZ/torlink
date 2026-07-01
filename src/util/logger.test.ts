import { describe, it, expect } from "vitest";
import { formatLine, shouldRotate, createLogger } from "./logger";

const AT = new Date("2026-07-01T00:00:00.000Z");

describe("formatLine", () => {
  it("prefixes an ISO timestamp and a padded level", () => {
    expect(formatLine("warn", "hello", AT)).toBe("2026-07-01T00:00:00.000Z WARN  hello\n");
    expect(formatLine("debug", "d", AT)).toBe("2026-07-01T00:00:00.000Z DEBUG d\n");
  });
});

describe("shouldRotate", () => {
  it("rotates only once the file has content and the write would exceed the cap", () => {
    expect(shouldRotate(0, 500, 1000)).toBe(false);
    expect(shouldRotate(600, 300, 1000)).toBe(false);
    expect(shouldRotate(600, 500, 1000)).toBe(true);
  });
});

describe("createLogger", () => {
  function harness(over: Record<string, unknown> = {}) {
    const lines: string[] = [];
    let rotated = 0;
    const logger = createLogger({
      file: "/x/torlink.log",
      maxBytes: 1000,
      enabled: true,
      debug: false,
      now: () => AT,
      append: async (_f: string, d: string) => {
        lines.push(d);
      },
      rotate: async () => {
        rotated++;
      },
      sizeOf: async () => 0,
      ...over,
    });
    return { logger, lines, rotated: () => rotated };
  }

  it("writes error/warn/info always; debug only when enabled", async () => {
    const off = harness({ debug: false });
    off.logger.info("i");
    off.logger.debug("d");
    await off.logger.flush();
    expect(off.lines.join("")).toContain("INFO  i");
    expect(off.lines.join("")).not.toContain(" d\n");

    const on = harness({ debug: true });
    on.logger.debug("d2");
    await on.logger.flush();
    expect(on.lines.join("")).toContain("DEBUG d2");
  });

  it("no-ops entirely when disabled", async () => {
    const h = harness({ enabled: false });
    h.logger.error("nope");
    await h.logger.flush();
    expect(h.lines).toEqual([]);
  });

  it("rotates when the running size would exceed the cap, then still writes", async () => {
    const h = harness({ sizeOf: async () => 999 });
    h.logger.warn("x".repeat(50));
    await h.logger.flush();
    expect(h.rotated()).toBe(1);
    expect(h.lines.length).toBe(1);
  });
});
