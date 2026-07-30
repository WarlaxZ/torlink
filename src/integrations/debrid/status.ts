import type { DebridStatus } from "./types";

// At or below this many days left, the header badge nudges the user.
const EXPIRY_WARN_DAYS = 14;

/** Whole days from `now` until `date`, rounded up, floored at 0. */
export function daysUntil(date: Date, now: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 86_400_000));
}

export function expiringSoon(status: DebridStatus, now: Date): boolean {
  return !!status.expiresAt && daysUntil(status.expiresAt, now) <= EXPIRY_WARN_DAYS;
}

/** One-line account state for the token prompt and the accounts pane. */
export function formatAccountStatus(status: DebridStatus | null, now: Date): string {
  if (!status) return "not connected";
  if (!status.active) return `${status.planLabel} account`;
  if (status.expiresAt) return `${status.planLabel} · ${daysUntil(status.expiresAt, now)}d left`;
  return status.planLabel;
}
