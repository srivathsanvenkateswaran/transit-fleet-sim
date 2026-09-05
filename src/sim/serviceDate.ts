/**
 * The GTFS-style `YYYYMMDD` calendar date of an instant, in a given time zone.
 *
 * This was two identical private functions - one in `duty.ts`, one in
 * `world.ts` - before intercity duties made the duplication worth ending.
 * Both call sites used it as a way to name "today" for a seeded draw's key,
 * and both fed it the wrong instant: see `createDutyState`'s call site in
 * `SimWorld`'s constructor, which is exactly what section 3.1 of
 * `docs/intercity-coaches.md` is about. This function is not the fix; it is
 * the one place the fix's ingredient now lives, so the two call sites cannot
 * quietly drift back apart.
 */
export function serviceDate(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}${value('month')}${value('day')}`
}
