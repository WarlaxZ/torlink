import { describe, expect, it } from "vitest";
import { OWNER_PROFILE, isOwnerProfile, resolveProfileId, slugForEmail } from "./profile";

describe("resolveProfileId", () => {
  it("returns the owner profile when no email is present", () => {
    expect(resolveProfileId(undefined, "owner@example.com")).toBe(OWNER_PROFILE);
    expect(resolveProfileId(null, "owner@example.com")).toBe(OWNER_PROFILE);
    expect(resolveProfileId("", "owner@example.com")).toBe(OWNER_PROFILE);
  });

  it("returns the owner profile when no owner email is configured (fail-soft)", () => {
    expect(resolveProfileId("friend@example.com", undefined)).toBe(OWNER_PROFILE);
  });

  it("maps the owner's own email to the owner profile, case-insensitively", () => {
    expect(resolveProfileId("Owner@Example.com", "owner@example.com")).toBe(OWNER_PROFILE);
  });

  it("maps a friend to a stable non-owner slug", () => {
    const a = resolveProfileId("friend@example.com", "owner@example.com");
    const b = resolveProfileId("friend@example.com", "owner@example.com");
    expect(a).toBe(b);
    expect(a).not.toBe(OWNER_PROFILE);
    expect(isOwnerProfile(a)).toBe(false);
  });

  it("gives distinct, filesystem-safe slugs to distinct emails that differ only in a separator", () => {
    const a = slugForEmail("a.b@example.com");
    const b = slugForEmail("a_b@example.com");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-f0-9]+$/);
    expect(b).toMatch(/^[a-f0-9]+$/);
  });
});
