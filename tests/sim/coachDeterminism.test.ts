import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { defaultCoachProfiles } from '../../src/sim/coachProfiles.js'
import { binFor, coachHarness, pallakkiDuty } from '../fakes/coachWorld.js'

/**
 * docs/intercity-coaches.md §8.3 and §15: determinism, the log, and
 * migration.
 *
 * "Determinism stays. Seeded, reproducible, no wall clock outside
 * `src/sim/clock.ts`, the same duty on the same date yielding the same
 * vehicle." Section 15 makes it a stronger test than the existing one,
 * because a cross-midnight roster is where a service-date bug hides.
 */

const BOOT_AT = new Date('2026-09-05T14:00:00+05:30')
const FULL_COVERAGE = {
  ...defaultCoachProfiles.device,
  coverageShareReserved: 1,
  coverageShareOrdinary: 1,
}

describe('determinism and the progress log (§8.3, §15)', () => {
  it('criterion 103: a process restarted mid-run reproduces the progressLog exactly, by replay', async () => {
    // "The log looks like state. It is not, because every entry is
    // derivable... a process restarted mid-run must produce the same log by
    // replay. That is the testable invariant, and it is also the strongest
    // determinism test in the suite, because it exercises nine hours of
    // seeded draws rather than one instant."
    const continuous = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const duty = pallakkiDuty(continuous.simulation, '20260905')
    const bin = binFor(continuous.simulation, duty.id)

    // One process that watched the whole run, minute by minute.
    for (let minute = 0; minute <= 400; minute += 1) {
      continuous.simulation.observe(bin, new Date(duty.departureAt.getTime() + minute * 60_000))
    }
    const at = new Date(duty.departureAt.getTime() + 400 * 60_000)
    const watched = continuous.simulation.observe(bin, at)!.duty.progressLog

    // A second process that booted seven hours in and has seen nothing.
    const restarted = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const replayed = restarted.simulation.observe(bin, at)!.duty.progressLog

    expect(replayed).toEqual(watched)
    expect(watched!.length).toBeGreaterThan(4)
    // And it is a real journal, not an empty array that trivially matches.
    const events = new Set(watched!.map((entry) => entry.event))
    expect(events.has('departed')).toBe(true)
    expect(events.has('halt_began')).toBe(true)
    expect(events.has('halt_ended')).toBe(true)
  })

  it('§8.2: every log entry is an observation the service already published, carrying no interpretation', async () => {
    const { simulation } = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const duty = pallakkiDuty(simulation, '20260905')
    const bin = binFor(simulation, duty.id)
    const log = simulation.observe(bin, new Date(duty.departureAt.getTime() + 400 * 60_000))!.duty
      .progressLog!
    for (const entry of log) {
      expect(new Date(entry.at).getTime()).toBeGreaterThanOrEqual(duty.departureAt.getTime())
      // `went_dark` is not "a problem" and `recovered` is not "resolved".
      expect(JSON.stringify(entry)).not.toMatch(/problem|error|fault|delay|resolved/i)
    }
    // §8.3: capped, oldest dropped first, so a pathological run cannot grow a
    // response without bound.
    expect(log.length).toBeLessThanOrEqual(defaultCoachProfiles.progressLogMaxEntries)
  })

  it('§8.3: the cap is enforced, oldest first', async () => {
    const { simulation } = await coachHarness(BOOT_AT, {
      device: FULL_COVERAGE,
      progressLogMaxEntries: 4,
    })
    const duty = pallakkiDuty(simulation, '20260905')
    const bin = binFor(simulation, duty.id)
    const at = new Date(duty.departureAt.getTime() + 400 * 60_000)
    const log = simulation.observe(bin, at)!.duty.progressLog!
    expect(log.length).toBe(4)

    // Proving the cap dropped the OLDEST entries takes a reference: BNG-HSP
    // logs a `departed` event at every stand a coach leaves (Nelamangala,
    // Tumakuru, Chitradurga, Davanagere...), not only at the origin, so
    // `log[0]!.event !== 'departed'` does not actually distinguish "the
    // origin departure was dropped" from "the coach happens to be between
    // two halts right now" - it used to pass by coincidence of which bin
    // this duty drew, and BNG-HSP rostering three more real departures
    // (§7.4) changed the generation order enough to draw a different one.
    // The uncapped log (default `progressLogMaxEntries`, comfortably above
    // this run's eleven natural entries) is the actual oldest-first proof:
    // the capped log must be exactly its last four entries.
    const uncapped = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const fullLog = uncapped.simulation.observe(bin, at)!.duty.progressLog!
    expect(fullLog.length).toBeGreaterThan(4)
    expect(log).toEqual(fullLog.slice(-4))
  })

  it('criterion 104: two fresh simulations with the same seed produce byte-identical /fleet/corridors and identical assignments', async () => {
    const first = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const second = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    expect(JSON.stringify(second.simulation.corridors(BOOT_AT).body)).toBe(
      JSON.stringify(first.simulation.corridors(BOOT_AT).body),
    )
    for (const duty of first.simulation.duties) {
      expect(second.simulation.assignmentFor(duty.id)).toEqual(
        first.simulation.assignmentFor(duty.id),
      )
    }
    // And the coverage draw, which is a fact about which vehicles have a
    // device at all, is identical too.
    expect(second.coaches.map((coach) => coach.bin)).toEqual(first.coaches.map((coach) => coach.bin))
    expect(second.coaches.map((coach) => coach.plates[0]!.normalised)).toEqual(
      first.coaches.map((coach) => coach.plates[0]!.normalised),
    )
  })

  it('criterion 104: the whole observation is identical across two processes at the same instant', async () => {
    const first = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const second = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const at = new Date('2026-09-06T02:14:00+05:30')
    for (const duty of first.simulation.activeDuties(at)) {
      const bin = binFor(first.simulation, duty.id)
      expect(JSON.stringify(second.simulation.observe(bin, at))).toBe(
        JSON.stringify(first.simulation.observe(bin, at)),
      )
    }
  })

  it('a replay to an earlier instant rebuilds rather than reusing a stale cursor', async () => {
    // `?at=` inside the roster window can move backwards, and a memoised
    // forward-only replay would otherwise answer with wherever the run had
    // already been driven to.
    const { simulation } = await coachHarness(BOOT_AT, { device: FULL_COVERAGE })
    const duty = pallakkiDuty(simulation, '20260905')
    const bin = binFor(simulation, duty.id)
    const early = new Date(duty.departureAt.getTime() + 20 * 60_000)
    const before = JSON.stringify(simulation.observe(bin, early))
    simulation.observe(bin, new Date(duty.departureAt.getTime() + 300 * 60_000))
    expect(JSON.stringify(simulation.observe(bin, early))).toBe(before)
  })

  it('criterion 105: with INTERCITY_CORRIDORS unset, no coach field appears anywhere in the bus goldens', async () => {
    // The migration test. `INTERCITY_CORRIDORS` is unset in the test
    // environment, so the sixteen goldens under tests/api/goldens are the
    // real check and `tests/api/goldens.test.ts` runs it. This asserts the
    // complementary half: none of the new keys leaked into a committed bus
    // body while this work was going on.
    const names = [
      'corridor',
      'reservation',
      'progressLog',
      'deadZone',
      'recovery',
      'dwell',
      'serviceClass',
      'corporation',
      'scheduledEndAt',
      'serviceDate',
    ]
    for (const golden of [
      'confirmed__live',
      'confirmed__dark',
      'inferred__stale',
      'unknown__untracked',
      'out_of_service__dark',
    ]) {
      const body = await readFile(
        new URL(`../api/goldens/${golden}.json`, import.meta.url),
        'utf8',
      )
      for (const name of names) expect(body).not.toContain(`"${name}"`)
    }
  })

  it('criterion 107: every intercity variable src/config.ts reads has a line in .env.example, and INTERCITY_DUTY_SWAP_RATE_PER_DAY has neither', async () => {
    const source = await readFile(new URL('../../src/config.ts', import.meta.url), 'utf8')
    const example = await readFile(new URL('../../.env.example', import.meta.url), 'utf8')
    const read = new Set(
      [...source.matchAll(/validation\.\w+(?:<[^>]+>)?\(\s*'(INTERCITY_[A-Z0-9_]+|MANIFEST_TOKEN)'/g)].map(
        (match) => match[1]!,
      ),
    )
    expect(read.size).toBeGreaterThan(30)
    for (const name of read) expect(example).toContain(`\n${name}=`)
    // §12.5: not a variable, in either file, so a deployment cannot turn a
    // mid-run coach duty swap on.
    expect(source).not.toContain('INTERCITY_DUTY_SWAP_RATE_PER_DAY')
    expect(example).not.toMatch(/^INTERCITY_DUTY_SWAP_RATE_PER_DAY=/m)
  })

  it('criterion 109: src/ contains no outbound HTTP client, which is why the manifest ingress is a push', async () => {
    // The structural argument §7.4 rests on. `scripts/` is excluded, as it
    // already is: `scripts/build-corridors.ts` genuinely does make outbound
    // calls, once, at build time.
    const { readdir } = await import('node:fs/promises')
    const files: string[] = []
    const walk = async (directory: string) => {
      for (const entry of await readdir(new URL(`../../${directory}/`, import.meta.url), {
        withFileTypes: true,
      })) {
        if (entry.isDirectory()) await walk(`${directory}/${entry.name}`)
        else if (entry.name.endsWith('.ts')) files.push(`${directory}/${entry.name}`)
      }
    }
    await walk('src')
    const offenders: string[] = []
    for (const file of files) {
      const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
      const stripped = source
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/\/\/.*$/gm, '')
      // `node:http`'s `createServer` is an inbound listener and is not a
      // client; what is forbidden is anything that can originate a request.
      const client =
        /\bfetch\s*\(|\bXMLHttpRequest\b|axios|node-fetch|\bundici\b|node:https|https?\.(get|request)\s*\(/
      if (client.test(stripped)) {
        // `loadGtfs` carries the one documented exception, GTFS_SOURCE=url,
        // which SPEC's own audit already records against criterion 44.
        if (!file.endsWith('geometry/loadGtfs.ts')) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
