import { describe, expect, it } from 'vitest'
import { metroArrivals } from '../../src/api/metroArrivals.js'

describe('metro arrivals contract', () => {
  it('returns station-specific arrivals', () => {
    const at = new Date('2026-08-20T09:41:26.000Z')
    const first = metroArrivals('MTR-PPL-018', null, 'purple', '3', at)
    const second = metroArrivals('MTR-PPL-037', null, 'purple', '3', at)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(JSON.stringify(first.body)).not.toBe(JSON.stringify(second.body))
  })

  it('returns a distinct closed answer outside service hours', () => {
    const result = metroArrivals('MTR-PPL-018', null, 'purple', '3', new Date('2026-08-20T18:00:00.000Z'))
    expect(result.status).toBe(200)
    expect((result.body as { error: string }).error).toBe('metro_service_closed')
  })
})

/**
 * The service-window edges the owner's brief called out by name: the
 * boundary before first train and after last train, the three different
 * Monday/Tue-Sat/Sunday openings, and Yellow's later close than Purple and
 * Green. Every instant below is chosen in IST (`Asia/Kolkata`, the
 * simulator's default `SIM_TIMEZONE`) and converted to the UTC the wire
 * format carries, so a reader can check each one against a clock without
 * running the simulator.
 *
 * 2026-08-17 is a Monday, 2026-08-18 a Tuesday, 2026-08-20 a Thursday,
 * 2026-08-21 a Friday and 2026-08-23 a Sunday - confirmed against a real
 * calendar, not assumed from a formula, because getting the weekday wrong
 * would make every assertion below pass for the wrong reason.
 */
describe('metro service window edges', () => {
  it('is closed before first train, and names the closed-network answer', () => {
    // Monday 2026-08-17, 02:00 IST - two hours before that day's 04:15 open.
    const result = metroArrivals('MTR-PPL-018', null, 'purple', '3', new Date('2026-08-16T20:30:00.000Z'))
    expect(result.status).toBe(200)
    const body = result.body as { error: string; serviceHours: Record<string, { firstTrain: string; lastTrain: string; nextOpensAt: string }> }
    expect(body.error).toBe('metro_service_closed')
    expect(body.serviceHours.purple?.firstTrain).toBe('04:15')
    expect(body.serviceHours.purple?.nextOpensAt).toBe('2026-08-16T22:45:00.000Z')
  })

  it('is closed after last train, and the next opening is tomorrow, not tonight', () => {
    // Thursday 2026-08-20, 23:30 IST - Purple's 23:05 last train has gone.
    // Tomorrow is Friday, an ordinary weekday, so the next opening is 05:00,
    // not the 04:15 that only applies to Monday.
    const result = metroArrivals('MTR-PPL-018', null, 'purple', '3', new Date('2026-08-20T18:00:00.000Z'))
    expect(result.status).toBe(200)
    const body = result.body as { error: string; serviceHours: Record<string, { nextOpensAt: string }> }
    expect(body.error).toBe('metro_service_closed')
    expect(body.serviceHours.purple?.nextOpensAt).toBe('2026-08-20T23:30:00.000Z')
  })

  it('opens at 04:15 on a Monday', () => {
    const before = metroArrivals('MTR-GNL-010', null, 'green', '3', new Date('2026-08-16T20:30:00.000Z'))
    const body = before.body as { serviceHours: Record<string, { firstTrain: string; nextOpensAt: string }> }
    expect(body.serviceHours.green?.firstTrain).toBe('04:15')
    expect(body.serviceHours.green?.nextOpensAt).toBe('2026-08-16T22:45:00.000Z')
  })

  it('opens at 05:00 Tuesday through Saturday', () => {
    // Tuesday 2026-08-18, 02:00 IST.
    const before = metroArrivals('MTR-GNL-010', null, 'green', '3', new Date('2026-08-17T20:30:00.000Z'))
    const body = before.body as { serviceHours: Record<string, { firstTrain: string; nextOpensAt: string }> }
    expect(body.serviceHours.green?.firstTrain).toBe('05:00')
    expect(body.serviceHours.green?.nextOpensAt).toBe('2026-08-17T23:30:00.000Z')
  })

  it('opens at 07:00 on a Sunday', () => {
    // Sunday 2026-08-23, 02:00 IST.
    const before = metroArrivals('MTR-GNL-010', null, 'green', '3', new Date('2026-08-22T20:30:00.000Z'))
    const body = before.body as { serviceHours: Record<string, { firstTrain: string; nextOpensAt: string }> }
    expect(body.serviceHours.green?.firstTrain).toBe('07:00')
    expect(body.serviceHours.green?.nextOpensAt).toBe('2026-08-23T01:30:00.000Z')
  })

  it("keeps Yellow running after Purple and Green have closed for the night", () => {
    // Thursday 2026-08-20, 23:30 IST: Purple and Green closed at 23:05, but
    // Yellow's last train is 23:55, so a Yellow query at the same instant
    // must not see a closed network.
    const result = metroArrivals('MTR-YLL-008', null, 'yellow', '3', new Date('2026-08-20T18:00:00.000Z'))
    expect((result.body as { error?: string }).error).not.toBe('metro_service_closed')
  })

  it('closes Yellow at 23:55, after which even Yellow reports closed', () => {
    // Thursday 2026-08-20, 23:59 IST - four minutes past Yellow's 23:55 last
    // train. Friday is an ordinary weekday, so the next opening is 05:00.
    const result = metroArrivals('MTR-YLL-008', null, 'yellow', '3', new Date('2026-08-20T18:29:00.000Z'))
    const body = result.body as { error: string; serviceHours: Record<string, { nextOpensAt: string }> }
    expect(body.error).toBe('metro_service_closed')
    expect(body.serviceHours.yellow?.nextOpensAt).toBe('2026-08-20T23:30:00.000Z')
  })
})
