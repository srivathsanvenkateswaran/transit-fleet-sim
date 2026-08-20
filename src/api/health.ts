import type { WorldPort } from '../world/port.js'
import { errors, type ApiErrorBody } from './errors.js'

export function health() {
  return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) }
}

export function readiness(
  world: WorldPort,
  tickMs: number,
): { status: 200; body: Record<string, unknown> } | { status: 503; body: ApiErrorBody } {
  const at = world.now()
  const status = world.status(at)
  const lastTickAge =
    status.lastTickAt === null
      ? Number.POSITIVE_INFINITY
      : at.getTime() - new Date(status.lastTickAt).getTime()
  if (!status.geometryLoaded || status.vehicles === 0 || lastTickAge > tickMs * 5) {
    return { status: 503, body: errors.notReady() }
  }
  return { status: 200, body: { status: 'ready', ...status } }
}
