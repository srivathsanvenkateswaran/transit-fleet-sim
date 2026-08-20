import { createServer } from 'node:http'
import { config } from './config.js'
import { loadSpikeShape } from './geometry/loadSpikeShape.js'
import { positionAt } from './geometry/shape.js'

const shape = await loadSpikeShape()
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
      route: '500-D',
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
