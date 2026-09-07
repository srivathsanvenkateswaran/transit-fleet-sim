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
 * carries every one of these eleven service ids already; nothing was added
 * to roster it). Consecutive legs hand off at a shared hub with a
 * non-negative turnaround - the coach is always physically where the next
 * leg needs it, never teleported - and the four chains were chosen, by
 * inspecting every corridor's own real timetable, specifically because their
 * union of `[departure, arrival)` windows covers 06:00-23:00 with only the
 * gaps a real timetable's own headways leave (documented on each chain
 * below; see also `docs/intercity-coaches.md` for the wider roster).
 *
 * ## What this does not do
 *
 * It does not invent a departure, a service number, or a vehicle. The four
 * bins (`KA_SARIGE_STICKER_CHAINS[].bin`) are ordinary coaches this fleet
 * already generated for the `karnataka_sarige` pool of one of these
 * corridors - see the `bin` field's own comment. The only thing this file
 * changes is *which* coach a handful of already-real duties are assigned to,
 * and that reassignment is deliberately not scoped to a chain's own home
 * corridor: `BDM-01010` already ran a leg on `BNG-MYS` it was never
 * generated against, and every bin below does the same. A bin's three-letter
 * prefix is therefore cosmetic with respect to which legs it runs - it says
 * where `generateCoachFleet` happened to mint that particular coach, nothing
 * about its sticker chain - but it is not cosmetic to a rider: `GET
 * /fleet/resolve` answers `vehicle.hub` straight from the bin's own prefix
 * (`fixtureHub(bin.slice(0, 3))`), and the consuming app's typed-entry
 * screen and hub directory (Tatak's `src/fleet/hubs.ts`) know exactly six
 * hub codes - `BLR`, `KBS`, `MYS`, `MDK`, `HUB`, `HSP` - not the fuller
 * `INTERCITY_HUB_CODES` list this simulator mints coaches against. A sticker
 * reading `BDM-…` or `MNG-…` is real and resolves, but its hub prefix is one
 * the rider's own typed-entry menu cannot offer and the board screen's
 * hub-name lookup does not recognise - a latent, avoidable rough edge for
 * the one class of vehicle a rider is being told by name to scan. All four
 * bins here are therefore drawn from four of the hub pools this fleet
 * actually generated `karnataka_sarige` coaches against - `KBS`, `MYS`,
 * `MDK`, `HUB` - which is every one of Tatak's five intercity hub codes
 * except `HSP`
 * (Hosapete never originates a `karnataka_sarige` departure in this
 * roster - see the `HSP`-hub comment below - so `generateCoachFleet` never
 * minted a coach in that pool to reassign).
 */
export interface DemoContinuityLeg {
  readonly corridorId: string
  readonly serviceId: string
}

export interface DemoContinuityChain {
  /**
   * A real coach this fleet already generated - each one is the ordinary
   * `<hub>-<serial>` bin `generateCoachFleet` assigns to some
   * `karnataka_sarige` slot somewhere in this fleet, not a bin minted for
   * this file, and not necessarily one drawn from this chain's own
   * corridors (see the file header's own note on why the prefix is picked
   * for the rider-facing hub it names rather than for which legs follow).
   * Picking an existing coach rather than adding a new one is what keeps
   * this a reassignment rather than a fleet of one vehicle that exists only
   * for the sticker page.
   */
  readonly bin: string
  readonly legs: readonly DemoContinuityLeg[]
}

export const KA_SARIGE_STICKER_CHAINS: readonly DemoContinuityChain[] = [
  // HUB-01181: kept the same bin as before this pass, but a wholly
  // different chain. `BNG-HBL` (Hubballi) runs no forward Karnataka Sarige
  // in Tatak's data - a coach based there can only ever depart at 06:30 at
  // the earliest, which cannot cover this file's own 06:15 checkpoint - so
  // there is no chain built on that corridor that closes this vehicle's
  // window at all, and the fix is a different chain entirely, exactly as
  // flagged going into this pass. This one starts on `BNG-BDM` instead:
  // `0600BDMBNG` alone spans 06:00-17:53, covering every checkpoint from
  // 06:15 through 16:00 in one leg. Its evening leg, `1831BNGMNG`, is the
  // earliest real KBS departure after that arrival - `BNG-BDM` has none
  // between 17:53 and 18:31, so the 18:00 checkpoint sits inside a
  // real, unavoidable 38-minute depot gap (17:53-18:31) rather than the
  // 4h38m dark window this bin carried before. `1831BNGMNG` alone then
  // carries it to next-day 02:19, clearing 20:00 and 22:45 comfortably.
  //
  // `2000BNGBDM` (the corridor's own forward leg, KBS 20:00 -> BDM ~07:53
  // the next day) was tried and rejected for the reason the previous pass
  // already found: it repeats daily, so its own next-day arrival lands
  // after that day's `0600BDMBNG` (06:00) has already pulled out, and two
  // duties would sit open on one bin at once every morning. Checked against
  // its own next occurrence, `1831BNGMNG`'s tail (next-day 02:19) clears
  // the following `0600BDMBNG` (06:00) by 3h41m - no such collision here.
  {
    bin: 'HUB-01181',
    legs: [
      { corridorId: 'BNG-BDM', serviceId: '0600BDMBNG' }, // BDM 06:00 -> KBS 17:53
      { corridorId: 'BNG-MNG', serviceId: '1831BNGMNG' }, // KBS 18:31 -> MNG 02:19 (+1d)
    ],
  },
  // MYS-01010: the chain that used to be MNG-01203's, with its 3h10m
  // midday hole (13:20-16:30) actually closed rather than carried. Its
  // dawn leg is the same real `0531MNGBNG` as before; from there, instead
  // of waiting three hours for `BNG-HSP`'s 16:30 departure, it takes
  // `BNG-MYS`'s own early-afternoon leg (`1401BNGMYS`, KBS 14:01), a same-
  // corridor round trip back (`1400MRCBNG`, MYS 18:00 -> KBS 21:49, a
  // 9m24s stand at Mysuru), and finally `BNG-CKM`'s late departure
  // (`2230BNGCKM`) through to next-day 04:40. What is left of the gap is
  // 13:20-14:01 - 41 minutes, and there is no Karnataka Sarige departure
  // anywhere in Tatak's roster between those two clock readings, so this
  // file's own 14:00 checkpoint sits one minute inside it. That is the
  // nearest a real timetable gets: not a contrivance, the honest ceiling
  // of what `BNG-MYS`'s own headway offers this bin.
  //
  // Next-occurrence check: `2230BNGCKM`'s tail (next-day 04:40) clears the
  // following `0531MNGBNG` (05:31) by 51 minutes.
  {
    bin: 'MYS-01010',
    legs: [
      { corridorId: 'BNG-MNG', serviceId: '0531MNGBNG' }, // MNG 05:31 -> KBS 13:20
      { corridorId: 'BNG-MYS', serviceId: '1401BNGMYS' }, // KBS 14:01 -> MYS 17:50
      { corridorId: 'BNG-MYS', serviceId: '1400MRCBNG' }, // MYS 18:00 -> KBS 21:49
      { corridorId: 'BNG-CKM', serviceId: '2230BNGCKM' }, // KBS 22:30 -> CKM 04:40 (+1d)
    ],
  },
  // KBS-01032: also fresh. `0530MNGBNG` opens the day from Mangaluru,
  // ahead of 06:15, through to KBS at 13:19; a 71-minute stand there hands
  // onto `BNG-HSP`'s own `1630BNGKPL`, the same long evening working
  // `MNG-01203` used to carry alone (16:30 through next-day 02:00),
  // clearing 18:00, 20:00 and 22:45. `BNG-HSP`'s only other departure in
  // reach of this leg's own 13:19 arrival, `1030BNGHMP`, reads as a real
  // service number but the roster carries it flagged `"confidence":
  // "invented"` - Tatak's own corridor dataset has no trip by that number
  // (`GET /api/route` on it answers `unknown_trip`) - so it is not a real
  // Tatak service number and this chain does not use it, leaving a single
  // 3h11m hole (13:19-16:30) across the 14:00 and 16:00 checks: the same
  // shape of gap the whole file exists to close, just left standing once
  // on the one chain the roster's real (non-invented) departures could not
  // stretch further to close. `KBS` is also the one hub `BNG-HSP` itself
  // ever generates a coach against, which is why this leg lands on the
  // `KBS` bin rather than one of the other three: `BNG-HSP` mints no
  // `MDK`, `MYS` or `HUB` coach to reassign here in the first place.
  //
  // Next-occurrence check: `1630BNGKPL`'s own tail (next-day 02:00) clears
  // the following `0530MNGBNG` (05:30) by 3h30m.
  {
    bin: 'KBS-01032',
    legs: [
      { corridorId: 'BNG-MNG', serviceId: '0530MNGBNG' }, // MNG 05:30 -> KBS 13:19
      { corridorId: 'BNG-HSP', serviceId: '1630BNGKPL' }, // KBS 16:30 -> HSP 02:00 (+1d)
    ],
  },
  // MDK-01010: a fresh chain, not carried over from before this pass.
  // `0545BNGVRP` opens the day from KBS itself at 05:45, ahead of the
  // 06:15 checkpoint; `1030MYSTPT` (a 55m24s stand at Mysuru) runs
  // straight through both the noon and 14:00 checks (10:30-14:19); and
  // `1432BNGMNG` (a 12m24s turn at KBS) carries it to Mangaluru by 22:20,
  // clearing 16:00, 18:00 and 20:00. `BNG-MNG` has no departure back
  // toward KBS between 22:20 and the next morning, so 22:45 sits 25
  // minutes past this chain's own last arrival - the same shape of gap as
  // the other three, just at the far end of the evening instead of the
  // middle of the afternoon.
  //
  // Next-occurrence check: `1432BNGMNG`'s own arrival (22:20, same day)
  // clears the following `0545BNGVRP` (05:45) by 7h25m.
  {
    bin: 'MDK-01010',
    legs: [
      { corridorId: 'BNG-MYS', serviceId: '0545BNGVRP' }, // KBS 05:45 -> MYS 09:34
      { corridorId: 'BNG-MYS', serviceId: '1030MYSTPT' }, // MYS 10:30 -> KBS 14:19
      { corridorId: 'BNG-MNG', serviceId: '1432BNGMNG' }, // KBS 14:32 -> MNG 22:20
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
 * Whether `(corridorId, serviceId)` is one of the eleven legs pinned above -
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
 * is what surfaced this in the first place: a pinned leg on the original
 * four-chain design drew `out_of_service` on 2026-09-07, the first date this
 * was checked against - a bin that changed under this pass, but the failure
 * mode it exposed did not.
 */
export function isDemoContinuityLeg(corridorId: string, serviceId: string): boolean {
  return DEMO_CONTINUITY_LEG_KEYS.has(`${corridorId}|${serviceId}`)
}

/** The duty state a pinned leg always carries - see `isDemoContinuityLeg`. */
export function demoContinuityDutyState(at: Date): DutyState {
  return { status: 'confirmed', since: new Date(at), confidence: null, reason: null }
}
