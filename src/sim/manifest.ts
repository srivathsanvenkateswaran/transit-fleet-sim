import type { ManifestRef } from '../world/port.js'

/**
 * The manifest ingress - docs/intercity-coaches.md §7.4 and §7.5.
 *
 * **The BPP pushes and this service never pulls**, and the argument is
 * structural rather than a preference: criterion 44/109 is a test that `src/`
 * contains no outbound HTTP client at all, and a pull would break a property
 * the repository asserts mechanically, for one field. A push also happens
 * exactly when there is something to say - a `confirm` that succeeded, a
 * cancellation that completed - both of which are already server-authoritative
 * on the other side.
 *
 * **The payload split is the subtlest thing in this file.** The BPP's seat
 * map has three sources and only two of them are facts it holds: seeded
 * occupancy marked `simulated`, live holds, and confirmed bookings. A single
 * `seatsSold` number would carry the provider's own seeded fill across the
 * boundary, and this service republishing it would give a fabrication a
 * second source and make it look corroborated. So:
 *
 *   - `booked` is published. Confirmed bookings the BPP actually holds.
 *   - `simulated` is accepted, recorded, and never published. It is a fact
 *     about the BPP's screen and about nothing else. Accepted rather than
 *     rejected so the two services can reconcile a seat map in a log without
 *     either of them lying on a response.
 *   - `held` is accepted, recorded, and never published. A hold lapses on a
 *     600-second TTL and is not a sale.
 *
 * There is deliberately no configuration that changes any of the above, and
 * `StoredManifest` keeps `held` and `simulated` on a type that `publish()`
 * cannot reach: the only function that produces a `ManifestRef` is below, and
 * `ManifestRef` has nowhere for either number to go.
 */

export interface ManifestKey {
  readonly serviceId: string
  readonly travelDate: string
}

export interface StoredManifest {
  readonly serviceId: string
  readonly travelDate: string
  readonly seatsTotal: number
  readonly seatsBooked: number
  /** Recorded and never published. §7.4. */
  readonly seatsHeld: number
  /** Recorded and never published. §7.4. */
  readonly seatsSimulated: number
  readonly asOf: Date
  readonly receivedAt: Date
  readonly expiresAt: Date
}

export interface ManifestProfile {
  readonly maxAgeSeconds: number
  readonly ttlMaxSeconds: number
}

export type ManifestPutOutcome =
  | { readonly kind: 'stored'; readonly manifest: StoredManifest }
  | {
      readonly kind: 'discarded_out_of_order'
      readonly held: StoredManifest
      readonly rejectedAsOf: string
    }
  | { readonly kind: 'invalid'; readonly message: string }

export class ManifestStore {
  readonly #byKey = new Map<string, StoredManifest>()
  readonly #profile: ManifestProfile

  constructor(profile: ManifestProfile) {
    this.#profile = profile
  }

