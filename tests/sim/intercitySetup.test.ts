import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { defaultScheduleProfile } from '../../src/sim/coachProfiles.js'
import { coachSlotsFor, loadIntercitySetup } from '../../src/sim/intercitySetup.js'

/**
 * docs/intercity-coaches.md §12.1: turning `INTERCITY_CORRIDORS` on loads and
 * cross-checks the corridor, hub and service-class configuration, and fails
 * fast, naming the offending value, rather than booting half-configured.
 */

function baseOptions(overrides: Partial<Parameters<typeof loadIntercitySetup>[0]> = {}) {
  return {
    corridors: ['BNG-HSP'],
    topologyPath: config.intercityTopologyPath,
    rosterPath: config.intercityRosterPath,
    hubCodes: config.intercityHubCodes,
    serviceClassIds: config.intercityServiceClasses,
    classesPath: new URL('../../data/bundle/corridor-classes.json', import.meta.url).pathname,
    ...overrides,
  }
}

describe('loading the intercity setup', () => {
  it('is off by default: an empty corridor list loads nothing and reads no file', async () => {
    const setup = await loadIntercitySetup(baseOptions({ corridors: [], topologyPath: '/does/not/exist.json', rosterPath: '/does/not/exist.json' }))
    expect(setup).toBeNull()
  })

  it('loads the real bundled topology and service-class table when a known corridor is named', async () => {
    const setup = await loadIntercitySetup(baseOptions())
    expect(setup?.topology.corridors.map((corridor) => corridor.id)).toContain('BNG-HSP')
    expect(setup?.serviceClasses.length).toBe(6)
  })

  it('fails fast, naming it, when INTERCITY_CORRIDORS names a corridor the bundle does not have', async () => {
    await expect(loadIntercitySetup(baseOptions({ corridors: ['NOT-A-REAL-CORRIDOR'] }))).rejects.toThrow(
      /NOT-A-REAL-CORRIDOR/,
    )
  })

  it('fails fast, naming it, when INTERCITY_HUB_CODES names a hub with no known division', async () => {
    await expect(loadIntercitySetup(baseOptions({ hubCodes: ['ZZZ'] }))).rejects.toThrow(/ZZZ/)
  })

  it('fails fast, naming it, when INTERCITY_SERVICE_CLASSES names a class missing from the table', async () => {
    await expect(loadIntercitySetup(baseOptions({ serviceClassIds: ['not_a_real_class'] }))).rejects.toThrow(
      /not_a_real_class/,
    )
  })

  it('loads the roster and fails fast when a configured corridor has no roster entry', async () => {
    const setup = await loadIntercitySetup(baseOptions())
    expect(setup?.roster.corridors.map((corridor) => corridor.corridorId)).toContain('BNG-HSP')
    // §13.3: the roster is a fixture, not a timetable, and it says so on the
    // file itself as well as in SOURCE.md and on /fleet/corridors.
    expect(setup?.roster.provenance.departures).toBe('authored_secondary')
    expect(setup?.roster.note).toContain('NOTHING IN THIS FILE IS A CLAIM')

    const empty = join(await mkdtemp(join(tmpdir(), 'roster-')), 'empty-roster.json')
    await writeFile(
      empty,
      JSON.stringify({
        note: 'n',
        provenance: { departures: 'authored_secondary', stands: 'authored_secondary' },
        corridors: [],
      }),
    )
    await expect(loadIntercitySetup(baseOptions({ rosterPath: empty }))).rejects.toThrow(/BNG-HSP/)
    await rm(empty)
  })

  it('§3.5: the coach fleet size falls out of the roster rather than being configured', async () => {
    const setup = await loadIntercitySetup(baseOptions())
    const slots = coachSlotsFor(
      setup!,
      ['BNG-HSP'],
      new Date('2026-09-05T14:00:00+05:30'),
      3,
      defaultScheduleProfile,
    )
    // One slot per class the roster actually runs on that corridor, sized to
    // peak concurrency plus the one spare §12.5's substitution needs.
    expect(slots.map((slot) => slot.serviceClassId).sort()).toEqual([
      'airavat',
      'karnataka_sarige',
      'pallakki',
      'rajahamsa_executive',
    ])
    expect(slots.every((slot) => slot.count >= 2)).toBe(true)
    expect(slots.every((slot) => slot.hub === 'KBS' && slot.corporation === 'KSRTC')).toBe(true)
  })
})
