import { describe, expect, it, vi } from 'vitest'
import { resolveVehicle } from '../../src/api/resolve.js'
import { formatBin } from '../../src/fleet/bin.js'
import { FleetRegistry, type FleetVehicle } from '../../src/fleet/registry.js'
import type { DutyStatus, TrackingState } from '../../src/world/port.js'
import {
  FAKE_NOW,
  FakeWorld,
  fakeDuty,
  fakeObservation,
  fakeTracking,
} from '../fakes/fakeWorld.js'

const BUS: FleetVehicle = {
  bin: formatBin('BLR', 412),
  class: 'bus',
  homeRouteNumber: '500-D',
  plates: [
    {
      normalised: 'KA01ZZ9902',
      display: 'KA-01-ZZ-9902',
      since: '2023-06-01',
      until: '2026-02-14',
      reason: 'original_registration',
    },
    {
      normalised: 'KA01ZZ1234',
      display: 'KA-01-ZZ-1234',
      since: '2026-02-14',
      until: null,
      reason: 're_registration',
    },
  ],
}
const METRO: FleetVehicle = {
  bin: formatBin('MTR', 18),
  class: 'metro',
  homeRouteNumber: 'purple',
  plates: [],
}

describe('resolve contract', () => {
  it('normalises all documented BIN forms to the same response', () => {
    const world = new FakeWorld({ observations: [fakeObservation(BUS.bin, 'confirmed', 'live')] })
    const registry = new FleetRegistry([BUS])
    const bodies = ['BLR-04126', 'blr04126', 'BLR 04126'].map(
      (code) => resolveVehicle({ code, entry: null, at: null }, world, registry).body,
    )
    expect(bodies[1]).toEqual(bodies[0])
    expect(bodies[2]).toEqual(bodies[0])
  })

  it('makes manual entry strict and scan entry frictionless', () => {
    const world = new FakeWorld({ observations: [fakeObservation(BUS.bin, 'confirmed', 'live')] })
    const registry = new FleetRegistry([BUS])
    const manual = resolveVehicle({ code: BUS.bin, entry: 'manual', at: null }, world, registry)
    const implicit = resolveVehicle({ code: BUS.bin, entry: null, at: null }, world, registry)
    const scan = resolveVehicle({ code: BUS.bin, entry: 'scan', at: null }, world, registry)
    expect(manual.body).toMatchObject({ confirmation: { required: true } })
    expect(implicit.body).toMatchObject({ confirmation: { required: true } })
    expect(scan.body).toMatchObject({ confirmation: { required: false } })
  })

  it('returns a bad check character before consulting the registry', () => {
    const registry = new FleetRegistry([BUS])
    const lookup = vi.spyOn(registry, 'findByBin')
    const result = resolveVehicle(
      { code: 'BLR-04128', entry: null, at: null },
      new FakeWorld(),
      registry,
    )
    expect(result).toMatchObject({ status: 400, body: { error: 'bad_check_character' } })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('keeps unknown, retired, absent-today and wrong-class outcomes distinct', () => {
    const registry = new FleetRegistry([BUS, METRO])
    const withdrawn = new FakeWorld({
      observations: [fakeObservation(BUS.bin, fakeDuty('out_of_service', { reason: 'withdrawn' }), 'live')],
    })
    expect(
      resolveVehicle(
        { code: formatBin('BLR', 9_999), entry: null, at: null },
        withdrawn,
        registry,
      ),
    ).toMatchObject({ status: 404, body: { error: 'unknown_bin' } })
    expect(
      resolveVehicle({ code: 'KA01ZZ5555', entry: null, at: null }, withdrawn, registry),
    ).toMatchObject({ status: 404, body: { error: 'unknown_plate' } })
    const retired = resolveVehicle(
      { code: 'KA01ZZ9902', entry: null, at: null },
      withdrawn,
      registry,
    )
    expect(retired).toEqual({
      status: 404,
      body: {
        error: 'plate_no_longer_current',
        message: 'That registration was retired on 14 February 2026.',
        retiredOn: '2026-02-14',
      },
    })
    expect(JSON.stringify(retired.body)).not.toContain(BUS.bin)
    expect(JSON.stringify(retired.body)).not.toContain('KA01ZZ1234')
    expect(resolveVehicle({ code: BUS.bin, entry: null, at: null }, withdrawn, registry)).toMatchObject({
      status: 200,
      body: { duty: { status: 'out_of_service', reason: 'withdrawn' } },
    })
    expect(resolveVehicle({ code: METRO.bin, entry: null, at: null }, withdrawn, registry)).toMatchObject({
      status: 422,
      body: { error: 'not_a_resolvable_code', class: 'metro', seeInstead: '/fleet/metro/arrivals' },
    })
  })

  it('answers all sixteen independent duty and tracking cells', () => {
    const duties: DutyStatus[] = ['confirmed', 'inferred', 'unknown', 'out_of_service']
    const trackingStates: TrackingState[] = ['live', 'stale', 'dark', 'untracked']
    const registry = new FleetRegistry([BUS])
    for (const duty of duties) {
      for (const tracking of trackingStates) {
        const world = new FakeWorld({ observations: [fakeObservation(BUS.bin, duty, tracking)] })
        const result = resolveVehicle({ code: BUS.bin, entry: null, at: null }, world, registry)
        expect(result).toMatchObject({
          status: 200,
          body: { duty: { status: duty }, tracking: { state: tracking } },
        })
      }
    }
  })

  it('nulls every unsupported claim in unknown, stale and untracked states', () => {
    const world = new FakeWorld({
      now: FAKE_NOW,
      observations: [
        fakeObservation(BUS.bin, 'unknown', fakeTracking('stale')),
      ],
    })
    const result = resolveVehicle(
      { code: BUS.bin, entry: null, at: null },
      world,
      new FleetRegistry([BUS]),
    )
    expect(result.body).toMatchObject({
      duty: {
        route: null,
        headsign: null,
        directionId: null,
        trip: null,
        since: null,
        confidence: null,
      },
      tracking: { state: 'stale', progress: null },
      confirmation: { verify: [{ label: 'Number plate', value: 'KA-01-ZZ-1234' }] },
    })

    const untrackedWorld = new FakeWorld({ observations: [fakeObservation(BUS.bin, 'confirmed', 'untracked')] })
    const untracked = resolveVehicle(
      { code: BUS.bin, entry: null, at: null },
      untrackedWorld,
      new FleetRegistry([BUS]),
    )
    expect(untracked.body).toMatchObject({
      tracking: { state: 'untracked', fixAgeSeconds: null, observedAt: null, position: null },
    })
  })
})
