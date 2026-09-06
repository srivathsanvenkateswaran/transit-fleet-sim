/**
 * Everything both new-corridor generators (`build-corridors.ts`'s new-corridor
 * loop and `build-corridor-roster.ts`) need to agree on: which Tatak
 * corridor becomes which id here, which physical direction is modelled
 * (this simulator has one fixed stand sequence per corridor - see the note
 * on `CANONICAL_DIRECTION` below), the stand-code labels, and the two
 * service classes and hub rows this project has no other source for.
 *
 * All of this is this project's own editorial choice, not a fact read off
 * Tatak or KSRTC - see the comment on each table for what is and is not
 * sourced.
 */
import type { Corporation } from '../../src/fleet/corporation.js'

export interface NewCorridorDef {
  /** This repo's corridor id. Never surfaced to Tatak or the BPP - see docs/intercity-coaches.md §7.4: only `serviceId` crosses repos. */
  readonly id: string
  readonly name: string
  readonly tatakId: string
  readonly tatakDir: string
  /**
   * This simulator's roster has one fixed stand sequence per corridor (see
   * `corridorRoster.ts`'s `scheduleCalls`, which walks `corridor.stands` in
   * array order for every departure regardless of which way it actually
   * runs) - a limitation of the existing mechanism, not something this data
   * pass changes. So each corridor here models exactly one physical
   * direction of travel, chosen as whichever direction Tatak's own dataset
   * gives more real (non-null) service numbers for for its actual reserved
   * classes, not necessarily the direction the corridor id's letters read
   * in.
   *
   * `0` keeps Tatak's own stop order (the corridor id's first town is the
   * origin); `1` reverses it (the corridor id's second town is the origin).
   */
  readonly tatakDirectionId: 0 | 1
  /** Origin-side hub for every departure on this corridor, matching the physical direction above - see FIXTURE_HUBS. */
  readonly hub: string
}

/**
 * Direction choice and reasoning, corridor by corridor (counts exclude the
 * four cross-corridor-ambiguous service numbers - see AMBIGUOUS_SERVICE_NUMBERS):
 *
 * - BNG-MYS: dir0 (Bengaluru origin) has 7 usable real numbers, dir1 has 7 -
 *   roughly even; kept at dir0 to match the corridor id's own reading.
 * - BNG-MNG: dir0 has 34, dir1 has 34 - even; kept at dir0.
 * - BNG-CKM: dir0 has 12, dir1 has 12 - even; kept at dir0.
 * - MYS-MDK: dir0 (Mysuru origin) has 0 usable real numbers after excluding
 *   the corridor's one dir0 real number as cross-corridor-ambiguous; dir1
 *   (Madikeri origin) has 1. Reversed so the corridor has any real service
 *   at all, at the cost of the id's letters no longer matching travel
 *   direction - flagged here rather than hidden in the data.
 * - MYS-MNG: dir0 has 0 usable (its one real number is ambiguous), dir1 has
 *   2, including the corridor's only bookable-class (AIRAVAT) real number.
 *   Reversed for the same reason as MYS-MDK.
 * - KA-COAST (MNG-KWR): dir0 ("N", northbound from Mangaluru) has 2, dir1
 *   ("S", southbound) has 3 - close either way; kept at dir0 so the id's
 *   letters (Mangaluru first) match the travel direction.
 * - DND-ANK: no real service number in either direction (Tatak's own
 *   dataset carries zero for this corridor); dir0 (Dandeli origin, matching
 *   the id) used for the invented placeholders `build-corridor-roster.ts`
 *   adds instead.
 */
export const NEW_CORRIDORS: readonly NewCorridorDef[] = [
  { id: 'BNG-MYS', name: 'Bengaluru - Mysuru', tatakId: 'KA-BNG-MYS', tatakDir: 'ka-bng-mys', tatakDirectionId: 0, hub: 'KBS' },
  { id: 'BNG-MNG', name: 'Bengaluru - Mangaluru', tatakId: 'KA-BNG-MNG', tatakDir: 'ka-bng-mng', tatakDirectionId: 0, hub: 'KBS' },
  { id: 'BNG-CKM', name: 'Bengaluru - Chikkamagaluru', tatakId: 'KA-BNG-CKM', tatakDir: 'ka-bng-ckm', tatakDirectionId: 0, hub: 'KBS' },
  { id: 'MYS-MDK', name: 'Madikeri - Mysuru', tatakId: 'KA-MYS-MDK', tatakDir: 'ka-mys-mdk', tatakDirectionId: 1, hub: 'MDK' },
  { id: 'MYS-MNG', name: 'Mangaluru - Mysuru', tatakId: 'KA-MYS-MNG', tatakDir: 'ka-mys-mng', tatakDirectionId: 1, hub: 'MNG' },
  { id: 'MNG-KWR', name: 'Mangaluru - Karwar', tatakId: 'KA-COAST', tatakDir: 'ka-coast', tatakDirectionId: 0, hub: 'MNG' },
  { id: 'DND-ANK', name: 'Dandeli - Ankola', tatakId: 'KA-DND-ANK', tatakDir: 'ka-dnd-ank', tatakDirectionId: 0, hub: 'DND' },
]

