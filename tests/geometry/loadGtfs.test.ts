import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import { loadGtfs } from '../../src/geometry/loadGtfs.js'

describe('GTFS loader', () => {
  it('loads all five routes from the committed bundle without a network call', async () => {
    const loaded = await loadGtfs({ source: 'bundled' })
    expect([...loaded.routes.values()].map((route) => route.number).sort()).toEqual([
      '335-E',
      '401-K',
      '500-A',
      '500-D',
      'G-4',
    ])
    expect(loaded.shapes.size).toBe(10)
    expect(loaded.trips.size).toBeGreaterThan(700)
    expect([...loaded.shapes.values()].every((shape) => shape.distanceSource === 'shape_dist_traveled')).toBe(true)
    expect([...loaded.stops.values()].some((stop) => stop.nameLocal !== null)).toBe(true)
  }, 20_000)

  it('loads a plain directory in path mode', async () => {
    const directory = await makeTinyGtfs()
    const loaded = await loadGtfs({ source: 'path', path: directory, routeNumbers: ['T-1'] })
    expect(loaded.routes.get('r1')?.trips[0]?.stops[1]?.stopDistanceMetres).toBeGreaterThan(1_000)
  })

  it('loads a zip in path mode', async () => {
    const { zipPath } = await makeTinyZip()
    const loaded = await loadGtfs({ source: 'path', path: zipPath, routeNumbers: ['T-1'] })
    expect(loaded.routes.get('r1')?.number).toBe('T-1')
  })

  it('downloads once and reuses the validated cache in url mode', async () => {
    const { directory, zipPath } = await makeTinyZip()
    const archive = await readFile(zipPath)
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/zip' })
      response.end(archive)
    })
    server.listen(0)
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Test server has no TCP address')
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    const url = `http://${host}:${address.port}/feed.zip`
    const cacheDirectory = join(directory, 'cache')
    const first = await loadGtfs({ source: 'url', url, cacheDirectory, routeNumbers: ['T-1'] })
    const second = await loadGtfs({ source: 'url', url, cacheDirectory, routeNumbers: ['T-1'] })
    server.close()
    expect(first.routes.get('r1')?.number).toBe('T-1')
    expect(second.routes.get('r1')?.number).toBe('T-1')
    expect(requests).toBe(1)
  })

  it('fails honestly when a mode-specific source is missing', async () => {
    await expect(loadGtfs({ source: 'path', path: null })).rejects.toThrow('GTFS_PATH is required')
    await expect(loadGtfs({ source: 'url', url: null })).rejects.toThrow('GTFS_URL is required')
  })
})

const TABLES = ['routes.txt', 'trips.txt', 'stop_times.txt', 'stops.txt', 'shapes.txt', 'translations.txt']

async function makeTinyGtfs(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tiny-gtfs-'))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'routes.txt'), 'route_id,route_short_name,route_long_name\nr1,T-1,Tiny route\n')
  await writeFile(
    join(directory, 'trips.txt'),
    'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nr1,weekday,t1,End,0,s1\n',
  )
  await writeFile(
    join(directory, 'stop_times.txt'),
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,a,1\nt1,08:05:00,08:05:00,b,2\n',
  )
  await writeFile(
    join(directory, 'stops.txt'),
    'stop_id,stop_name,stop_lat,stop_lon\na,Start,12.97,77.59\nb,End,12.98,77.60\n',
  )
  await writeFile(
    join(directory, 'shapes.txt'),
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\ns1,12.97,77.59,0,0\ns1,12.98,77.60,1,1553\n',
  )
  await writeFile(
    join(directory, 'translations.txt'),
    'table_name,field_name,record_id,language,translation\nstops,stop_name,a,kn,ಆರಂಭ\n',
  )
  return directory
}

async function makeTinyZip(): Promise<{ directory: string; zipPath: string }> {
  const directory = await makeTinyGtfs()
  const zipPath = join(directory, 'tiny.zip')
  const zip = new AdmZip()
  for (const name of TABLES) zip.addLocalFile(join(directory, name))
  zip.writeZip(zipPath)
  return { directory, zipPath }
}
