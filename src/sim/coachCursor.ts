import type { Corridor, SegmentKind, StandKind } from '../geometry/corridorTopology.js'
import { rand } from './rand.js'

/**
 * A coach's cursor along a corridor - docs/intercity-coaches.md §3.4 and §4.
 *
 * Deliberately not `BusCursor`. A city bus runs a GTFS trip on a shape and
 * loops forever; a coach runs a corridor once, past stands of five different
 * kinds, and stops. Sharing one cursor type would have meant either a bus
 * carrying four fields it never sets or a coach's halt kinds leaking into
 * `advanceCursor`, and the existing bus model must behave exactly as it does
 * today (§14.3). So this is a second, smaller cursor over the same
 * `ShapeIndex` machinery, and `src/sim/cursor.ts` is untouched.
 *
 * The two things it knows that a bus's cursor does not:
 *
 *   - **why it is stopped.** §4.1: a consumer seeing a vehicle stationary for
 *     twenty-five minutes at 02:00 has no way to distinguish a scheduled halt
 *     from a breakdown. The service already knows which one it is.
 *   - **what kind of road it is on.** §12.6: one mean across highway and
 *     urban is what would make a 340 km run come out ninety minutes wrong,
 *     because a coach spends about 25 km getting out of Bengaluru at city
 *     speed and the rest on divided highway at nearly four times that.
 */

export interface CoachDwellState {
  readonly kind: StandKind
  readonly standId: string
  readonly standName: string
  readonly startedAtMs: number
  readonly scheduledSeconds: number
  readonly endsAtMs: number
  /**
   * §4.2: "never zero and never omitted". A halt is discretionary and the
   * driver leaves when the last passenger is back on the coach, which is the
   * single largest source of variance on the whole run - so this is the
   * kind's own standard deviation, floored at one second so no configuration
   * can produce the one certain number in a model that has none.
   */
  readonly uncertaintySeconds: number
}

export interface CoachCursor {
  distanceMetres: number
  nextStandIndex: number
  dwell: CoachDwellState | null
  speedKph: number
  segmentKind: SegmentKind
  standVisits: number
  /** §3.4's terminal state: set once, and the cursor never moves again. */
  arrivedAtMs: number | null
}

export type CoachEventKind = 'departed' | 'halt_began' | 'halt_ended' | 'arrived'

export interface CoachEvent {
  readonly kind: CoachEventKind
  readonly atMs: number
  readonly standId: string
  readonly standName: string
  readonly dwellKind: StandKind
}

export interface CoachMotionProfile {
  readonly seed: number
  readonly highwayKphMean: number
  readonly highwayKphSd: number
  readonly highwayKphMin: number
  readonly highwayKphMax: number
  readonly urbanKphMean: number
  readonly urbanKphSd: number
  readonly dwellSecondsMeanByKind: Readonly<Record<StandKind, number>>
  readonly dwellSecondsSdByKind: Readonly<Record<StandKind, number>>
}

export function createCoachCursor(
  corridor: Corridor,
  profile: CoachMotionProfile,
  bin: string,
): CoachCursor {
  const segmentKind = segmentKindAt(corridor, 0)
  return {
    distanceMetres: 0,
    nextStandIndex: 1,
    dwell: null,
    speedKph: drawCoachSpeedKph(profile, bin, 0, segmentKind),
    segmentKind,
    standVisits: 0,
    arrivedAtMs: null,
  }
}

export interface CoachAdvanceResult {
  readonly consumedSeconds: number
  readonly arrived: boolean
  readonly events: readonly CoachEvent[]
}

/**
 * Advance a coach by `elapsedSeconds` of simulated time.
 *
 * Idempotent once arrived, exactly as `advanceOneWay` is: a duty that is over
 * is over, and a caller that keeps ticking it by mistake cannot make it drive
 * again.
 */
