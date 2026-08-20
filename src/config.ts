import { resolve } from 'node:path'

export type GtfsSource = 'bundled' | 'path' | 'url'

/**
 * Environment names and local defaults live in this file only. Configuration
 * grows with the service, but callers receive already parsed values.
 */
export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: parsePositiveInteger(process.env.PORT ?? '3000', 'PORT'),
  gtfsSource: parseGtfsSource(process.env.GTFS_SOURCE ?? 'bundled'),
  gtfsBundlePath: resolve(process.env.GTFS_BUNDLE_PATH ?? 'data/bundle'),
  gtfsPath: process.env.GTFS_PATH === undefined ? null : resolve(process.env.GTFS_PATH),
  gtfsUrl: process.env.GTFS_URL ?? null,
  gtfsRepositoryUrl:
    process.env.GTFS_REPOSITORY_URL ?? 'https://github.com/Vonter/bmtc-gtfs',
  upstreamGtfsUrl:
    'https://raw.githubusercontent.com/Vonter/bmtc-gtfs/main/gtfs/bmtc.zip',
  gtfsCacheDir: resolve(process.env.GTFS_CACHE_DIR ?? '.cache/gtfs'),
  busRoutes: (process.env.BUS_ROUTES ?? '500-D,500-A,G-4,335-E,401-K')
    .split(',')
    .map((route) => route.trim())
    .filter(Boolean),
  geometryMaxStopOffsetMetres: parsePositiveNumber(
    process.env.GEOMETRY_MAX_STOP_OFFSET_METRES ?? '150',
    'GEOMETRY_MAX_STOP_OFFSET_METRES',
  ),
} as const

function parsePositiveInteger(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

function parsePositiveNumber(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`)
  }
  return value
}

function parseGtfsSource(raw: string): GtfsSource {
  if (raw === 'bundled' || raw === 'path' || raw === 'url') return raw
  throw new Error(`GTFS_SOURCE must be bundled, path or url, got ${JSON.stringify(raw)}`)
}
