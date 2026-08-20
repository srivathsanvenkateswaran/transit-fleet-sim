import { normaliseCode } from './bin.js'

const STANDARD_PLATE = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/
const BH_PLATE = /^(\d{2})BH(\d{4})([A-Z]{1,2})$/

export interface ParsedPlate {
  readonly normalised: string
  readonly display: string
  readonly kind: 'standard' | 'bh'
}

export function parsePlate(value: string): ParsedPlate | null {
  const normalised = normaliseCode(value)
  const standard = STANDARD_PLATE.exec(normalised)
  if (standard !== null) {
    const [, state, district, series, serial] = standard
    if (state === undefined || district === undefined || series === undefined || serial === undefined) {
      return null
    }
    const groups = [state, district.padStart(2, '0'), series, serial].filter(Boolean)
    return { normalised, display: groups.join('-'), kind: 'standard' }
  }
  const bh = BH_PLATE.exec(normalised)
  if (bh !== null) {
    const [, year, serial, series] = bh
    if (year === undefined || serial === undefined || series === undefined) return null
    return { normalised, display: `${year}-BH-${serial}-${series}`, kind: 'bh' }
  }
  return null
}

export function looksLikePlate(value: string): boolean {
  const normalised = normaliseCode(value)
  return STANDARD_PLATE.test(normalised) || BH_PLATE.test(normalised)
}
