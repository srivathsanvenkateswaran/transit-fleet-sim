import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import {
  DEFAULT_CORRIDOR_LIMITS,
  buildCorridorTrack,
  loadCorridorTopology,
  reverseCorridor,
  validateCorridorTopology,
  type Corridor,
  type CorridorTopology,
} from '../../src/geometry/corridorTopology.js'

/**
 * docs/intercity-coaches.md §9.4 and §15 criteria 46-52: the committed
 * `corridor-topology.json` (real, routed, checked here) plus the six
 * applicable integrity checks exercised against hand-built topologies that
 * are deliberately wrong in one way each - the same discipline
 * `tests/geometry/metroTopology.test.ts` applies to `metro-topology.json`.
 * Check 7 (Pavagada against OSM relation 15728171) has no corridor to run
 * against yet - see the note on `PAVAGADA_OSM_RELATION_ID` in
 * `src/geometry/corridorTopology.ts` - and is not exercised here.
 */

function straightTrack(points: readonly { lat: number; lon: number }[]) {
  return buildCorridorTrack(points, 'test')
}

function baseCorridor(overrides: Partial<Corridor> = {}): Corridor {
  const points = [
    { lat: 13.0, lon: 77.5 },
    { lat: 13.2, lon: 77.3 },
    { lat: 13.4, lon: 77.1 },
    { lat: 13.6, lon: 76.9 },
  ]
  const track = straightTrack(points)
  return {
    id: 'TEST',
    name: 'Test corridor',
    nameLocal: null,
    corporations: ['KSRTC'],
    lengthMetres: track.lengthMetres,
    stands: [
      { id: 'A', name: 'A', nameLocal: null, lat: points[0]!.lat, lon: points[0]!.lon, kind: 'boarding', distanceMetres: 0, provenance: 'authored_secondary' },
      { id: 'B', name: 'B', nameLocal: null, lat: points[3]!.lat, lon: points[3]!.lon, kind: 'terminal', distanceMetres: track.lengthMetres, provenance: 'authored_secondary' },
    ],
    segments: [
      { fromStandId: 'A', toStandId: 'B', kind: 'highway', geometry: 'routed', distanceMetres: track.lengthMetres, points },
    ],
    deadZones: [],
    track,
    ...overrides,
  }
}

function topologyOf(...corridors: readonly Corridor[]): CorridorTopology {
  return {
    source: 'openstreetmap',
    fetchedAt: '2026-09-05',
    extract: { provider: 'test', region: 'test', date: '2026-09-05' },
    router: { engine: 'test', version: 'test', profile: 'car' },
    corridors,
  }
}

describe('the committed corridor topology (BNG-HSP)', () => {
  it('loads and passes every applicable integrity check', async () => {
    const topology = await loadCorridorTopology(config.intercityTopologyPath)
    expect(topology.corridors.map((corridor) => corridor.id)).toContain('BNG-HSP')
    const corridor = topology.corridors.find((c) => c.id === 'BNG-HSP')!
    expect(corridor.stands).toHaveLength(9)
    expect(corridor.segments).toHaveLength(8)
    expect(corridor.stands[0]?.kind).toBe('boarding')
    expect(corridor.stands.at(-1)?.kind).toBe('terminal')
    expect(corridor.stands.some((stand) => stand.kind === 'meal_halt')).toBe(true)
  })

  it('routes real road geometry rather than falling back to a straight line for every segment', async () => {
    const topology = await loadCorridorTopology(config.intercityTopologyPath)
    const corridor = topology.corridors.find((c) => c.id === 'BNG-HSP')!
    // §9.3: "a straight line between stands is not acceptable as the
    // default." At least the great majority of an 8-segment, ~420 km corridor
    // must be genuinely routed, or this pipeline built nothing.
    const routed = corridor.segments.filter((segment) => segment.geometry === 'routed')
    expect(routed.length).toBe(corridor.segments.length)
    expect(corridor.track.points.length).toBeGreaterThan(100)
  })

  it('publishes which segments are urban and which are highway, on both ends of the corridor', async () => {
    const topology = await loadCorridorTopology(config.intercityTopologyPath)
    const corridor = topology.corridors.find((c) => c.id === 'BNG-HSP')!
    expect(corridor.segments[0]?.kind).toBe('urban')
    expect(corridor.segments.at(-1)?.kind).toBe('urban')
    expect(corridor.segments.some((segment) => segment.kind === 'highway')).toBe(true)
  })

  it('places every dead zone at least 500m clear of every stand, summing to roughly the documented share of the route', async () => {
    const topology = await loadCorridorTopology(config.intercityTopologyPath)
    const corridor = topology.corridors.find((c) => c.id === 'BNG-HSP')!
    expect(corridor.deadZones).toHaveLength(3)
    const totalZoneMetres = corridor.deadZones.reduce((sum, zone) => sum + (zone.toMetres - zone.fromMetres), 0)
    expect(totalZoneMetres / corridor.lengthMetres).toBeGreaterThan(0.05)
    expect(totalZoneMetres / corridor.lengthMetres).toBeLessThan(0.2)
  })
})

