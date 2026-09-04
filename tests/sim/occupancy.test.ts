import { describe, expect, it } from 'vitest'
import { defaultBusOccupancyProfile, occupancyFor, type OccupancyInput } from '../../src/sim/occupancy.js'

const ROUTE_LENGTH_METRES = 20_000

function baseInput(overrides: Partial<OccupancyInput> = {}): OccupancyInput {
  return {
    bin: 'BLR-04126',
    trackingState: 'live',
    routeId: '1066',
    routeNumber: '500-D',
    directionId: 0,
    distanceAlongRouteMetres: ROUTE_LENGTH_METRES / 2,
    routeLengthMetres: ROUTE_LENGTH_METRES,
    at: new Date('2026-08-20T03:00:00Z'), // 08:30 IST
    tripStartedAtMs: new Date('2026-08-20T02:00:00Z').getTime(),
    ...overrides,
  }
}

describe('the demand-based occupancy model', () => {
  it('gives a dark or untracked vehicle no occupancy at all, not a zero', () => {
    for (const trackingState of ['dark', 'untracked'] as const) {
      const observation = occupancyFor(baseInput({ trackingState }))
      expect(observation).toEqual({ status: 'NO_DATA_AVAILABLE' })
      expect(Object.keys(observation)).not.toContain('percentage')
    }
  })

  it('answers identically for the same input drawn twice', () => {
    const input = baseInput()
    expect(occupancyFor(input)).toEqual(occupancyFor(baseInput()))
  })

  it('never lets status and percentage disagree, across the whole reachable range', () => {
    for (const routeNumber of ['500-D', 'KIA-4']) {
      for (let fraction = 0; fraction <= 1; fraction += 0.05) {
        for (const minuteOfDay of [0, 240, 510, 840, 1_110, 1_380]) {
          const at = atMinutes(minuteOfDay)
          const observation = occupancyFor(
            baseInput({
              routeNumber,
              distanceAlongRouteMetres: fraction * ROUTE_LENGTH_METRES,
              at,
              tripStartedAtMs: at.getTime(),
            }),
          )
          expect(observation.percentage).toBeGreaterThanOrEqual(0)
          expect(observation.percentage).toBeLessThanOrEqual(100)
          if (observation.status === 'FULL') expect(observation.percentage).toBeGreaterThanOrEqual(90)
          if (observation.status === 'EMPTY') expect(observation.percentage).toBeLessThanOrEqual(15)
          if (observation.status === 'STANDING_ROOM_ONLY' || observation.status === 'CRUSHED_STANDING_ROOM_ONLY') {
            expect(observation.percentage).toBeGreaterThan(30)
          }
        }
      }
    }
  })

  it('reaches every status on the ladder, including FULL, somewhere in a busy day', () => {
    const seen = new Set<string>()
    for (const bin of Array.from({ length: 12 }, (_, index) => `BLR-0${4000 + index}`)) {
      for (const routeId of Array.from({ length: 8 }, (_, index) => `route-${index}`)) {
        for (let fraction = 0; fraction <= 1; fraction += 0.02) {
          const at = atMinutes(8 * 60 + 15)
          const observation = occupancyFor(
            baseInput({
              bin,
              routeId,
              distanceAlongRouteMetres: fraction * ROUTE_LENGTH_METRES,
              at,
              tripStartedAtMs: at.getTime() + bin.length,
            }),
          )
          seen.add(observation.status)
        }
      }
    }
    expect(seen).toEqual(
      new Set([
        'EMPTY',
        'MANY_SEATS_AVAILABLE',
        'FEW_SEATS_AVAILABLE',
        'STANDING_ROOM_ONLY',
        'CRUSHED_STANDING_ROOM_ONLY',
        'FULL',
      ]),
    )
  })

  it('does not make FULL the common case across an ordinary day', () => {
    let full = 0
    let total = 0
    for (const bin of Array.from({ length: 6 }, (_, index) => `BLR-0${4200 + index}`)) {
      for (let minuteOfDay = 0; minuteOfDay < 1_440; minuteOfDay += 20) {
        for (let fraction = 0; fraction <= 1; fraction += 0.1) {
          const at = atMinutes(minuteOfDay)
          const observation = occupancyFor(
            baseInput({
              bin,
              distanceAlongRouteMetres: fraction * ROUTE_LENGTH_METRES,
              at,
              tripStartedAtMs: at.getTime(),
            }),
          )
          total += 1
          if (observation.status === 'FULL') full += 1
        }
      }
    }
    expect(full / total).toBeLessThan(0.1)
  })

  it('is fuller in the centre-bound direction during the morning peak than the reverse', () => {
    const at = atMinutes(8 * 60 + 15)
    const inbound = occupancyFor(baseInput({ directionId: 0, at, tripStartedAtMs: at.getTime() }))
    const outbound = occupancyFor(baseInput({ directionId: 1, at, tripStartedAtMs: at.getTime() }))
    expect(inbound.percentage ?? 0).toBeGreaterThan(outbound.percentage ?? 0)
  })

  it('flips which direction is fuller between the morning and evening peaks', () => {
    const morning = atMinutes(8 * 60 + 15)
    const evening = atMinutes(18 * 60 + 15)
    const morningInbound = occupancyFor(baseInput({ directionId: 0, at: morning, tripStartedAtMs: morning.getTime() }))
    const morningOutbound = occupancyFor(baseInput({ directionId: 1, at: morning, tripStartedAtMs: morning.getTime() }))
    const eveningInbound = occupancyFor(baseInput({ directionId: 0, at: evening, tripStartedAtMs: evening.getTime() }))
    const eveningOutbound = occupancyFor(baseInput({ directionId: 1, at: evening, tripStartedAtMs: evening.getTime() }))
    expect(morningInbound.percentage ?? 0).toBeGreaterThan(morningOutbound.percentage ?? 0)
    expect(eveningOutbound.percentage ?? 0).toBeGreaterThan(eveningInbound.percentage ?? 0)
  })

  it('reads far fuller at the evening peak than at eleven at night, same route and position', () => {
    const peak = occupancyFor(baseInput({ at: atMinutes(18 * 60 + 15), tripStartedAtMs: 1 }))
    const lateNight = occupancyFor(baseInput({ at: atMinutes(23 * 60), tripStartedAtMs: 1 }))
    expect(peak.percentage ?? 0).toBeGreaterThan((lateNight.percentage ?? 0) + 30)
    expect(lateNight.status === 'EMPTY' || lateNight.status === 'MANY_SEATS_AVAILABLE').toBe(true)
  })

  it('gives an airport (Vayu Vajra) run a different capacity than an ordinary bus', () => {
    // Demand pressure is a share of design capacity, so it lands on the same
    // percentage for both classes here - the difference the model is meant to
    // produce is in the ladder: the airport coach is almost all seats and
    // barely any standing room, so at the same percentage it is still
    // `FEW_SEATS_AVAILABLE` where an ordinary bus is already standing-room.
    const input = baseInput({
      distanceAlongRouteMetres: ROUTE_LENGTH_METRES * 0.3,
      at: atMinutes(8 * 60 + 15),
      tripStartedAtMs: 1,
    })
    const ordinary = occupancyFor(input)
    const airport = occupancyFor({ ...input, routeNumber: 'KIA-4' })
    expect(ordinary.percentage).toBe(airport.percentage)
    expect(ordinary.status).toBe('STANDING_ROOM_ONLY')
    expect(airport.status).toBe('FEW_SEATS_AVAILABLE')
  })

  it('keeps seated and standing capacity separate: FEW_SEATS_AVAILABLE cannot exceed seated capacity', () => {
    for (const routeNumber of ['500-D', 'KIA-4']) {
      const profile = defaultBusOccupancyProfile
      const seatedCapacity = routeNumber === 'KIA-4' ? profile.airportSeatedCapacity : profile.seatedCapacity
      const standingCapacity = routeNumber === 'KIA-4' ? profile.airportStandingCapacity : profile.standingCapacity
      const seatedShare = seatedCapacity / (seatedCapacity + standingCapacity)
      for (let fraction = 0; fraction <= 1; fraction += 0.05) {
        const observation = occupancyFor(
          baseInput({
            routeNumber,
            distanceAlongRouteMetres: fraction * ROUTE_LENGTH_METRES,
            at: atMinutes(8 * 60 + 15),
            tripStartedAtMs: 1,
          }),
        )
        if (observation.status === 'FEW_SEATS_AVAILABLE') {
          expect(observation.percentage ?? 0).toBeLessThanOrEqual(Math.round(seatedShare * 100) + 1)
        }
        if (observation.status === 'STANDING_ROOM_ONLY' || observation.status === 'CRUSHED_STANDING_ROOM_ONLY' || observation.status === 'FULL') {
          expect(observation.percentage ?? 0).toBeGreaterThan(Math.round(seatedShare * 100) - 2)
        }
      }
    }
  })
})

function atMinutes(minuteOfDay: number): Date {
  // 2026-08-20T00:00:00 IST == 2026-08-19T18:30:00Z; IST is UTC+5:30.
  const istMidnightUtcMs = new Date('2026-08-19T18:30:00Z').getTime()
  return new Date(istMidnightUtcMs + minuteOfDay * 60_000)
}
