import { isPremiumActive, type RealDebridUser } from "./realdebrid";

// At or below this many days of premium left, the header badge nudges the user.
const EXPIRY_WARN_DAYS = 14;

// A compact, render-ready view of the connected Real-Debrid account.
export interface RdStatus {
  username: string;
  premium: boolean;
  // When premium, the best estimate of when it lapses; null when free/expired.
  premiumUntil: Date | null;
}

export function rdStatusFromUser(user: RealDebridUser, now: Date): RdStatus {
  const premium = isPremiumActive(user);
  let premiumUntil: Date | null = null;
  if (premium) {
    const fromSeconds = new Date(now.getTime() + (user.premium ?? 0) * 1000);
    if (user.expiration) {
      const parsed = new Date(user.expiration);
      premiumUntil = Number.isNaN(parsed.getTime()) ? fromSeconds : parsed;
    } else {
      premiumUntil = fromSeconds;
    }
  }
  return { username: user.username, premium, premiumUntil };
}

// Whole days from `now` until `date`, rounded up, floored at 0.
export function daysUntil(date: Date, now: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 86_400_000));
}

export function premiumExpiringSoon(status: RdStatus, now: Date): boolean {
  return !!status.premiumUntil && daysUntil(status.premiumUntil, now) <= EXPIRY_WARN_DAYS;
}

// One-line account state for the token prompt.
export function formatAccountStatus(status: RdStatus | null, now: Date): string {
  if (!status) return "not connected";
  if (!status.premium) return "free account";
  if (status.premiumUntil) return `premium · ${daysUntil(status.premiumUntil, now)}d left`;
  // Defensive: premium accounts always have premiumUntil set above; this guards the type.
  return "premium";
}
