import { readFile } from 'node:fs/promises'
import type { Corridor, CorridorStand, StandKind } from '../geometry/corridorTopology.js'
import type { ServiceClass } from '../fleet/serviceClass.js'
import {
  compactToIso,
  gtfsTimeFromSeconds,
  isoToCompact,
  localDayIso,
  localInstant,
  secondsOfDay,
  shiftIsoDay,
} from './localTime.js'
import { rand } from './rand.js'

/**
 * The multi-day roster - docs/intercity-coaches.md §3.5 and §11.3.
 *
 * `dispatchInitialFleet` places `BUSES_PER_ROUTE` vehicles evenly around a
 * round trip at process start. For a coach that is not a simplification, it
 * is the wrong object: "A corridor has one to three departures a day per
 * direction at named clock times on named dates." So dispatch becomes a
 * calendar, the fleet size falls out of the roster rather than being
 * configured, and the world holds two collections rather than one - `#roster`
 * (every duty in the window, read on lookup) and `#active` (dispatched and
 * not yet arrived, iterated every tick).
 *
 * Everything in this file is a pure function of the roster file, the
 * corridor geometry, the seed and a window of service dates. Nothing here
 * reads a clock except through the `at` it is handed, which is what lets
 * criterion 60 start two processes on different calendar days and get the
 * same answer.
 */

export interface RosterDeparture {
  readonly serviceId: string
  readonly number: string
  readonly headsign: string
  /**
   * A GTFS-style time measured from its own service date's local midnight,
   * and it may exceed 24 hours (§3.3). `24:30` is a departure at 00:30 the
   * following calendar morning, filed - correctly - under the previous
   * service date.
   */
  readonly departureTime: string
  readonly serviceClass: string
  readonly hub: string
  readonly corporation: string
  readonly confidence: string
  /**
   * ISO weekday numbers of the **service date** this departure runs on,
   * 1 for Monday through 7 for Sunday. Absent means every day.
   *
   * Not a calendar in the GTFS sense - there is no `calendar_dates.txt` here
   * and no exception mechanism - but enough for the one thing a roster has to
   * be able to express and this fixture would otherwise not: a service that
   * exists and does not run today. Without it `duty_not_scheduled` would be
   * an error string in the taxonomy with no reachable producer.
   */
  readonly runsOn?: readonly number[]
  readonly note?: string
}

export interface RosterCorridor {
  readonly corridorId: string
  readonly departures: readonly RosterDeparture[]
}

export interface CorridorRosterFile {
  readonly note: string
  readonly provenance: { readonly departures: string; readonly stands: string }
  readonly corridors: readonly RosterCorridor[]
}

/** One stand's scheduled call, as the static feed would carry it. */
export interface ScheduledCall {
  readonly stand: CorridorStand
  readonly sequence: number
  /** Seconds from the service date's local midnight. May exceed 86,400. */
  readonly arrivalSeconds: number
  readonly departureSeconds: number
  /** GTFS `HH:MM:SS`, past `24:00:00` for a stand reached after midnight. */
  readonly arrivalTime: string
  readonly departureTime: string
  readonly scheduledDwellSeconds: number
}

export interface CoachDuty {
  /** `BNG-HSP-20260905-2259`. This service's own composite id. */
  readonly id: string
  readonly corridorId: string
  readonly serviceId: string
  readonly number: string
  readonly headsign: string
  /** GTFS `YYYYMMDD`. Explicit, carried, never derived from an instant (§3.2). */
  readonly serviceDate: string
  /** ISO `YYYY-MM-DD` of the calendar day the coach actually pulls out. */
  readonly travelDate: string
  readonly serviceClassId: string
  readonly hub: string
  readonly corporation: string
  readonly departureAt: Date
  readonly scheduledArrivalAt: Date
  /** GTFS `start_time`, noon-relative, possibly past `24:00:00`. */
  readonly startTime: string
  readonly calls: readonly ScheduledCall[]
  readonly provenance: string
}

export interface RosterWindow {
  readonly from: string
  readonly to: string
  readonly serviceDates: readonly string[]
}

export interface ScheduleProfile {
  readonly timezone: string
  readonly highwayKph: number
  readonly urbanKph: number
  readonly dwellSecondsByKind: Readonly<Record<StandKind, number>>
}