describe('the corridor integrity gate (§9.4)', () => {
  it('check 1: fails a corridor whose routed length is too far from the great-circle distance between its endpoints', () => {
    const corridor = baseCorridor({ lengthMetres: 10_000_000 })
    expect(() => validateCorridorTopology(topologyOf(corridor))).toThrow(/detour ratio/)
  })

  it('check 2: fails when stands are re-sorted by coordinate rather than kept in route order', () => {
    const corridor = baseCorridor()
    const swapped = { ...corridor, stands: [corridor.stands[1]!, corridor.stands[0]!] }
    expect(() => validateCorridorTopology(topologyOf(swapped))).toThrow(/distance order/)
  })

  it('check 3: fails when consecutive stands are farther apart than the configured maximum gap', () => {
    const corridor = baseCorridor()
    expect(() =>
      validateCorridorTopology(topologyOf(corridor), { ...DEFAULT_CORRIDOR_LIMITS, maxStandGapMetres: 1 }),
    ).toThrow(/gap/)
  })

  it('check 4: fails when the committed track is not monotonic', () => {
    const corridor = baseCorridor()
    const brokenTrack = {
      ...corridor.track,
      points: corridor.track.points.map((point, index) =>
        index === 1 ? { ...point, cumulativeDistanceMetres: -1 } : point,
      ),
    }
    expect(() => validateCorridorTopology(topologyOf({ ...corridor, track: brokenTrack }))).toThrow(/not monotonic/)
  })

  it('check 5: fails when a stand sits farther than the configured offset from the routed line', () => {
    const corridor = baseCorridor()
    const farStand = { ...corridor.stands[0]!, lat: corridor.stands[0]!.lat + 5 }
    expect(() =>
      validateCorridorTopology(topologyOf({ ...corridor, stands: [farStand, corridor.stands[1]!] })),
    ).toThrow(/off the routed line/)
  })

  it('check 6: fails when a dead zone overlaps a stand within 500m', () => {
    const corridor = baseCorridor({
      deadZones: [{ fromMetres: -100, toMetres: 100, reason: 'no_cellular_coverage' }],
    })
    expect(() => validateCorridorTopology(topologyOf(corridor))).toThrow(/overlaps stand/)
  })

  it('accepts a well-formed corridor with a dead zone that clears every stand by more than 500m', () => {
    const corridor = baseCorridor({
      deadZones: [{ fromMetres: 20_000, toMetres: 30_000, reason: 'no_cellular_coverage' }],
    })
    expect(() => validateCorridorTopology(topologyOf(corridor))).not.toThrow()
  })
})

/**
 * The bidirectional-roster fix (docs/intercity-coaches.md's "single-direction
 * roster mechanism" gap): a real Tatak service running the opposite way over
 * a corridor this project already models is not a second corridor, it is the
 * same asphalt travelled the other direction. `reverseCorridor` mirrors the
 * committed track rather than fetching a second OSRM fixture, and it has to
 * come out a corridor `validateCorridorTopology` would accept on its own -
 * this is what §9.4's checks would run against the real bundled reversal.
 */
