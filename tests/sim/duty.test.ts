import { describe, expect, it } from 'vitest'
import {
  createDutyState,
  defaultBusDutyProfile,
  maybeSwapDuty,
  validateDutyProfile,
} from '../../src/sim/duty.js'

const START = new Date('2026-08-20T03:00:00Z')

describe('duty state machine', () => {
  it('refuses a distribution that does not sum to one', () => {
    expect(() =>
      validateDutyProfile({
        ...defaultBusDutyProfile,
        confirmedShare: 0.6,
        inferredShare: 0.2,
        unknownShare: 0.1,
        outOfServiceShare: 0.05,
      }),
    ).toThrow('Duty shares must sum to 1.0')
  })

  it('can force each duty state through its configured share', () => {
    for (const status of ['confirmed', 'inferred', 'unknown', 'out_of_service'] as const) {
      const profile = forcedDutyProfile(status)
      expect(createDutyState('BLR-04126', START, '20260820', profile).status).toBe(status)
    }
  })

  it('sets confidence only for inferred duty and inside its configured range', () => {
    for (const status of ['confirmed', 'inferred', 'unknown', 'out_of_service'] as const) {
      const profile = forcedDutyProfile(status)
      const state = createDutyState('BLR-04126', START, '20260820', profile)
      if (status === 'inferred') {
        expect(state.confidence).toBeGreaterThanOrEqual(profile.inferredConfidenceMin)
        expect(state.confidence).toBeLessThanOrEqual(profile.inferredConfidenceMax)
      } else {
        expect(state.confidence).toBeNull()
      }
    }
  })

  it('drops a confirmed roster to inferred or unknown without a device input', () => {
    const profile = { ...forcedDutyProfile('confirmed'), swapRatePerDay: 1_000_000 }
    const state = createDutyState('BLR-04126', START, '20260820', profile)
    maybeSwapDuty(state, 'BLR-04126', new Date(START.getTime() + 60_000), profile)
    expect(['inferred', 'unknown']).toContain(state.status)
    expect(state.reason).toBe('roster_swapped')
  })
})

function forcedDutyProfile(status: 'confirmed' | 'inferred' | 'unknown' | 'out_of_service') {
  return {
    ...defaultBusDutyProfile,
    confirmedShare: status === 'confirmed' ? 1 : 0,
    inferredShare: status === 'inferred' ? 1 : 0,
    unknownShare: status === 'unknown' ? 1 : 0,
    outOfServiceShare: status === 'out_of_service' ? 1 : 0,
    swapRatePerDay: 0,
  }
}