export async function loadCorridorRoster(
  path: string,
  corridorIds: readonly string[],
): Promise<CorridorRosterFile> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as CorridorRosterFile
  validateCorridorRoster(raw, corridorIds)
  return raw
}

export function validateCorridorRoster(
  roster: CorridorRosterFile,
  corridorIds: readonly string[],
): void {
  const rostered = new Set(roster.corridors.map((corridor) => corridor.corridorId))
  const missing = corridorIds.filter((id) => !rostered.has(id))
  if (missing.length > 0) {
    throw new Error(`INTERCITY_CORRIDORS names corridors with no roster entry: ${missing.join(', ')}`)
  }
  const seen = new Set<string>()
  for (const corridor of roster.corridors) {
    for (const departure of corridor.departures) {
      const key = `${corridor.corridorId}|${departure.serviceId}`
      if (seen.has(key)) {
        throw new Error(`Corridor ${corridor.corridorId} rosters service ${departure.serviceId} twice`)
      }
      seen.add(key)
      if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(departure.departureTime)) {
        throw new Error(
          `Corridor ${corridor.corridorId} service ${departure.serviceId} has a departure time that is not HH:MM: ${departure.departureTime}`,
        )
      }
    }
  }
}

/**
 * §12.1: `INTERCITY_ROSTER_DAYS` service days held at once, at least two.
 *
 * The window opens one service day behind the current one, because that is
 * the day whose 22:59 departure is still on the road at 03:00 - the whole
 * reason a coach roster cannot be a single day. Open question 8 asks whether
 * the window should instead be keyed on the longest duty in the fixture; a
 * fixed count is the cheaper answer and the one §12.1 states, and the boundary
 * it creates is exercised by criteria 64 and 65 rather than assumed away.
 */
export function rosterWindowFor(at: Date, days: number, timezone: string): RosterWindow {
  const today = localDayIso(at, timezone)
  const fromIso = shiftIsoDay(today, -1)
  const serviceDates: string[] = []
  for (let offset = 0; offset < days; offset += 1) {
    serviceDates.push(isoToCompact(shiftIsoDay(fromIso, offset)))
  }
  return {
    from: serviceDates[0]!,
    to: serviceDates.at(-1)!,
    serviceDates,
  }
}

/** §10.7's new `503`: a process whose roster ran out yesterday is not ready. */
export function windowContains(window: RosterWindow, serviceDate: string): boolean {
  return serviceDate >= window.from && serviceDate <= window.to
}

export function buildRoster(
  corridors: readonly Corridor[],
  roster: CorridorRosterFile,
  window: RosterWindow,
  profile: ScheduleProfile,
): readonly CoachDuty[] {
  const corridorById = new Map(corridors.map((corridor) => [corridor.id, corridor]))
  const duties: CoachDuty[] = []
  for (const rosterCorridor of roster.corridors) {
    const corridor = corridorById.get(rosterCorridor.corridorId)
    if (corridor === undefined) continue
    const calls = scheduleCalls(corridor, profile)
    for (const serviceDate of window.serviceDates) {
      for (const departure of rosterCorridor.departures) {
        if (!runsOnServiceDate(departure, serviceDate)) continue
        duties.push(dutyFor(corridor, departure, serviceDate, calls, profile))
      }
    }
  }
  return duties.sort((a, b) => a.departureAt.getTime() - b.departureAt.getTime() || a.id.localeCompare(b.id))
}

/**
 * The scheduled call at every stand, as offsets from the departure.
 *
 * The schedule falls out of the geometry and the configured means rather than
 * being authored beside the departure time, and that is deliberate: a
 * hand-written arrival time would be a second, independent claim about a
 * corridor this service has already measured, and the two would drift. The
 * speeds are per segment kind (§12.6) because "one mean across both kinds is
 * what would make a 340 km run come out ninety minutes wrong".
 */
