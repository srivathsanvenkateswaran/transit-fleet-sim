import { describe, expect, it } from 'vitest'
import { formatBin, parseBin } from '../../src/fleet/bin.js'

const HUBS = new Set(['BLR', 'MTR'])

describe('BIN', () => {
  it('formats every check digit through Damm', () => {
    expect(formatBin('BLR', 412)).toBe('BLR-04126')
    expect(formatBin('MTR', 18)).toBe('MTR-00182')
  })

  it('normalises accepted input and emits the canonical form', () => {
    expect(parseBin('blr04126', HUBS)).toEqual({
      ok: true,
      value: {
        canonical: 'BLR-04126',
        normalised: 'BLR04126',
        hub: 'BLR',
        serial: '0412',
        checkDigit: '6',
      },
    })
  })

  it('distinguishes a check failure from format and hub failures', () => {
    expect(parseBin('BLR-04128', HUBS)).toEqual({ ok: false, reason: 'bad_check_character' })
    expect(parseBin('XYZ-04126', HUBS)).toEqual({ ok: false, reason: 'unknown_hub' })
    expect(parseBin('BLR-4126', HUBS)).toEqual({ ok: false, reason: 'malformed' })
  })
})
