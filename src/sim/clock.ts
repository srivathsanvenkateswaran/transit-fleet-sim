export interface SimClock {
  now(): Date
}

export function createClock(value: string): SimClock {
  if (value === 'system') return { now: () => new Date() }
  if (value.startsWith('offset:')) {
    const seconds = Number(value.slice('offset:'.length))
    if (!Number.isFinite(seconds)) throw new Error(`Invalid SIM_CLOCK offset ${value}`)
    return { now: () => new Date(Date.now() + seconds * 1000) }
  }
  const instant = new Date(value)
  if (!Number.isFinite(instant.getTime())) throw new Error(`Invalid SIM_CLOCK instant ${value}`)
  return { now: () => new Date(instant) }
}
