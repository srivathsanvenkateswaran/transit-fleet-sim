import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { config } from '../config.js'
import type { FleetRegistry } from '../fleet/registry.js'
import type { WorldPort } from '../world/port.js'
import { errors } from './errors.js'
import { health, readiness } from './health.js'
import { resolveVehicle } from './resolve.js'
import { vehiclePosition } from './vehiclePosition.js'

export interface ApiServerOptions {
  readonly corsAllowedOrigin?: string
  readonly tickMs?: number
  readonly predictionHorizonStops?: number
}

export function createApiServer(
  world: WorldPort,
  registry: FleetRegistry,
  options: ApiServerOptions = {},
): Server {
  let requestSequence = 0
  const cors = options.corsAllowedOrigin ?? config.corsAllowedOrigins
  const tickMs = options.tickMs ?? config.simTickMs
  const predictionHorizon = options.predictionHorizonStops ?? config.predictionHorizonStops
  const server = createServer((request, response) => {
    requestSequence += 1
    const requestId = headerValue(request, 'x-request-id') ?? `sim-${requestSequence}`
    response.setHeader('x-simulated', 'true')
    response.setHeader('x-request-id', requestId)
    response.setHeader('access-control-allow-origin', cors)
    response.setHeader('content-type', 'application/json; charset=utf-8')
    route(request, response, world, registry, tickMs, predictionHorizon)
  })
  server.requestTimeout = config.requestTimeoutMs
  return server
}

function route(
  request: IncomingMessage,
  response: ServerResponse,
  world: WorldPort,
  registry: FleetRegistry,
  tickMs: number,
  predictionHorizon: number,
): void {
  if (request.method !== 'GET') {
    send(response, 404, errors.unknownRoute())
    return
  }
  const url = new URL(request.url ?? '/', config.publicBaseUrl)
  if (url.pathname === '/fleet/resolve') {
    const result = resolveVehicle(
      {
        code: url.searchParams.get('code'),
        entry: url.searchParams.get('entry'),
        at: url.searchParams.get('at'),
      },
      world,
      registry,
    )
    response.setHeader('cache-control', 'no-store')
    send(response, result.status, result.body)
    return
  }
  const positionMatch = /^\/fleet\/vehicle\/([^/]+)\/position$/.exec(url.pathname)
  if (positionMatch !== null) {
    const encodedBin = positionMatch[1]
    const result = vehiclePosition(
      decodeURIComponent(encodedBin ?? ''),
      world,
      registry,
      predictionHorizon,
    )
    response.setHeader('cache-control', 'no-store')
    send(response, result.status, result.body)
    return
  }
  if (url.pathname === '/healthz') {
    send(response, 200, health())
    return
  }
  if (url.pathname === '/readyz') {
    const result = readiness(world, tickMs)
    send(response, result.status, result.body)
    return
  }
  send(response, 404, errors.unknownRoute())
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.end(JSON.stringify(body))
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name]
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
}
