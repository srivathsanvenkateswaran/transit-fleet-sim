import { looksLikeBin, normaliseCode, parseBin, type ParsedBin } from './bin.js'
import { looksLikePlate, parsePlate, type ParsedPlate } from './plate.js'

export type ClassifiedCode =
  | { readonly kind: 'bin'; readonly value: ParsedBin }
  | { readonly kind: 'plate'; readonly value: ParsedPlate }
  | { readonly kind: 'bad_check_character'; readonly code: string }
  | { readonly kind: 'malformed'; readonly code: string }

export function classifyCode(value: string, hubs: ReadonlySet<string>): ClassifiedCode {
  const code = normaliseCode(value)
  if (looksLikeBin(code)) {
    const parsed = parseBin(code, hubs)
    if (parsed.ok) return { kind: 'bin', value: parsed.value }
    if (parsed.reason === 'bad_check_character') return { kind: 'bad_check_character', code }
    return { kind: 'malformed', code }
  }
  if (looksLikePlate(code)) {
    const parsed = parsePlate(code)
    if (parsed !== null) return { kind: 'plate', value: parsed }
  }
  return { kind: 'malformed', code }
}
