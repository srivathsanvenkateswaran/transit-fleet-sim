import { describe, expect, it } from 'vitest'
import { parsePlate } from '../../src/fleet/plate.js'

describe('plate parser', () => {
  it('normalises and displays standard plates', () => {
    expect(parsePlate('ka01f1234')).toEqual({
      normalised: 'KA01F1234',
      display: 'KA-01-F-1234',
      kind: 'standard',
    })
    expect(parsePlate('KA1ZZ0001')?.display).toBe('KA-01-ZZ-0001')
  })

  it('accepts and formats BH plates defensively', () => {
    expect(parsePlate('22bh1234aa')).toEqual({
      normalised: '22BH1234AA',
      display: '22-BH-1234-AA',
      kind: 'bh',
    })
  })

  it('rejects malformed plates', () => {
    expect(parsePlate('KA-01-F-123')).toBeNull()
  })
})
