/**
 * Time of day without a server. Every peer's wall clock is already within a second or so of everyone else's,
 * so the day is just the wall clock divided into days: nobody has to own it, send it, or hand it over.
 * Long-lived timestamps in replicated state (crops, fires, stumps) use the same wall-clock seconds.
 */

/** A whole day and night, in seconds. */
export const DAY_SECONDS = 480;

/** Time of day at a wall-clock second: 0 is midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
export function dayTime(wall: number): number {
  const t = wall / DAY_SECONDS;
  return t - Math.floor(t);
}

/** The sun's height: 1 at noon, -1 at midnight. */
export function sunHeight(time: number): number {
  return Math.sin((time - 0.25) * Math.PI * 2);
}

/** How light it is, from 0 in the dead of night to 1 in full day, easing through dawn and dusk. */
export function daylight(time: number): number {
  const t = Math.min(1, Math.max(0, (sunHeight(time) + 0.12) / 0.37));
  return t * t * (3 - 2 * t);
}

/** Wolves are out and the cold bites. */
export function isNight(time: number): boolean {
  return daylight(time) < 0.25;
}

/** "Dawn", "Noon"... for the HUD. */
export function timeName(time: number): string {
  const h = time * 24;
  if (h < 5) return 'Night';
  if (h < 7.5) return 'Dawn';
  if (h < 11) return 'Morning';
  if (h < 14) return 'Noon';
  if (h < 17) return 'Afternoon';
  if (h < 19.5) return 'Dusk';
  return 'Night';
}

/** The local clock's offset from the wall clock, to pin the time of day for testing (`?hour=21`). Only this peer sees it. */
export function hourOffset(hour: number | null, wall: number): number {
  if (hour === null || !Number.isFinite(hour)) return 0;
  return ((hour / 24 - dayTime(wall) + 1) % 1) * DAY_SECONDS;
}
