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
  /**
   * The hub at the corridor's *other* end, for a real Tatak service that
   * runs the opposite way over the same road - see `reverseCorridor` in
   * `src/geometry/corridorTopology.ts` and the "bidirectional rosters" note
   * on `RosterDeparture.direction`. Absent means this corridor's reverse
   * direction is never rostered, either because the far end has no fixture
   * hub of its own (DND-ANK's Ankola) or because that direction carries no
   * real service number to roster in the first place.
   */
  readonly reverseHub?: string
  /**
   * Real reverse-direction service numbers to leave off the roster even
   * though they pass every other filter - because their own local
   * stop_times fragment does not begin at this corridor's reverse-direction
   * origin (the forward corridor's own last stand). `realDeparturesFor`
   * reads a departure's clock off the *first* stop_sequence row its trip
   * carries in this feed and schedules it as a full run from that corridor's
   * own origin stand; a trip whose first row is some other, mid-corridor
   * town would have that town's real clock reading relabelled as the
   * corridor's own origin's, which is a different, worse claim than the
   * "the real trip continues past where this corridor ends" approximation
   * `CORRIDOR_EXCLUSIVE_SERVICE_NUMBERS` already accepts - that one keeps
   * the one true origin and only understates the destination; this one
   * would invent an origin the coach never called at. See MNG-KWR below.
   */
  readonly reverseExcludedServiceNumbers?: ReadonlySet<string>
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
 *
 * Four more corridors, added when the owner's own audit
 * (`track-audit.ts`, run against Tatak's planner) showed the rider being
 * offered a coach on four corridors Tatak had just gained and this
 * simulator had never heard of. Same pipeline, same reasoning ladder:
 *
 * - BNG-BJP (Vijayapura): dir0 has one usable real number (2005BNGBJP;
 *   the corridor's other dir0 code, 2205BNGBJP, is KALYANA_RATHA, a class
 *   `CLASS_MAP` has no row for), dir1 has one (1744BJPBNG, same exclusion
 *   on its own KALYANA_RATHA sibling). Tied, so kept at dir0 to match the
 *   id's own reading, same tie-break BNG-MYS already uses.
 * - BNG-BDM (Badami): dir0's one real number, 2015BNGBDM, is
 *   NON_AC_SLEEPER - unmapped, so dir0 has zero usable. dir1 has three
 *   (0600BDMBNG, 0715BDMBNG, 0745BDMBNG, all KARNATAKA_SARIGE). By the
 *   MYS-MDK/MYS-MNG rule that would mean reversing to dir1 - except every
 *   demo itinerary this simulator serves departs Bengaluru, so a
 *   Badami-origin corridor would carry real numbers this project never
 *   shows a rider. Kept at dir0 anyway, on zero usable real numbers, and
 *   `buildCorridorRoster`'s existing DND-ANK fallback fires: this corridor's
 *   whole roster is Tatak's own one generated dir0 slot, invented and
 *   labelled as such.
 * - BNG-BGK (Bagalkot): dir0 has two usable real numbers, 1930BNGBLI and
 *   2100BNGBLI (`BLI` is Bilagi, a stop this corridor's own feed carries
 *   short of Bagalkot itself - see `docs/research/karnataka-corridor-
 *   evidence.md`'s letter-group table in the Tatak checkout). Kept at dir0,
 *   the same Bengaluru-origin reading every other corridor here uses.
 * - BNG-HBL (Hubballi): dir0 has five usable real numbers (four
 *   AIRAVAT_CLUB_CLASS, one PALLAKKI; NON_AC_SLEEPER's one dir0 code is
 *   unmapped same as BDM's). dir1 has many more - seventeen real
 *   KARNATAKA_SARIGE numbers alone - but every one of them is a
 *   Hubballi-origin departure, which is not the leg any demo itinerary
 *   needs. Kept at dir0 for the same reason BDM is: this project only ever
 *   shows a rider the Bengaluru-origin half of a corridor, so that is the
 *   half worth having real numbers for.
 */
export const NEW_CORRIDORS: readonly NewCorridorDef[] = [
  { id: 'BNG-MYS', name: 'Bengaluru - Mysuru', tatakId: 'KA-BNG-MYS', tatakDir: 'ka-bng-mys', tatakDirectionId: 0, hub: 'KBS', reverseHub: 'MYS' },
  { id: 'BNG-MNG', name: 'Bengaluru - Mangaluru', tatakId: 'KA-BNG-MNG', tatakDir: 'ka-bng-mng', tatakDirectionId: 0, hub: 'KBS', reverseHub: 'MNG' },
  { id: 'BNG-CKM', name: 'Bengaluru - Chikkamagaluru', tatakId: 'KA-BNG-CKM', tatakDir: 'ka-bng-ckm', tatakDirectionId: 0, hub: 'KBS', reverseHub: 'CKM' },
  { id: 'MYS-MDK', name: 'Madikeri - Mysuru', tatakId: 'KA-MYS-MDK', tatakDir: 'ka-mys-mdk', tatakDirectionId: 1, hub: 'MDK', reverseHub: 'MYS' },
  { id: 'MYS-MNG', name: 'Mangaluru - Mysuru', tatakId: 'KA-MYS-MNG', tatakDir: 'ka-mys-mng', tatakDirectionId: 1, hub: 'MNG', reverseHub: 'MYS' },
  {
    id: 'MNG-KWR',
    name: 'Mangaluru - Karwar',
    tatakId: 'KA-COAST',
    tatakDir: 'ka-coast',
    tatakDirectionId: 0,
    hub: 'MNG',
    reverseHub: 'KWR',
    // Both real dir1 numbers Tatak carries for this feed besides
    // 1900KWRBNG (the one that genuinely starts at Karwar) are themselves
    // mid-corridor fragments: 1630UDPBNG's own stop_times begin at Udupi
    // (16:30), not Karwar, and 1916CDPBNG's begin at Kundapura (19:16) -
    // see this file's `reverseExcludedServiceNumbers` doc. Rostering either
    // as a Karwar departure would assert a five-plus-hour stretch of road
    // neither coach ever drove.
    reverseExcludedServiceNumbers: new Set(['1630UDPBNG', '1916CDPBNG']),
  },
  // No reverseHub: Ankola has no fixture hub of its own (§ FIXTURE_HUBS) and
  // this corridor's own dataset carries zero real service numbers in either
  // direction anyway - both ends already run on invented placeholders.
  { id: 'DND-ANK', name: 'Dandeli - Ankola', tatakId: 'KA-DND-ANK', tatakDir: 'ka-dnd-ank', tatakDirectionId: 0, hub: 'DND' },
  { id: 'BNG-BJP', name: 'Bengaluru - Vijayapura', tatakId: 'KA-BNG-BJP', tatakDir: 'ka-bng-bjp', tatakDirectionId: 0, hub: 'KBS', reverseHub: 'BJP' },
  { id: 'BNG-BDM', name: 'Bengaluru - Badami', tatakId: 'KA-BNG-BDM', tatakDir: 'ka-bng-bdm', tatakDirectionId: 0, hub: 'KBS', reverseHub: 'BDM' },
  { id: 'BNG-BGK', name: 'Bengaluru - Bagalkot', tatakId: 'KA-BNG-BGK', tatakDir: 'ka-bng-bgk', tatakDirectionId: 0, hub: 'KBS', reverseHub: 'BGK' },
  { id: 'BNG-HBL', name: 'Bengaluru - Hubballi', tatakId: 'KA-BNG-HBL', tatakDir: 'ka-bng-hbl', tatakDirectionId: 0, hub: 'KBS', reverseHub: 'HUB' },
]

/**
 * This simulator's `ServiceClassId` for every Tatak class this project can
 * roster. A Tatak class with no row here (`ashwamedha`, `ev_power_plus`,
 * `non_ac_sleeper`, `ac_seater_executive_chair`, `ambaari_dream_class`,
 * `kalyana_ratha`) has no matching row in `data/bundle/corridor-classes.json`
 * and gets no roster entry at all - this repo could not generate a coach for
 * it regardless of what this script did.
 *
 * `AIRAVAT_CLUB_CLASS_2` is the one exception, mapped onto the same
 * `airavat_club_class` row rather than left out: it is the class behind
 * BNG-MNG's own `1004BNGMNG`, and everything Tatak's own catalogue says
 * about it (`src/classes.ts` in that checkout) describes the same premium
 * AC sleeper product as `AIRAVAT_CLUB_CLASS`, one generation apart on the
 * fleet rather than a different thing a rider buys. Treating "2" as its own
 * `ServiceClassId` would mean a new row in `corridor-classes.json`, a new
 * name in `INTERCITY_SERVICE_CLASSES`, and a fleet-class distinction this
 * simulator has no other use for - all to keep separate two things Tatak's
 * own documentation says are the same coach.
 */
export const CLASS_MAP: Readonly<Record<string, string>> = {
  KARNATAKA_SARIGE: 'karnataka_sarige',
  RAJAHAMSA_EXECUTIVE: 'rajahamsa_executive',
  AIRAVAT: 'airavat',
  AIRAVAT_CLUB_CLASS: 'airavat_club_class',
  AIRAVAT_CLUB_CLASS_2: 'airavat_club_class',
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
 * - 2334BNGMNG: KA-BNG-MNG and KA-MYS-MNG
 *
 * `0801BNGCDP` used to be a fifth entry here (KA-BNG-MNG and KA-COAST) and
 * is not any more - see `CORRIDOR_EXCLUSIVE_SERVICE_NUMBERS` below for why
 * that one code turned out not to be this kind of ambiguity at all.
 */
export const AMBIGUOUS_SERVICE_NUMBERS: ReadonlySet<string> = new Set([
  '2105BNGMRC',
  '2131MRCBNG',
  '2334BNGMNG',
])

/**
 * Real service numbers Tatak's own dataset sights on more than one
 * corridor feed, kept on exactly one of them rather than dropped from
 * every corridor the way `AMBIGUOUS_SERVICE_NUMBERS` is.
 *
 * The distinction from that set matters and is worth stating plainly:
 * `src/intercity/sourced.ts` in the Tatak checkout is explicit that a
 * through-service is stamped onto every corridor feed that plausibly
 * carries it, once per town it is SIGHTED at - that is Tatak's own design,
 * not a data error, and it is a completely different situation from the
 * four codes above, where Tatak's own comment admits it cannot tell which
 * of two corridors the working actually belongs to.
 *
 * `0801BNGCDP` decodes to a 08:01 Bengaluru departure bound for `CDP` -
 * Kundapura (`docs/research/karnataka-corridor-evidence.md`'s letter-group
 * table, in the Tatak checkout) - a coastal town on `KA-COAST`, not a stop
 * on the Mangaluru trunk `KA-BNG-MNG` models. Both feeds carry it as a real
 * dir0 KARNATAKA_SARIGE working because the road out of Bengaluru is one
 * road as far as Udupi, then forks; this project's own corridors split
 * that one road into two, so the code has to pick one of them rather than
 * being dropped from both. `MNG-KWR` (built from `KA-COAST`) is the pick,
 * on the destination the code itself names.
 */
export const CORRIDOR_EXCLUSIVE_SERVICE_NUMBERS: Readonly<Record<string, string>> = {
  '0801BNGCDP': 'MNG-KWR',
}

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
  // Never needed before this pass: no earlier `buildFromTatak` corridor
  // rode the Bengaluru-Hosapete trunk, because BNG-HSP itself is the one
  // corridor built from an authored stand list rather than from Tatak. All
  // four new corridors below share some or all of it.
  'KA-BP-BNG-PEENYA': 'PNY',
  'KA-BP-TUMAKURU': 'TUM',
  'KA-BP-SIRA': 'SIR',
  'KA-BP-HIRIYUR': 'HRR',
  'KA-BP-CHITRADURGA': 'CTD',
  'KA-BP-KUDLIGI': 'KDL',
  'KA-BP-HOSAPETE': 'HSP',
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
  // Added alongside BNG-BJP, BNG-BDM and BNG-BGK, which share one trunk out
  // of Hosapete (Kustagi, Ilkal, Hungund) before splitting to their own
  // three towns.
  'KA-BP-KUSTAGI': 'KST',
  'KA-BP-ILKAL': 'ILK',
  // Not 'HUN' - Hunsur already holds that on the Mysuru-Madikeri corridor,
  // and STAND_CODE_BY_TATAK_STOP_ID is keyed statewide, not per corridor.
  'KA-BP-HUNGUND': 'HGD',
  'KA-BP-VIJAYAPURA': 'BJP',
  'KA-BP-BADAMI': 'BDM',
  'KA-BP-BAGALKOT': 'BGK',
  // BNG-HBL's own trunk out of Chitradurga, distinct from the Hosapete one
  // above - Hubballi is reached via Davanagere and Haveri, not Kustagi.
  'KA-BP-DAVANAGERE': 'DVG',
  'KA-BP-HAVERI': 'HVR',
  'KA-BP-HUBBALLI': 'HBL',
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
  // Every stop on the shared Bengaluru-Hosapete trunk (Peenya through
  // Hosapete) carries an empty `tatak_territory_corporation` in every Tatak
  // feed that names it, including `KA-BNG-HMP` itself - a gap in Tatak's
  // own research, not a fourth corporation. This project's own call for the
  // gap: the whole stretch is undisputed KSRTC territory in reality (the
  // hand-authored BNG-HSP corridor's own `CORPORATIONS` already says as
  // much, splitting to KKRTC only past Hosapete), so an empty string reads
  // as KSRTC here rather than failing the build over a field Tatak never
  // filled in for this one road.
  '': 'KSRTC',
}

export function corporationForTerritory(territoryCorporation: string): Corporation {
  const corporation = CORPORATION_BY_TERRITORY[territoryCorporation]
  if (corporation === undefined) throw new Error(`Unknown territory corporation ${territoryCorporation}`)
  return corporation
}
