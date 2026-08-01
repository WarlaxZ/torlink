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

  describe("the advertised-host override", () => {
    // WSL2 in its default NAT mode is the case this exists for. Inside the VM,
    // os.networkInterfaces() reports eth0 at 172.x — non-internal, IPv4, and
    // perfectly plausible — so without an override this hands the television a
    // URL it cannot route to, and the failure surfaces as "couldn't play this
    // file", blaming the file for a network problem. Bridged Docker is the same
    // shape.
    const WSL: NetInterfaces = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [{ address: "172.23.61.4", family: "IPv4", internal: false }],
    };

    it("wins over the interface that was guessed", () => {
      expect(castOrigin("0.0.0.0", 9161, WSL, "192.168.0.10")).toBe("http://192.168.0.10:9161");
    });

    it("wins even over an explicit non-loopback bind", () => {
      expect(castOrigin("172.23.61.4", 9161, WSL, "192.168.0.10")).toBe("http://192.168.0.10:9161");
    });

    it("wins over a loopback bind, because the port is forwarded from elsewhere", () => {
      // The portproxy case: the server listens on loopback inside the VM and
      // Windows forwards to it. Nothing about this machine's own interfaces can
      // tell us that, which is exactly why this is a setting and not a guess.
      expect(castOrigin("127.0.0.1", 9161, WSL, "192.168.0.10")).toBe("http://192.168.0.10:9161");
    });

    it("accepts host:port and lets the port it names win", () => {
      // Forwarded ports are usually not the same number on both sides.
      expect(castOrigin("0.0.0.0", 9161, WSL, "192.168.0.10:8080")).toBe(
        "http://192.168.0.10:8080",
      );
    });

    it("brackets an IPv6 literal", () => {
      expect(castOrigin("0.0.0.0", 9161, WSL, "2001:db8::5")).toBe("http://[2001:db8::5]:9161");
    });

    it("falls back to the guess when it is blank or unusable", () => {
      expect(castOrigin("0.0.0.0", 9161, IFACES, "   ")).toBe("http://192.168.0.98:9161");
      expect(castOrigin("0.0.0.0", 9161, IFACES, undefined)).toBe("http://192.168.0.98:9161");
      // A port that is not a number would produce a URL nothing can fetch, so the
      // guess is better than honouring it.
      expect(castOrigin("0.0.0.0", 9161, IFACES, "tv.local:nope")).toBe("http://192.168.0.98:9161");
    });

    it("is not defeated by a loopback address being configured", () => {
      // Naming loopback as the advertised host cannot be what anyone meant: it is
      // the one answer guaranteed to be wrong for a television.
      expect(castOrigin("0.0.0.0", 9161, WSL, "localhost")).toBeNull();
      expect(castOrigin("0.0.0.0", 9161, WSL, "127.0.0.1")).toBeNull();
    });
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
