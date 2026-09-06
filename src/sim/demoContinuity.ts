import type { Assignment, CoachDuty } from './corridorRoster.js'
import type { DutyState } from './duty.js'

/**
 * Four Karnataka Sarige coaches, pinned to a chain of real, already-rostered
 * departures so each one carries a duty at any hour between 06:00 and 23:00
 * local, every day the roster carries these service numbers.
 *
 * ## Why this exists
 *
 * A demo QR sticker names one fixed vehicle. `assignFleet` (`corridorRoster.
 * ts`) draws a fresh candidate for every duty from a pool scoped to one
 * corridor, one service class and one hub - which is correct for the fleet
 * at large (§10.3's "the assignment function is seeded and pure") but means
 * no ordinary coach ever runs two duties on different corridors, or a
 * corridor's forward leg and its own reverse leg, in the same day: a KBS-hub
 * pool member only ever matches `duty.hub === 'KBS'`, a BDM-hub member only
 * `duty.hub === 'BDM'`, and so on. A single physical coach carries no
 * departure past whichever one duty ends its own hub's slice of the day.
 * That is exactly why the original single sticker went dark for most of the
 * clock: the vehicle behind it had one duty, at one hour, and nothing either
 * side of it.
 *
 * A real depot does not work that way - the same coach goes out on the
 * morning working, comes back, and is handed the evening one, on whatever
 * corridor the roster clerk has open. This is that reassignment, done by
 * hand for four coaches instead of left to the per-corridor pool: each entry
 * below is a sequence of duties, named by `(corridorId, serviceId)` rather
 * than by a duty id, because a duty id embeds the service *date* and these
 * departures repeat daily - the pin has to survive the date rolling over,
 * which is the whole point of putting a coach on a sticker.
 *
 * Every leg is a real, already-rostered `karnataka_sarige` departure with a
 * genuine Tatak-sourced service number (`data/bundle/corridor-roster.json`
 * carries every one of these nine service ids already; nothing was added to
 * roster it). Consecutive legs hand off at a shared hub with a non-negative
 * turnaround - the coach is always physically where the next leg needs it,
 * never teleported - and the four chains were chosen, by inspecting every
 * corridor's own real timetable, specifically because their union of
 * `[departure, arrival)` windows covers 06:00-23:00 with only the gaps a
 * real timetable's own headways leave (documented on each chain below; see
 * also `docs/intercity-coaches.md` for the wider roster).
 *
 * ## What this does not do
 *
 * It does not invent a departure, a service number, or a vehicle. The four
 * bins (`KA_SARIGE_STICKER_CHAINS[].bin`) are ordinary coaches this fleet
 * already generated for one of these corridors - see the `bin` field's own
 * comment. The only thing this file changes is *which* coach a handful of
 * already-real duties are assigned to.
 */
export interface DemoContinuityLeg {
  readonly corridorId: string
  readonly serviceId: string
}

export interface DemoContinuityChain {
  /**
   * A real coach this fleet already generated - each one is the ordinary
   * `<hub>-<serial>` bin `generateCoachFleet` assigns to some
   * `karnataka_sarige` slot on one of this chain's own corridors, not a bin
   * minted for this file. Picking an existing coach rather than adding a
   * new one is what keeps this a reassignment rather than a fleet of one
   * vehicle that exists only for the sticker page.
   */
  readonly bin: string
  readonly legs: readonly DemoContinuityLeg[]
}

export const KA_SARIGE_STICKER_CHAINS: readonly DemoContinuityChain[] = [
  // BDM-01010: a Badami-hub coach, out on BNG-BDM's own reverse leg all
  // morning and afternoon, then a same-depot corridor change onto BNG-MYS's
  // evening run. Gap, at the depot: 17:53-18:50.
  //
  // BNG-BDM's own forward leg (`2000BNGBDM`, KBS 20:00 -> BDM ~07:53 the
  // next day) was the first thing tried here, and it is wrong: this
  // service repeats every day, so "the next day" is also a day this same
  // reverse leg runs, and 07:53 is *after* that day's own `0600BDMBNG`
  // (06:00) has already pulled out - the same bin would carry two open
  // duties at once every single morning. Every pairing below was checked
  // against its own next occurrence for exactly this, not just against
  // itself once.
  {
    bin: 'BDM-01010',
    legs: [
      { corridorId: 'BNG-BDM', serviceId: '0600BDMBNG' }, // BDM 06:00 -> KBS ~17:53
      { corridorId: 'BNG-MYS', serviceId: '1850BNGCBT' }, // KBS 18:50 -> MYS ~22:40
    ],
  },
  // HUB-01181: a Hubballi-hub coach. BNG-HBL ran no forward Karnataka
  // Sarige in Tatak's own data (see newCorridors.ts's own note on why), so
  // this coach's second leg is a same-depot corridor change to BNG-CKM.
  // Gap: 17:52-22:30 - the real evening options ex-KBS this coach's own
  // corridor does not have are either much longer hauls that reoffend the
  // next-occurrence overlap above (BNG-BJP, BNG-BDM) or already spoken for
  // by another chain (BNG-MYS's own 18:50) - BNG-CKM's 22:30 is what is
  // left, and it still lands exactly on the hour this file exists to cover.
  {
    bin: 'HUB-01181',
    legs: [
      { corridorId: 'BNG-HBL', serviceId: '0630HBLBNG' }, // HUB 06:30 -> KBS ~17:52
      { corridorId: 'BNG-CKM', serviceId: '2230BNGCKM' }, // KBS 22:30 -> CKM ~04:40 (+1d)
    ],
  },
  // MNG-01216: a Mangaluru-hub coach, out to KBS in the morning and then
  // doing BNG-MYS's own out-and-back in the afternoon and evening. Gaps:
  // 13:19-14:01 and 17:51-19:00, both ordinary depot turnaround, neither
  // near a checked hour.
  {
    bin: 'MNG-01216',
    legs: [
      { corridorId: 'BNG-MNG', serviceId: '0530MNGBNG' }, // MNG 05:30 -> KBS ~13:19
      { corridorId: 'BNG-MYS', serviceId: '1401BNGMYS' }, // KBS 14:01 -> MYS ~17:51
      { corridorId: 'BNG-MYS', serviceId: '1900MYSTPT' }, // MYS 19:00 -> KBS ~22:50
    ],
  },
  // MNG-01203: a second, distinct Mangaluru-hub coach (real service number,
  // not the one above), reassigned onto BNG-HSP's long evening run for its
  // second leg - a single working that alone covers both the 17:00 and
  // 22:30 checks. Gap: 13:20-16:30.
  {
    bin: 'MNG-01203',
    legs: [
      { corridorId: 'BNG-MNG', serviceId: '0531MNGBNG' }, // MNG 05:31 -> KBS ~13:20
      { corridorId: 'BNG-HSP', serviceId: '1630BNGKPL' }, // KBS 16:30 -> past HSP ~02:00 (+1d)
    ],
  },
]

