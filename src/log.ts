import { config, type LogLevel } from './config.js'

const severity: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (severity[level] < severity[config.logLevel]) return
  const record = { level, event, ...fields }
  if (config.logFormat === 'pretty') {
    process.stdout.write(`[${level}] ${event} ${JSON.stringify(fields)}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(record)}\n`)
}
