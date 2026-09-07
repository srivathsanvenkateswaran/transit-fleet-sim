import type { IntercityPort, IntercityResult } from '../world/port.js'
import { errors } from './errors.js'

/**
 * The three intercity HTTP surfaces - docs/intercity-coaches.md §10.3-§10.5.
 *
 * Every handler here takes an `IntercityPort | null`. `null` is §14.1's
 * default-off case and produces the same ordinary `404` any unknown path
 * does, with no TODO stub and no feature flag inside the handler - the same
 * increment boundary this repository already draws around `/fleet/routes`.
 */

export function dutyEndpoint(
  intercity: IntercityPort | null,
  path: string,
  search: URLSearchParams,
  at: Date,
): IntercityResult {
  if (intercity === null) return { status: 404, body: errors.unknownRoute() }
  const byId = /^\/fleet\/duty\/(.+)$/.exec(path)
  if (byId !== null) {
    return intercity.dutyLookup({ dutyId: decodeURIComponent(byId[1] ?? '') }, at)
  }
  const serviceId = search.get('service')
  const date = search.get('date')
  return intercity.dutyLookup(
    {
      ...(serviceId === null ? {} : { serviceId }),
      ...(date === null ? {} : { date }),
    },
    at,
  )
}

export function corridorsEndpoint(intercity: IntercityPort | null, at: Date): IntercityResult {
  if (intercity === null) return { status: 404, body: errors.unknownRoute() }
  return intercity.corridors(at)
}

/**
 * §10.5. `MANIFEST_TOKEN` is a different credential from `ADMIN_TOKEN`,
 * and it does not sit under `/admin/`: the BPP is a peer service rather than
 * an operator of this one, and putting the two writes behind one credential
 * would let a ticketing platform force a coach dark. One credential for one
 * capability.
 *
 * Absent-by-default with a `404` rather than a `401`, on the same reasoning
 * `/admin/scenario` already carries: a deployment that forgets to set one has
 * no surface rather than a guessable one.
 */
export function manifestEndpoint(
  intercity: IntercityPort | null,
  method: string,
  token: string | null,
  presented: string | null,
  body: unknown,
  search: URLSearchParams,
  at: Date,
): IntercityResult {
  if (intercity === null || token === null) return { status: 404, body: errors.unknownRoute() }
  if (presented !== token) return { status: 401, body: errors.unauthorized() }
  if (method === 'DELETE') {
    return intercity.deleteManifest(
      { serviceId: search.get('service'), travelDate: search.get('date') },
      at,
    )
  }
  return intercity.putManifest(body, at)
}

/** `Authorization: Bearer <token>`, or null. */
export function bearerToken(header: string | null): string | null {
  if (header === null) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}
