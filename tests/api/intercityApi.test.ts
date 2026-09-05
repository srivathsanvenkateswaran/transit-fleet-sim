import { once } from 'node:events'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiServer } from '../../src/api/server.js'
import { resolveVehicle } from '../../src/api/resolve.js'
import { FleetRegistry, type FleetVehicle } from '../../src/fleet/registry.js'
import { defaultCoachProfiles } from '../../src/sim/coachProfiles.js'
import type { CoachSimulation } from '../../src/sim/coachWorld.js'
import {
  binFor,
  coachHarness,
  coachWorldPort,
  pallakkiDuty,
  sarigeDuty,
} from '../fakes/coachWorld.js'

/**
 * docs/intercity-coaches.md §10: the HTTP surface.
 *
 * "Every path in SPEC section 7 keeps its shape. Three fields are added to
 * two existing responses, three endpoints are new, and one endpoint's
 * behaviour is deliberately unchanged."
 */

// 02:14 IST on 6 September: the instant §16's demo freezes on, with the
// Pallakki sleeper on the road and the Karnataka Sarige finished for the day.
const NOW = new Date('2026-09-06T02:14:00+05:30')
const MANIFEST_TOKEN = 'manifest-token-for-the-peer'
const ADMIN_TOKEN = 'admin-token-for-the-operator'

/** `Response.json()` is `unknown` under this project's compiler options. */
async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>
}

const FULL_COVERAGE = {
  ...defaultCoachProfiles.device,
  coverageShareReserved: 1,
  coverageShareOrdinary: 1,
}

