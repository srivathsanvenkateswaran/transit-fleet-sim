import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('committed wire evidence', () => {
  it('proves manual and scan entry differ on required confirmation', async () => {
    const manual = await evidence('resolve-manual.json')
    const scan = await evidence('resolve-scan.json')
    expect(manual).toMatchObject({
      bin: 'BLR-04126',
      matchedOn: 'bin',
      confirmation: { required: true },
      meta: { simulated: true, seed: 1, generatedAt: '2026-08-20T09:41:26.000Z' },
    })
    expect(scan).toMatchObject({ confirmation: { required: false } })
  })

  it('proves fix age and single-vehicle tracking are values from the wire', async () => {
    const resolved = await evidence('resolve-manual.json')
    const position = await evidence('vehicle-position.json')
    const tracking = resolved.tracking as {
      state: string
      fixAgeSeconds: number
      observedAt: string
      servedAt: string
      progress: unknown
    }
    expect(tracking.state).toBe('live')
    expect(tracking.fixAgeSeconds).toBe(
      (new Date(tracking.servedAt).getTime() - new Date(tracking.observedAt).getTime()) / 1000,
    )
    expect(tracking.progress).not.toBeNull()
    expect(position).toMatchObject({ bin: 'BLR-04126', tracking: { state: 'live' } })
  })

  it('proves checksum and registry not-found errors remain distinct', async () => {
    expect(await evidence('bad-check-character.json')).toMatchObject({
      error: 'bad_check_character',
      hint: 'check_digit',
    })
    expect(await evidence('unknown-bin.json')).toMatchObject({
      error: 'unknown_bin',
      bin: 'BLR99992',
    })
  })

  it('proves the frozen world is ready with the complete bus increment', async () => {
    expect(await evidence('readyz.json')).toEqual({
      status: 'ready',
      geometryLoaded: true,
      routes: 5,
      metroLines: 0,
      vehicles: 30,
      lastTickAt: '2026-08-20T09:41:26.000Z',
      tickLagMs: 0,
      seed: 1,
    })
  })

  it('proves the response headers survive outside the JSON body', async () => {
    const headers = (await readFile(new URL('../../evidence/resolve.headers', import.meta.url), 'utf8')).toLowerCase()
    expect(headers).toContain('http/1.1 200 ok')
    expect(headers).toContain('x-simulated: true')
    expect(headers).toContain('cache-control: no-store')
    expect(headers).toContain('x-request-id:')
  })
})

async function evidence(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(`../../evidence/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>
}
