import { describe, expect, it } from 'vitest'
import { dammCheckDigit, hasValidDammCheckDigit } from '../../src/fleet/checkChar.js'

describe('Damm check character', () => {
  it('produces the canonical examples from the function', () => {
    expect(dammCheckDigit('0412')).toBe('6')
    expect(dammCheckDigit('0018')).toBe('2')
  })

  it('rejects every single-digit substitution for every four-digit serial', () => {
    let checked = 0
    for (let value = 0; value < 10_000; value += 1) {
      const payload = String(value).padStart(4, '0')
      const valid = `${payload}${dammCheckDigit(payload)}`
      for (let position = 0; position < valid.length; position += 1) {
        for (let replacement = 0; replacement <= 9; replacement += 1) {
          if (String(replacement) === valid[position]) continue
          const changed = `${valid.slice(0, position)}${replacement}${valid.slice(position + 1)}`
          expect(hasValidDammCheckDigit(changed)).toBe(false)
          checked += 1
        }
      }
    }
    expect(checked).toBe(450_000)
  })

  it('rejects all 27,000 changing adjacent serial transpositions', () => {
    let checked = 0
    for (let value = 0; value < 10_000; value += 1) {
      const payload = String(value).padStart(4, '0')
      const checkedValue = `${payload}${dammCheckDigit(payload)}`
      for (let position = 0; position < payload.length - 1; position += 1) {
        if (payload[position] === payload[position + 1]) continue
        const changed =
          `${payload.slice(0, position)}${payload[position + 1]}${payload[position]}` +
          `${payload.slice(position + 2)}${checkedValue.at(-1)}`
        expect(hasValidDammCheckDigit(changed)).toBe(false)
        checked += 1
      }
    }
    expect(checked).toBe(27_000)
  })
})
