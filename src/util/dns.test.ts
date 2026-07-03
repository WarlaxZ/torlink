import { describe, it, expect } from "vitest";
import { parseDnsServers, dohEndpoint } from "./dns";

describe("parseDnsServers", () => {
  it("returns nothing for empty/undefined input", () => {
    expect(parseDnsServers(undefined)).toEqual([]);
    expect(parseDnsServers("")).toEqual([]);
    expect(parseDnsServers("  ,  ")).toEqual([]);
  });

  it("passes through raw IPv4/IPv6 addresses, trimmed", () => {
    expect(parseDnsServers("1.1.1.1")).toEqual(["1.1.1.1"]);
    expect(parseDnsServers(" 8.8.8.8 , 8.8.4.4 ")).toEqual(["8.8.8.8", "8.8.4.4"]);
    expect(parseDnsServers("2606:4700:4700::1111")).toEqual(["2606:4700:4700::1111"]);
  });

  it("expands known aliases (case-insensitive)", () => {
    expect(parseDnsServers("cloudflare")).toEqual(["1.1.1.1", "1.0.0.1"]);
    expect(parseDnsServers("Google")).toEqual(["8.8.8.8", "8.8.4.4"]);
    expect(parseDnsServers("QUAD9")).toEqual(["9.9.9.9", "149.112.112.112"]);
  });

  it("mixes aliases and raw IPs", () => {
    expect(parseDnsServers("cloudflare,9.9.9.9")).toEqual(["1.1.1.1", "1.0.0.1", "9.9.9.9"]);
  });
});

describe("dohEndpoint", () => {
  it("uses Google's /resolve path for Google IPs and /dns-query for the rest", () => {
    expect(dohEndpoint("8.8.8.8")).toBe("https://8.8.8.8/resolve");
    expect(dohEndpoint("8.8.4.4")).toBe("https://8.8.4.4/resolve");
    expect(dohEndpoint("1.1.1.1")).toBe("https://1.1.1.1/dns-query");
    expect(dohEndpoint("9.9.9.9")).toBe("https://9.9.9.9/dns-query");
  });
});