/**
 * This simulator's `ServiceClassId` for every Tatak class this project can
 * roster. A Tatak class with no row here (`ashwamedha`, `ev_power_plus`,
 * `non_ac_sleeper`, `ac_seater_executive_chair`, `ambaari_dream_class`,
 * `airavat_club_class_2`) has no matching row in
 * `data/bundle/corridor-classes.json` and gets no roster entry at all -
 * this repo could not generate a coach for it regardless of what this
 * script did.
 */
export const CLASS_MAP: Readonly<Record<string, string>> = {
  KARNATAKA_SARIGE: 'karnataka_sarige',
  RAJAHAMSA_EXECUTIVE: 'rajahamsa_executive',
  AIRAVAT: 'airavat',
  AIRAVAT_CLUB_CLASS: 'airavat_club_class',
  AMBAARI_UTSAV: 'ambaari_utsav',
  PALLAKKI: 'pallakki',
}

/**
 * Four real service numbers Tatak's own dataset assigns to a trip on two
 * different corridors at once (its own S-grade bustimings.in differencing
 * pass reused the same real bus's clock as a plausible template for a
 * generated departure on more than one corridor independently). Tatak's
 * data does not say which corridor the bus actually belongs to, so rather
 * than guess, both occurrences are dropped from every corridor's roster:
 *
 * - 2105BNGMRC: KA-BNG-MYS and KA-MYS-MDK
 * - 2131MRCBNG: KA-BNG-MYS and KA-MYS-MDK
 * - 0801BNGCDP: KA-BNG-MNG and KA-COAST
 * - 2334BNGMNG: KA-BNG-MNG and KA-MYS-MNG
 */
export const AMBIGUOUS_SERVICE_NUMBERS: ReadonlySet<string> = new Set([
  '2105BNGMRC',
  '2131MRCBNG',
  '0801BNGCDP',
  '2334BNGMNG',
])

/**
 * Stand-id codes for every boarding point across the seven new corridors,
 * this project's own three-letter labels (not a Tatak or KSRTC field) -
 * the same kind of editorial choice `build-corridors.ts` already made for
 * BNG-HSP's `KA-STAND-*` ids. Keyed by Tatak's own boarding-point id so the
 * same physical place gets the same code on every corridor it appears on.
 */
export const STAND_CODE_BY_TATAK_STOP_ID: Readonly<Record<string, string>> = {
  'KA-BP-BNG-MAJESTIC': 'MAJ',
  'KA-BP-BNG-YESHWANTHPUR': 'YWP',
  'KA-BP-BNG-MYSORE-ROAD': 'MYR',
  'KA-BP-NELAMANGALA': 'NLM',
  'KA-BP-KUNIGAL': 'KNG',
  'KA-BP-RAMANAGARA': 'RMN',
  'KA-BP-CHANNAPATNA': 'CNP',
  'KA-BP-MADDUR': 'MDR',
  'KA-BP-MANDYA': 'MDY',
  'KA-BP-SRIRANGAPATNA': 'SRP',
  'KA-BP-MYSURU-CENTRAL': 'MYS',
  'KA-BP-MYSURU-SUBURBAN': 'MYU',
  'KA-BP-CHANNARAYAPATNA': 'CRP',
  'KA-BP-HASSAN': 'HSN',
  'KA-BP-SAKLESHPUR': 'SKL',
  'KA-BP-UPPINANGADY': 'UPG',
  'KA-BP-BC-ROAD': 'BCR',
  'KA-BP-MANGALURU-KSRTC': 'MNG',
  'KA-BP-MANGALURU-CENTRAL': 'MNC',
  'KA-BP-BELUR': 'BEL',
  'KA-BP-CHIKKAMAGALURU': 'CKM',
  'KA-BP-HUNSUR': 'HUN',
  'KA-BP-PERIYAPATNA': 'PRP',
  'KA-BP-KUSHALNAGAR': 'KSN',
  'KA-BP-MADIKERI': 'MDK',
  'KA-BP-KR-NAGAR': 'KRN',
  'KA-BP-HOLENARASIPURA': 'HLN',
  'KA-BP-UDUPI': 'UDP',
  'KA-BP-KUNDAPURA': 'KDP',
  'KA-BP-BHATKAL': 'BTK',
  'KA-BP-MURUDESHWARA': 'MRD',
  'KA-BP-HONNAVARA': 'HON',
  'KA-BP-KUMTA': 'KUM',
  'KA-BP-GOKARNA': 'GOK',
  'KA-BP-ANKOLA': 'ANK',
  'KA-BP-KARWAR': 'KWR',
  'KA-BP-DANDELI': 'DND',
}

export function standCodeFor(tatakStopId: string): string {
  const code = STAND_CODE_BY_TATAK_STOP_ID[tatakStopId]
  if (code === undefined) throw new Error(`No stand code chosen for Tatak boarding point ${tatakStopId}`)
  return code
}

const CORPORATION_BY_TERRITORY: Readonly<Record<string, Corporation>> = {
  KSRTC: 'KSRTC',
  NWKRTC: 'NWKRTC',
  KKRTC: 'KKRTC',
  BMTC: 'BMTC',
}

export function corporationForTerritory(territoryCorporation: string): Corporation {
  const corporation = CORPORATION_BY_TERRITORY[territoryCorporation]
  if (corporation === undefined) throw new Error(`Unknown territory corporation ${territoryCorporation}`)
  return corporation
}
