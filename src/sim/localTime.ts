/**
 * Local-time arithmetic for a roster that crosses midnight.
 *
 * `src/sim/metro.ts` already carries private copies of the first three of
 * these. They are not reached into from here and it is not changed: a
 * headway table and a corridor roster want the same conversions for
 * different reasons, and merging them would put a metro change one edit away
 * from a coach regression. What is genuinely new is `gtfsTimeFromOffset`,
 * which is the whole of docs/intercity-coaches.md §3.3 in one function.
 */

/** GTFS `YYYYMMDD` for an instant, in a zone. */
export function localDayCompact(at: Date, timezone: string): string {
  const parts = localParts(at, timezone)
  return `${parts.year}${parts.month}${parts.day}`
}

/** ISO `YYYY-MM-DD` for an instant, in a zone. */
export function localDayIso(at: Date, timezone: string): string {
  const parts = localParts(at, timezone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** The instant at which a given local wall time occurs on a given local day. */
export function localInstant(dayIso: string, timeHhMm: string, timezone: string): Date {
  const tentative = new Date(`${dayIso}T${padTime(timeHhMm)}.000Z`)
  const desired = minutesOfDay(timeHhMm)
  const observed = localMinutesOfDay(tentative, timezone)
  return new Date(tentative.getTime() + (desired - observed) * 60_000)
}

/** `YYYYMMDD` to `YYYY-MM-DD`, and back. Both forms are on the wire (§10.3). */
export function compactToIso(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}

export function isoToCompact(iso: string): string {
  return iso.replaceAll('-', '')
}

/** `YYYY-MM-DD` shifted by whole days, staying a calendar date rather than an instant. */
export function shiftIsoDay(iso: string, days: number): string {
  const shifted = new Date(`${iso}T12:00:00.000Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

/**
 * docs/intercity-coaches.md §3.3: "a corridor's stands after midnight
 * routinely [carry times past 24:00:00] (`30:15:00` for a 06:15 arrival on a
 * 22:59 departure's service date)."
 *
 * A GTFS time is measured from noon minus twelve hours of the *service* date,
 * so an arrival the morning after a late departure is `24:00:00` or later and
 * is not wrapped. Everything here takes an offset in seconds from that
 * origin, which is what makes the overflow fall out rather than needing a
 * special case: `30:30:00` is simply 109,800 seconds, formatted.
 */
export function gtfsTimeFromSeconds(secondsFromServiceDateStart: number): string {
  const total = Math.max(0, Math.round(secondsFromServiceDateStart))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Seconds from local midnight for an `HH:MM` or `HH:MM:SS` wall time. */
export function secondsOfDay(time: string): number {
  const [hours = '0', minutes = '0', seconds = '0'] = time.split(':')
  return Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

function minutesOfDay(time: string): number {
  return Math.floor(secondsOfDay(time) / 60)
}

function localMinutesOfDay(at: Date, timezone: string): number {
  const parts = localParts(at, timezone)
  return Number(parts.hour) * 60 + Number(parts.minute)
}

function padTime(time: string): string {
  const [hours = '00', minutes = '00', seconds = '00'] = time.split(':')
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}`
}

function localParts(at: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  )
}
