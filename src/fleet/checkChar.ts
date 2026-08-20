const DAMM_TABLE: readonly (readonly number[])[] = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
]

export function dammCheckDigit(payload: string): string {
  return String(dammFold(assertDigits(payload)))
}

export function hasValidDammCheckDigit(value: string): boolean {
  return dammFold(assertDigits(value)) === 0
}

function dammFold(digits: string): number {
  let interim = 0
  for (const character of digits) {
    const row = DAMM_TABLE[interim]
    const next = row?.[Number(character)]
    if (next === undefined) throw new Error('Invalid Damm table lookup')
    interim = next
  }
  return interim
}

function assertDigits(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error('Damm input must contain digits only')
  return value
}