/**
 * Overrides `assignFleet`'s own answer for exactly the duties named above,
 * on every service date the roster window carries - matched by
 * `(corridorId, serviceId)` rather than by duty id for the reason
 * `KA_SARIGE_STICKER_CHAINS`'s own doc gives. Every other duty keeps
 * whatever `assignFleet` gave it; this only ever narrows four coaches onto
 * the chains chosen for them.
 */
export function pinDemoContinuityChains(
  duties: readonly CoachDuty[],
  assignments: ReadonlyMap<string, Assignment>,
): ReadonlyMap<string, Assignment> {
  const binByLegKey = new Map<string, string>()
  for (const chain of KA_SARIGE_STICKER_CHAINS) {
    for (const leg of chain.legs) {
      binByLegKey.set(`${leg.corridorId}|${leg.serviceId}`, chain.bin)
    }
  }
  if (binByLegKey.size === 0) return assignments
  const merged = new Map(assignments)
  for (const duty of duties) {
    const bin = binByLegKey.get(`${duty.corridorId}|${duty.serviceId}`)
    if (bin === undefined) continue
    merged.set(duty.id, {
      dutyId: duty.id,
      bin,
      status: 'assigned',
      previousBin: null,
      supersededAt: null,
    })
  }
  return merged
}

/** The bins `pinDemoContinuityChains` pins, so the assignment pool that
 *  feeds `assignFleet` can leave them out - see `coachWorld.ts`'s own
 *  comment on why: a pinned bin that also stayed in the ordinary pool could
 *  be handed a second, unrelated, overlapping duty by the very mechanism
 *  this file exists to override. */
export function demoContinuityBins(): ReadonlySet<string> {
  return new Set(KA_SARIGE_STICKER_CHAINS.map((chain) => chain.bin))
}

const DEMO_CONTINUITY_LEG_KEYS: ReadonlySet<string> = new Set(
  KA_SARIGE_STICKER_CHAINS.flatMap((chain) =>
    chain.legs.map((leg) => `${leg.corridorId}|${leg.serviceId}`),
  ),
)

/**
 * Whether `(corridorId, serviceId)` is one of the nine legs pinned above -
 * `coachWorld.ts`'s `buildRun` asks this to skip `createDutyState`'s own
 * seeded draw for these duties specifically.
 *
 * Every other duty in the fleet keeps that draw, and keeping it is the
 * point: §10.3's `confirmed`/`inferred`/`unknown`/`out_of_service` split is
 * a real fact this simulation models, that BMTC's (or here, KSRTC's) own
 * signing system does not confirm every duty it should. But that draw is
 * keyed on `(bin, serviceId, serviceDate)`, so it varies by calendar day -
 * and a sticker glued to a physical vehicle cannot come with a footnote
 * that says it might not sell today because the roster's confidence model
 * rolled `out_of_service`. Four fixed vehicles that must sell on any scan
 * cannot also be four vehicles that sell on 98% of scans; the two asks
 * would already be true of this simulator's own general behaviour if this
 * pin only fixed the vehicle and left its duty confidence to chance, which
 * is what surfaced this in the first place: `HUB-01181`'s own `2230BNGCKM`
 * leg drew `out_of_service` on 2026-09-07, the first date this was checked
 * against.
 */
export function isDemoContinuityLeg(corridorId: string, serviceId: string): boolean {
  return DEMO_CONTINUITY_LEG_KEYS.has(`${corridorId}|${serviceId}`)
}

/** The duty state a pinned leg always carries - see `isDemoContinuityLeg`. */
export function demoContinuityDutyState(at: Date): DutyState {
  return { status: 'confirmed', since: new Date(at), confidence: null, reason: null }
}
