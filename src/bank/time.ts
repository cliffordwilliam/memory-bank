// Wall-clock times with an offset, e.g. "2026-10-15T21:00:00+07:00" (spec §8).
// Claude's text is stored verbatim; the database derives the UTC copy. These
// helpers check the text strictly (SQLite would quietly roll "2026-02-30" over
// to March 2) and compute the same UTC moment for filters and the future check.

const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/** Real-world offsets run from -12:00 to +14:00. */
const MAX_OFFSET_MINUTES = 14 * 60;

/** SQLite's date functions only cover these UTC moments (0000-01-01 to 9999-12-31). */
const MIN_MILLIS = utcMillis(0, 0, 1);
const MAX_MILLIS = utcMillis(10_000, 0, 1) - 1;

export const WALL_CLOCK_EXAMPLE = "2026-10-12T21:00:00+07:00";

/**
 * The moment a wall-clock time stands for, in milliseconds since the epoch,
 * or null if the text isn't a real date and time with an offset.
 */
export function wallClockToMillis(text: string): number | null {
  const m = WALL_CLOCK.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "0", frac = "", z, sign, oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;

  // Reject days the month doesn't have (Feb 30, Apr 31, Feb 29 in 2027).
  const daysInMonth = new Date(utcMillis(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;

  let offsetMinutes = 0;
  if (!z) {
    if (Number(om) > 59) return null;
    offsetMinutes = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
    if (offsetMinutes < -12 * 60 || offsetMinutes > MAX_OFFSET_MINUTES) return null;
  }

  const millis = frac ? Math.floor(Number(`0${frac}`) * 1000) : 0;
  const moment = utcMillis(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
  if (moment < MIN_MILLIS || moment > MAX_MILLIS) return null;
  return moment;
}

/** Like Date.UTC, but without its mapping of years 0–99 to 1900–1999. */
function utcMillis(year: number, monthIndex: number, day: number, hour = 0, minute = 0, second = 0, millis = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime();
}

/** The same UTC text format the database uses for occurred_at_utc. */
export function millisToUtcText(millis: number): string {
  return new Date(millis).toISOString();
}
