// Front-end-agnostic profile identity. A "profile" is the container for the four
// per-user lists (watch history, favourites, saved searches, reccd account). Which
// profile a web request uses is derived from the Cloudflare Access email; the TUI
// and any non-Access request use the owner profile. Lives in src/core because both
// front ends resolve it and eslint forbids src/web importing src/ui.
import { createHash } from "node:crypto";

/**
 * The reserved id for the server owner — the existing top-level config fields and
 * stream-history.json. Not a hex slug, so it can never collide with slugForEmail.
 */
export const OWNER_PROFILE = "owner";

/**
 * A stable, collision-free, filesystem-safe id for a friend's email. A hash rather
 * than a sanitised string precisely so `a.b@x` and `a_b@x` cannot merge into one
 * profile — a lossy strip of unsafe characters would let them. 128 bits is ample.
 */
export function slugForEmail(email: string): string {
  const normalised = email.trim().toLowerCase();
  return createHash("sha256").update(normalised).digest("hex").slice(0, 32);
}

/**
 * The profile a request belongs to. Fails soft to the owner: no email, no configured
 * owner, or the owner's own email all resolve to OWNER_PROFILE, so torlink behaves
 * exactly as it does today until an owner email is set and a *different* user signs in.
 */
export function resolveProfileId(
  email: string | null | undefined,
  ownerEmail: string | undefined,
): string {
  const e = email?.trim().toLowerCase();
  if (!e) return OWNER_PROFILE;
  const owner = ownerEmail?.trim().toLowerCase();
  if (!owner) return OWNER_PROFILE;
  if (e === owner) return OWNER_PROFILE;
  return slugForEmail(e);
}

export function isOwnerProfile(profileId: string): boolean {
  return profileId === OWNER_PROFILE;
}
