import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, resolveCloudflareAccess } from "./config.js";

const TEAM_ENV = "TORLINK_CF_ACCESS_TEAM_DOMAIN";
const AUD_ENV = "TORLINK_CF_ACCESS_AUD";

describe("resolveCloudflareAccess", () => {
  beforeEach(() => {
    vi.stubEnv(TEAM_ENV, "");
    vi.stubEnv(AUD_ENV, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns null when nothing is configured", () => {
    expect(resolveCloudflareAccess({ ...defaultConfig })).toBeNull();
  });

  it("returns null when only one half is set", () => {
    expect(resolveCloudflareAccess({ ...defaultConfig, cfAccessTeamDomain: "t.cloudflareaccess.com" })).toBeNull();
    expect(resolveCloudflareAccess({ ...defaultConfig, cfAccessAud: "aud" })).toBeNull();
  });

  it("reads both halves from config", () => {
    const res = resolveCloudflareAccess({
      ...defaultConfig,
      cfAccessTeamDomain: "t.cloudflareaccess.com",
      cfAccessAud: "aud-1",
    });
    expect(res).toEqual({ teamDomain: "t.cloudflareaccess.com", aud: "aud-1" });
  });

  it("lets env vars win over config", () => {
    vi.stubEnv(TEAM_ENV, "env.cloudflareaccess.com");
    vi.stubEnv(AUD_ENV, "env-aud");
    const res = resolveCloudflareAccess({
      ...defaultConfig,
      cfAccessTeamDomain: "file.cloudflareaccess.com",
      cfAccessAud: "file-aud",
    });
    expect(res).toEqual({ teamDomain: "env.cloudflareaccess.com", aud: "env-aud" });
  });
});
