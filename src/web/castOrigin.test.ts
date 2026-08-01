import { describe, expect, it } from "vitest";
import { castOrigin } from "./castOrigin";
import type { NetInterfaces } from "./links";

const IFACES: NetInterfaces = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [{ address: "192.168.0.98", family: "IPv4", internal: false }],
};

const LOOPBACK_ONLY: NetInterfaces = { lo0: IFACES.lo0 };

describe("castOrigin", () => {
  it("names a LAN address for a wildcard bind, never loopback", () => {
    expect(castOrigin("0.0.0.0", 9161, IFACES)).toBe("http://192.168.0.98:9161");
    expect(castOrigin("", 9161, IFACES)).toBe("http://192.168.0.98:9161");
    expect(castOrigin("::", 9161, IFACES)).toBe("http://192.168.0.98:9161");
  });

  it("uses an explicit non-loopback bind address as given", () => {
    expect(castOrigin("192.168.0.98", 9161, IFACES)).toBe("http://192.168.0.98:9161");
    expect(castOrigin("torlink.lan", 9161, IFACES)).toBe("http://torlink.lan:9161");
  });

  it("brackets an IPv6 literal, or the port reads as another hextet", () => {
    expect(castOrigin("2001:db8::1", 9161, IFACES)).toBe("http://[2001:db8::1]:9161");
  });

  it("is null for a loopback bind, because nothing on the LAN can reach it", () => {
    // The honest answer, and the one this module exists to give. Handing a
    // television the machine's LAN address when the server is listening only on
    // loopback would be a URL that never answers — a cast that fails with no
    // explanation, instead of a button that says why it cannot work.
    expect(castOrigin("127.0.0.1", 9161, IFACES)).toBeNull();
    expect(castOrigin("localhost", 9161, IFACES)).toBeNull();
    expect(castOrigin("::1", 9161, IFACES)).toBeNull();
  });

  it("is null when a wildcard bind found no non-loopback address at all", () => {
    // A machine with no network. A caller turns this into "no address a
    // Chromecast could reach this on"; it must not fall back to loopback.
    expect(castOrigin("0.0.0.0", 9161, LOOPBACK_ONLY)).toBeNull();
  });

  it("ignores an internal or IPv6 interface when picking a LAN address", () => {
    const mixed: NetInterfaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      utun0: [{ address: "fe80::1", family: "IPv6", internal: false }],
      en0: [{ address: "10.0.0.7", family: "IPv4", internal: false }],
    };
    expect(castOrigin("0.0.0.0", 9161, mixed)).toBe("http://10.0.0.7:9161");
  });
});
