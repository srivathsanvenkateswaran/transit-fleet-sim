import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { loadMetroTopology } from '../../src/geometry/metroTopology.js'

describe('bundled metro topology', () => {
  it('contains the operational station counts and explicit interpolation flags', async () => {
    const topology = await loadMetroTopology(config.metroTopologyPath)
    expect(topology.lines.map((line) => [line.id, line.stations.length])).toEqual([
      ['purple', 37],
      ['green', 32],
      ['yellow', 16],
    ])
    expect(topology.lines.find((line) => line.id === 'green')?.segments.every((segment) => segment.geometry === 'interpolated')).toBe(true)
    expect(topology.lines.find((line) => line.id === 'purple')?.segments.every((segment) => segment.geometry === 'osm')).toBe(true)
  })
})