  /**
   * §7.4's validation, and the reasons rather than the list.
   *
   * `asOf` is the version. Pushes can arrive out of order - a cancellation
   * overtaking the confirm it follows - and a stale count clobbering a fresh
   * one would be silently wrong for an hour. A push whose `asOf` is not
   * strictly newer than the stored one is accepted, discarded, and the
   * response says which one is held.
   */
  put(body: unknown, at: Date): ManifestPutOutcome {
    const parsed = parsePush(body, this.#profile, at)
    if (parsed.kind === 'invalid') return parsed
    const push = parsed.push
    const key = keyOf(push)
    const held = this.get(push.serviceId, push.travelDate, at)
    if (held !== null && push.asOf.getTime() <= held.asOf.getTime()) {
      return { kind: 'discarded_out_of_order', held, rejectedAsOf: push.asOf.toISOString() }
    }
    const stored: StoredManifest = {
      serviceId: push.serviceId,
      travelDate: push.travelDate,
      seatsTotal: push.total,
      seatsBooked: push.booked,
      seatsHeld: push.held,
      seatsSimulated: push.simulated,
      asOf: push.asOf,
      receivedAt: new Date(at),
      expiresAt: new Date(at.getTime() + push.ttlSeconds * 1_000),
    }
    this.#byKey.set(key, stored)
    return { kind: 'stored', manifest: stored }
  }

  /**
   * §7.6: "No last-known count is kept alive past its expiry and no reason is
   * published for its absence", because a push-based ingress cannot
   * distinguish "the BPP is down" from "nobody has booked this coach", and a
   * service that named one of those would be guessing about a system it
   * cannot see.
   */
  get(serviceId: string, travelDate: string, at: Date): StoredManifest | null {
    const stored = this.#byKey.get(keyOf({ serviceId, travelDate }))
    if (stored === undefined) return null
    if (at.getTime() >= stored.expiresAt.getTime()) return null
    const ageSeconds = (at.getTime() - stored.asOf.getTime()) / 1_000
    if (ageSeconds > this.#profile.maxAgeSeconds) return null
    return stored
  }

  /** §7.4: what a cancellation of the last booking sends, rather than a `booked: 0` push. */
  delete(serviceId: string | null, travelDate: string | null): number {
    if (serviceId === null && travelDate === null) {
      const size = this.#byKey.size
      this.#byKey.clear()
      return size
    }
    if (serviceId === null || travelDate === null) return 0
    return this.#byKey.delete(keyOf({ serviceId, travelDate })) ? 1 : 0
  }

  size(): number {
    return this.#byKey.size
  }
}

/**
 * The only place a stored manifest becomes something a response carries.
 *
 * `seatsBooked` is the push's `booked` field and never `booked + held` or
 * `booked + simulated` (criterion 85). `covers` is the load-bearing field and
 * does not go away when the data gets better: booked is not boarded, and this
 * network is one sales channel among counters, AWATAR direct and several
 * aggregators, so the count is **structurally a lower bound on sales** and
 * will still be one when the provider is real (§7.5).
 */
export function publishManifest(stored: StoredManifest, at: Date): ManifestRef {
  return {
    seatsBooked: stored.seatsBooked,
    seatsTotal: stored.seatsTotal,
    asOf: stored.asOf.toISOString(),
    // §7.6: a manifest is a measurement taken at an instant, exactly as a
    // GNSS fix is. It is published with its age and never freshened - the
    // service does not increment a count because a booking is probably in
    // flight, for the same reason it does not extrapolate a dark vehicle's
    // position forward.
    ageSeconds: Math.max(0, Math.floor((at.getTime() - stored.asOf.getTime()) / 1_000)),
    source: 'bpp',
    covers: 'bookings_through_this_network_only',
  }
}

interface ParsedPush {
  readonly serviceId: string
  readonly travelDate: string
  readonly total: number
  readonly booked: number
  readonly held: number
  readonly simulated: number
  readonly asOf: Date
  readonly ttlSeconds: number
}

function parsePush(
  body: unknown,
  profile: ManifestProfile,
  at: Date,
): { kind: 'ok'; push: ParsedPush } | { kind: 'invalid'; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { kind: 'invalid', message: 'A manifest push must be a JSON object.' }
  }
  const record = body as Record<string, unknown>
  const serviceId = record.serviceId
  const travelDate = record.travelDate
  if (typeof serviceId !== 'string' || serviceId === '') {
    return { kind: 'invalid', message: 'serviceId is required.' }
  }
  if (typeof travelDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) {
    return { kind: 'invalid', message: 'travelDate must be an ISO YYYY-MM-DD date.' }
  }
  const seats = record.seats
  if (typeof seats !== 'object' || seats === null) {
    return { kind: 'invalid', message: 'seats is required.' }
  }
  const seatRecord = seats as Record<string, unknown>
  const counts: Record<string, number> = {}
  for (const field of ['total', 'booked', 'held', 'simulated']) {
    const value = seatRecord[field]
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      return { kind: 'invalid', message: `seats.${field} must be a non-negative integer.` }
    }
    counts[field] = value as number
  }
  const total = counts.total!
  const booked = counts.booked!
  const held = counts.held!
  const simulated = counts.simulated!
  if (booked > total) {
    return { kind: 'invalid', message: `seats.booked (${booked}) exceeds seats.total (${total}).` }
  }
  // §7.4: "A payload whose `booked + held + simulated` exceeds `total` is
  // 400." A seat map that adds up to more seats than the coach has is not a
  // seat map, whichever of the three is wrong.
  if (booked + held + simulated > total) {
    return {
      kind: 'invalid',
      message: `seats.booked + seats.held + seats.simulated (${booked + held + simulated}) exceeds seats.total (${total}).`,
    }
  }
  const asOfRaw = record.asOf
  if (typeof asOfRaw !== 'string') return { kind: 'invalid', message: 'asOf is required.' }
  const asOf = new Date(asOfRaw)
  if (!Number.isFinite(asOf.getTime())) {
    return { kind: 'invalid', message: 'asOf must be an RFC 3339 instant.' }
  }
  // §7.4: "A manifest that claims to know tomorrow's sales is not a manifest."
  if (asOf.getTime() > at.getTime()) {
    return { kind: 'invalid', message: 'asOf must not be in the future.' }
  }
  const ttlRaw = record.ttlSeconds
  // Required, on the same reasoning as the scenario TTL: a manifest left in
  // place forever is a service that quietly stopped telling the truth while
  // `/readyz` still says ready.
  if (!Number.isSafeInteger(ttlRaw) || (ttlRaw as number) < 1 || (ttlRaw as number) > profile.ttlMaxSeconds) {
    return {
      kind: 'invalid',
      message: `ttlSeconds is required and must be an integer from 1 to ${profile.ttlMaxSeconds}.`,
    }
  }
  return {
    kind: 'ok',
    push: {
      serviceId,
      travelDate,
      total,
      booked,
      held,
      simulated,
      asOf,
      ttlSeconds: ttlRaw as number,
    },
  }
}

function keyOf(key: ManifestKey): string {
  return `${key.serviceId}|${key.travelDate}`
}
