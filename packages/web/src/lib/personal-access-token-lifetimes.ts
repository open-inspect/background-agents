/** The lifetimes a token can be given when it is issued, in Settings or at an app's sign-in. */

const LIFETIME_DAYS = [7, 30, 90, 180, 365] as const;

/** The lifetime offered first, when the policy allows it. */
export const DEFAULT_LIFETIME_DAYS = 30;

/** The lifetimes on offer under a cap: the standard choices within it, and the cap itself. */
export function lifetimeChoices(maxLifetimeDays: number): number[] {
  const within = LIFETIME_DAYS.filter((days) => days <= maxLifetimeDays);
  return within.includes(maxLifetimeDays as (typeof LIFETIME_DAYS)[number])
    ? within
    : [...within, maxLifetimeDays];
}

/** `days` when it is on offer; otherwise the longest choice under it, or else the shortest. */
export function fitLifetime(days: number, lifetimes: readonly number[]): number {
  if (lifetimes.includes(days)) return days;
  return lifetimes.filter((choice) => choice <= days).at(-1) ?? lifetimes[0] ?? days;
}

export function lifetimeLabel(days: number): string {
  if (days === 365) return "1 year";
  return days === 1 ? "1 day" : `${days} days`;
}
