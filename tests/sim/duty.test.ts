import { describe, expect, it } from 'vitest'
import type { GtfsRoute, GtfsTrip } from '../../src/geometry/loadGtfs.js'
import type { ActiveBus } from '../../src/sim/dispatch.js'
import {
  createDutyState,
  defaultBusDutyProfile,
  dutyObservation,
  maybeSwapDuty,
  validateDutyProfile,
} from '../../src/sim/duty.js'

const START = new Date('2026-08-20T03:00:00Z')

describe('duty state machine', () => {
  it('refuses a distribution that does not sum to one', () => {
    expect(() =>
      validateDutyProfile({
        ...defaultBusDutyProfile,
        confirmedShare: 0.6,
        inferredShare: 0.2,
        unknownShare: 0.1,
        outOfServiceShare: 0.05,
      }),
    ).toThrow('Duty shares must sum to 1.0')
  })

  it('can force each duty state through its configured share', () => {
    for (const status of ['confirmed', 'inferred', 'unknown', 'out_of_service'] as const) {
      const profile = forcedDutyProfile(status)
      expect(createDutyState('BLR-04126', START, '20260820', profile).status).toBe(status)
    }
  })

  it('sets confidence only for inferred duty and inside its configured range', () => {
    for (const status of ['confirmed', 'inferred', 'unknown', 'out_of_service'] as const) {
      const profile = forcedDutyProfile(status)
      const state = createDutyState('BLR-04126', START, '20260820', profile)
      if (status === 'inferred') {
        expect(state.confidence).toBeGreaterThanOrEqual(profile.inferredConfidenceMin)
        expect(state.confidence).toBeLessThanOrEqual(profile.inferredConfidenceMax)
      } else {
        expect(state.confidence).toBeNull()
      }
    }
  })

  it('drops a confirmed roster to inferred or unknown without a device input', () => {
    const profile = { ...forcedDutyProfile('confirmed'), swapRatePerDay: 1_000_000 }
    const state = createDutyState('BLR-04126', START, '20260820', profile)
    maybeSwapDuty(state, 'BLR-04126', new Date(START.getTime() + 60_000), profile)
    expect(['inferred', 'unknown']).toContain(state.status)
    expect(state.reason).toBe('roster_swapped')
  })

  // docs/intercity-coaches.md §3.2: `trip.startDate` is a GTFS *service* date,
  // which is not always the calendar date of `startedAt` - a relief
  // departure at 00:30 can belong to the *previous* day's service. The fix
  // is that `dutyObservation` reads `ActiveBus.serviceDate` as a carried
  // field rather than recomputing it from `tripStartedAt`. This test proves
  // that by deliberately setting the two to disagree, which a roster-fed
  // duty can do honestly and a naive derivation never could.
  it("reports the carried serviceDate field, not the calendar date of tripStartedAt", () => {
    const state = createDutyState('KBS-01847', START, '20260905', forcedDutyProfile('confirmed'))
    const bus = fixtureBus({
      tripStartedAt: new Date('2026-09-06T00:30:00Z'), // after midnight UTC
      serviceDate: '20260905', // the previous day's GTFS service, on purpose
    })
    const observation = dutyObservation(state, bus, [bus.route], forcedDutyProfile('confirmed'))
    expect(observation.trip?.startDate).toBe('20260905')
    expect(observation.trip?.startedAt).toBe('2026-09-06T00:30:00.000Z')
  })
})

function fixtureBus(overrides: Partial<ActiveBus> = {}): ActiveBus {
  const trip: GtfsTrip = {
    id: 'trip-1',
    routeId: 'route-1',
    serviceId: 'weekday',
    shapeId: 'shape-1',
    directionId: 0,
    headsign: 'Terminal',
    stops: [
      {
        stop: { id: 'a', name: 'A', nameLocal: null, lat: 13, lon: 77 },
        sequence: 1,
        arrivalTime: '00:30:00',
        departureTime: '00:30:00',
        stopDistanceMetres: 0,
      },
    ],
  }
  const route: GtfsRoute = { id: 'route-1', number: '2259BNGHMP', name: 'Test route', trips: [trip] }
  return {
    member: { bin: 'KBS-01847', class: 'bus', homeRouteNumber: '2259BNGHMP' },
    route,
    trip,
    cursor: {
      shapeId: 'shape-1',
      distanceMetres: 0,
      directionId: 0,
      dwellUntilMs: null,
      layoverUntilMs: null,
      nextStopIndex: 0,
      segment: 0,
      stopVisits: 0,
      speedKph: 40,
      arrivedAtMs: null,
    },
    tripStartedAt: START,
    serviceDate: '20260820',
    ...overrides,
  }
}

function forcedDutyProfile(status: 'confirmed' | 'inferred' | 'unknown' | 'out_of_service') {
  return {
    ...defaultBusDutyProfile,
    confirmedShare: status === 'confirmed' ? 1 : 0,
    inferredShare: status === 'inferred' ? 1 : 0,
    unknownShare: status === 'unknown' ? 1 : 0,
    outOfServiceShare: status === 'out_of_service' ? 1 : 0,
    swapRatePerDay: 0,
  }
}