export function scheduleCalls(
  corridor: Corridor,
  profile: ScheduleProfile,
): readonly Omit<ScheduledCall, 'arrivalTime' | 'departureTime'>[] {
  const kindByPair = new Map(
    corridor.segments.map((segment) => [`${segment.fromStandId}|${segment.toStandId}`, segment.kind]),
  )
  const calls: Omit<ScheduledCall, 'arrivalTime' | 'departureTime'>[] = []
  let cursorSeconds = 0
  for (let index = 0; index < corridor.stands.length; index += 1) {
    const stand = corridor.stands[index]!
    const previous = corridor.stands[index - 1]
    if (previous !== undefined) {
      const kind = kindByPair.get(`${previous.id}|${stand.id}`) ?? 'highway'
      const kph = kind === 'urban' ? profile.urbanKph : profile.highwayKph
      cursorSeconds += ((stand.distanceMetres - previous.distanceMetres) / 1_000 / kph) * 3_600
    }
    const arrivalSeconds = cursorSeconds
    // The origin is a departure, not a call: a coach does not arrive at the
    // stand it starts from, and the boarding dwell there is time before the
    // published departure rather than after it.
    const dwell = index === 0 || stand.kind === 'terminal' ? 0 : profile.dwellSecondsByKind[stand.kind]
    cursorSeconds += dwell
    calls.push({
      stand,
      sequence: index + 1,
      arrivalSeconds,
      departureSeconds: cursorSeconds,
      scheduledDwellSeconds: dwell,
    })
  }
  return calls
}

/** Sunday is 7 here rather than 0, matching ISO 8601 and the roster file. */
function runsOnServiceDate(departure: RosterDeparture, serviceDate: string): boolean {
  if (departure.runsOn === undefined) return true
  const day = new Date(`${compactToIso(serviceDate)}T12:00:00.000Z`).getUTCDay()
  return departure.runsOn.includes(day === 0 ? 7 : day)
}

function dutyFor(
  corridor: Corridor,
  departure: RosterDeparture,
  serviceDate: string,
  calls: readonly Omit<ScheduledCall, 'arrivalTime' | 'departureTime'>[],
  profile: ScheduleProfile,
): CoachDuty {
  const departureOffsetSeconds = secondsOfDay(departure.departureTime)
  const serviceDateMidnight = localInstant(compactToIso(serviceDate), '00:00', profile.timezone)
  const departureAt = new Date(serviceDateMidnight.getTime() + departureOffsetSeconds * 1_000)
  const runSeconds = calls.at(-1)?.arrivalSeconds ?? 0
  const timedCalls: ScheduledCall[] = calls.map((call) => ({
    ...call,
    arrivalTime: gtfsTimeFromSeconds(departureOffsetSeconds + call.arrivalSeconds),
    departureTime: gtfsTimeFromSeconds(departureOffsetSeconds + call.departureSeconds),
  }))
  return {
    id: `${corridor.id}-${serviceDate}-${departure.departureTime.replace(':', '').slice(0, 4)}`,
    corridorId: corridor.id,
    serviceId: departure.serviceId,
    number: departure.number,
    headsign: departure.headsign,
    serviceDate,
    travelDate: localDayIso(departureAt, profile.timezone),
    serviceClassId: departure.serviceClass,
    hub: departure.hub,
    corporation: departure.corporation,
    departureAt,
    scheduledArrivalAt: new Date(departureAt.getTime() + runSeconds * 1_000),
    startTime: gtfsTimeFromSeconds(departureOffsetSeconds),
    calls: timedCalls,
    provenance: departure.confidence,
  }
}

/* ------------------------------------------------------------------ *
 * Assignment  (§10.3, §12.5)
 * ------------------------------------------------------------------ */

export type AssignmentStatus = 'assigned' | 'not_yet_assigned' | 'superseded'

export interface Assignment {
  readonly dutyId: string
  readonly bin: string
  readonly status: 'assigned' | 'superseded'
  readonly previousBin: string | null
  readonly supersededAt: Date | null
}

export interface AssignmentPoolMember {
  readonly bin: string
  readonly corridorId: string
  readonly serviceClassId: string
}

