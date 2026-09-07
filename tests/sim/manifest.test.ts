import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { ManifestStore, publishManifest } from '../../src/sim/manifest.js'
import { binFor, coachHarness, pallakkiDuty } from '../fakes/coachWorld.js'

/**
 * docs/intercity-coaches.md §7.4 and §7.5: the manifest ingress.
 *
 * The payload split is the subtlest thing in the document. The BPP's seat map
 * has three sources and only two are facts it holds: seeded occupancy, live
 * holds, and confirmed bookings. A single `seatsSold` number would carry the
 * provider's own seeded fill across the boundary, and **this service
 * republishing it would give a fabrication a second source and make it look
 * corroborated.**
 */

const BOOT_AT = new Date('2026-09-05T14:00:00+05:30')
const NOW = new Date('2026-09-05T16:45:00Z')

function push(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: '2259BNGHMP',
    travelDate: '2026-09-05',
    seats: { total: 30, booked: 4, held: 2, simulated: 17 },
    asOf: '2026-09-05T16:40:00Z',
    ttlSeconds: 3_600,
    ...overrides,
  }
}

function store() {
  return new ManifestStore({
    maxAgeSeconds: config.intercityManifestMaxAgeSeconds,
    ttlMaxSeconds: config.intercityManifestTtlMaxSeconds,
  })
}

