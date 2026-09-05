import { describe, expect, it } from 'vitest'
import {
  defaultBusOccupancyProfile,
  occupancyFor,
  projectOccupancy,
  type OccupancyInput,
  type OccupancyOutcome,
} from '../../src/sim/occupancy.js'
import type { TrackingState } from '../../src/world/port.js'

/**
 * docs/intercity-coaches.md §7: the refusal to publish an occupancy for a
 * reserved duty. `tests/sim/occupancy.test.ts` covers the demand model
 * itself; this file covers only the structural guarantee that a reserved
 * duty never reaches it.
 */

const RESERVED_ROUTE_LENGTH_METRES = 341_880 // BNG-HSP, for realism only

function reservedInput(overrides: Partial<OccupancyInput> = {}): OccupancyInput {
  return {
    bin: 'KBS-01847',
    trackingState: 'live',
    routeId: 'BNG-HSP',
    routeNumber: 'BNG-HSP',
    directionId: 0,
    distanceAlongRouteMetres: RESERVED_ROUTE_LENGTH_METRES / 2,
    routeLengthMetres: RESERVED_ROUTE_LENGTH_METRES,
    at: new Date('2026-09-06T02:00:00Z'),
    tripStartedAtMs: new Date('2026-09-05T17:29:00Z').getTime(),
    reservation: { required: true },
    ...overrides,
  }
}

/**
 * Fields a genuine call into `headcountFor` cannot survive: `localMinutes`
 * would call `Intl.DateTimeFormat(...).formatToParts` on an invalid `Date`
 * and throw, `directionFactor`/`centreFraction` would still run but
 * `distanceAlongRouteMetres / routeLengthMetres` on a negative length is at
 * least a nonsensical fraction, and `routeNumber` being an empty string with
 * a route length of `-1` and a fraction thereby outside `[0, 1]` before
 * `clamp` runs is exactly the kind of input the demand model was never
 * written to tolerate. If `occupancyFor` ever calls into that machinery for a
 * reserved duty, this input is chosen to make it visible - by throwing,
 * not by quietly returning a number nobody should trust.
 */
function poisonedInput(overrides: Partial<OccupancyInput> = {}): OccupancyInput {
  return reservedInput({
    at: new Date(Number.NaN),
    routeLengthMetres: -1,
    distanceAlongRouteMetres: Number.NaN,
    routeNumber: '',
    ...overrides,
  })
}

describe('the reserved-duty occupancy refusal', () => {
  it('withholds before computing anything, even with poisoned demand-model inputs', () => {
    const outcome = occupancyFor(poisonedInput())
    expect(outcome).toEqual({ kind: 'withheld', reason: 'reserved_no_onboard_count' })
  })

  it('withholds for a reserved duty at every tracking state, not only dark or untracked', () => {
    const states: readonly TrackingState[] = ['live', 'stale', 'dark', 'untracked']
    for (const trackingState of states) {
      const outcome = occupancyFor(poisonedInput({ trackingState }))
      expect(outcome).toEqual({ kind: 'withheld', reason: 'reserved_no_onboard_count' })
    }
  })

  it('projects the reserved withholding to an omitted key, never to NO_DATA_AVAILABLE', () => {
    const projected = projectOccupancy(occupancyFor(poisonedInput()))
    expect(projected).toBeUndefined()
    // The dark/untracked short-circuit is a different reason and still
    // becomes NO_DATA_AVAILABLE - the two withheld reasons project
    // differently on purpose (§7.2's "omission, not NO_DATA_AVAILABLE").
    const notReporting: OccupancyOutcome = { kind: 'withheld', reason: 'not_reporting' }
    expect(projectOccupancy(notReporting)).toEqual({ status: 'NO_DATA_AVAILABLE' })
  })

  it('is a fact about the duty, not the vehicle: reservation.required=false still models', () => {
    const input = reservedInput({ reservation: { required: false } })
    const outcome = occupancyFor(input, defaultBusOccupancyProfile)
    expect(outcome.kind).toBe('modelled')
  })

  it('is a fact about the duty, not the vehicle: reservation=null still models (an ordinary bus)', () => {
    const outcome = occupancyFor(reservedInput({ reservation: null }), defaultBusOccupancyProfile)
    expect(outcome.kind).toBe('modelled')
  })

  it('never omits percentage or status from a modelled outcome, and never invents them on a withheld one', () => {
    const modelled = occupancyFor(reservedInput({ reservation: null }))
    expect(modelled.kind).toBe('modelled')
    if (modelled.kind === 'modelled') {
      expect(typeof modelled.observation.status).toBe('string')
      expect(typeof modelled.observation.percentage).toBe('number')
    }
    const withheld = occupancyFor(reservedInput())
    // `Object.keys` rather than `toEqual({kind, reason})` alone: this fails
    // loudly if a future edit adds so much as an extra key to the withheld
    // arm, which is exactly the kind of change the type check below also
    // guards against from the other direction.
    expect(Object.keys(withheld).sort()).toEqual(['kind', 'reason'])
  })
})

// Type-level: the withheld arm of `OccupancyOutcome` structurally cannot
// carry a measured figure. If a future change ever adds an `observation` (or
// `percentage`, or `status`) field to that arm, `Extract<..., {kind:
// 'withheld'}>` picks it up, `HasNoObservation` becomes `false`, and the
// assignment below fails `npm run typecheck` - which is what "the refusal is
// structural, not a policy check" is supposed to mean: this is not a test
// that can be skipped or a lint rule that can be suppressed, it is the shape
// of the type not admitting the field at all.
type WithheldArm = Extract<OccupancyOutcome, { readonly kind: 'withheld' }>
type HasNoObservation = 'observation' extends keyof WithheldArm ? false : true
type HasNoPercentage = 'percentage' extends keyof WithheldArm ? false : true
type HasNoStatus = 'status' extends keyof WithheldArm ? false : true
const _withheldCarriesNoMeasuredFigure: HasNoObservation & HasNoPercentage & HasNoStatus = true
void _withheldCarriesNoMeasuredFigure