export function advanceCoach(
  cursor: CoachCursor,
  corridor: Corridor,
  from: Date,
  elapsedSeconds: number,
  profile: CoachMotionProfile,
  bin: string,
): CoachAdvanceResult {
  if (cursor.arrivedAtMs !== null) return { consumedSeconds: 0, arrived: true, events: [] }
  const events: CoachEvent[] = []
  let remaining = Math.max(0, elapsedSeconds)
  let currentMs = from.getTime()
  const startedWith = remaining

  while (remaining > 1e-9) {
    if (cursor.dwell !== null) {
      if (cursor.dwell.endsAtMs > currentMs) {
        const consumed = Math.min(remaining, (cursor.dwell.endsAtMs - currentMs) / 1_000)
        remaining -= consumed
        currentMs += consumed * 1_000
        if (currentMs < cursor.dwell.endsAtMs) break
      }
      events.push({
        kind: 'halt_ended',
        atMs: cursor.dwell.endsAtMs,
        standId: cursor.dwell.standId,
        standName: cursor.dwell.standName,
        dwellKind: cursor.dwell.kind,
      })
      events.push({
        kind: 'departed',
        atMs: cursor.dwell.endsAtMs,
        standId: cursor.dwell.standId,
        standName: cursor.dwell.standName,
        dwellKind: cursor.dwell.kind,
      })
      cursor.dwell = null
      continue
    }

    const nextStand = corridor.stands[cursor.nextStandIndex]
    const targetDistance = nextStand?.distanceMetres ?? corridor.lengthMetres
    const metresPerSecond = cursor.speedKph / 3.6
    const distanceRemaining = Math.max(0, targetDistance - cursor.distanceMetres)
    const secondsToTarget =
      metresPerSecond === 0 ? Number.POSITIVE_INFINITY : distanceRemaining / metresPerSecond

    if (secondsToTarget > remaining) {
      cursor.distanceMetres += metresPerSecond * remaining
      currentMs += remaining * 1_000
      remaining = 0
      break
    }

    cursor.distanceMetres = targetDistance
    remaining -= secondsToTarget
    currentMs += secondsToTarget * 1_000

    if (nextStand === undefined) {
      cursor.arrivedAtMs = currentMs
      const terminal = corridor.stands.at(-1)
      if (terminal !== undefined) {
        events.push({
          kind: 'arrived',
          atMs: currentMs,
          standId: terminal.id,
          standName: terminal.name,
          dwellKind: 'terminal',
        })
      }
      return { consumedSeconds: startedWith - remaining, arrived: true, events }
    }

    cursor.standVisits += 1
    cursor.nextStandIndex += 1

    if (nextStand.kind === 'terminal') {
      cursor.arrivedAtMs = currentMs
      events.push({
        kind: 'arrived',
        atMs: currentMs,
        standId: nextStand.id,
        standName: nextStand.name,
        dwellKind: 'terminal',
      })
      return { consumedSeconds: startedWith - remaining, arrived: true, events }
    }

    const scheduledSeconds = drawDwellSeconds(profile, bin, cursor.standVisits, nextStand.kind)
    cursor.dwell = {
      kind: nextStand.kind,
      standId: nextStand.id,
      standName: nextStand.name,
      startedAtMs: currentMs,
      scheduledSeconds,
      endsAtMs: currentMs + scheduledSeconds * 1_000,
      uncertaintySeconds: Math.max(1, Math.round(profile.dwellSecondsSdByKind[nextStand.kind])),
    }
    events.push({
      kind: 'halt_began',
      atMs: currentMs,
      standId: nextStand.id,
      standName: nextStand.name,
      dwellKind: nextStand.kind,
    })
    cursor.segmentKind = segmentKindAt(corridor, cursor.nextStandIndex - 1)
    cursor.speedKph = drawCoachSpeedKph(profile, bin, cursor.standVisits, cursor.segmentKind)
  }

  return { consumedSeconds: startedWith - remaining, arrived: false, events }
}

