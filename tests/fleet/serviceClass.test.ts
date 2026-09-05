import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import {
  SERVICE_CLASSES,
  loadServiceClasses,
  serviceClassById,
  validateServiceClasses,
} from '../../src/fleet/serviceClass.js'

describe('the service-class table (docs/intercity-coaches.md §2.2)', () => {
  it('keeps the committed bundle byte-identical to its generating source, so the two cannot drift', async () => {
    const committed = await readFile(new URL('../../data/bundle/corridor-classes.json', import.meta.url), 'utf8')
    expect(JSON.parse(committed)).toEqual(SERVICE_CLASSES)
  })

  it('loads and validates the committed bundle against the configured required classes', async () => {
    const classes = await loadServiceClasses(
      new URL('../../data/bundle/corridor-classes.json', import.meta.url).pathname,
      config.intercityServiceClasses,
    )
    expect(classes).toHaveLength(6)
  })

  it('fails startup, naming the missing ones, when a configured class is not in the table', () => {
    expect(() => validateServiceClasses(SERVICE_CLASSES, ['pallakki', 'not_a_real_class'])).toThrow(
      /not_a_real_class/,
    )
  })

  it('marks reservation as a property of the class, matching §1.2 exactly: only Karnataka Sarige is unreserved', () => {
    const reserved = SERVICE_CLASSES.filter((serviceClass) => serviceClass.reserved).map((serviceClass) => serviceClass.id)
    const unreserved = SERVICE_CLASSES.filter((serviceClass) => !serviceClass.reserved).map((serviceClass) => serviceClass.id)
    expect(unreserved).toEqual(['karnataka_sarige'])
    expect(reserved).toEqual(['rajahamsa_executive', 'airavat', 'airavat_club_class', 'ambaari_utsav', 'pallakki'])
  })

  it('resolves an id and returns null for an unknown one', () => {
    expect(serviceClassById('pallakki')?.capacity).toBe(30)
    expect(serviceClassById('not_a_real_class')).toBeNull()
  })
})