describe('the manifest ingress (§7.4)', () => {
  it('criterion 86: held and simulated are accepted at the door, recorded, and never published', async () => {
    const manifests = store()
    const outcome = manifests.put(push(), NOW)
    expect(outcome.kind).toBe('stored')
    const held = manifests.get('2259BNGHMP', '2026-09-05', NOW)!
    // Recorded, so the two services can reconcile a seat map in a log.
    expect(held.seatsHeld).toBe(2)
    expect(held.seatsSimulated).toBe(17)
    // And absent from the published shape, which has nowhere to put them.
    const published = publishManifest(held, NOW)
    expect(Object.keys(published).sort()).toEqual([
      'ageSeconds',
      'asOf',
      'covers',
      'seatsBooked',
      'seatsTotal',
      'source',
    ])
    expect(JSON.stringify(published)).not.toContain('17')
  })

  it('criterion 86: a push carrying simulated 17 and booked 0 yields seatsBooked 0', () => {
    // "This is the criterion that stops the provider's seeded fill acquiring
    // a second source." A screen showing seventeen seats taken is a fact
    // about that screen, and about nothing else.
    const manifests = store()
    manifests.put(push({ seats: { total: 30, booked: 0, held: 0, simulated: 17 } }), NOW)
    const published = publishManifest(manifests.get('2259BNGHMP', '2026-09-05', NOW)!, NOW)
    expect(published.seatsBooked).toBe(0)
  })

  it('criterion 85: seatsBooked is the push’s booked field, never booked + held or booked + simulated', () => {
    const manifests = store()
    manifests.put(push(), NOW)
    const published = publishManifest(manifests.get('2259BNGHMP', '2026-09-05', NOW)!, NOW)
    expect(published.seatsBooked).toBe(4)
    expect(published.seatsTotal).toBe(30)
    expect(published.source).toBe('bpp')
    // §7.5: `covers` is the load-bearing field and it does not go away when
    // the data gets better. Booked is not boarded, and this network is one
    // sales channel among counters, AWATAR direct and several aggregators.
    expect(published.covers).toBe('bookings_through_this_network_only')
  })

  it('criterion 87: an out-of-order push is accepted, discarded, and the response names the manifest still held', () => {
    const manifests = store()
    // A cancellation overtaking the confirm it follows.
    manifests.put(push({ asOf: '2026-09-05T16:40:00Z', seats: { total: 30, booked: 4, held: 0, simulated: 0 } }), NOW)
    const stale = manifests.put(
      push({ asOf: '2026-09-05T16:20:00Z', seats: { total: 30, booked: 9, held: 0, simulated: 0 } }),
      NOW,
    )
    expect(stale.kind).toBe('discarded_out_of_order')
    if (stale.kind !== 'discarded_out_of_order') throw new Error('unreachable')
    expect(stale.held.seatsBooked).toBe(4)
    expect(stale.rejectedAsOf).toBe(new Date('2026-09-05T16:20:00Z').toISOString())
    // A push at exactly the stored `asOf` is not newer either.
    expect(manifests.put(push({ asOf: '2026-09-05T16:40:00Z' }), NOW).kind).toBe(
      'discarded_out_of_order',
    )
    expect(manifests.get('2259BNGHMP', '2026-09-05', NOW)!.seatsBooked).toBe(4)
  })

  it('criterion 88: a manifest past its own TTL or past the max age disappears entirely', () => {
    const manifests = store()
    manifests.put(push({ ttlSeconds: 60 }), NOW)
    expect(manifests.get('2259BNGHMP', '2026-09-05', NOW)).not.toBeNull()
    // Past its own TTL.
    expect(manifests.get('2259BNGHMP', '2026-09-05', new Date(NOW.getTime() + 61_000))).toBeNull()

    // And past INTERCITY_MANIFEST_MAX_AGE_SECONDS, measured from `asOf`
    // rather than from receipt: a manifest is a measurement taken at an
    // instant, exactly as a GNSS fix is.
    const aged = store()
    aged.put(push({ ttlSeconds: 86_400 }), NOW)
    const beyond = new Date(
      new Date('2026-09-05T16:40:00Z').getTime() +
        (config.intercityManifestMaxAgeSeconds + 1) * 1_000,
    )
    expect(aged.get('2259BNGHMP', '2026-09-05', beyond)).toBeNull()
  })

  it('rejects a payload that adds up to more seats than the coach has, and one that knows tomorrow’s sales', () => {
    const manifests = store()
    expect(manifests.put(push({ seats: { total: 30, booked: 31, held: 0, simulated: 0 } }), NOW)).toMatchObject({
      kind: 'invalid',
    })
    expect(manifests.put(push({ seats: { total: 30, booked: 20, held: 8, simulated: 5 } }), NOW)).toMatchObject({
      kind: 'invalid',
    })
    // "A manifest that claims to know tomorrow's sales is not a manifest."
    expect(manifests.put(push({ asOf: '2026-09-06T00:00:00Z' }), NOW)).toMatchObject({ kind: 'invalid' })
  })

  it('requires a TTL in range: a manifest left in place forever is a service that quietly stopped telling the truth', () => {
    const manifests = store()
    expect(manifests.put(push({ ttlSeconds: undefined }), NOW)).toMatchObject({ kind: 'invalid' })
    expect(manifests.put(push({ ttlSeconds: 0 }), NOW)).toMatchObject({ kind: 'invalid' })
    expect(
      manifests.put(push({ ttlSeconds: config.intercityManifestTtlMaxSeconds + 1 }), NOW),
    ).toMatchObject({ kind: 'invalid' })
    expect(manifests.put(push({ ttlSeconds: config.intercityManifestTtlMaxSeconds }), NOW).kind).toBe(
      'stored',
    )
  })

  it('DELETE clears one or all, so "nobody has booked" and "we no longer hold a count" stay distinguishable', () => {
    const manifests = store()
    manifests.put(push(), NOW)
    manifests.put(push({ serviceId: '2115BNGHMP' }), NOW)
    expect(manifests.delete('2259BNGHMP', '2026-09-05')).toBe(1)
    expect(manifests.get('2259BNGHMP', '2026-09-05', NOW)).toBeNull()
    expect(manifests.get('2115BNGHMP', '2026-09-05', NOW)).not.toBeNull()
    expect(manifests.delete(null, null)).toBe(1)
    expect(manifests.size()).toBe(0)
  })

  it('criterion 91: a travel date whose departure falls after midnight resolves to the previous service date, and the response says so', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    // The 00:30 relief: booked for travel on the 6th, filed under service
    // date the 5th. "That mismatch is a live trap between two systems that
    // both look right."
    const result = simulation.putManifest(
      {
        serviceId: '0030BNGHMP',
        travelDate: '2026-09-06',
        seats: { total: 45, booked: 3, held: 1, simulated: 8 },
        asOf: '2026-09-05T16:40:00Z',
        ttlSeconds: 3_600,
      },
      NOW,
    )
    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.travelDate).toBe('2026-09-06')
    expect(body.serviceDate).toBe('20260905')
    expect(body.dutyId).toBe('BNG-HSP-20260905-2430')
    expect(body.note).toBe('This departure belongs to the previous GTFS service date.')
    expect(body.stored).toMatchObject({ seatsBooked: 3, seatsTotal: 45 })
  })

  it('§7.6: the middle window - between a booking confirming and its push landing, the held manifest is published unincremented', async () => {
    const { simulation } = await coachHarness(BOOT_AT, {
      device: {
        seed: 1,
        coverageShareReserved: 1,
        coverageShareOrdinary: 1,
        fixIntervalSeconds: 30,
        fixIntervalStationarySeconds: 120,
        fixJitterSeconds: 8,
        staleAfterSeconds: 180,
        darkAfterSeconds: 600,
        gpsNoiseMetres: 12,
        urbanDropoutRatePerHour: 0,
        urbanDropoutMinSeconds: 60,
        urbanDropoutMaxSeconds: 420,
      },
    })
    const duty = pallakkiDuty(simulation)
    const bin = binFor(simulation, duty.id)
    const at = new Date(duty.departureAt.getTime() + 30 * 60_000)

    // Before any push: no `manifest` key at all, and no reason for its
    // absence - a push-based ingress cannot distinguish "the BPP is down"
    // from "nobody has booked this coach".
    const before = simulation.observe(bin, at)!
    expect(before.duty.reservation?.required).toBe(true)
    expect(before.duty.reservation && 'manifest' in before.duty.reservation).toBe(false)

    simulation.putManifest(
      {
        serviceId: duty.serviceId,
        travelDate: duty.travelDate,
        seats: { total: 30, booked: 4, held: 2, simulated: 17 },
        asOf: new Date(at.getTime() - 214_000).toISOString(),
        ttlSeconds: 3_600,
      },
      at,
    )
    const after = simulation.observe(bin, at)!
    expect(after.duty.reservation?.manifest).toMatchObject({
      seatsBooked: 4,
      seatsTotal: 30,
      ageSeconds: 214,
      covers: 'bookings_through_this_network_only',
    })
    // Ten minutes later the count is unchanged and only its age has moved:
    // the service does not increment a count because a booking is probably
    // in flight, for the same reason it does not extrapolate a dark
    // vehicle's position forward.
    const later = simulation.observe(bin, new Date(at.getTime() + 600_000))!
    expect(later.duty.reservation?.manifest?.seatsBooked).toBe(4)
    expect(later.duty.reservation?.manifest?.ageSeconds).toBe(814)
  })
})
