import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { loadIntercitySetup } from '../../src/sim/intercitySetup.js'

/**
 * docs/intercity-coaches.md §12.1: turning `INTERCITY_CORRIDORS` on loads and
 * cross-checks the corridor, hub and service-class configuration, and fails
 * fast, naming the offending value, rather than booting half-configured.
 */

function baseOptions(overrides: Partial<Parameters<typeof loadIntercitySetup>[0]> = {}) {
  return {
    corridors: ['BNG-HSP'],
    topologyPath: config.intercityTopologyPath,
    hubCodes: config.intercityHubCodes,
    serviceClassIds: config.intercityServiceClasses,
    classesPath: new URL('../../data/bundle/corridor-classes.json', import.meta.url).pathname,
    ...overrides,
  }
}

describe('loading the intercity setup', () => {
  it('is off by default: an empty corridor list loads nothing and reads no file', async () => {
    const setup = await loadIntercitySetup(baseOptions({ corridors: [], topologyPath: '/does/not/exist.json' }))
    expect(setup).toBeNull()
  })

  it('loads the real bundled topology and service-class table when a known corridor is named', async () => {
    const setup = await loadIntercitySetup(baseOptions())
    expect(setup?.topology.corridors.map((corridor) => corridor.id)).toEqual(['BNG-HSP'])
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
})
