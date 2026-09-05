import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { loadCorridorTopology } from '../../src/geometry/corridorTopology.js'
import { occupancyFor, projectOccupancy, type OccupancyInput } from '../../src/sim/occupancy.js'
import type { TrackingState } from '../../src/world/port.js'

/**
 * docs/intercity-coaches.md §15.1: "A new layer, and it is the interesting
 * one: the full-day sweep... An honesty rule that holds at one instant and
 * fails at 03:40 has not held." Criteria 82 and 92, adapted to this pass's
 * scope: the HTTP surface and GTFS-Realtime feeds those criteria enumerate
 * are stage 8/9 work this task does not build (see the README's scope
 * note), so this sweep runs at the layer that *does* exist and that every
 * later surface will call through - `occupancyFor` / `projectOccupancy`
 * (src/sim/occupancy.ts) - over a full run of the real, committed BNG-HSP
 * corridor. Wiring stage 8 later adds no new risk to the claim this test
 * makes: the refusal already lives below where every projector would call
 * in, not inside any one of them.
 *
 * The sweep drives one simulated Pallakki duty (reserved) and one simulated
 * Karnataka Sarige duty (unreserved) along the corridor's own length, one
 * simulated minute at a time from departure to arrival, cycling every
 * tracking state at every minute - not a real device model (out of scope
 * here), but enough to ask the honesty question at every state a real one
 * can produce.
 */

const TRACKING_STATES: readonly TrackingState[] = ['live', 'stale', 'dark', 'untracked']

async function sweepInputs(reserved: boolean): Promise<readonly OccupancyInput[]> {
  const topology = await loadCorridorTopology(config.intercityTopologyPath)
  const corridor = topology.corridors[0]!
  const departure = new Date('2026-09-05T17:29:00Z')
  const averageMetresPerMinute = 1_000 // ~60 km/h, close enough for a sweep's own clock
  const totalMinutes = Math.ceil(corridor.lengthMetres / averageMetresPerMinute)

  const inputs: OccupancyInput[] = []
  for (let minute = 0; minute <= totalMinutes; minute += 1) {
    const distanceAlongRouteMetres = Math.min(corridor.lengthMetres, minute * averageMetresPerMinute)
    const at = new Date(departure.getTime() + minute * 60_000)
    for (const trackingState of TRACKING_STATES) {
      inputs.push({
        bin: 'KBS-01847',
        trackingState,
        routeId: corridor.id,
        routeNumber: corridor.id,
        directionId: 0,
        distanceAlongRouteMetres,
        routeLengthMetres: corridor.lengthMetres,
        at,
        tripStartedAtMs: departure.getTime(),
        reservation: reserved ? { required: true } : null,
      })
    }
  }
  return inputs
}

describe('the occupancy refusal over a full-day sweep of the real BNG-HSP corridor', () => {
  it('never emits an occupancy key for a reserved duty, at any minute of the run and any tracking state', async () => {
    const inputs = await sweepInputs(true)
    expect(inputs.length).toBeGreaterThan(1_000) // a real sweep, not a handful of points
    for (const input of inputs) {
      const outcome = occupancyFor(input)
      expect(outcome).toEqual({ kind: 'withheld', reason: 'reserved_no_onboard_count' })
      expect(projectOccupancy(outcome)).toBeUndefined()
    }
  })

  it('does emit a modelled occupancy for an unreserved duty on the same corridor, at least while live or stale', async () => {
    const inputs = await sweepInputs(false)
    const liveOrStale = inputs.filter((input) => input.trackingState === 'live' || input.trackingState === 'stale')
    expect(liveOrStale.length).toBeGreaterThan(0)
    for (const input of liveOrStale) {
      const outcome = occupancyFor(input)
      expect(outcome.kind).toBe('modelled')
      const projected = projectOccupancy(outcome)
      expect(projected).toBeDefined()
      expect(projected?.status).not.toBe('NO_DATA_AVAILABLE')
    }
    // And the dark/untracked minutes of that same unreserved duty still
    // withhold - for the ordinary "nobody counts a dark bus" reason, not the
    // reserved one. The two withheld reasons must not be confused for each
    // other in either direction.
    const darkOrUntracked = inputs.filter((input) => input.trackingState === 'dark' || input.trackingState === 'untracked')
    for (const input of darkOrUntracked) {
      expect(occupancyFor(input)).toEqual({ kind: 'withheld', reason: 'not_reporting' })
    }
  })
})
