import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { readiness } from '../../src/api/health.js'
import { defaultCoachProfiles } from '../../src/sim/coachProfiles.js'
import { INTERCITY_DUTY_SWAP_RATE_PER_DAY } from '../../src/sim/coachWorld.js'
import { activeAt, rosterWindowFor, windowContains } from '../../src/sim/corridorRoster.js'
import { binFor, coachHarness, pallakkiDuty, runMinutes } from '../fakes/coachWorld.js'
import { FakeWorld } from '../fakes/fakeWorld.js'

/**
 * docs/intercity-coaches.md §3 and §11.3: the duty crosses midnight, and the
 * world stops iterating vehicles that are not running.
 *
 * "A duty lasts eight to ten hours and crosses midnight. The clock, the
 * cursor, the dispatch loop and the duty model all assume a within-day cyclic
 * run, and each of them breaks in a different way."
 */

const BOOT_AT = new Date('2026-09-05T14:00:00+05:30')

describe('the multi-day roster (§3, §11.3)', () => {
  it('dispatches by departure rather than by spread: one duty per departure per service date', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    // Seven daily departures over a three-day window (three of BNG-HSP's own
    // invented and sourced rows, three real KARNATAKA_SARIGE numbers §7.4
    // added from Tatak's KA-BNG-HMP feed - 0930BNGHSP, 1630BNGKPL,
    // 2130BNGHSP - plus 2001HMPBNG, the one real `reverse` departure the
    // bidirectional-roster pass added), plus the weekend relief on the two
    // service dates it runs: 7*3 + 2. `BUSES_PER_ROUTE` does not apply and no
    // configuration says how many coaches there are - the fleet size falls
    // out of the roster (§3.5).
    expect(simulation.rosteredCount).toBe(23)
    // The window opens a service day behind the current one: that is the day
    // whose 22:59 departure is still on the road at 03:00.
    expect(simulation.rosterWindow.serviceDates).toEqual(['20260904', '20260905', '20260906'])
  })

  it('criterion 59: a duty dispatched at 22:59 and observed at 03:00 the next day reports the departure’s service date', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    const duty = pallakkiDuty(simulation, '20260905')
    const bin = binFor(simulation, duty.id)
    // 03:00 IST on 6 September: the calendar has turned over and the service
    // date has not.
    const at = new Date('2026-09-06T03:00:00+05:30')
    const observation = simulation.observe(bin, at)
    expect(observation).not.toBeNull()
    expect(observation!.duty.serviceDate).toBe('20260905')
    expect(observation!.duty.trip?.startDate).toBe('20260905')
    // §3.3: and the start time is a GTFS noon-relative time, not a wall clock.
    expect(observation!.duty.trip?.startTime).toBe('22:59:00')
  })

  it('criterion 60: two worlds booted on different calendar days agree about the same duty', async () => {
    // "This is the section 3.1 test and it is the one that catches the
    // service-date key." The duty draw is keyed on the duty's own service
    // date, so a process restarted at 03:00 cannot redraw a running coach's
    // status against tomorrow.
    const first = await coachHarness(new Date('2026-09-05T14:00:00+05:30'))
    const second = await coachHarness(new Date('2026-09-06T03:00:00+05:30'))
    const duty = pallakkiDuty(first.simulation, '20260906')
    const same = pallakkiDuty(second.simulation, '20260906')
    expect(same.id).toBe(duty.id)
    const at = new Date('2026-09-07T03:00:00+05:30')
    const one = first.simulation.observe(binFor(first.simulation, duty.id), at)
    const two = second.simulation.observe(binFor(second.simulation, same.id), at)
    expect(binFor(second.simulation, same.id)).toBe(binFor(first.simulation, duty.id))
    expect(two?.duty.status).toBe(one?.duty.status)
    expect(two?.duty.serviceDate).toBe(one?.duty.serviceDate)
    expect(two?.tracking).toEqual(one?.tracking)
  })

  it('criterion 61: a run whose arrival falls after midnight emits stop times past 24:00:00', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    const duty = pallakkiDuty(simulation)
    const past = duty.calls.filter((call) => Number(call.arrivalTime.split(':')[0]) >= 24)
    expect(past.length).toBeGreaterThan(0)
    // The terminal is reached the following morning on the departure's own
    // service date, which is `30:xx:00` rather than `06:xx:00`.
    expect(duty.calls.at(-1)!.arrivalTime).toMatch(/^3\d:\d{2}:\d{2}$/)
    // And the after-midnight relief departure is written as the GTFS time it
    // is: 24:30 on service date N, departing 00:30 on calendar day N+1.
    const relief = simulation.duties.find(
      (candidate) => candidate.serviceId === '0030BNGHMP' && candidate.serviceDate === '20260905',
    )!
    expect(relief.startTime).toBe('24:30:00')
    expect(relief.serviceDate).toBe('20260905')
    expect(relief.travelDate).toBe('2026-09-06')
  })

  it('criterion 62: a coach that reaches its terminal stops rather than turning round', async () => {
    const { simulation } = await coachHarness(BOOT_AT, {
      device: { ...defaultCoachProfiles.device, coverageShareReserved: 1, coverageShareOrdinary: 1 },
    })
    const duty = pallakkiDuty(simulation)
    const arrival = simulation.runSnapshot(
      duty,
      new Date(duty.departureAt.getTime() + 600 * 60_000),
    )
    expect(arrival.cursor.arrivedAtMs).not.toBeNull()
    const distanceAtArrival = arrival.cursor.distanceMetres
    // Six more hours of elapsed time move it no further: there is no layover
    // and no return leg, because the duty is finished rather than paused.
    const later = simulation.runSnapshot(
      duty,
      new Date(duty.departureAt.getTime() + 960 * 60_000),
    )
    expect(later.cursor.distanceMetres).toBe(distanceAtArrival)
    expect(later.cursor.arrivedAtMs).toBe(arrival.cursor.arrivedAtMs)
  })

  it('criterion 63: the active set is exactly the duties departed and not yet arrived', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    for (const at of [
      new Date('2026-09-05T14:00:00+05:30'),
      new Date('2026-09-06T02:14:00+05:30'),
      new Date('2026-09-06T11:00:00+05:30'),
    ]) {
      const active = simulation.activeDuties(at)
      const expected = simulation.duties.filter(
        (duty) =>
          duty.departureAt.getTime() <= at.getTime() &&
          duty.scheduledArrivalAt.getTime() > at.getTime(),
      )
      expect(active.map((duty) => duty.id).sort()).toEqual(expected.map((duty) => duty.id).sort())
      // §11.1: most of the fleet is not moving. At any instant roughly a
      // third of the roster is in flight, which is the whole cost model.
      expect(active.length).toBeLessThan(simulation.rosteredCount)
    }
    expect(activeAt(simulation.duties, BOOT_AT).length).toBeGreaterThan(0)
  })

  it('criterion 63: a coach outside its duty is not observable at all, so nothing ticks it', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    const duty = pallakkiDuty(simulation)
    const bin = binFor(simulation, duty.id)
    // Twelve hours before it departs, this vehicle has nothing to report and
    // the world says so by returning null - the API answers SPEC 5.3 cell D
    // from the registry row, which is the honest answer for a coach parked in
    // a depot: the plate is a fact and the world has nothing to add.
    expect(simulation.observe(bin, new Date(duty.departureAt.getTime() - 12 * 3_600_000))).toBeNull()
    expect(
      simulation.observe(bin, new Date(duty.scheduledArrivalAt.getTime() + 3_600_000)),
    ).toBeNull()
  })

  it('criterion 64: /readyz is 503 when the roster window no longer contains today', async () => {
    const { simulation } = await coachHarness(BOOT_AT)
    expect(simulation.rosterWindowStale(BOOT_AT)).toBe(false)
    // A process whose roster ran out: still ticking, still holding geometry,
    // and answering every duty lookup with `outside_roster_window`.
    const stale = new Date('2026-09-20T09:00:00+05:30')
    expect(simulation.rosterWindowStale(stale)).toBe(true)

    const world = new FakeWorld({
      now: stale,
      status: {
        lastTickAt: stale.toISOString(),
        corridors: 1,
        coachesRostered: 11,
        coachesActive: 0,
        rosterWindow: { from: simulation.rosterWindow.from, to: simulation.rosterWindow.to },
        rosterWindowStale: true,
      },
    })
    const result = readiness(world, config.simTickMs)
    expect(result.status).toBe(503)
    expect((result.body as { reason?: string }).reason).toBe('roster_window_stale')

    // And it stays 200 when the window is current, with the four new counts.
    const fresh = new FakeWorld({
      status: {
        corridors: 1,
        coachesRostered: 11,
        coachesActive: 3,
        rosterWindow: { from: '20260905', to: '20260907' },
        rosterWindowStale: false,
      },
    })
    const ready = readiness(fresh, config.simTickMs)
    expect(ready.status).toBe(200)
    expect(ready.body).toMatchObject({
      corridors: 1,
      coachesRostered: 11,
      coachesActive: 3,
      rosterWindow: { from: '20260905', to: '20260907' },
    })
  })

  it('criterion 66: the coach duty swap rate is zero and no observation moves a duty off confirmed mid-run', async () => {
    // §12.5: a coach 200 km from the nearest depot cannot be reassigned to
    // another block. It is a constant rather than an environment variable so
    // a deployment cannot turn it on, and `.env.example` has no line for it.
    expect(INTERCITY_DUTY_SWAP_RATE_PER_DAY).toBe(0)
    expect(defaultCoachProfiles.duty.swapRatePerDay).toBe(0)

    const { simulation } = await coachHarness(BOOT_AT)
    for (const duty of simulation.duties) {
      const statuses = new Set(
        [...runMinutes(simulation, duty.id, 540, 15)].map((frame) => frame.observation.duty.status),
      )
      expect(statuses.size).toBe(1)
    }
  })

  it('the roster window is at least two service days, because one cannot hold a cross-midnight duty', () => {
    const window = rosterWindowFor(BOOT_AT, 3, config.simTimezone)
    expect(window.serviceDates.length).toBe(3)
    // It opens a day behind: that is the day whose 22:59 departure is still
    // on the road at 03:00.
    expect(window.from).toBe('20260904')
    expect(windowContains(window, '20260904')).toBe(true)
    expect(windowContains(window, '20260907')).toBe(false)
    expect(() => config.intercityRosterDays).not.toThrow()
  })
})