describe('reverseCorridor (bidirectional rosters)', () => {
  it('produces a corridor that passes every integrity check the forward one does', () => {
    const corridor = baseCorridor({
      deadZones: [{ fromMetres: 20_000, toMetres: 30_000, reason: 'no_cellular_coverage' }],
    })
    const reversed = reverseCorridor(corridor)
    expect(() => validateCorridorTopology(topologyOf(reversed))).not.toThrow()
  })

  it('swaps boarding and terminal at the ends and preserves the id, name and length', () => {
    const corridor = baseCorridor()
    const reversed = reverseCorridor(corridor)
    expect(reversed.id).toBe(corridor.id)
    expect(reversed.name).toBe(corridor.name)
    expect(reversed.lengthMetres).toBeCloseTo(corridor.lengthMetres, 0)
    expect(reversed.stands[0]?.id).toBe(corridor.stands.at(-1)!.id)
    expect(reversed.stands[0]?.kind).toBe('boarding')
    expect(reversed.stands.at(-1)?.id).toBe(corridor.stands[0]!.id)
    expect(reversed.stands.at(-1)?.kind).toBe('terminal')
  })

  it('keeps an interior stand’s own kind (a meal halt reversed is still a meal halt)', () => {
    const points = [
      { lat: 13.0, lon: 77.5 },
      { lat: 13.2, lon: 77.3 },
      { lat: 13.4, lon: 77.1 },
      { lat: 13.6, lon: 76.9 },
    ]
    const track = straightTrack(points)
    const middle = points[1]!
    const corridor: Corridor = {
      ...baseCorridor(),
      stands: [
        { id: 'A', name: 'A', nameLocal: null, lat: points[0]!.lat, lon: points[0]!.lon, kind: 'boarding', distanceMetres: 0, provenance: 'authored_secondary' },
        { id: 'M', name: 'M', nameLocal: null, lat: middle.lat, lon: middle.lon, kind: 'meal_halt', distanceMetres: Math.round(track.lengthMetres / 3), provenance: 'authored_secondary' },
        { id: 'B', name: 'B', nameLocal: null, lat: points[3]!.lat, lon: points[3]!.lon, kind: 'terminal', distanceMetres: track.lengthMetres, provenance: 'authored_secondary' },
      ],
      segments: [
        { fromStandId: 'A', toStandId: 'M', kind: 'highway', geometry: 'routed', distanceMetres: track.lengthMetres / 3, points: points.slice(0, 2) },
        { fromStandId: 'M', toStandId: 'B', kind: 'highway', geometry: 'routed', distanceMetres: (track.lengthMetres * 2) / 3, points: points.slice(1) },
      ],
      track,
    }
    const reversed = reverseCorridor(corridor)
    const reversedMeal = reversed.stands.find((stand) => stand.id === 'M')
    expect(reversedMeal?.kind).toBe('meal_halt')
  })

  it('mirrors a dead zone to the same clearance from the (now opposite) nearer stand', () => {
    const corridor = baseCorridor({
      deadZones: [{ fromMetres: 20_000, toMetres: 30_000, reason: 'no_cellular_coverage' }],
    })
    const reversed = reverseCorridor(corridor)
    expect(reversed.deadZones).toHaveLength(1)
    const zone = reversed.deadZones[0]!
    expect(zone.fromMetres).toBeCloseTo(corridor.lengthMetres - 30_000, -1)
    expect(zone.toMetres).toBeCloseTo(corridor.lengthMetres - 20_000, -1)
  })

  it('running the real committed BNG-MYS corridor backwards still ends at its own origin', () => {
    // Not a synthetic fixture: the actual bundled corridor, so the reversal
    // is checked against real routed geometry and not just the hand-built
    // four-point test corridor above.
    return loadCorridorTopology(config.intercityTopologyPath).then((topology) => {
      const corridor = topology.corridors.find((c) => c.id === 'BNG-MYS')!
      const reversed = reverseCorridor(corridor)
      expect(() => validateCorridorTopology(topologyOf(reversed))).not.toThrow()
      expect(reversed.stands[0]?.id).toBe(corridor.stands.at(-1)!.id)
      expect(reversed.stands.at(-1)?.id).toBe(corridor.stands[0]!.id)
    })
  })
})
