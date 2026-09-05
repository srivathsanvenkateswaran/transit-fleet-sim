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
  // docs/intercity-coaches.md §10.7: "`503` conditions gain one: the roster
  // window does not contain today. A process whose roster ran out yesterday
  // answers every duty lookup with `outside_roster_window` while `/readyz`
  // says ready, and that is exactly the silent-failure shape `/readyz` exists
  // to catch." Absent when coaches are off, so this never fires on a
  // deployment that has none.
  if (status.rosterWindowStale === true) {
    return {
      status: 503,
      body: {
        ...errors.notReady(),
        reason: 'roster_window_stale',
        message: 'The corridor roster window no longer contains today.',
        ...(status.rosterWindow === undefined ? {} : { rosterWindow: status.rosterWindow }),
      },
    }
  }
  return { status: 200, body: { status: 'ready', ...status } }
}
