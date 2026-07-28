import { describe, it, expect } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { isAuthorized, hostHeaderOk, isCrossSiteRequest, isCrossSiteHttpRequest } from "./auth";

describe("isAuthorized", () => {
  it("is open when no token is configured", () => {
    expect(isAuthorized(null, undefined)).toBe(true);
  });
  it("accepts a matching bearer token or raw token", () => {
    expect(isAuthorized("s3cret", "Bearer s3cret")).toBe(true);
    expect(isAuthorized("s3cret", "s3cret")).toBe(true);
  });
  it("rejects a missing, wrong, or different-length token", () => {
    expect(isAuthorized("s3cret", undefined)).toBe(false);
    expect(isAuthorized("s3cret", "Bearer nope")).toBe(false);
    expect(isAuthorized("s3cret", "s3cret-plus-suffix")).toBe(false);
    expect(isAuthorized("s3cret", "s3cre")).toBe(false);
  });
});

describe("hostHeaderOk", () => {
  it("accepts loopback hosts with or without a port", () => {
    expect(hostHeaderOk("127.0.0.1")).toBe(true);
    expect(hostHeaderOk("127.0.0.1:9161")).toBe(true);
    expect(hostHeaderOk("localhost:9160")).toBe(true);
    expect(hostHeaderOk("LOCALHOST")).toBe(true);
    expect(hostHeaderOk("[::1]:9161")).toBe(true);
    expect(hostHeaderOk("[::1]")).toBe(true);
  });
  it("rejects external names and addresses (DNS rebinding)", () => {
    expect(hostHeaderOk("attacker.example")).toBe(false);
    expect(hostHeaderOk("attacker.example:9161")).toBe(false);
    expect(hostHeaderOk("192.168.1.20:9161")).toBe(false);
    expect(hostHeaderOk("localhost.attacker.example")).toBe(false);
  });
  it("rejects a missing or malformed header", () => {
    expect(hostHeaderOk(undefined)).toBe(false);
    expect(hostHeaderOk("")).toBe(false);
    expect(hostHeaderOk("[::1")).toBe(false);
  });
});

describe("isCrossSiteRequest", () => {
  const HOST = "127.0.0.1:9162";

  // The direction that must keep working. With no token there is no credential
  // to forge, so anything that gets past this is authorized: a cross-origin POST
  // to /api/control {"action":"delete"} would delete the visitor's files.
  it("rejects a request a browser labelled cross-site", () => {
    expect(isCrossSiteRequest({ secFetchSite: "cross-site", host: HOST })).toBe(true);
    expect(isCrossSiteRequest({ origin: "https://evil.example", host: HOST })).toBe(true);
    expect(isCrossSiteRequest({ origin: "https://evil.example", secFetchSite: "cross-site", host: HOST })).toBe(true);
    // Another local page on another port: same host, different origin.
    expect(isCrossSiteRequest({ origin: "http://127.0.0.1:3000", host: HOST })).toBe(true);
    expect(isCrossSiteRequest({ secFetchSite: "same-site", host: HOST })).toBe(true);
    // Opaque origin: a sandboxed iframe or a file:// page.
    expect(isCrossSiteRequest({ origin: "null", host: HOST })).toBe(true);
    expect(isCrossSiteRequest({ origin: "not a url", host: HOST })).toBe(true);
  });

  // The other direction, which matters just as much: the rule is "reject when the
  // headers say cross-site", not "require the headers". curl and scripts send
  // neither, and a loopback POST from a shell is the existing API contract.
  it("allows the dashboard's own fetch and header-less clients", () => {
    expect(isCrossSiteRequest({ origin: `http://${HOST}`, secFetchSite: "same-origin", host: HOST })).toBe(false);
    // Same, without Sec-Fetch-Site (an older browser): Origin matches Host.
    expect(isCrossSiteRequest({ origin: `http://${HOST}`, host: HOST })).toBe(false);
    // curl / a script / a supervisor: no Origin, no Sec-Fetch-Site at all.
    expect(isCrossSiteRequest({ host: HOST })).toBe(false);
    expect(isCrossSiteRequest({})).toBe(false);
    // A typed URL or a bookmark, which cannot be a cross-site POST.
    expect(isCrossSiteRequest({ secFetchSite: "none", host: HOST })).toBe(false);
    // Host names and cases are compared normalised, port included.
    expect(isCrossSiteRequest({ origin: "http://LOCALHOST:9162", host: "localhost:9162" })).toBe(false);
    expect(isCrossSiteRequest({ origin: "http://localhost", host: "localhost" })).toBe(false);
  });

  it("reads node:http headers, taking the first value of a duplicated one", () => {
    expect(isCrossSiteHttpRequest({ host: HOST })).toBe(false);
    expect(isCrossSiteHttpRequest({ origin: `http://${HOST}`, host: HOST })).toBe(false);
    expect(isCrossSiteHttpRequest({ origin: "https://evil.example", host: HOST })).toBe(true);
    expect(isCrossSiteHttpRequest({ "sec-fetch-site": "cross-site", host: HOST })).toBe(true);
    // A smuggled second Origin must not turn into the string "a,b" and land in
    // the unparseable branch by accident — the first value decides.
    const duplicated = { origin: ["https://evil.example", `http://${HOST}`], host: HOST };
    expect(isCrossSiteHttpRequest(duplicated as unknown as IncomingHttpHeaders)).toBe(true);
  });
});
