// The bug this module exists to kill: `--host 0.0.0.0` used to be printed
// verbatim as `http://0.0.0.0:9161`, which is not an address a browser can
// visit. Pure by construction — the interface list is a parameter — so every
// case below is exercised without depending on the machine's NICs.
import { describe, it, expect } from "vitest";
import { displayHosts, webUrl, type NetInterfaces } from "./links";

const IFACES: NetInterfaces = {
  lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  eth0: [
    { family: "IPv4", address: "192.168.1.24", internal: false },
    { family: "IPv6", address: "fe80::1", internal: false },
  ],
  docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
};

describe("displayHosts", () => {
  it("maps an IPv4 wildcard to loopback plus every external IPv4", () => {
    expect(displayHosts("0.0.0.0", IFACES)).toEqual({
      local: "127.0.0.1",
      lan: ["192.168.1.24", "172.17.0.1"],
    });
  });
  it("maps an IPv6 wildcard the same way", () => {
    expect(displayHosts("::", IFACES).local).toBe("127.0.0.1");
  });
  it("treats an empty host as a wildcard", () => {
    expect(displayHosts("", IFACES).local).toBe("127.0.0.1");
  });
  it("passes an explicit host through with no LAN list", () => {
    expect(displayHosts("192.168.1.24", IFACES)).toEqual({ local: "192.168.1.24", lan: [] });
  });
  it("brackets an IPv6 literal so it can be concatenated into a URL", () => {
    expect(displayHosts("::1", IFACES)).toEqual({ local: "[::1]", lan: [] });
  });
  it("does not double-bracket an already-bracketed literal", () => {
    expect(displayHosts("[::1]", IFACES).local).toBe("[::1]");
  });
  it("skips internal addresses and IPv6 in the LAN list", () => {
    expect(displayHosts("0.0.0.0", IFACES).lan).not.toContain("127.0.0.1");
    expect(displayHosts("0.0.0.0", IFACES).lan).not.toContain("fe80::1");
  });
  it("yields an empty LAN list on a machine with only loopback", () => {
    expect(displayHosts("0.0.0.0", { lo: IFACES.lo }).lan).toEqual([]);
  });
  it("tolerates the numeric family node used to report", () => {
    const numeric: NetInterfaces = { eth0: [{ family: 4, address: "10.0.0.2", internal: false }] };
    expect(displayHosts("0.0.0.0", numeric).lan).toEqual(["10.0.0.2"]);
  });
  it("tolerates an undefined interface entry", () => {
    expect(displayHosts("0.0.0.0", { eth0: undefined }).lan).toEqual([]);
  });
});

describe("webUrl", () => {
  it("builds a bare URL with no token", () => {
    expect(webUrl("127.0.0.1", 9161)).toBe("http://127.0.0.1:9161");
  });
  it("puts the token in the fragment, never the query", () => {
    expect(webUrl("127.0.0.1", 9161, "abc")).toBe("http://127.0.0.1:9161/#k=abc");
  });
  it("encodes a token with URL-significant characters", () => {
    expect(webUrl("127.0.0.1", 9161, "a b&c")).toBe("http://127.0.0.1:9161/#k=a%20b%26c");
  });
  it("treats an empty token as no token", () => {
    expect(webUrl("127.0.0.1", 9161, "")).toBe("http://127.0.0.1:9161");
  });
});
