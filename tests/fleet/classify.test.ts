import { describe, expect, it } from 'vitest'
import { classifyCode } from '../../src/fleet/classify.js'

const HUBS = new Set(['BLR'])

describe('code classification', () => {
  it('evaluates the tighter BIN form before plate forms', () => {
    expect(classifyCode('BLR-04126', HUBS).kind).toBe('bin')
    expect(classifyCode('KA01F1234', HUBS).kind).toBe('plate')
    expect(classifyCode('22BH1234AA', HUBS).kind).toBe('plate')
  })

  it('keeps the three accepted structures disjoint', () => {
    const samples = ['BLR04126', 'KA011234', 'KA01ZZ1234', '22BH1234AA']
    expect(samples.map((sample) => classifyCode(sample, HUBS).kind)).toEqual([
      'bin',
      'plate',
      'plate',
      'plate',
    ])
  })

  it('surfaces a bad BIN check character before any lookup', () => {
    expect(classifyCode('BLR-04128', HUBS)).toEqual({
      kind: 'bad_check_character',
      code: 'BLR04128',
    })
    expect(classifyCode('not a vehicle', HUBS).kind).toBe('malformed')
  })
})