/**
 * `bin = f(seed, corridor, serviceId, serviceDate)`, and nothing else.
 *
 * §10.3 is precise about what the assignment horizon does and does not do:
 * "The assignment function is seeded and pure... so the answer three weeks
 * out is perfectly computable. The horizon does not govern whether the answer
 * exists; it governs when the service is willing to state it as a fact about
 * the world." So this function has no `at` parameter at all - the horizon is
 * applied at the endpoint (`dutyLookup`), which is the only place that knows
 * what "now" is, and the two guarantees hold at once instead of being
 * conflated.
 *
 * Assignment walks the pool from a seeded offset and takes the first coach
 * not already committed to an overlapping duty, so two duties in flight at
 * once never name the same vehicle. Because the duty list is sorted and the
 * offset is seeded, that is a pure function of the roster.
 */
export function assignFleet(
  duties: readonly CoachDuty[],
  pool: readonly AssignmentPoolMember[],
  seed: number,
  substitutionRatePerDuty: number,
): ReadonlyMap<string, Assignment> {
  const assignments = new Map<string, Assignment>()
  const busyUntil = new Map<string, number>()
  for (const duty of duties) {
    const candidates = pool.filter(
      (member) => member.corridorId === duty.corridorId && member.serviceClassId === duty.serviceClassId,
    )
    if (candidates.length === 0) continue
    const offset = Math.floor(rand(seed, duty.id, 'assignment', 0) * candidates.length)
    const first = pick(candidates, offset, duty.departureAt.getTime(), busyUntil)
    // §12.5: substitution fires at dispatch only. The rostered coach fails
    // its check, a spare takes the run, and the duty is untouched - which is
    // the mirror image of the bus model's mid-day duty swap, where the
    // vehicle is identical and the duty changed.
    const substituted =
      substitutionRatePerDuty > 0 && rand(seed, duty.id, 'substitution', 0) < substitutionRatePerDuty
    const second = substituted
      ? pick(candidates, offset + 1, duty.departureAt.getTime(), busyUntil, first.bin)
      : null
    const chosen = second ?? first
    busyUntil.set(chosen.bin, duty.scheduledArrivalAt.getTime())
    assignments.set(duty.id, {
      dutyId: duty.id,
      bin: chosen.bin,
      status: second === null ? 'assigned' : 'superseded',
      previousBin: second === null ? null : first.bin,
      supersededAt: second === null ? null : duty.departureAt,
    })
  }
  return assignments
}

function pick(
  candidates: readonly AssignmentPoolMember[],
  offset: number,
  departureMs: number,
  busyUntil: ReadonlyMap<string, number>,
  exclude?: string,
): AssignmentPoolMember {
  for (let step = 0; step < candidates.length; step += 1) {
    const candidate = candidates[(offset + step + candidates.length * 2) % candidates.length]!
    if (candidate.bin === exclude) continue
    if ((busyUntil.get(candidate.bin) ?? Number.NEGATIVE_INFINITY) <= departureMs) return candidate
  }
  return candidates[(offset + candidates.length * 2) % candidates.length]!
}

/**
 * How many coaches a corridor's class actually needs, derived from the
 * roster rather than configured - §3.5: "`BUSES_PER_ROUTE` does not apply and
 * the fleet size falls out of the roster rather than being configured, which
 * is how an operator thinks about it."
 *
 * Peak concurrency plus one spare, because §12.5's substitution needs
 * somewhere to substitute from and a pool with no slack would substitute a
 * coach for itself.
 */
export function poolSizeFor(duties: readonly CoachDuty[]): number {
  const events = duties
    .flatMap((duty) => [
      { at: duty.departureAt.getTime(), delta: 1 },
      { at: duty.scheduledArrivalAt.getTime(), delta: -1 },
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta)
  let concurrent = 0
  let peak = 0
  for (const event of events) {
    concurrent += event.delta
    peak = Math.max(peak, concurrent)
  }
  return peak + 1
}

/** §11.3's `#active`: dispatched and not yet arrived, at this instant. */
export function activeAt(duties: readonly CoachDuty[], at: Date): readonly CoachDuty[] {
  const ms = at.getTime()
  return duties.filter(
    (duty) => duty.departureAt.getTime() <= ms && duty.scheduledArrivalAt.getTime() > ms,
  )
}

export function serviceClassOf(
  classes: readonly ServiceClass[],
  id: string,
): ServiceClass | null {
  return classes.find((serviceClass) => serviceClass.id === id) ?? null
}

