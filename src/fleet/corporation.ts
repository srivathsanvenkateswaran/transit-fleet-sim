/**
 * The four road-transport corporations a coach can belong to.
 *
 * docs/intercity-coaches.md §1.1: Karnataka's road transport was one
 * undivided KSRTC until 1997 and then split three times. BMTC stays
 * Bengaluru-city-only; the other three run the intercity network this
 * document adds. A metro train belongs to none of these - BMRCL is not a
 * road transport corporation and is not in this union - which is why
 * `FleetVehicle.corporation` is null for a train rather than reaching for a
 * fifth value nothing in this document establishes. See §2.2's own interface
 * sketch, which shows `corporation` as non-optional everywhere including
 * metro; criterion 56 is the more precise, binding statement ("every metro
 * vehicle carries neither corporation nor serviceClass") and is what this
 * codebase follows where the two disagree.
 */
export type Corporation = 'BMTC' | 'KSRTC' | 'NWKRTC' | 'KKRTC'

export const CORPORATION_NAMES: Readonly<Record<Corporation, string>> = {
  BMTC: 'Bengaluru Metropolitan Transport Corporation',
  KSRTC: 'Karnataka State Road Transport Corporation',
  NWKRTC: 'North Western Karnataka Road Transport Corporation',
  KKRTC: 'Kalyana Karnataka Road Transport Corporation',
}

/**
 * The operating division behind each fixture hub code, and the corporation
 * that runs it. docs/intercity-coaches.md §2.3: "The hub code for a coach is
 * the operating division, not the corporation... `BLR` stays BMTC's alone.
 * KSRTC's Bengaluru operations get `KBS`." This is fixture data, not a
 * general algorithm - the three corporations run roughly 35 divisions
 * between them and only five are stood up here, matching
 * `INTERCITY_HUB_CODES`'s default. Adding a division means adding a row here
 * and to the default env list together; `loadFixtureHub` fails startup
 * loudly rather than silently treating an unknown hub as belonging to no
 * corporation.
 */
export interface FixtureHub {
  readonly code: string
  readonly division: string
  readonly corporation: Corporation
}

export const FIXTURE_HUBS: readonly FixtureHub[] = [
  { code: 'KBS', division: 'Kempegowda Bus Station', corporation: 'KSRTC' },
  { code: 'MYS', division: 'Mysuru', corporation: 'KSRTC' },
  { code: 'MDK', division: 'Madikeri', corporation: 'KSRTC' },
  { code: 'HUB', division: 'Hubballi', corporation: 'NWKRTC' },
  { code: 'HSP', division: 'Hosapete', corporation: 'KKRTC' },
  // Added alongside the seven new corridors in scripts/build-corridors.ts
  // and scripts/build-corridor-roster.ts. Same editorial status as the five
  // above: this project's own choice of division/corporation for a hub
  // code its roster now needs, not a verified fact about KSRTC's or
  // NWKRTC's actual division structure.
  { code: 'MNG', division: 'Mangaluru', corporation: 'KSRTC' },
  { code: 'CKM', division: 'Chikkamagaluru', corporation: 'KSRTC' },
  { code: 'UDP', division: 'Udupi', corporation: 'KSRTC' },
  { code: 'DND', division: 'Dandeli', corporation: 'NWKRTC' },
  // Added for the bidirectional-roster coverage pass: a `reverse` departure
  // on BNG-BJP, BNG-BDM, BNG-BGK or MNG-KWR originates at the corridor's
  // other end, which needed its own hub the way `MNG` already gets one on
  // MYS-MNG. Same editorial status as the four above - Vijayapura, Badami
  // and Bagalkot are grouped with NWKRTC's real Belagavi-division territory
  // (the same region `DND` already sits in), and Karwar with it for the
  // same reason; not a verified fact about NWKRTC's actual division
  // boundaries.
  { code: 'BJP', division: 'Vijayapura', corporation: 'NWKRTC' },
  { code: 'BDM', division: 'Badami', corporation: 'NWKRTC' },
  { code: 'BGK', division: 'Bagalkot', corporation: 'NWKRTC' },
  { code: 'KWR', division: 'Karwar', corporation: 'NWKRTC' },
]

export function fixtureHub(code: string): FixtureHub | null {
  return FIXTURE_HUBS.find((hub) => hub.code === code.toUpperCase()) ?? null
}

/**
 * The RTO district number a corporation's fixture plates are drawn from.
 *
 * docs/intercity-coaches.md §2.4, `UNRESOLVED`: "the district-code table is
 * not verified... this document will not present a table of thirty numbers
 * it has not read." What follows is not that table. It is one district per
 * corporation, taken from the document's own two worked examples -
 * `KA-32-ZZ-4417` for a KKRTC coach registered in Kalaburagi, `KA-25-ZZ-0918`
 * for NWKRTC in Dharwad - plus BMTC's existing fixture districts and KSRTC's
 * home district of Bengaluru. A wrong entry here produces a plate that names
 * the wrong district and still cannot collide with a real vehicle, because
 * the `ZZ` series carries that guarantee, not this table (§2.4 again).
 */
export const DISTRICT_CODE_BY_CORPORATION: Readonly<Record<Corporation, readonly string[]>> = {
  BMTC: ['01', '41', '50'],
  KSRTC: ['01'],
  NWKRTC: ['25'],
  KKRTC: ['32'],
}
