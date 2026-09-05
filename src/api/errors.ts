export interface ApiErrorBody {
  readonly error: string
  readonly message: string
  readonly [context: string]: unknown
}

export const errors = {
  malformedCode: (code: string): ApiErrorBody => ({
    error: 'malformed_code',
    message: 'Enter a valid bus code or number plate.',
    code,
  }),
  badCheckCharacter: (code: string): ApiErrorBody => ({
    error: 'bad_check_character',
    message: 'That code did not pass its own checksum. Please retype it.',
    code,
    hint: 'check_digit',
  }),
  unknownBin: (bin: string): ApiErrorBody => ({
    error: 'unknown_bin',
    message: 'No bus is registered with that code.',
    bin,
  }),
  unknownPlate: (plate: string): ApiErrorBody => ({
    error: 'unknown_plate',
    message: 'No current bus is registered with that number plate.',
    plate,
  }),
  retiredPlate: (retiredOn: string): ApiErrorBody => ({
    error: 'plate_no_longer_current',
    message: `That registration was retired on ${formatDate(retiredOn)}.`,
    retiredOn,
  }),
  notResolvable: (): ApiErrorBody => ({
    error: 'not_a_resolvable_code',
    message: 'Metro vehicles are resolved by station arrivals, not a vehicle code.',
    class: 'metro',
    seeInstead: '/fleet/metro/arrivals',
  }),
  timeTravelDisabled: (): ApiErrorBody => ({
    error: 'time_travel_disabled',
    message: 'Resolving at another time is disabled.',
  }),
  unknownRoute: (): ApiErrorBody => ({
    error: 'not_found',
    message: 'No endpoint exists at this path.',
  }),
  invalidRequest: (message: string): ApiErrorBody => ({
    error: 'invalid_request',
    message,
  }),
  notReady: (): ApiErrorBody => ({
    error: 'not_ready',
    message: 'The simulated world is not ready.',
  }),
  /**
   * docs/intercity-coaches.md §10.5. Reached only when the credential is
   * configured and the caller presented the wrong one; a deployment that has
   * not set `MANIFEST_TOKEN` at all gets an ordinary `404` instead, so an
   * unset token is a surface that does not exist rather than one to guess at.
   */
  unauthorized: (): ApiErrorBody => ({
    error: 'unauthorized',
    message: 'That credential is not accepted on this path.',
  }),
} as const

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}
