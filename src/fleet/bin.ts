import { dammCheckDigit, hasValidDammCheckDigit } from './checkChar.js'

const BIN_PATTERN = /^([A-Z]{3})(\d{4})(\d)$/

export interface ParsedBin {
  readonly canonical: string
  readonly normalised: string
  readonly hub: string
  readonly serial: string
  readonly checkDigit: string
}

export type BinParseResult =
  | { readonly ok: true; readonly value: ParsedBin }
  | { readonly ok: false; readonly reason: 'malformed' | 'unknown_hub' | 'bad_check_character' }

export function normaliseCode(value: string): string {
  return value.toUpperCase().replaceAll(/[^A-Z0-9]/g, '')
}

export function formatBin(hub: string, serial: number | string): string {
  const canonicalHub = hub.toUpperCase()
  if (!/^[A-HJ-NP-Z]{3}$/.test(canonicalHub)) throw new Error(`Invalid BIN hub ${hub}`)
  const serialDigits = typeof serial === 'number' ? String(serial).padStart(4, '0') : serial
  if (!/^\d{4}$/.test(serialDigits)) throw new Error(`Invalid BIN serial ${serial}`)
  return `${canonicalHub}-${serialDigits}${dammCheckDigit(serialDigits)}`
}

export function parseBin(value: string, hubs: ReadonlySet<string>): BinParseResult {
  const normalised = normaliseCode(value)
  const match = BIN_PATTERN.exec(normalised)
  if (match === null) return { ok: false, reason: 'malformed' }
  const [, hub, serial, checkDigit] = match
  if (hub === undefined || serial === undefined || checkDigit === undefined) {
    return { ok: false, reason: 'malformed' }
  }
  if (!hubs.has(hub)) return { ok: false, reason: 'unknown_hub' }
  if (!hasValidDammCheckDigit(`${serial}${checkDigit}`)) {
    return { ok: false, reason: 'bad_check_character' }
  }
  return {
    ok: true,
    value: {
      canonical: `${hub}-${serial}${checkDigit}`,
      normalised,
      hub,
      serial,
      checkDigit,
    },
  }
}

export function looksLikeBin(value: string): boolean {
  return BIN_PATTERN.test(normaliseCode(value))
}
