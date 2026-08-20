import { resolve } from 'node:path'

/**
 * Environment names and local defaults live in this file only. Configuration
 * grows with the service, but callers receive already parsed values.
 */
export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: parsePositiveInteger(process.env.PORT ?? '3000', 'PORT'),
  gtfsSource: process.env.GTFS_SOURCE ?? 'bundled',
  gtfsPath: resolve(process.env.GTFS_PATH ?? 'data/bundle/gtfs'),
  gtfsUrl:
    process.env.GTFS_URL ??
    'https://raw.githubusercontent.com/Vonter/bmtc-gtfs/main/gtfs/bmtc.zip',
  gtfsRepositoryUrl:
    process.env.GTFS_REPOSITORY_URL ?? 'https://github.com/Vonter/bmtc-gtfs',
  gtfsCacheDir: resolve(process.env.GTFS_CACHE_DIR ?? '.cache/gtfs'),
} as const

function parsePositiveInteger(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}
