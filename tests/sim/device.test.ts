import { describe, expect, it } from 'vitest'
import type { Position } from '../../src/world/port.js'
import {
  addGpsNoise,
  createDeviceState,
  defaultBusDeviceProfile,
  trackingObservation,
  updateDevice,
} from '../../src/sim/device.js'

const START = new Date('2026-08-20T03:00:00Z')
const POSITION: Position = {
  lat: 12.97,
  lon: 77.59,
  bearing: 45,
  speedKph: 17,
  accuracyMetres: 0,
}
const snapshot = () => ({ position: POSITION, progress: null })

describe('bus device model', () => {
  it('makes no-device coverage terminal and honest', () => {
    const profile = { ...defaultBusDeviceProfile, coverageShare: 0 }
    const state = createDeviceState('BLR-04126', START, snapshot, profile)
    expect(trackingObservation(state, START, true, profile)).toMatchObject({
      state: 'untracked',
      observedAt: null,
      position: null,
      progress: null,
      reason: 'no_device_fitted',
    })
  })

  it('ages a retained fix through live, stale and dark without extrapolation', () => {
    const profile = {
      ...defaultBusDeviceProfile,
      coverageShare: 1,
      fixIntervalSeconds: 1_000,
      fixJitterSeconds: 0,
      staleAfterSeconds: 10,
      darkAfterSeconds: 20,
      dropoutRatePerHour: 0,
    }
    const state = createDeviceState('BLR-04126', START, snapshot, profile)
    expect(trackingObservation(state, START, true, profile).state).toBe('live')
    const stale = trackingObservation(state, new Date(START.getTime() + 11_000), true, profile)
    const dark = trackingObservation(state, new Date(START.getTime() + 21_000), true, profile)
    expect(stale).toMatchObject({ state: 'stale', position: POSITION, progress: null })
    expect(dark).toMatchObject({ state: 'dark', position: POSITION, progress: null })
  })

  it('suppresses fixes during a seeded dropout and marks the reconnect fix', () => {
    const profile = {
      ...defaultBusDeviceProfile,
      seed: 31,
      coverageShare: 1,
      fixIntervalSeconds: 20,
      fixJitterSeconds: 0,
      dropoutRatePerHour: 60,
      dropoutMinSeconds: 60,
      dropoutMaxSeconds: 60,
    }
    const state = createDeviceState('BLR-04126', START, snapshot, profile)
    let sawDropout = false
    let recoveredAt: Date | null = null
    for (let minute = 1; minute <= 1_000; minute += 1) {
      const at = new Date(START.getTime() + minute * 60_000)
      const wasDropping = state.dropoutActive
      updateDevice(state, at, snapshot, profile)
      sawDropout ||= state.dropoutActive
      if (wasDropping && !state.dropoutActive) {
        recoveredAt = at
        break
      }
    }
    expect(sawDropout).toBe(true)
    expect(recoveredAt).not.toBeNull()
    expect(trackingObservation(state, recoveredAt!, true, profile).recoveredFromDropout).toBe(true)
  })

  it('adds deterministic off-polyline GNSS noise and reports its accuracy', () => {
    const profile = { ...defaultBusDeviceProfile, gpsNoiseMetres: 12 }
    const first = addGpsNoise(POSITION, profile, 'BLR-04126', 4)
    expect(first).toEqual(addGpsNoise(POSITION, profile, 'BLR-04126', 4))
    expect(first).not.toEqual(POSITION)
    expect(first.accuracyMetres).toBe(12)
  })
})