describe('the intercity HTTP surface (§10)', () => {
  let server: Server
  let baseUrl: string
  let simulation: CoachSimulation
  let registry: FleetRegistry
  let coaches: readonly FleetVehicle[]

  beforeEach(async () => {
    const harness = await coachHarness(NOW, { device: FULL_COVERAGE })
    simulation = harness.simulation
    coaches = harness.coaches
    registry = new FleetRegistry(coaches)
    server = createApiServer(coachWorldPort(simulation, NOW), registry, {
      intercity: simulation,
      manifestToken: MANIFEST_TOKEN,
    })
    server.listen(0)
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    baseUrl = `http://${host}:${address.port}`
  })

  afterEach(async () => {
    server.close()
    await once(server, 'close')
  })

  it('criterion 93: a coach BIN and a coach plate both resolve 200, and carry corporation and service class', async () => {
    const duty = pallakkiDuty(simulation, '20260905')
    const bin = binFor(simulation, duty.id)
    const vehicle = coaches.find((candidate) => candidate.bin === bin)!
    const plate = vehicle.plates[0]!.display

    for (const code of [bin, plate]) {
      const result = resolveVehicle(
        { code, entry: 'manual', at: null },
        coachWorldPort(simulation, NOW),
        registry,
      )
      expect(result.status).toBe(200)
      const body = result.body as Record<string, any>
      expect(body.vehicle.class).toBe('coach')
      // §1.1/§2.1: provenance, disclosed plainly because no consumer surface
      // in Karnataka does, and framed as a fact about this simulation.
      expect(body.vehicle.corporation).toEqual({
        code: 'KSRTC',
        name: 'Karnataka State Road Transport Corporation',
        simulated: true,
      })
      expect(body.vehicle.serviceClass).toMatchObject({
        id: 'pallakki',
        reserved: true,
        capacity: 30,
        // §2.2: `capacitySource` is not decoration - a manifest's denominator
        // is only as good as this figure, and today every row is secondary.
        capacitySource: 'secondary',
      })
      expect(body.vehicle.hub).toEqual({ code: 'KBS', name: 'Kempegowda Bus Station' })
    }
  })

  it('criterion 94: duty.corridor and duty.route are never both non-null and never both null on a coach with a duty', async () => {
    const duty = pallakkiDuty(simulation, '20260905')
    const result = resolveVehicle(
      { code: binFor(simulation, duty.id), entry: 'manual', at: null },
      coachWorldPort(simulation, NOW),
      registry,
    )
    const body = result.body as Record<string, any>
    expect(body.duty.route).toBeNull()
    expect(body.duty.corridor).toEqual({
      id: 'BNG-HSP',
      name: 'Bengaluru - Hosapete - Hampi',
      nameLocal: null,
    })
    // §10.1: a consumer that only understands buses reads `route: null` and
    // degrades to what it can support, rather than parsing a corridor id as a
    // route number and rendering `BNG-HSP` where `500-D` goes.
    expect(body.duty.serviceDate).toBe('20260905')
    expect(body.duty.service).toEqual({
      id: '2259BNGHMP',
      number: '2259BNGHMP',
      headsign: 'Hampi',
    })
    expect(body.duty.trip.scheduledEndAt).toBe(duty.scheduledArrivalAt.toISOString())
    expect(Array.isArray(body.duty.progressLog)).toBe(true)
    expect(body.duty.progressLog[0]).toMatchObject({ event: 'departed' })
  })

  it('criterion 95: confirmation.verify carries three rows for a coach with a known duty - plate, destination and departure', async () => {
    const duty = pallakkiDuty(simulation, '20260905')
    const result = resolveVehicle(
      { code: binFor(simulation, duty.id), entry: 'manual', at: null },
      coachWorldPort(simulation, NOW),
      registry,
    )
    const body = result.body as Record<string, any>
    expect(body.confirmation.prompt).toBe('Check the coach in front of you.')
    expect(body.confirmation.verify.map((row: { label: string }) => row.label)).toEqual([
      'Number plate',
      'Destination',
      'Departure',
    ])
    // §10.1: the departure time is on the list and the route number is not,
    // because a corridor has no number to check.
    expect(body.confirmation.verify[2].value).toBe('22:59')

    // A coach the world has nothing to say about gets the one row it can
    // still verify with its eyes.
    const parked = coaches.find(
      (candidate) => simulation.observe(candidate.bin, NOW) === null,
    )!
    const idle = resolveVehicle(
      { code: parked.bin, entry: 'manual', at: null },
      coachWorldPort(simulation, NOW),
      registry,
    )
    expect((idle.body as Record<string, any>).confirmation.verify).toHaveLength(1)
  })

  it('criterion 96: both forms of /fleet/duty return identical bodies, and both date spellings resolve', async () => {
    const duty = pallakkiDuty(simulation, '20260905')
    const byId = await json(await fetch(`${baseUrl}/fleet/duty/${duty.id}`))
    const byService = await json(await fetch(`${baseUrl}/fleet/duty?service=2259BNGHMP&date=2026-09-05`))
    const byServiceDate = await json(await fetch(`${baseUrl}/fleet/duty?service=2259BNGHMP&date=20260905`))
    expect(byService).toEqual(byId)
    expect(byServiceDate).toEqual(byId)
    expect(byId.duty.serviceDate).toBe('20260905')
    expect(byId.duty.travelDate).toBe('2026-09-05')
    expect(byId.assignment.status).toBe('assigned')
    expect(byId.vehicle.bin).toBe(binFor(simulation, duty.id))
    expect(byId.vehicle.corporation.code).toBe('KSRTC')
    expect(byId.tracking).not.toBeNull()
  })

  it('criterion 97: a duty beyond the assignment horizon is a 200 with vehicle null, not a 404', async () => {
    // "This one must not regress to a 404." A 404 would tell a caller its
    // duty id is wrong when it is right, and naming a plate for a coach three
    // weeks out would assert an operational commitment nobody has made.
    const far = simulation.duties.find(
      (duty) =>
        duty.departureAt.getTime() - NOW.getTime() >
        defaultCoachProfiles.assignmentHorizonHours * 3_600_000,
    )!
    const response = await fetch(`${baseUrl}/fleet/duty/${far.id}`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.vehicle).toBeNull()
    expect(body.tracking).toBeNull()
    expect(body.assignment).toMatchObject({
      status: 'not_yet_assigned',
      reason: 'beyond_assignment_horizon',
    })
    // The duty itself is real and every field is populated.
    expect(body.duty.service.id).toBeDefined()
    expect(body.duty.scheduledDeparture).toBe(far.departureAt.toISOString())
  })

  it('criterion 98: the same duty returns the same BIN across two fresh simulations with the same seed', async () => {
    const other = await coachHarness(NOW, { device: FULL_COVERAGE })
    for (const duty of simulation.duties) {
      expect(other.simulation.assignmentFor(duty.id)?.bin).toBe(
        simulation.assignmentFor(duty.id)?.bin,
      )
    }
    // §12.5's substitution: the duty is identical and the vehicle changed,
    // which is the mirror image of the bus model's mid-day duty swap.
    const substituted = await coachHarness(NOW, {
      device: FULL_COVERAGE,
      substitutionRatePerDuty: 1,
    })
    const duty = pallakkiDuty(substituted.simulation, '20260905')
    const assignment = substituted.simulation.assignmentFor(duty.id)!
    expect(assignment.status).toBe('superseded')
    expect(assignment.previousBin).not.toBeNull()
    expect(assignment.previousBin).not.toBe(assignment.bin)
    expect(assignment.supersededAt).not.toBeNull()
  })

  it('§10.3: the four error shapes, and the two that are 400 rather than 404', async () => {
    const unknown = await fetch(`${baseUrl}/fleet/duty/BNG-HSP-20260905-9999`)
    expect(unknown.status).toBe(404)
    expect((await json(unknown)).error).toBe('unknown_duty')

    // The weekend relief exists and does not run on a Monday service date.
    // (20260906 would be a `200`: the relief's own service date is the 5th
    // and it departs at 00:30 on the 6th, which is exactly the two-date trap
    // §10.3 exists to keep from surfacing as a wrong answer.)
    const trap = await fetch(`${baseUrl}/fleet/duty?service=0030BNGHMP&date=2026-09-06`)
    expect(trap.status).toBe(200)
    expect((await json(trap)).duty.serviceDate).toBe('20260905')
    const notScheduled = await fetch(`${baseUrl}/fleet/duty?service=0030BNGHMP&date=20260907`)
    expect(notScheduled.status).toBe(404)
    const notScheduledBody = await json(notScheduled)
    expect(notScheduledBody.error).toBe('duty_not_scheduled')
    expect(notScheduledBody.nearestDates.length).toBeGreaterThan(0)

    const badDate = await fetch(`${baseUrl}/fleet/duty?service=2259BNGHMP&date=tuesday`)
    expect(badDate.status).toBe(400)
    expect((await json(badDate)).error).toBe('invalid_request')

    // §10.3: outside the window is a 400 carrying the window, never a 404 -
    // the duty id is right and this process simply does not hold that day.
    const outside = await fetch(`${baseUrl}/fleet/duty?service=2259BNGHMP&date=2027-01-01`)
    expect(outside.status).toBe(400)
    const outsideBody = await json(outside)
    expect(outsideBody.error).toBe('outside_roster_window')
    expect(outsideBody.rosterWindow).toEqual({
      from: simulation.rosterWindow.from,
      to: simulation.rosterWindow.to,
    })
  })

  it('§10.4: /fleet/corridors publishes the geometry provenance and the departures, marked as authored', async () => {
    const body = await json(await fetch(`${baseUrl}/fleet/corridors`))
    const corridor = body.corridors[0]
    expect(corridor.id).toBe('BNG-HSP')
    expect(corridor.standCount).toBe(9)
    // §9.3: a corridor with an interpolated segment says so on an endpoint
    // anyone can curl, rather than only in a document.
    expect(corridor.geometry).toEqual({ routed: 8, osmRelation: 0, interpolated: 0 })
    expect(corridor.segments).toEqual({ highway: 6, urban: 2 })
    expect(corridor.deadZones.count).toBe(3)
    expect(corridor.deadZones.shareOfRoute).toBeGreaterThan(0)
    expect(corridor.departuresToday.length).toBeGreaterThan(0)
    // §13.3: "A departure time is exactly the kind of number a screenshot
    // turns into a fact." So it is marked here as well as in SOURCE.md and
    // the fidelity table.
    expect(corridor.provenance).toEqual({
      stands: 'authored_secondary',
      departures: 'authored_secondary',
    })
    expect(body.meta.simulated).toBe(true)
  })

  it('criterion 90: MANIFEST_TOKEN and ADMIN_TOKEN do not substitute for each other', async () => {
    const push = {
      serviceId: '2259BNGHMP',
      travelDate: '2026-09-05',
      seats: { total: 30, booked: 4, held: 2, simulated: 17 },
      asOf: '2026-09-05T18:00:00Z',
      ttlSeconds: 3_600,
    }
    // The right credential works.
    const good = await fetch(`${baseUrl}/fleet/manifest`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${MANIFEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(push),
    })
    expect(good.status).toBe(200)
    expect((await json(good)).stored.seatsBooked).toBe(4)

    // An operator credential does not open a peer's door.
    const admin = await fetch(`${baseUrl}/fleet/manifest`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(push),
    })
    expect(admin.status).toBe(401)

    // And the scenario surface is not reachable with a manifest credential:
    // "putting the two writes behind one credential would let a ticketing
    // platform force a coach dark."
    const scenario = await fetch(`${baseUrl}/admin/scenario`, {
      method: 'POST',
      headers: { authorization: `Bearer ${MANIFEST_TOKEN}` },
      body: '{}',
    })
    expect(scenario.status).toBe(404)
  })

  it('§10.5: with MANIFEST_TOKEN unset the endpoint is a 404 rather than a 401', async () => {
    const closed = createApiServer(coachWorldPort(simulation, NOW), registry, {
      intercity: simulation,
      manifestToken: null,
    })
    closed.listen(0)
    await once(closed, 'listening')
    const address = closed.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    const response = await fetch(`http://${host}:${address.port}/fleet/manifest`, {
      method: 'PUT',
      headers: { authorization: 'Bearer anything' },
      body: '{}',
    })
    // A deployment that forgets to set one has no surface rather than a
    // guessable one.
    expect(response.status).toBe(404)
    expect((await json(response)).error).toBe('not_found')
    closed.close()
    await once(closed, 'close')
  })

  it('§14.1: with no intercity port at all, the three new paths are an ordinary 404', async () => {
    const off = createApiServer(coachWorldPort(simulation, NOW), registry, {
      manifestToken: MANIFEST_TOKEN,
    })
    off.listen(0)
    await once(off, 'listening')
    const address = off.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    const base = `http://${host}:${address.port}`
    for (const path of ['/fleet/corridors', '/fleet/duty?service=x&date=20260905', '/fleet/duty/x']) {
      const response = await fetch(`${base}${path}`)
      expect(response.status).toBe(404)
      expect((await json(response)).error).toBe('not_found')
    }
    // And root discovery does not advertise a path that answers 404.
    const root = await json(await fetch(`${base}/`))
    expect(root.endpoints.some((entry: { path: string }) => entry.path === '/fleet/duty')).toBe(false)
    expect(root.suggestedPollSeconds).toBeUndefined()
    off.close()
    await once(off, 'close')
  })

  it('§8.1: root discovery publishes the suggested poll interval rather than leaving it to folklore', async () => {
    const root = await json(await fetch(`${baseUrl}/`))
    expect(root.suggestedPollSeconds).toBe(defaultCoachProfiles.prediction.horizonSeconds / 180)
    expect(root.endpoints.some((entry: { path: string }) => entry.path === '/fleet/duty')).toBe(true)
    expect(root.endpoints.some((entry: { path: string }) => entry.path === '/fleet/corridors')).toBe(
      true,
    )
  })

  it('§10.7: /readyz carries the corridor and roster counts, and the window', async () => {
    const body = await json(await fetch(`${baseUrl}/readyz`))
    expect(body.status).toBe('ready')
    expect(body.corridors).toBe(1)
    expect(body.coachesRostered).toBe(10)
    expect(body.coachesActive).toBe(simulation.activeCount(NOW))
    expect(body.rosterWindow).toEqual({
      from: simulation.rosterWindow.from,
      to: simulation.rosterWindow.to,
    })
  })

  it('/fleet/vehicle/{bin}/position carries a coach’s next stands with their bands', async () => {
    const duty = pallakkiDuty(simulation, '20260905')
    const bin = binFor(simulation, duty.id)
    const body = await json(await fetch(`${baseUrl}/fleet/vehicle/${bin}/position`))
    expect(body.class).toBe('coach')
    expect(body.nextStops.length).toBeGreaterThan(0)
    for (const stop of body.nextStops) {
      expect(stop.eta.uncertaintySeconds).toBeGreaterThan(0)
    }
    // Not a hot poll: a cold read must never be served from a cache.
    const response = await fetch(`${baseUrl}/fleet/vehicle/${bin}/position`)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('an unreserved coach carries a modelled occupancy on the same endpoints a reserved one carries none', async () => {
    const sarige = sarigeDuty(simulation, '20260906')
    const bin = binFor(simulation, sarige.id)
    const at = new Date(sarige.departureAt.getTime() + 60 * 60_000)
    const result = resolveVehicle(
      { code: bin, entry: 'manual', at: null },
      coachWorldPort(simulation, at),
      registry,
    )
    const body = result.body as Record<string, any>
    expect(body.tracking.occupancy).toBeDefined()
    expect(body.duty.reservation).toBeNull()
  })
})
