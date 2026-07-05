import { describe, expect, it } from "vitest";
import { parseDefaultInterface } from "./vpn";

describe("parseDefaultInterface", () => {
  it("parses Linux, macOS, and Windows default routes", () => {
    expect(parseDefaultInterface("linux", "default via 10.0.0.1 dev tun0 proto static")).toBe("tun0");
    expect(parseDefaultInterface("darwin", "   route to: default\ninterface: utun4\n")).toBe("utun4");
    expect(parseDefaultInterface("win32", "My VPN\r\n")).toBe("My VPN");
  });
});
