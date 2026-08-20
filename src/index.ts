import { createServer } from 'node:http'
import { config } from './config.js'
import { loadGtfs } from './geometry/loadGtfs.js'
import { positionAt } from './geometry/shape.js'

const gtfs = await loadGtfs()
const route = [...gtfs.routes.values()].find((candidate) => candidate.number === '500-D')
if (route === undefined) throw new Error('Configured GTFS has no 500-D route')
const trip = route.trips[0]
if (trip === undefined) throw new Error('Configured 500-D route has no trips')
const shape = gtfs.shapes.get(trip.shapeId)
if (shape === undefined) throw new Error(`Configured GTFS has no shape ${trip.shapeId}`)
const startedAt = Date.now()
const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/position') {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not_found' }))
    return
  }
  const elapsedSeconds = (Date.now() - startedAt) / 1000
  const distanceMetres = (elapsedSeconds * 8) % shape.lengthMetres
  response.writeHead(200, { 'content-type': 'application/json', 'x-simulated': 'true' })
  response.end(
    JSON.stringify({
      route: route.number,
      shapeId: shape.id,
      distanceMetres,
      position: positionAt(shape, distanceMetres),
      distanceSource: shape.distanceSource,
    }),
  )
})

server.listen(config.port, config.host, () => {
  process.stdout.write(`transit-fleet-sim spike listening on ${config.host}:${config.port}\n`)
})
