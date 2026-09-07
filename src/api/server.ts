import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { config } from '../config.js'
import type { FleetRegistry } from '../fleet/registry.js'
import type { IntercityPort, WorldPort } from '../world/port.js'
import { log } from '../log.js'
import { errors } from './errors.js'
import { health, readiness } from './health.js'
import { resolveVehicle } from './resolve.js'
import { vehiclePosition } from './vehiclePosition.js'
import { metroArrivals } from './metroArrivals.js'
import { root } from './root.js'
import { bearerToken, corridorsEndpoint, dutyEndpoint, manifestEndpoint } from './intercity.js'
import { gtfsRealtimeFeed, type FeedKind } from './gtfsRealtime.js'

export interface ApiServerOptions {
  readonly corsAllowedOrigin?: string
  readonly tickMs?: number
  readonly predictionHorizonStops?: number
  /**
   * docs/intercity-coaches.md §14.1. Absent is the default-off case: the
   * three intercity paths and the coach half of the feeds answer the same
   * ordinary `404` as any unknown path, with no stub and no flag inside a
   * handler.
   */
  readonly intercity?: IntercityPort
  /** §10.5, injected so a test can set the credential without the environment. */
  readonly manifestToken?: string | null
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
  const intercity = options.intercity ?? null
  const manifestToken =
    options.manifestToken === undefined ? config.manifestToken : options.manifestToken
  const server = createServer((request, response) => {
    const startedAt = performance.now()
    const context: Record<string, unknown> = {}
    requestSequence += 1
    const requestId = headerValue(request, 'x-request-id') ?? `sim-${requestSequence}`
    response.setHeader('x-simulated', 'true')
    response.setHeader('x-request-id', requestId)
    response.setHeader('access-control-allow-origin', cors)
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.once('finish', () => {
      log('info', 'request', {
        requestId,
        method: request.method,
        path: (request.url ?? '/').split('?')[0],
        status: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        ...context,
      })
    })
    void route(request, response, {
      world,
      registry,
      tickMs,
      predictionHorizon,
      intercity,
      manifestToken,
      context,
    })
  })
  server.requestTimeout = config.requestTimeoutMs
  return server
}

interface RouteContext {
  readonly world: WorldPort
  readonly registry: FleetRegistry
  readonly tickMs: number
  readonly predictionHorizon: number
  readonly intercity: IntercityPort | null
  readonly manifestToken: string | null
  readonly context: Record<string, unknown>
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: RouteContext,
): Promise<void> {
  const { world, registry, tickMs, predictionHorizon, intercity, manifestToken, context } = options
  const url = new URL(request.url ?? '/', config.publicBaseUrl)
  const method = request.method ?? 'GET'

  // §7.4/§10.5: the one write this service accepts, and the only non-GET
  // method it answers at all. Everything else keeps the existing blanket 404.
  if (url.pathname === '/fleet/manifest' && (method === 'PUT' || method === 'DELETE')) {
    let body: unknown = null
    if (method === 'PUT') {
      const raw = await readBody(request)
      try {
        body = raw === '' ? null : JSON.parse(raw)
      } catch {
        send(response, 400, errors.invalidRequest('The request body must be JSON.'))
        return
      }
    }
    const result = manifestEndpoint(
      intercity,
      method,
      manifestToken,
      bearerToken(headerValue(request, 'authorization')),
      body,
      url.searchParams,
      world.now(),
    )
    response.setHeader('cache-control', 'no-store')
    send(response, result.status, result.body)
    return
  }

  if (method !== 'GET') {
    send(response, 404, errors.unknownRoute())
    return
  }
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
    context.entry = url.searchParams.get('entry') ?? 'manual'
    if (result.status === 200) {
      const body = result.body as {
        bin: string
        matchedOn: string
        duty: { status: string }
        tracking: { state: string }
      }
      context.bin = body.bin
      context.matchedOn = body.matchedOn
      context.dutyStatus = body.duty.status
      context.trackingState = body.tracking.state
    }
    response.setHeader('cache-control', 'no-store')
    send(response, result.status, result.body)
    return
  }
  const positionMatch = /^\/fleet\/vehicle\/([^/]+)\/position$/.exec(url.pathname)
  if (positionMatch !== null) {
    const encodedBin = positionMatch[1]
    let requestedBin: string
    try {
      requestedBin = decodeURIComponent(encodedBin ?? '')
    } catch {
      send(response, 400, errors.malformedCode(encodedBin ?? ''))
      return
    }
    const result = vehiclePosition(
      requestedBin,
      world,
      registry,
      predictionHorizon,
    )
    if (result.status === 200) {
      const body = result.body as {
        bin: string
        duty: { status: string }
        tracking: { state: string }
      }
      context.bin = body.bin
      context.dutyStatus = body.duty.status
      context.trackingState = body.tracking.state
    }
    response.setHeader('cache-control', 'no-store')
    send(response, result.status, result.body)
    return
  }
  if (url.pathname === '/fleet/metro/arrivals') {
    // `world.now()` and not a fresh `new Date()`: the metro service window
    // (day-of-week first train, per-line last train) has to be driven by the
    // same clock as every other simulated vehicle, so that SIM_CLOCK moving
    // the world to 02:00 on a Sunday also moves a rider's metro board to
    // "closed until 07:00" rather than answering off the real wall clock the
    // rest of the simulator was told to ignore.
    const result = metroArrivals(
      url.searchParams.get('station'),
      url.searchParams.get('towards'),
      url.searchParams.get('line'),
      url.searchParams.get('limit'),
      world.now(),
    )
    response.setHeader('cache-control', 'no-store')
    send(response, result.status, result.body)
    return
  }
  if (url.pathname === '/fleet/corridors') {
    const result = corridorsEndpoint(intercity, world.now())
    response.setHeader('cache-control', 'no-store')
    send(response, result.status, result.body)
    return
  }
  if (url.pathname === '/fleet/duty' || url.pathname.startsWith('/fleet/duty/')) {
    const result = dutyEndpoint(intercity, url.pathname, url.searchParams, world.now())
    response.setHeader('cache-control', 'no-store')
    send(response, result.status, result.body)
    return
  }
  const feedMatch = /^\/gtfs-rt\/(vehicle-positions|trip-updates)$/.exec(url.pathname)
  if (feedMatch !== null) {
    const result = gtfsRealtimeFeed(
      feedMatch[1] as FeedKind,
      world,
      registry,
      url.searchParams.get('class'),
    )
    response.setHeader('content-type', result.contentType)
    response.setHeader('cache-control', `public, max-age=${config.feedTtlSeconds}`)
    response.statusCode = result.status
    response.end(result.payload)
    return
  }
  if (url.pathname === '/') {
    send(response, 200, root(intercity !== null))
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

/** Bounded by `REQUEST_TIMEOUT_MS` at the server level; a manifest push is small. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer))
    if (chunks.reduce((total, part) => total + part.length, 0) > 64_000) break
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.end(JSON.stringify(body))
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name]
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
}
