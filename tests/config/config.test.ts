import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

describe('configuration', () => {
  it('collects every invalid variable before failing startup', () => {
    expect(() =>
      loadConfig({
        PORT: 'not-a-port',
        BUS_COVERAGE_SHARE: '2',
        GTFS_SOURCE: 'path',
        DUTY_CONFIRMED_SHARE: '0.70',
      }),
    ).toThrowError(/PORT[\s\S]*GTFS_PATH[\s\S]*Duty shares[\s\S]*BUS_COVERAGE_SHARE/)
  })

  it('requires source-specific settings without inventing a fallback', () => {
    expect(() => loadConfig({ GTFS_SOURCE: 'url' })).toThrow('GTFS_URL is required')
    expect(() => loadConfig({ GTFS_SOURCE: 'path' })).toThrow('GTFS_PATH is required')
  })

  it('rejects impossible or reversed peak windows', () => {
    expect(() => loadConfig({ BUS_PEAK_WINDOWS: '25:00-26:00' })).toThrow('BUS_PEAK_WINDOWS')
    expect(() => loadConfig({ BUS_PEAK_WINDOWS: '10:00-09:00' })).toThrow('BUS_PEAK_WINDOWS')
  })

  it('keeps env.example exactly aligned with every named environment variable', async () => {
    const source = await readFile(new URL('../../src/config.ts', import.meta.url), 'utf8')
    const example = await readFile(new URL('../../.env.example', import.meta.url), 'utf8')
    const sourceNames = new Set(
      [...source.matchAll(/validation\.\w+(?:<[^>]+>)?\(\s*'([A-Z][A-Z0-9_]+)'/g)].map(
        (match) => match[1]!,
      ),
    )
    const exampleNames = new Set(
      example
        .split('\n')
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => line.slice(0, line.indexOf('='))),
    )
    expect([...exampleNames].sort()).toEqual([...sourceNames].sort())
  })
})