/**
 * §12.6. A highway does not have a rush hour in the sense the bus model's
 * peak factor models, so no peak multiplier is applied here at all - applying
 * a 0.7 factor to a coach on NH-48 at 08:00 would slow it for a reason that
 * is not there. An urban segment's draw is clamped below the slowest highway
 * running, which is what "urban" means on a corridor: at mean 17 and sd 4
 * that ceiling is three standard deviations out and essentially never binds,
 * but it makes the ordering between the two kinds a property of the code.
 */
export function drawCoachSpeedKph(
  profile: CoachMotionProfile,
  bin: string,
  segment: number,
  kind: SegmentKind,
): number {
  if (kind === 'urban') {
    const sampled = normal(profile.seed, bin, 'urban_speed', segment, profile.urbanKphMean, profile.urbanKphSd)
    return clamp(sampled, 1, profile.highwayKphMin)
  }
  const sampled = normal(profile.seed, bin, 'highway_speed', segment, profile.highwayKphMean, profile.highwayKphSd)
  return clamp(sampled, profile.highwayKphMin, profile.highwayKphMax)
}

export function drawDwellSeconds(
  profile: CoachMotionProfile,
  bin: string,
  standVisit: number,
  kind: StandKind,
): number {
  return Math.max(
    0,
    normal(
      profile.seed,
      bin,
      `dwell_${kind}`,
      standVisit,
      profile.dwellSecondsMeanByKind[kind],
      profile.dwellSecondsSdByKind[kind],
    ),
  )
}

/** Which segment the stand at `index` leads away from. */
export function segmentKindAt(corridor: Corridor, index: number): SegmentKind {
  const from = corridor.stands[index]
  const to = corridor.stands[index + 1]
  if (from === undefined || to === undefined) return 'highway'
  return (
    corridor.segments.find((segment) => segment.fromStandId === from.id && segment.toStandId === to.id)
      ?.kind ?? 'highway'
  )
}

/**
 * How many `meal_halt` stands the coach has not yet reached, and how many
 * kilometres of `highway` segment remain before a given distance along the
 * route. Both are terms in §5.3's band and both are monotonically decreasing
 * functions of progress, which is what makes criterion 79 hold by
 * construction rather than by luck.
 */
export function haltsRemaining(corridor: Corridor, fromMetres: number, toMetres: number): number {
  return corridor.stands.filter(
    (stand) =>
      stand.kind === 'meal_halt' && stand.distanceMetres > fromMetres && stand.distanceMetres <= toMetres,
  ).length
}

export function highwayKmBetween(corridor: Corridor, fromMetres: number, toMetres: number): number {
  if (toMetres <= fromMetres) return 0
  let metres = 0
  for (const segment of corridor.segments) {
    if (segment.kind !== 'highway') continue
    const start = corridor.stands.find((stand) => stand.id === segment.fromStandId)?.distanceMetres
    const end = corridor.stands.find((stand) => stand.id === segment.toStandId)?.distanceMetres
    if (start === undefined || end === undefined) continue
    metres += Math.max(0, Math.min(end, toMetres) - Math.max(start, fromMetres))
  }
  return metres / 1_000
}

/** True when the path between the two distances enters an `urban` segment. */
export function entersUrban(corridor: Corridor, fromMetres: number, toMetres: number): boolean {
  return corridor.segments.some((segment) => {
    if (segment.kind !== 'urban') return false
    const start = corridor.stands.find((stand) => stand.id === segment.fromStandId)?.distanceMetres
    const end = corridor.stands.find((stand) => stand.id === segment.toStandId)?.distanceMetres
    if (start === undefined || end === undefined) return false
    return Math.min(end, toMetres) > Math.max(start, fromMetres)
  })
}

function normal(
  seed: number,
  bin: string,
  purpose: string,
  bucket: number,
  mean: number,
  standardDeviation: number,
): number {
  const first = Math.max(Number.EPSILON, rand(seed, bin, `${purpose}_a`, bucket))
  const second = rand(seed, bin, `${purpose}_b`, bucket)
  const standard = Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second)
  return mean + standard * standardDeviation
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
