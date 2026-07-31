import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_RECC_URL, shouldProvision } from "./provision";
import { defaultConfig, type Config } from "../config/config";

const base = (over: Partial<Config> = {}): Config => ({ ...defaultConfig, downloadDir: "/tmp/dl", ...over });

describe("shouldProvision", () => {
  beforeEach(() => {
    // resolveReccConfig reads these, and a developer may well have them
    // exported -- without stubbing, half these cases pass by accident.
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  it("is true on a fresh install with nothing configured", () => {
    expect(shouldProvision(base())).toBe(true);
  });

  it("is false once a token exists — the account is already there", () => {
    expect(shouldProvision(base({ reccToken: "tok" }))).toBe(false);
  });

  it("is false when TORLINK_RECC_TOKEN supplies the token", () => {
    vi.stubEnv("TORLINK_RECC_TOKEN", "from-env");
    expect(shouldProvision(base())).toBe(false);
  });

  // The case that matters: a self-hosted reccd is not ours to sign up against,
  // and signing up against reccd.stream instead would ignore what the user set.
  it("is false for a self-hosted reccUrl with no token", () => {
    expect(shouldProvision(base({ reccUrl: "http://192.168.0.98:4100" }))).toBe(false);
  });

  it("is false for a self-hosted TORLINK_RECC_URL with no token", () => {
    vi.stubEnv("TORLINK_RECC_URL", "http://192.168.0.98:4100");
    expect(shouldProvision(base())).toBe(false);
  });

  // The hand-setup user who typed the host and left the token blank. Signing
  // them up against the host they already named is what they were trying to do.
  it("is true when reccUrl is already the default host but no token is set", () => {
    expect(shouldProvision(base({ reccUrl: DEFAULT_RECC_URL }))).toBe(true);
  });

  it("tolerates a trailing slash on the configured default host", () => {
    expect(shouldProvision(base({ reccUrl: `${DEFAULT_RECC_URL}/` }))).toBe(true);
  });

  it("is false when the user has opted out", () => {
    expect(shouldProvision(base({ reccAutoSignup: false }))).toBe(false);
  });

  it("is true when reccAutoSignup is explicitly true", () => {
    expect(shouldProvision(base({ reccAutoSignup: true }))).toBe(true);
  });

  // config.json is hand-editable and this is the only field here whose absent
  // state means ON, so a junk value must fail safe towards NOT signing up. A
  // user who wrote "no" meant no. `as unknown as Config` because these are
  // exactly the values TypeScript would stop a caller writing — the point is
  // that a text editor does not typecheck.
  it.each([["no"], ["false"], [0], [null], [""], [1], ["yes"]])(
    "does not sign up when reccAutoSignup is the junk value %p",
    (value) => {
      const cfg = { ...base(), reccAutoSignup: value } as unknown as Config;
      expect(shouldProvision(cfg)).toBe(false);
    },
  );
});
