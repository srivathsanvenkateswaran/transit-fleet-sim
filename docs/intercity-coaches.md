# Intercity coaches: extending the simulator from a city fleet to a state network

**Status:** build-ready specification, peer to [`SPEC.md`](../SPEC.md). No code has been
written yet.
**Audience:** an engineer who has read `SPEC.md` in full and has the Bengaluru
service running. This document assumes every decision in that one and reopens
none of them.
**Written:** 5 September 2026.

---

## 0. Read this first: the decisions this document takes

`SPEC.md` simulates a Bengaluru city fleet: BMTC buses on real GTFS shapes and
Namma Metro trains on real OSM station order, with staleness, dropouts, partial
device coverage, prediction bands and roster uncertainty deliberately modelled.
This document adds Karnataka's intercity coaches, run by KSRTC, NWKRTC and
KKRTC, which the World Bank's K-BREEZE project appraisal puts at about 19,000
buses between the three.[^kbreeze]

**An intercity coach is not a city bus with a longer route.** What follows is
the list of differences that run through everything below, and they are the
reason this is a separate document rather than a section added to `SPEC.md`.

1. **A duty lasts eight to ten hours and crosses midnight.** The clock, the
   cursor, the dispatch loop and the duty model all assume a within-day cyclic
   run, and each of them breaks in a different way. Section 3 says exactly how,
   file by file.

2. **A meal halt is not a dropout, and the service must say so.** A coach parked
   thirty minutes at a dhaba at 02:00 is doing what it was scheduled to do. The
   current model has one dwell concept and no way to distinguish a deliberate
   stop from a stuck one. Section 4.

3. **Highway prediction over four hours is tighter than city prediction over ten
   minutes**, proportionally, and the existing `base + perStop * n` band gets that
   backwards if it is merely reparameterised. Section 5 replaces stop-count
   linearity with a term for remaining highway distance and a term for remaining
   halts, and extends the horizon from five stops to six hours - because refusing
   to predict the one arrival the model genuinely supports is the mistake section
   7.3 of `SPEC.md` already argued against.

4. **A reserved coach is better fitted and worse tracked than a city bus.**
   Coverage and continuity are different facts and the intercity case inverts
   them: `untracked` gets rarer, `dark` gets far more common and far longer.
   Dropouts stop being a Poisson process in time and become intervals of route
   distance, because a dead zone between districts is in the same place every
   night for every coach. Section 6, with the evidence for the ruling.

5. **A reserved coach's load is somebody else's fact, and only partly even
   theirs.** The demand model in `src/sim/occupancy.ts` is correct for a walk-up
   bus because nobody counts. Bookings against a reserved coach are counted, by a
   booking system, and this service does not hold that count. **So it emits no
   occupancy for a reserved duty at all**: it publishes the booking count the BPP
   pushes it (section 7.4), under a name that means a booking count and never as a
   measure of how full the coach is (section 7.5), or it publishes nothing.
   Section 7.

6. **The rider is asleep.** Tracking an overnight coach is one cold read at 05:40,
   not a ten-second poll at a bus stop, and the read has to answer "did anything
   happen while I was out" with facts rather than a snapshot. Section 8.

**These architectural decisions are settled and are not reopened here.**

- **The simulator owns vehicle identity; the BPP owns the booking; the join key
  is the service and the date.** A reservation names a service and a date. This
  simulator resolves that pair to a vehicle and a plate at run time, through
  `GET /fleet/duty` (section 10.3), and the count of bookings against it travels
  the other way through a push the BPP makes (section 7.4). The BPP never invents
  a plate and this simulator never invents a booking.
- **Determinism stays.** Seeded, reproducible, no wall clock outside
  `src/sim/clock.ts`, the same duty on the same date yielding the same vehicle.
  Section 15 makes it a stronger test than the existing one, because a
  cross-midnight roster is where a service-date bug hides.
- **The fixture remains the default in the consuming app.** Nothing here
  becoming unavailable may degrade a journey plan. Section 14.
- **No real operator feeds, no real plates.** Every vehicle, plate, corporation
  assignment and position stays fabricated. Section 2.4 states the plate
  guarantee for coaches, including the one place it is weaker than BMTC's and
  what that means.

**What this document does not own.** The corridor stand lists and the departure
times. Those are dataset work, they are large, and the consuming app's own
statewide design costs them at 20 to 30 engineer-days on their own.[^tatak-spec]
This simulator consumes a corridor file; it does not harvest one. Section 9.5
states the boundary and why neither repository may import the other.

---

## 1. What an intercity coach is, in this domain

An engineer who has built the Bengaluru service needs this section to know which
of the parameters below are copying something real and which are chosen.

Every domain claim carries the confidence label the underlying research gave it:
**[V]** verified against an official or primary-adjacent source, **[S]**
secondary (Wikipedia, news, a booking aggregator), **[I]** inferred. The labels
are carried rather than laundered, because a published cancellation slab and a
marketing blurb do not deserve the same trust and this document will not turn
one into the other.

### 1.1 Four corporations, one brand, and the disclosure gap

Karnataka's road transport was one undivided KSRTC until 1997 and then split
three times.[^kkrtc][^nwkrtc]

| Corporation | HQ | Territory | Fleet |
|---|---|---|---|
| **BMTC** | Bengaluru | Bengaluru city only | ~7,067 buses **[S]**, and past 7,000 in 2025[^bmtc-fleet] |
| **KSRTC** | Bengaluru | Southern Karnataka excluding Bengaluru city; 17 divisions plus one bus-station division | ~8,600-8,900 **[S]** |
| **NWKRTC** | Hubballi | North-western Karnataka; 9 divisions | ~5,000-5,400 **[S]** |
| **KKRTC** | Kalaburagi | Kalyana Karnataka; 8 districts, 9 divisions. Renamed from NEKRTC on 6 July 2021 **[V]** | ~4,500-4,700 **[S]** |

The three intercity corporations **share one reservation brand and one booking
backend**, AWATAR, and share the premium class names between them.[^awatar] The
consequence is a real disclosure gap: Hampi is in Vijayanagara district, which
is KKRTC territory, and every consumer surface examined - KSRTC's own retail
booking, every aggregator, the reporting around the named overnight service -
sells the Bengaluru-to-Hampi coach as "KSRTC" **[S/I]**. No surface found
discloses which corporation actually dispatched the vehicle.

**This simulator can state which corporation it modelled a coach as belonging
to, and that is a smaller claim than closing the gap.** Because it generates the
fleet itself, per corporation, the corporation is known at generation time rather
than inferred at display time - but the vehicle is fabricated, so the value is a
fact about the simulation and not about Karnataka. The sibling BPP's own
specification draws the line in the same place: the simulator's corporation
*"may perfectly well report which corporation it modelled the coach as belonging
to; that value renders, if at all, beside the plate and under the same
'simulated' framing, never in the disclosure slot."*[^bpp-reserved] Section 2.1
makes it a first-class field on the vehicle and section 10.1 marks it as
simulated provenance rather than as an operator disclosure.

### 1.2 The service classes, and the one distinction that matters

| Class | AC | Berths | Layout | Reserved | Notes |
|---|---|---|---|---|---|
| **Karnataka Sarige** | No | No | 3+2 | **No** | The ordinary bus. 5,874 vehicles, KSRTC's largest single class **[V]**[^sarige] |
| **Rajahamsa Executive** | No | No | 2+2 | Yes | Non-AC ultra-deluxe. 127 buses, KSRTC+NWKRTC+KKRTC **[V]**[^rajahamsa] |
| **Airavat** | Yes | No | 2+2 | Yes | Launched 16 May 2012. Volvo B9R/B11R, Mercedes, Scania **[V]**[^airavat-club] |
| **Airavat Club Class** | Yes | Semi-sleeper | 2+2 | Yes | 53 seats reported on Bengaluru-Chennai **[S]**[^airavat-club] |
| **Ambaari Utsav** | Yes | Yes | 2+1 | Yes | Launched 21 Feb 2023; 40 buses; 40 berths; Volvo 9600 **[V]**[^ambaari-utsav] |
| **Pallakki** | No | Yes | 2+1 | Yes | 30 berths, Ashok Leyland Viking 222, BS-VI. The Bengaluru-Hampi overnight **[S]**[^pallakki] |

**Reservation is a property of the service class, not of the corporation and not
of the distance.** The same three corporations run Karnataka Sarige, which is
walk-up and standing-room-permitted, and Pallakki, which is sold by berth. A
model that gated on "intercity" or on "KSRTC" would make an ordinary mofussil bus
un-boardable and would apply the occupancy refusal of section 7 to a vehicle
nobody counts. Every rule below that turns on reservation reads
`serviceClass.reserved`, never the corporation and never the corridor length.

`UNRESOLVED:` no corporation-published fare table, distance slab or fare
multiplier was obtained. Every figure found was a single-route anecdote or an
aggregator's floor price **[S, weak]**. Nothing in this document depends on a
fare, and nothing in it should grow one.

### 1.3 Three corridors, sized

| Corridor | Distance | Duration | Shape |
|---|---|---|---|
| Bengaluru (Kempegowda) - Hosapete - Hampi | ~340 km road | ~7.5 h | Overnight sleeper. Route 2259BNGHMP departs 22:59, Hosapete ~06:00, Hampi ~06:30, 9 stops **[S, and the primary fetch failed - see open question 3]**[^hampi] |
| Bengaluru - Chennai | 347 km | ~8 h | Both a 10:00 daytime and 21:55/22:15 overnight departures reported; multi-point boarding on the Chennai side **[S]**[^abhibus] |
| Mysuru - Madikeri | ~118-120 km | 3-4 h | Daytime seater. No sleeper service found on this pair **[S]** |

The prompt's framing of a nine-hour duty sits inside this band and the fixture
corridors span it. Bengaluru to Kalaburagi, not modelled in the fixture, is
longer still.

### 1.4 What nobody publishes

**No operator publishes a schedule feed.** No GTFS, no data.gov.in dataset, no
community scrape playing the role `Vonter/bmtc-gtfs` plays for BMTC.[^bmtc-gtfs]
The Beckn domain code for intercity bus, TRV12, is still draft, and no state RTC
is a live ONDC participant for intercity booking **[S, not independently
re-fetched]**. The K-BREEZE appraisal names "fragmented institutional systems and
weak data integration" as a barrier the project is funded to fix, which is
first-party confirmation from the operators' own financier that no unified route
dataset exists institutionally.[^kbreeze]

That is the reason section 9 has to invent a geometry pipeline rather than
extend one.

---

## 2. Identity, extended

`SPEC.md` section 4 gives a bus three identifiers doing three jobs: the plate for
the rider, the BIN for the system, the route number for the rider. A coach needs
two more facts and needs the plate more urgently.

### 2.1 Why identity matters more at 22:00 than at 09:00

A rider at a city bus stop at 09:00 is looking at a bus that has a route number
painted on a destination board, arriving every few minutes, on a road they know.
If they board the wrong one they lose ten minutes.

A rider at Kempegowda Bus Station at 22:00 is looking for one specific coach
among forty parked ones, in the dark, with an identical livery on most of them,
because the class names and colours are shared across three corporations
(section 1.1). If they board the wrong one they lose the night, because there is
no next Bengaluru-Hampi Pallakki for twenty-four hours.

**So the UI rule of `SPEC.md` section 4.5 - show the rider what they can verify
with their eyes - has more work to do here, not less.** What a rider can verify
at a dark stand:

| Fact | Where they verify it |
|---|---|
| **Number plate** | Painted front and rear, and it is the only unambiguous one |
| **Destination board** | The corridor's terminal, and often the run code |
| **Service class** | Painted livery and the class name on the board |
| **Bay** | Numbered at the stand |

The corporation is **not** on that list and cannot be. A KKRTC coach and a KSRTC
coach on the shared brand look the same. So the corporation is carried as
**provenance**, disclosed plainly because no existing surface does, and never
presented as something to check. That is the same posture the BIN already has.

### 2.2 The vehicle record

```ts
export interface FleetVehicle {
  readonly bin: string
  readonly class: 'bus' | 'metro' | 'coach'          // 'coach' is new
  readonly corporation: Corporation                   // new
  readonly serviceClass: ServiceClassId | null        // new; null for metro
  readonly homeRouteNumber: string                    // corridor id for a coach
  readonly plates: readonly PlatePeriod[]
}

export type Corporation = 'BMTC' | 'KSRTC' | 'NWKRTC' | 'KKRTC'

export type ServiceClassId =
  | 'karnataka_sarige'
  | 'rajahamsa_executive'
  | 'airavat'
  | 'airavat_club_class'
  | 'ambaari_utsav'
  | 'pallakki'
```

The service class table is data, not code, and lives beside the corridor bundle
so a class can be added without a release:

```jsonc
{
  "id": "pallakki", "name": "Pallakki",
  "reserved": true, "ac": false, "layout": "2+1",
  "berths": true, "capacity": 30,
  "capacitySource": "secondary",              // "primary" | "secondary" | "assumed"
  "corporations": ["KSRTC", "NWKRTC", "KKRTC"]
}
```

**`capacitySource` is not decoration.** Section 7 lets a manifest report
`seatsSold` against `seatsTotal`, and `seatsTotal` comes from here. A figure
sourced from an aggregator's blurb and a figure sourced from an operator's spec
sheet must not read alike downstream, and today every one of them is
`"secondary"`.

### 2.3 The BIN hub code becomes the division

`SPEC.md` section 4.2 makes the hub code three letters from a closed set held in
the registry, never containing `I` or `O`. Bengaluru uses `BLR` and metro uses
`MTR`.

**The hub code for a coach is the operating division, not the corporation.** The
three corporations run roughly 35 divisions between them (KSRTC 17 plus the
Kempegowda bus-station division, NWKRTC 9, KKRTC 9) **[S]**, and a division is
what a depot record is actually keyed on. Using the corporation would give three
hub codes for 19,000 vehicles and make the serial the whole identifier, which
defeats the point of having a hub segment at all.

`BLR` stays BMTC's alone. KSRTC's Bengaluru operations get `KBS`, after the
Kempegowda bus-station division that genuinely exists **[S]**. The fixture set:

| Hub | Division | Corporation |
|---|---|---|
| `KBS` | Kempegowda Bus Station | KSRTC |
| `MYS` | Mysuru | KSRTC |
| `MDK` | Madikeri | KSRTC |
| `HUB` | Hubballi | NWKRTC |
| `HSP` | Hosapete | KKRTC |

Every one avoids `I` and `O`. The Damm check digit, the canonical hyphenated
form, the normalisation rule and the disjointness proof of `SPEC.md` section 6.3
are all unchanged: a BIN is still three letters then five digits, and adding hub
codes cannot make it collide with a plate, which opens with exactly two letters.

### 2.4 Plates: real district numbers, the `ZZ` series, and a weaker guarantee

The format is unchanged and already cited: two-letter state code, one-or-two-digit
RTO district number, one-to-three-letter series omitting `I` and `O`, four-digit
serial.[^plate-format] What changes is that a statewide fleet spans thirty
district numbers instead of Bengaluru's few.

```
KA-32-ZZ-4417      KKRTC coach registered in Kalaburagi district
KA-25-ZZ-0918      NWKRTC coach registered in Dharwad district
```

`UNRESOLVED:` **the district-code table is not verified.** Codes like `KA-01`
for Bengaluru and `KA-09` for Mysuru are widely reported, but no check was made
against the Karnataka Transport Department's own RTO list, and this document
will not present a table of thirty numbers it has not read. The generator takes
the table from the corridor bundle, where each entry carries its own source, and
a wrong entry produces a plate that is wrong about a district and still cannot
collide with a real vehicle.

**That last clause is where the honesty guarantee gets weaker than it is for
BMTC, and the weakening has to be said plainly.** `SPEC.md` section 4.3 pins
fixture plates to the `ZZ` series on the ground that BMTC does not run it. For
three corporations, thirty districts and 19,000 vehicles, nobody has checked
whether `ZZ` is in issue anywhere, and nobody can from here: there is no
published fleet register. So:

- The `ZZ` series is kept, because it is the strongest available guard and it
  costs nothing.
- The claim in the README and in section 17 changes from "a series BMTC does not
  run" to "a series chosen to be improbable, on a network with no published
  fleet register".
- Every response continues to carry `meta.simulated: true` and `X-Simulated:
  true`, and those, not the plate series, are what a consumer asserts on.
- Open question 4 records what would settle it.

---

## 3. The duty crosses midnight: exactly what breaks

`SPEC.md` section 8 describes a world where a bus runs a shape, turns round at a
terminal after a layover, and does it again, forever, within one day. Every one
of the following is a real break, named at the function that produces it.

### 3.1 The duty draw is keyed on the wrong date

`SimWorld`'s constructor builds duty state with
`createDutyState(bin, at, serviceDate(this.#lastTickAt, config.simTimezone))`,
and `createDutyState` draws from `rand(profile.seed, bin, 'duty', serviceDate)`.
That service date is **the calendar date of the current tick**, not the date of
the duty being drawn.

For a city bus the two are the same and the process is restarted daily in
practice, so the bug never bites. For a coach dispatched at 22:59 on 5 September
and still running at 03:00 on 6 September, a process restarted at 03:00 redraws
that vehicle's duty against key `20260906` and can produce a different status for
the same run. **That is a determinism break on the one guarantee section 0 says
is settled**: the same duty on the same date must yield the same answer.

The fix is not subtle: the draw is keyed on the duty's own service date, which
the roster carries, and never on the wall date.

```
rand(seed, bin, 'duty', `${serviceId}|${serviceDate}`)
```

### 3.2 `startDate` is computed from an instant and GTFS forbids that

`dutyObservation()` emits
`startDate: serviceDate(bus.tripStartedAt, config.simTimezone)`, which is the
calendar date of the start instant.

GTFS's service date is not a calendar date, and `SPEC.md` section 6.2 already
says so about the field it is emitting: a trip starting at 00:30 belongs to the
previous service date and `startTime` may exceed `24:00:00`. A coach's return
run departing Hampi at 20:00 and a relief departure at 00:30 belong to different
service dates and the same calendar date; deriving one from the other silently
misfiles the second. The service date becomes an explicit field on the roster
entry, carried through, and `startedAt` stays the unambiguous RFC 3339 instant it
already is.

### 3.3 Stop times past 24:00:00 have never been exercised

`loadGtfs.ts` stores `arrivalTime` and `departureTime` as raw strings and nothing
parses them, so nothing breaks today. But the bundled BMTC feed never carries a
time past `24:00:00`, and a corridor's stands after midnight routinely do
(`30:15:00` for a 06:15 arrival on a 22:59 departure's service date). The moment
anything computes a scheduled time - and section 5's prediction band does, because
it needs a scheduled halt duration - that parsing path runs for the first time.
It must be verified against a real overnight input rather than trusted because a
comment describes the convention correctly.

### 3.4 A run has no end, only a layover

`SimWorld.advanceBus` handles a terminal by setting a layover, then flipping
direction and re-dispatching:

```
bus.trip = representativeTrip(bus.route, nextDirection)
bus.cursor = createCursor(bus.trip, 0, this.#profile, bus.member.bin, current)
bus.tripStartedAt = new Date(current)
```

A coach that reaches Hampi at 06:30 does not turn round and drive to Bengaluru at
06:35. It is finished. There is no cursor state for "this vehicle's duty is over
and it is not running anything", and `BusCursor` has `dwellUntilMs` and
`layoverUntilMs` and nothing else.

**This is the largest single engine change in the document.** The cursor gains a
terminal state, the world gains a distinction between a rostered duty and an
active one, and `tickAt` iterates only the active set (section 11.3).

### 3.5 Dispatch is a spread, not a calendar

`dispatchInitialFleet` places `BUSES_PER_ROUTE` vehicles evenly around the round
trip at process start, alternating direction by index. `SPEC.md` section 8.4 is
already honest that this is a simplification and not a schedule.

For a coach it is not a simplification, it is the wrong object. A corridor has
one to three departures a day per direction at named clock times on named dates.
Dispatch becomes a roster: for each corridor, for each service date in the
window, the departures that exist, each resolving to a vehicle. `BUSES_PER_ROUTE`
does not apply and the fleet size falls out of the roster rather than being
configured, which is how an operator thinks about it and is the same move
`METRO_TRAINS_PER_LINE` already makes.

### 3.6 `SIM_SPEEDUP` desynchronises the calendar from the seeded buckets

`tickAt` multiplies elapsed time by `#speedup` before advancing the cursor, but
`maybeSwapDuty` and `activeDropout` bucket on `at.getTime()`, which is the clock
time, unmultiplied. At `SIM_SPEEDUP=1` nothing is visible. At the speedup a
nine-hour demo actually needs, the cursor covers 340 km while the dropout buckets
advance nine minutes, so a coach crosses three simulated dead zones and the
temporal dropout process fires once.

This is already latent in the bus model and only a long duty makes it visible.
The cheap fix is the correct one: bucket on **simulated** elapsed seconds
rather than wall milliseconds, so every seeded draw lives on the same
clock the cursor does. The geographic dead-zone model of section 6.3 needs no
buckets at all and is immune either way, which is one more argument for it.

### 3.7 The demand curve is a city curve

`occupancyFor` reads `localMinutes(input.at)` into a two-peak curve with a
morning and evening rush and an overnight floor. At 02:00 on a corridor it
returns the floor for a coach that is genuinely full of sleeping passengers.
Section 7 makes this moot for a reserved coach by refusing to run the model at
all; for an unreserved intercity duty it is replaced with a shape that fits a
long-distance run.

### 3.8 The dropout lookback grows with the dead zone

`activeDropout` scans back `ceil(dropoutMaxSeconds / 60) + 1` minute buckets on
every call, which is eight at the current 420-second maximum. A dead zone
measured in tens of minutes would make that scan hundreds of buckets per vehicle
per observation. The geographic model of section 6.3 replaces the scan with a
comparison of `cursor.distanceMetres` against a small authored list, which is
both cheaper and the only way to get the behaviour that matters.

---

## 4. Halts and stands: a long dwell is a fact, not a symptom

### 4.1 A corridor's stop list is not homogeneous

A corridor's stop list is not homogeneous.

| Kind | Typical dwell | What happens | Load changes |
|---|---|---|---|
| `boarding` | 2-5 min | City-side pickup: Majestic, Madiwala, Electronic City | Yes, boarding only |
| `stand` | 5-15 min | A taluk or district bus stand en route | Yes, both ways |
| `meal_halt` | 20-40 min | A highway dhaba, everyone off, nobody joins | No |
| `crew_change` | 5-10 min | Driver relief at a depot on the corridor | No |
| `terminal` | - | The run ends | Everyone off |

`BusCursor` has one `dwellUntilMs` and no notion of why it is set. A consumer
seeing a vehicle stationary for twenty-five minutes at 02:00 has no way to
distinguish a scheduled halt from a breakdown. The service already knows which
one it is, so the dwell needs to say so rather than leave the consumer guessing.

### 4.2 What goes on the wire

`tracking.progress` gains one nullable object, present only while stopped:

```jsonc
"progress": {
  "nextStop": { "id": "KA-STAND-CTD-01", "name": "Chitradurga", "nameLocal": "ಚಿತ್ರದುರ್ಗ", "sequence": 5 },
  "currentStatus": "STOPPED_AT",
  "distanceAlongRouteMetres": 201430.0,
  "routeLengthMetres": 341880.0,
  "dwell": {
    "kind": "meal_halt",                       // boarding|stand|meal_halt|crew_change|terminal
    "stop": { "id": "KA-HALT-HRR-01", "name": "Hiriyur (meal halt)" },
    "startedAt": "2026-09-05T20:38:00Z",
    "scheduledSeconds": 1800,
    "endsAt": "2026-09-05T21:08:00Z",
    "endsAtUncertaintySeconds": 420
  }
}
```

**Rules a builder must not get wrong:**

- **`endsAtUncertaintySeconds` is never zero and never omitted.** A halt is
  discretionary. The driver leaves when the last passenger is back on the coach,
  and that is the single largest source of variance on the whole run (section
  5.3). A halt end with no band would be the one certain number in a document
  that has none.
- **`dwell` is null when the vehicle is moving**, and `currentStatus` is
  `IN_TRANSIT_TO` or `INCOMING_AT` exactly as it is for a bus.
- **A halt never produces a `tracking.reason`.** `tracking.reason` is non-null
  whenever the state is not `live`, and a halted coach with a working device is
  `live`. The two are orthogonal, in the same way `duty` and `tracking` are, and
  for the same reason: a stopped coach that is also dark has two independent
  facts about it and a consumer needs both.
- **A dropout during a halt is reported as a dropout.** The dwell object stays
  (it is a scheduled fact and it is still true), the tracking state ages through
  `stale` into `dark`, and `fixAgeSeconds` says how long since anyone heard from
  it. Folding one into the other would let a stationary coach hide a dead device
  for half an hour.

### 4.3 The device keeps talking, more slowly

The AIS-140 device model in `SPEC.md` section 8.5 emits every
`BUS_FIX_INTERVAL_SECONDS` with jitter. Secondary sources on VLTD behaviour
consistently report a 30-second interval while moving and a longer one while
stationary.[^ais140-freq] The city model ignores the distinction because a city
bus is never stationary for long enough to matter.

A coach parked for thirty minutes at a 20-second interval emits ninety identical
fixes. So the intercity device profile takes two intervals:

```
INTERCITY_FIX_INTERVAL_SECONDS             default 30
INTERCITY_FIX_INTERVAL_STATIONARY_SECONDS  default 120
```

`UNRESOLVED:` the clause and figures in AIS-140 itself. This inherits `SPEC.md`'s
open question 3 unchanged: the ARAI standard is paywalled and the state protocol
document is a scanned PDF.[^ais140-odisha] The 30-second moving interval is well
attested; the stationary figure is a plausible choice and is configurable.

The observable consequence is what matters and it is real: a halted coach's
`fixAgeSeconds` sits between 0 and 120 rather than between 0 and 30, its
`position.speedKph` is 0, and its `currentStatus` is `STOPPED_AT`. Those three
together are how a consumer tells a halt from a dropout using fields that already
exist, before it ever reads `dwell`.

---

## 5. Highway prediction: the band changes shape

### 5.1 The existing model, and why reparameterising it is wrong

`SPEC.md` section 7.3 sets

```
uncertaintySeconds = PREDICTION_UNCERTAINTY_BASE_SECONDS
                   + PREDICTION_UNCERTAINTY_PER_STOP_SECONDS * stopsRemaining
```

with bus defaults `45 + 30n` and metro defaults `15 + 5n`, and calls it
deliberately linear and uncalibrated. `world.ts`'s `predictNextStops` hardcodes
`45 + index * 30` and does not read the config at all, which is a small existing
bug worth fixing on the way past.

The model is stop-count linear because in city traffic the number of stops is a
decent proxy for the number of independent delay events: each stop is a dwell, and
between stops are junctions and signals whose count scales with the same thing.

**On a highway that proxy fails, in both directions.** Between Tumakuru and
Chitradurga a coach passes no signals, makes no stops, and covers 90 km of
divided highway. Its running time over that stretch has genuinely low variance.
Counting it as "one stop" and adding 30 seconds understates nothing and
overstates nothing by accident; it simply is not measuring the thing that varies.
Meanwhile the meal halt at Hiriyur, which is one stop by the same count, carries
more variance on its own than the previous 90 km of driving.

### 5.2 What actually varies on an intercity run

In descending order of contribution:

1. **Halt duration.** Discretionary, driver-dependent, twenty minutes or
   forty-five. The largest single term.
2. **Urban approach.** The last 20 to 30 km into the destination city at
   Bengaluru's measured average of about 17.4 km/h[^blr-speed] rather than
   highway speed. A fixed, large, one-off contribution that appears only when the
   remaining path enters a city.
3. **Highway running time.** Real but small: variance accumulates slowly with
   distance, from traffic, weather and the driver's own pace.

### 5.3 The replacement

```
uncertaintySeconds =
    INTERCITY_UNCERTAINTY_BASE_SECONDS                                   default 120
  + INTERCITY_UNCERTAINTY_PER_HIGHWAY_KM_SECONDS   * remainingHighwayKm  default 1.5
  + INTERCITY_UNCERTAINTY_PER_HALT_SECONDS         * haltsRemaining      default 420
  + INTERCITY_UNCERTAINTY_URBAN_APPROACH_SECONDS   (once, if applicable) default 600
```

Worked, for a coach at Chitradurga at 02:00 predicting Hosapete, 190 km and one
halt away with no city at the far end:

```
120 + 1.5 * 190 + 420 * 1 + 0 = 825 s, about 14 minutes, on a 3-hour horizon
```

Four and a half minutes of that is distance and seven is the halt, which is the
right ordering. Compare the city model's fifth stop: `45 + 30 * 5 = 195 s` on a
horizon of perhaps ten minutes, a third of the prediction. **A four-hour highway
prediction is proportionally tighter than a ten-minute city one**, which is the
claim section 0 makes and which the stop-count model, reparameterised, would have
inverted.

### 5.4 The horizon becomes time, not stops

`PREDICTION_HORIZON_STOPS` defaults to 5 and everything past it is `NO_DATA`.
On a corridor with nine stands that refuses to predict the destination, which is
the one arrival the rider cares about and the one the model above genuinely
supports.

```
INTERCITY_PREDICTION_HORIZON_SECONDS   default 21600     (six hours)
```

Beyond it, `schedule_relationship: NO_DATA` with no `arrival` or `departure`,
exactly as the specification requires.[^gtfsrt-ref]

**This is not a loosening of the honesty rule; it is the rule applied to
different physics.** `SPEC.md` section 7.3 argues that refusing to publish a
prediction relocates the arithmetic into the client, where it is done with less
information and no natural place for a band. That argument does not weaken over
six hours on a highway - it strengthens, because the client's alternative is
distance divided by an assumed speed, and the assumed speed is exactly the term
this model gets right and a client cannot. Six hours is chosen so that a coach
dispatched at 22:59 can predict its 06:30 arrival from about 00:30, which is the
last moment a rider is awake to set an alarm against it.

### 5.5 The invariants, and the one that is new

`SPEC.md` criterion 36 requires `uncertainty` to be non-decreasing along a
trip's `stop_time_update` list. That survives unchanged: a later stand has at
least as much remaining highway and at least as many remaining halts as an
earlier one.

The new invariant is the one that makes the model checkable across time:

> **For a fixed stand within one run, `uncertainty` is non-increasing between
> successive observations.**

It holds by construction, because both variable terms are monotonically
decreasing functions of progress. A rider watching the Hosapete estimate firm up
from ±23 minutes at Tumakuru to ±14 at Chitradurga to ±4 at Kudligi is watching
the model behave, and a violation means something is reading the wrong cursor.
Section 15 makes it criterion 79.

---

## 6. Device coverage: the ruling, and the evidence for it

### 6.1 The question

`SPEC.md` sets `BUS_COVERAGE_SHARE` at 0.75 and `METRO_COVERAGE_SHARE` at 1.0,
and argues the metro figure from a real mechanism: a train with no position does
not get a movement authority, so complete coverage is a condition of operating at
all. The bus figure is a plausible number for an under-instrumented fleet.

Is an intercity coach better or worse instrumented than a BMTC bus?

### 6.2 The ruling: better fitted, worse tracked

**Better fitted**, in descending order of how much the argument carries.

1. **The reserved fleet is newer than the city fleet, and AIS-140 fitment is a
   condition of registration for new public service vehicles.**[^ais140-morth]
   That mandate does not distinguish city from intercity, so it separates the two
   fleets only through their age profiles - and the age profiles do differ.
   Ambaari Utsav launched in February 2023 with 40 buses **[V]**;[^ambaari-utsav]
   Pallakki is current-production BS-VI Ashok Leyland Viking 222 **[S]**;[^pallakki]
   Airavat has been recapitalised on Volvo B9R/B11R and Scania since
   2012 **[V]**.[^airavat-club] BMTC's fleet passed 7,000 buses in 2025 with about
   one in five electric,[^bmtc-fleet] which leaves a long tail of older diesel
   stock predating the mandate. A fleet whose premium tier is largely post-2018 is
   more completely fitted by construction.
2. **The operator carries commercial exposure on the coach and not on the city
   bus.** KSRTC's own published reservation terms make cancellations refundable on
   a slab and close bookings 30 to 45 minutes before departure **[V]**.[^ksrtc-terms]
   A delayed or cancelled coach is a refund liability against named bookings; a
   delayed city bus is an operations statistic. Knowing where the vehicle is has a
   money value on one and not the other.
3. **The device is the same device.** Nothing about a coach makes a VLTD harder
   to fit. There is no tunnel, no overhead line, no depot-power constraint that a
   city bus does not also have.

**Worse tracked, and this is the half that matters.** Coverage answers *is there
a device*; continuity answers *can it reach a backhaul*. The city model conflates
them because in Bengaluru they nearly coincide: a fitted device is in cellular
range except in a tunnel. On a corridor they come apart completely. A coach
between Chitradurga and Hosapete at 03:00 crosses stretches with no usable
cellular service for tens of kilometres, and the device is working perfectly the
whole time.

So the intercity profile inverts the two:

| | City bus | Reserved coach | Ordinary intercity |
|---|---|---|---|
| coverage (device fitted) | 0.75 | **0.92** | **0.70** |
| dropout mechanism | Poisson in time | **Geographic dead zones** | Geographic dead zones |
| dropouts per vehicle-hour | 1.5 | see 6.3 | see 6.3 |
| typical dark duration | 60-420 s | **8-40 min** | 8-40 min |
| `STALE_AFTER_SECONDS` | 90 | **180** | 180 |
| `DARK_AFTER_SECONDS` | 300 | **600** | 600 |

**Karnataka Sarige is deliberately at or below the city bus figure.** The
ordinary class is the old, cheap, rural end of the same corporations' fleets and
is exactly where fitment lapses. Setting it at 0.70 is what makes the ruling a
ruling about *service class* rather than about *mode*, and it is what lets a demo
show a well-instrumented reserved coach and a badly-instrumented ordinary bus on
the same corridor at the same moment - the intercity version of the bus/metro
contrast `SPEC.md` section 2.3 builds its demo around.

**Every number in that table is a modelling choice, not a measurement.** No
public source states any of the three corporations' AIS-140 fitment rate; the
research found no open dataset on any of it and the K-BREEZE appraisal's own
framing of "weak data integration" suggests the operators may not have a clean
figure either.[^kbreeze] Section 17's fidelity table records this as stubbed. The
*direction* of the ruling is argued from fleet age and commercial exposure; the
*magnitudes* are chosen so a demo shows the behaviour, and they are environment
variables for that reason.

### 6.3 Dead zones are geography, not chance

The urban dropout model is a Poisson process keyed on `rand(seed, bin, 'dropout',
minuteBucket)`. It models a tunnel well: a short loss at a random moment,
uncorrelated between vehicles.

An intercity dead zone is the opposite of random, in ways the temporal model
cannot express.

- **It is in the same place every night.** The same coach loses signal between
  the same two kilometre marks on every run, and so does the coach behind it. A
  demo that shows a dropout must show it again on the second take, and must show
  it happening to a different vehicle in the same place. `rand(seed, bin, ...)`
  produces uncorrelated draws across vehicles by construction and cannot.
- **Its duration is a consequence of speed.** A 35 km zone at 65 km/h is 32
  minutes; the same zone at 45 km/h in rain is 47. A uniform duration draw between
  a configured minimum and maximum cannot produce that relationship, and the
  relationship is what makes the recovery behave right.

So a dead zone is **an interval of route distance**, authored per corridor, and a
vehicle is dark exactly while `cursor.distanceMetres` lies inside one:

```jsonc
"deadZones": [
  { "fromMetres": 187400, "toMetres": 221900, "reason": "no_cellular_coverage" },
  { "fromMetres": 268100, "toMetres": 281300, "reason": "no_cellular_coverage" }
]
```

That is deterministic without a seeded draw at all, which is strictly better than
the seeded version: it reproduces across vehicles, not merely per vehicle. Where
the zones come from is section 9.4, and the answer is that they are fabricated,
because no usable public coverage map exists at 35 km resolution.

The generator carries two load-bearing constraints:

- **A dead zone never covers a stand or a halt.** A stand is a town and a town
  has a tower. A coach that went dark exactly when it arrived at Chitradurga
  would read as a breakdown at the stand, which is the wrong story and would make
  section 4's whole distinction useless.
- **The urban dropout process still runs on the urban segments.** The first 25 km
  out of Bengaluru and the last 20 km into Hosapete are a city bus's problem and
  get a city bus's failure mode. Both mechanisms run on the same corridor, on
  different parts of it, and `/fleet/corridors` publishes which is which.

Configuration:

```
INTERCITY_DEAD_ZONE_COUNT_PER_CORRIDOR   default 3
INTERCITY_DEAD_ZONE_SHARE_OF_ROUTE       default 0.12
INTERCITY_DEAD_ZONE_MIN_METRES           default 8000
INTERCITY_DEAD_ZONE_MAX_METRES           default 40000
```

### 6.4 Recovery: publish the gap, do not paper over it

`SPEC.md` section 8.5 models store-and-forward recovery by jumping the position
to where the vehicle actually is and setting `recoveredFromDropout: true` for one
fix interval, deliberately not replaying the buffered fixes because GTFS-Realtime
is a snapshot with nowhere to put them. That is right and it stays.

Over a 40-minute dead zone the coach has moved 45 km, and the jump is 45 km. A
consuming app drawing a dot will animate a 45 km teleport, or interpolate through
it and draw the coach off the highway across open country. So the intercity model
publishes both ends of the gap instead of letting the second silently overwrite
the first:

```jsonc
"recoveredFromDropout": true,
"recovery": {
  "fromPosition": { "lat": 14.2251, "lon": 76.4009 },
  "fromObservedAt": "2026-09-05T21:47:12Z",
  "gapSeconds": 2318,
  "gapMetres": 44810,
  "cause": "dead_zone"                    // "dead_zone" | "device_offline" | "unknown"
}
```

This is not a new claim. Both fixes were real observations the service already
made; the object publishes them together so a consumer can draw the gap as a gap.
`cause` is `dead_zone` only when the dark period began and ended inside an
authored zone, and `unknown` otherwise - the service does not guess at a cause
it cannot distinguish.

---

## 7. Occupancy on a reserved coach: the refusal

### 7.1 Why the demand model is right for a bus and wrong for a coach

`src/sim/occupancy.ts` turns a bus's position, direction, route and time of day
into a load, and `SPEC.md` section 8.9 and 13.2 are explicit that the shape is a
plausible guess and not fitted to any ridership data. **That is the correct
answer for a BMTC bus**, and the reason is stated in the code's own header: a
walk-up boarding leaves no record, BMTC has no automatic passenger counter, and
nobody counts. A modelled figure is the best honest answer available, it is
marked as modelled, and the fidelity table says a consumer must not tune a
threshold to it.

**None of that justification transfers to a reserved coach.** A Pallakki berth is
sold by number, weeks in advance, through a booking system that holds a row per
seat. The occupancy of that coach is not unmeasured; it is *the manifest*. It is
knowable to the digit, and it has an owner.

A generated figure for a knowable quantity is not a coarse estimate; it is
fabricating a fact that somebody else holds. The commit "Stop asserting metro
occupancy nobody measured" corrected the same failure once already:
`FEW_SEATS_AVAILABLE` at a flat 62% on every train forever was a literal nobody
computed, rendered downstream as though the fleet had counted riders. A
demand-model number for a coach whose true load sits in a database would repeat
that mistake with a better-looking curve behind it.

### 7.2 The rule

> **The simulator must not emit an occupancy for a reserved duty at all. Not a
> modelled one, and not one derived from a booking count. It publishes the
> booking count it was told, under a name that means a booking count, or it
> publishes nothing.**

The outcomes, and there is no other:

| Duty | What is emitted as `occupancy` | What is emitted as `reservation.manifest` |
|---|---|---|
| Reserved, manifest held | **Nothing** | `seatsBooked`, `seatsTotal`, `asOf`, `ageSeconds`, `covers` |
| Reserved, no manifest or expired | **Nothing** | **Nothing** |
| Unreserved (Karnataka Sarige) | The demand model, `source: "modelled"` | Not applicable |

**A reserved coach never carries an `occupancy` field, manifest or no manifest**,
and `occupancy_status` is omitted from its GTFS-Realtime entity unconditionally.
Section 7.5 argues why a booking count cannot become an occupancy no matter how
good the count gets.

**Omission, not `NO_DATA_AVAILABLE`, and the distinction is not pedantry.**
`SPEC.md` has a dark or untracked bus report `occupancy_status:
NO_DATA_AVAILABLE`, which reads as *this vehicle has a counting system and it is
not reporting*. A reserved coach has no counting system on board at all. Emitting
`NO_DATA_AVAILABLE` would assert an on-vehicle capability that does not exist.
Omitting the key says *this service publishes no crowding for this vehicle*,
which is true, and it is exactly what `src/sim/metro.ts` already does for the
same reason.

The choice also costs nothing downstream, which is why it should be made on which
one is true rather than on convenience: the consuming app's `readOccupancy`
already collapses an absent field and `NO_DATA_AVAILABLE` to the same null, and
its own comment says the two are the same fact.

### 7.3 Making the refusal structural

A policy check at the response projector is not enough. The check has to be
somewhere a future change cannot route around, and the cheapest such place is the
type system.

```ts
export type OccupancyOutcome =
  | { readonly kind: 'modelled'; readonly observation: OccupancyObservation }
  | { readonly kind: 'withheld'
      readonly reason: 'reserved_no_onboard_count' | 'not_reporting' }
```

**There is deliberately no arm that carries a measured occupancy**, because
nothing anywhere in this service measures how full a coach is, and an arm with no
producer is an invitation. `withheld` carries no number, so there is nothing for a
projector to serialise by accident, and `projectTracking` emits the `occupancy`
key only for `modelled`. `occupancyFor` returns `withheld` on its first branch
when the duty is reserved, before it computes anything - the same shape as its
existing dark/untracked short-circuit, which already returns before
`headcountFor` runs.

The manifest is a separate object on the duty and never reaches this function at
all. Keeping the two apart in the type system is what stops a later change from
"improving" the refusal by feeding a booking count into an occupancy field.

**The reserved branch is a branch on the duty, not on the vehicle class**, which
matters for the repository-hygiene test that keeps class comparisons inside
`profile.ts`, `device.ts` and `duty.ts`. `input.reservation` is a property of the
duty being served, so the existing regex does not fire and, more importantly,
should not: reservation is the correct axis and the class is not.

### 7.4 The ingress: the BPP pushes, this service never pulls

The BPP owns the booking; this service never invents one. Something still has
to deliver the count - **somebody has to actually push it across.** This
section specifies that seam.

**Direction: push, and the argument is structural rather than a preference.**

- **This service makes no outbound call, ever.** `SPEC.md` section 3.2 puts
  ingesting anything out of scope, and criterion 44 is a test that `src/`
  contains no HTTP client at all. A pull would break a property the repository
  currently asserts mechanically, for one field.
- **The simulator does not know which duties have bookings.** A pull would mean
  polling every rostered duty on a timer against a service that may not be
  deployed. A push happens exactly when there is something to say.
- **The BPP already has the moment.** A `confirm` that succeeds and a
  cancellation that completes are the two events that change the count, and both
  are already server-authoritative on that side.

```
PUT /fleet/manifest          Authorization: Bearer <MANIFEST_TOKEN>

{ "serviceId":  "2259BNGHMP",
  "travelDate": "2026-09-25",
  "seats": { "total": 30, "booked": 4, "held": 2, "simulated": 17 },
  "asOf":       "2026-09-25T16:40:00Z",
  "ttlSeconds": 3600 }
```

**`MANIFEST_TOKEN` is a different credential from `ADMIN_TOKEN`**, and both are
absent-by-default with a `404` rather than a `401`. The BPP is a peer service,
not an operator of this one, and handing it the scenario surface would let a
ticketing platform force a coach dark. One credential for one capability.

**The join key is `(serviceId, travelDate)`, because that is what the other side
has.** The BPP's own specification commits to exactly this: *"`serviceId` is
stable across dates and releases, and it is the same string in this provider's
fixtures, in Tatak's dataset and in whatever roster the simulator builds"*, and
it names a lookup shaped `?service=...&date=...`.[^bpp-reserved] So the wire key
is the operator's run code and an ISO calendar date, not this service's internal
`dutyId`, and section 10.3's endpoint takes the same pair.

**The travel date and the GTFS service date are not the same field, and the
response says so rather than reinterpreting silently.** A coach booked for
travel on 26 September that departs at 00:30 belongs to service date 20260925.
That mismatch is a live trap between two systems that both look right, so the
`200` echoes both and names the difference:

```jsonc
{ "serviceId": "2259BNGHMP",
  "travelDate": "2026-09-26",
  "serviceDate": "20260925",
  "dutyId": "BNG-HSP-20260925-0030",
  "note": "This departure belongs to the previous GTFS service date.",
  "stored": { "seatsBooked": 4, "seatsTotal": 30, "asOf": "...", "expiresAt": "..." } }
```

**What the payload has to split.** The BPP's seat map has three sources and only two of them are facts it
holds: seeded occupancy marked `simulated: true`, live holds, and confirmed
bookings.[^bpp-reserved] Its own words: *"Rows 2 and 3 are facts this provider
actually holds; row 1 is not."*

So a single `seatsSold` number would carry the BPP's own seeded fill across the
boundary, and **this service republishing it would give a fabrication a second
source and make it look corroborated.** Hence the split, and hence the rule:

- **`booked` is published.** Confirmed bookings the BPP actually holds.
- **`simulated` is accepted and never published.** It is a fact about the BPP's
  screen and about nothing else. It is accepted rather than rejected so the two
  services can reconcile a seat map in a log without either of them lying on a
  response.
- **`held` is accepted and never published.** A hold lapses on a 600-second TTL
  and is not a sale.
- A payload whose `booked + held + simulated` exceeds `total` is `400`. A payload
  with `simulated` and no `booked` is accepted and stores `seatsBooked: 0`, which
  is the truth.

Validation, and the reasons rather than the list:

- `booked <= total`, or `400`.
- `asOf` must not be in the future, or `400`. A manifest that claims to know
  tomorrow's sales is not a manifest.
- **`asOf` is the version.** Pushes can arrive out of order, a cancellation
  overtaking the confirm it follows, and a stale count clobbering a fresh one
  would be silently wrong for an hour. A push whose `asOf` is not strictly newer
  than the stored one is accepted with `200`, **discarded**, and the response
  says which one is held.
- `ttlSeconds` is **required**, 1 to 86400, on the same reasoning as the scenario
  TTL: a manifest left in place forever is a service that quietly stopped telling
  the truth while `/readyz` still says ready.
- `DELETE /fleet/manifest` clears one or all, and is what a cancellation of the
  last booking should send rather than a `booked: 0` push, so that "nobody has
  booked" and "we no longer hold a count" stay distinguishable on this side.

### 7.5 What is published, and why it can never be an occupancy

```jsonc
"duty": {
  "reservation": {
    "required": true,
    "manifest": {
      "seatsBooked": 4,
      "seatsTotal": 30,
      "asOf": "2026-09-25T16:40:00Z",
      "ageSeconds": 214,
      "source": "bpp",
      "covers": "bookings_through_this_network_only"
    }
  }
}
```

**`covers` is the load-bearing field and it does not go away when the data gets
better.** Three separate gaps sit between this number and how full the coach is,
and only one of them is a temporary artefact of the current build:

1. **Booked is not boarded.** A no-show is a booking and an empty berth. There is
   no gate scan on a coach and there never will be, so nothing anywhere in this
   stack can close this gap.
2. **This network is one channel.** KSRTC sells at counters, through AWATAR
   directly, and through several aggregators. A count of bookings made through
   one Beckn provider is **structurally a lower bound on sales** and will still be
   one when that provider is real. This gap does not close either.
3. **The provider's own map is partly seeded.** This one is an artefact of the
   current build and would close if real inventory ever arrived, and it is the
   reason section 7.4 splits the payload rather than trusting a total.

Gaps 1 and 2 are permanent. **So `seatsBooked` is not an occupancy that happens
to be imprecise; it is a different quantity, and time and better data will not
turn it into one.** Publishing it as `occupancy_percentage`, or mapping it onto
the `OccupancyStatus` ladder, would assert bodies from tickets - which this
service is built to refuse. It is published under a name that says what it
counts, beside a field that says what it does not cover, and nowhere near an
occupancy field.

That settles the two ladder questions that would otherwise need answering:
`FULL` is never emitted for a reserved coach on a sold-out manifest, because
`FULL` is a claim about the vehicle rather than about a sales channel, and
`STANDING_ROOM_ONLY` is never emitted because nobody stands on a sleeper. The
whole enum is simply absent.

### 7.6 What this service publishes before, during and after the BPP exists

**As the platform stands today, there is no manifest source and every reserved
coach reports nothing.** `ondc-transit-bpp`'s shipped platform sells TRV11
journeys and passes, and its fidelity table records *"Seat/quantity inventory: no
inventory model. Every `select` succeeds. No out-of-stock path"* about exactly
those two products, neither of which has any inventory to model.[^bpp-spec] That
line describes the platform before reserved intercity lands; it is not a claim
that reserved intercity has no inventory.

**That changes when `docs/reserved-intercity.md` is implemented.** That
specification, written the same day as this one, gives the reserved category
finite numbered seats that another buyer can exhaust, server-authoritative holds
on a 600-second absolute TTL, deterministic occupancy seeded from service
identity and travel date, and a passenger manifest. Its own comparison table sets
the three cases side by side: TRV11 has no inventory and every `select` succeeds,
passes are nine static always-sellable items, and reserved is *"finite. Numbered
seats, exhaustible, held."*[^bpp-reserved] From that point there is a real count
on the other side of section 7.4's endpoint, and this service will hold and
publish one.

What the service publishes in each window, and none of the three requires a new
mechanism:

| Window | What is published |
|---|---|
| **No manifest has ever arrived** (today, and any duty nobody booked through this network) | No `manifest` key. No `occupancy`. Nothing. |
| **Between a booking confirming and its push landing** | The manifest currently held, with its `asOf` and its `ageSeconds`, unchanged and unincremented. |
| **Pushes have stopped and the held manifest has aged out** | No `manifest` key. Nothing. |

**The middle row is the staleness rule this service already has, applied to a
different field.** A manifest is a measurement taken at an instant, exactly as a
GNSS fix is, and it is published with its age and never freshened. The service
does not increment a count because a booking is probably in flight, for the same
reason it does not extrapolate a dark vehicle's position forward.

**If the BPP is unreachable, this service publishes nothing, exactly as on day
one.** The ingress is a push, so there is nothing for this service to fail to
reach: what actually happens is that pushes stop arriving, the held manifest ages
past `INTERCITY_MANIFEST_MAX_AGE_SECONDS` or its own TTL, and the `manifest` key
disappears. **No last-known count is kept alive past its expiry and no reason is
published for its absence**, because a push-based ingress cannot distinguish "the
BPP is down" from "nobody has booked this coach", and a service that named one of
those would be guessing about a system it cannot see.

This mirrors the metro-occupancy fix, and section 16's demo shows it on screen
rather than hiding it in a fidelity table.

---

## 8. The rider is asleep

### 8.1 The consumption pattern inverts

`SPEC.md` section 7.1 justifies `GET /fleet/vehicle/{bin}/position` on a hot-poll
argument: an app tracking one bus after a purchase should not fetch and parse a
fleet-wide protobuf every ten seconds. The endpoint exists to make a ten-second
poll cheap.

An overnight rider polls nothing for six hours. They board at 22:59, sleep, and
open the phone once at 05:40 to find out whether Hosapete is close. The endpoint's
cost model is not a hot poll; it is a cold, occasional, high-value read.

What follows from that:

- **`Cache-Control: no-store` stays.** A position a CDN can serve twice is a
  position that is silently older than its `fixAgeSeconds` claims, and a cold read
  is exactly the read that must not be served from yesterday.
- **The suggested poll interval is published rather than left to folklore.** The
  root discovery document gains `suggestedPollSeconds`, default 120 for a coach
  against the city's implicit 10. A phone tracking a coach overnight is on a
  charger or dead by 04:00, and designing for a ten-second poll would guarantee
  the second.
- **`FEED_TTL_SECONDS` is unchanged and irrelevant here.** It governs a fleet feed
  a consumer polls; it says nothing about a tracker that reads once.

### 8.2 The one cold read has to answer "did anything happen"

At 05:40 the rider wants four things: where are we, which stand is next, when do
we reach Hampi, and *was everything fine while I was out*. The first three are
already answerable. The fourth has no field.

`fixAgeSeconds` answers "how long since anyone heard from it" but not "and it was
fine at 02:00 at Chitradurga", and that second sentence is the one that lets
somebody go back to sleep. So the duty carries a bounded journal of its own run:

```jsonc
"duty": {
  "progressLog": [
    { "at": "2026-09-05T17:29:00Z", "event": "departed",  "stop": "Kempegowda Bus Station" },
    { "at": "2026-09-05T18:52:00Z", "event": "departed",  "stop": "Tumakuru" },
    { "at": "2026-09-05T20:38:00Z", "event": "halt_began","stop": "Hiriyur (meal halt)" },
    { "at": "2026-09-05T21:11:00Z", "event": "halt_ended","stop": "Hiriyur (meal halt)" },
    { "at": "2026-09-05T21:47:12Z", "event": "went_dark", "cause": "dead_zone" },
    { "at": "2026-09-05T22:25:50Z", "event": "recovered", "gapMetres": 44810 }
  ]
}
```

**Every entry is an observation the service already published at the moment it
happened.** The log is retention, not a new claim, and it carries no
interpretation: `went_dark` is not "a problem" and `recovered` is not "resolved".

### 8.3 The log does not break the no-persistence rule

`SPEC.md` section 3.2 says there is no database, no volume and no state to
migrate, because the world is a pure function of the seed and the clock. A log
looks like state.

It is not, because **every entry is derivable**. A dead-zone entry is a pure
function of the cursor's path against an authored interval. A stand departure is a
pure function of the run. Recomputing the log for a duty means replaying that
duty's cursor from its dispatch instant, which is a bounded, deterministic
computation over a few thousand iterations, with every draw already keyed through
`rand`.

So the implementation may accumulate the log in memory as the tick produces it,
and **a process restarted mid-run must produce the same log by replay**. That is
the testable invariant and it is criterion 103. It is also, incidentally, the
strongest determinism test in the suite, because it exercises nine hours of
seeded draws rather than one instant.

`INTERCITY_PROGRESS_LOG_MAX_ENTRIES` caps it at 40, oldest dropped first, so a
pathological run cannot grow a response without bound.

### 8.4 What this service does not do

**An alarm before Hosapete is the consuming app's job.** This service's
contribution is a prediction with a band good enough to set one against, which is
what section 5.4's six-hour horizon exists for. Building notification delivery
here would put a scheduler, a subscription store and a push credential into a
service whose whole design rests on having none of the three.

---

## 9. Geometry: OpenStreetMap has no intercity routes, so something else does

### 9.1 The measurement

`SPEC.md` section 9.2 takes metro line order from OSM `route=subway` relations
and calls it a scar: a vendor dataset had reversed a six-station run, and OSM's
ordered relation members fixed it. The obvious move for coaches is the same one
against `route=bus`.

**It does not work, and here is the measurement.** Run against
`overpass-api.de/api/interpreter` on 5 September 2026, with the response's own
`timestamp_osm_base` at `2026-09-05T07:36:27Z`:

```
[out:json][timeout:180];
area["ISO3166-2"="IN-KA"]->.ka;
( relation["type"="route"]["route"="bus"](area.ka); );
out tags;
```

| | |
|---|---|
| `route=bus` relations in Karnataka | **888** |
| carrying `network=BMTC` | **853** |
| carrying `operator=BMTC` or a misspelling of it | 871 |
| mentioning KSRTC in any tag | **8** |
| carrying an NWKRTC or KKRTC tag, under any spelling | **0** |

Of the eight that mention KSRTC, three are Mysuru city routes run by KSRTC's
Urban Division (`116: CBS => LnT` and its pair, `119: CBS => LnT`), two are
untagged rural stubs with no `ref`, and two are BMTC's own Chikkaballapura
service mis-associated. **Exactly one is a genuine intercity corridor**: relation
`15728171`, `Pavagada => Bengaluru`, `network=KSRTC`,
`public_transport:version=2`, with 156 way members resolving to 155 ways and
1,972 nodes.

One corridor, against 853 fully mapped BMTC relations. The consuming app's own
acquisition research reached the same conclusion independently against a bounding
box rather than an area, counting 944 relations of which 853 BMTC, and the same
single Pavagada corridor.[^tatak-spec] Two independent queries agreeing on the
same number is as close to settled as this gets.

**The metro precedent does not transfer.** Three metro lines were hand-completed
by a small motivated community. A network of thousands of intercity routes has
never been reached by any organised OSM effort, and waiting for one is not a
plan.

### 9.2 What OSM does have

The route relations are missing. **The roads are not.** Karnataka's trunk network
is mapped, connected and tagged: NH-48, NH-50, NH-150A and the state highways
carry `ref` tags and form a routable graph. A coach does not travel on a route
relation; it travels on a road, and the road is there.

The same queries found two more things worth having:

- **171 `amenity=bus_station` nodes and 328 `amenity=bus_station` ways**
  statewide, measured today by the same method. Thin, but a real skeleton for
  geocoding stands. (The consuming app's research counted the same 171 nodes.)
- **42 KSRTC intercity stands already sitting in the bundled BMTC feed**, present
  in the raw `stops.txt` and discarded by the bounding-box filter, per the
  consuming project's own documentation **[S, that project's stated fact, not
  re-counted here]**. Free Bengaluru-side boarding-point coordinates, worth
  checking before anything is hand-authored.

### 9.3 The replacement pipeline: route the roads, commit the result

**Build corridor geometry by routing over the OSM road graph between authored
stand coordinates, offline, once, and commit the output.** The discipline is
identical to `metro-topology.json`: a build-time script, a committed derived
database, an integrity gate in CI, and nothing fetched at runtime.

```
scripts/build-corridors.ts
  1. read the authored stand list per corridor (id, name, nameLocal, lat, lon, kind)
  2. route between consecutive stands over a Karnataka .osm.pbf extract,
     with an offline engine (OSRM or Valhalla), profile biased to trunk/primary
  3. simplify each leg's polyline (section 11.2)
  4. classify each leg as `highway` or `urban` (section 12.6)
  5. place dead zones (section 6.3), never overlapping a stand or halt
  6. write data/bundle/corridor-topology.json and append to SOURCE.md
```

**A straight line between stands is not acceptable as the default.** Bengaluru to
Hosapete is about 290 km as the crow flies and about 340 km by road; a coach on
the straight line crosses Chitradurga's fields at 65 km/h, and every position the
service publishes is off the carriageway by tens of kilometres. The metro's
interpolation fallback is tolerable because a straight line between two stations
900 m apart is a small lie; the same fallback across 90 km is not.

**Where routing genuinely fails**, the leg falls back to a straight line and is
recorded as `"geometry": "interpolated"` on that segment, surfaced in
`/fleet/corridors`, exactly as `loadMetroTopology` already does. Same field name,
same rule, same reason: a straight line is acceptable when it is labelled.

The output mirrors the metro topology's shape:

```jsonc
{
  "source": "openstreetmap",
  "fetchedAt": "2026-09-05",
  "extract": { "provider": "geofabrik", "region": "india/karnataka", "date": "2026-09-01" },
  "router": { "engine": "osrm", "version": "5.27.1", "profile": "car" },
  "corridors": [
    {
      "id": "BNG-HSP",
      "name": "Bengaluru - Hosapete - Hampi",
      "corporations": ["KSRTC", "KKRTC"],
      "lengthMetres": 341880,
      "stands": [
        { "id": "KA-STAND-KBS-01", "name": "Kempegowda Bus Station",
          "nameLocal": "ಕೆಂಪೇಗೌಡ ಬಸ್ ನಿಲ್ದಾಣ", "lat": 12.977, "lon": 77.572,
          "kind": "boarding", "distanceMetres": 0, "provenance": "gtfs_bundle" }
      ],
      "segments": [
        { "fromStandId": "...", "toStandId": "...", "kind": "urban",
          "geometry": "routed", "distanceMetres": 24310 }
      ],
      "deadZones": [ { "fromMetres": 187400, "toMetres": 221900, "reason": "no_cellular_coverage" } ]
    }
  ]
}
```

### 9.4 The integrity gate

`scripts/check-corridor-topology.ts`, run in CI, mirroring the four metro checks
and adding the ones this geometry needs. `SPEC.md` calls the metro gate not
optional and the reason to trust the metro simulation at all; the same applies
here with more force, because this geometry is reconstructed rather than read.

1. **Detour ratio.** Every corridor's routed length is within
   `CORRIDOR_MAX_DETOUR_RATIO` (default 1.6) of the great-circle distance between
   its endpoints. A route three times the crow-flight distance has snapped through
   a ferry, looped a one-way system, or routed via the wrong Hosapete.
2. **Stand order is never re-sorted by coordinate.** Same rule as the metro line
   and the same reason: re-sorting is how a corridor that doubles back gets
   silently reversed, and on a 340 km run a reversal is not cosmetic.
3. **Stand gap.** Consecutive stands never more than
   `CORRIDOR_MAX_STAND_GAP_METRES` apart (default 180000). A longer gap means an
   omitted stand, and on this network an omitted stand may be an omitted meal
   halt, which is the thing section 5's band depends on counting.
4. **Monotonic cumulative distance**, checked exactly as `measureShapeDistances`
   already checks `shape_dist_traveled`, with the same haversine fallback. This
   one is free; `buildShapeIndex` already does it and reports which source it
   used.
5. **Stand projection offset.** Every stand projects within
   `CORRIDOR_MAX_STAND_OFFSET_METRES` of the routed line, default 500 rather than
   the city's 150, because a bus stand is a compound and the routed line is the
   carriageway.
6. **Dead zones fall in open country.** No zone overlaps a stand, a halt, or the
   500 m either side of one. Section 6.3.
7. **Pavagada is checked against its own relation.** The one corridor OSM has
   mapped is routed by the same pipeline and compared against the relation's own
   stitched way geometry. **This is the only place the pipeline can be validated
   against something independent**, and that is a strong reason to carry a
   corridor nobody would otherwise demo.

### 9.5 The boundary with the consuming project

`SPEC.md` section 1.1 forbids a shared library, a shared database or a build-time
dependency in either direction. The corridor stand lists and departure times are
exactly the sort of thing two projects would be tempted to share, and they must
not.

- **This repository owns `data/bundle/corridor-topology.json` and builds it with
  its own script.** It does not read the consuming app's dataset, and the
  consuming app does not read this one.
- Both may derive from the same public sources. That is not a dependency; it is
  two projects reading the same open data, which is already true of
  `Vonter/bmtc-gtfs`.
- **This service does not harvest aggregators and does not call ksrtc.in or
  AWATAR, at build time or at runtime.** The stand lists here are authored from
  the research cited in section 1, with their confidence labels carried into
  `SOURCE.md`, and the departure times are a fixture roster (section 13), not a
  claim about KSRTC's timetable. The 20-to-30-day dataset build the consuming
  project costs is that project's work, and this document does not absorb its
  number.

### 9.6 Licence

The routed geometry is derived from OpenStreetMap, so `corridor-topology.json` is
a **derived database published under ODbL**, stated in `THIRD_PARTY_NOTICES.md`
and in `data/bundle/SOURCE.md`, with "© OpenStreetMap contributors"
attribution.[^osm-copyright] That is the same treatment `metro-topology.json`
already gets and for the same reason: the share-alike obligation attaches to the
database, not to the MIT-licensed software that reads it.

The routing engine's own licence (OSRM is BSD-2, Valhalla is MIT) adds no
obligation to the output and is recorded in `SOURCE.md` for traceability, along
with the engine version and the extract date, because an undated derived database
is a liability.

---

## 10. The API surface

Every path in `SPEC.md` section 7 keeps its shape. Three fields are added to two
existing responses, three endpoints are new, and one endpoint's behaviour is
deliberately unchanged.

### 10.1 `GET /fleet/resolve`: a coach resolves, and a train still does not

A coach BIN or a coach plate resolves normally, `200`. **The test for
resolvability is the UI rule of `SPEC.md` section 4.5 - can the rider verify it
with their eyes - and a plate on the back of a coach at a dark stand is exactly
that.** A metro BIN keeps its `422 not_a_resolvable_code`, unchanged, because
nothing on a train is readable from a platform edge.

The additions to the `200` body, every one of them additive:

```jsonc
{
  "bin": "KBS-01847",
  "matchedOn": "plate",

  "vehicle": {
    "class": "coach",                                     // NEW value
    "plate": { "display": "KA-01-ZZ-4417", "normalised": "KA01ZZ4417", "since": "2026-02-14" },
    "plateAbsentReason": null,
    "hub": { "code": "KBS", "name": "Kempegowda Bus Station" },
    "corporation": {                                       // NEW
      "code": "KSRTC",
      "name": "Karnataka State Road Transport Corporation",
      "simulated": true                                    // §1.1: a fact about the simulation
    },
    "serviceClass": {                                      // NEW
      "id": "pallakki", "name": "Pallakki",
      "reserved": true, "ac": false, "layout": "2+1", "berths": true,
      "capacity": 30, "capacitySource": "secondary"
    }
  },

  "duty": {
    "status": "confirmed",
    "confidence": null,
    "corridor": {                                          // NEW, replaces `route` for a coach
      "id": "BNG-HSP",
      "name": "Bengaluru - Hosapete - Hampi",
      "nameLocal": null
    },
    "route": null,                                         // null for a coach; a corridor is not a GTFS route
    "service": { "id": "2259BNGHMP", "number": "2259BNGHMP", "headsign": "Hampi" },
    "serviceDate": "20260905",                             // NEW, explicit, never derived from an instant
    "reservation": {                                       // NEW
      "required": true,
      "manifest": {                                        // absent when none is held
        "seatsBooked": 4, "seatsTotal": 30,
        "asOf": "2026-09-05T16:40:00Z", "ageSeconds": 214,
        "source": "bpp", "covers": "bookings_through_this_network_only"
      }
    },
    "trip": {
      "id": "BNG-HSP-20260905-2259",
      "startTime": "22:59:00",
      "startDate": "20260905",
      "startedAt": "2026-09-05T17:29:00Z",
      "scheduledEndAt": "2026-09-06T01:00:00Z"             // NEW, and it crosses midnight
    },
    "since": "2026-09-05T17:29:00Z",
    "source": "roster",
    "alternatives": [],
    "reason": null,
    "progressLog": [ /* section 8.2 */ ]                   // NEW
  },

  "tracking": { /* section 10.2 */ },
  "confirmation": { /* below */ },
  "meta": { "simulated": true, "seed": 1, "generatedAt": "2026-09-05T22:14:03Z", "overridden": false }
}
```

**`duty.corridor` and `duty.route` are both present and exactly one is non-null.**
A corridor is not a GTFS route: it has no `route_short_name` a rider reads off a
destination board, and inventing one would put a fabricated route number on a
screen. Keeping both fields, rather than overloading `route`, means a consumer
that only understands buses reads `route: null` and degrades to what it can
support, instead of parsing a corridor id as a route number and rendering
`BNG-HSP` where `500-D` goes.

**`confirmation.verify` grows a third row for a coach**, and this is where
`SPEC.md` section 6.4's instruction to render the array verbatim earns its keep:

```jsonc
"confirmation": {
  "required": true,
  "prompt": "Check the coach in front of you.",
  "verify": [
    { "label": "Number plate",  "value": "KA-01-ZZ-4417" },
    { "label": "Destination",   "value": "Hampi" },
    { "label": "Departure",     "value": "22:59" }
  ]
}
```

Departure time is on the list and route number is not, because at a stand at
22:00 the destination board and the departure time are what a rider checks, and
a corridor has no number to check. A consuming app that re-derived its own labels
would have to ship a release to show this; one that renders the array as it
arrives already does.

### 10.2 `tracking`, and the fields that carry the new failure modes

Byte-for-byte the same shape as `SPEC.md` section 6.2, with three additions,
every one of them nullable and absent-by-default so an existing parser is
unaffected:

```jsonc
"tracking": {
  "state": "dark",
  "fixAgeSeconds": 1842,
  "observedAt": "2026-09-05T21:47:12Z",
  "servedAt":   "2026-09-05T22:17:54Z",
  "position": { "lat": 14.2251, "lon": 76.4009, "bearing": 21.7, "speedKph": 64.3, "accuracyMetres": 12 },
  "progress": null,
  "source": "simulated_gnss",
  "reason": "no_fix_since",
  "deadZone": {                                    // NEW, non-null only inside an authored zone
    "corridorId": "BNG-HSP",
    "fromMetres": 187400,
    "toMetres": 221900,
    "enteredAt": "2026-09-05T21:47:12Z",
    "expectedExitAt": "2026-09-05T22:26:00Z",
    "expectedExitUncertaintySeconds": 300
  },
  "recoveredFromDropout": false,
  "recovery": null                                 // NEW, section 6.4
}
```

**`deadZone` being non-null is a stronger statement than `reason:
"no_fix_since"`**, and it is the one place this service knows more about a dark
vehicle than the city model ever can. A dark city bus could be anywhere; a dark
coach is inside a known interval of a corridor it cannot leave. Publishing the
interval lets a consuming app say "no signal between Chitradurga and Kudligi,
back around 22:26" instead of "no signal since 21:47", which is a materially
better sentence built from facts the service already has.

**`progress` stays null in `stale`, `dark` and `untracked`, unchanged.** The
`deadZone` object is not a position and does not pretend to be one; it is the
authored geometry of a known gap, and the last known `position` beside it is
still the last known position with its true age.

### 10.3 `GET /fleet/duty`: the join key

**This is the endpoint the reservation side needs and the one that makes the
settled architecture work.** A rider who scanned a code on a bus asks *which bus
is this*. A rider holding a ticket bought three weeks ago asks *which coach is
mine, and where is it*. The BIN is not on that ticket, because when the ticket
was issued no vehicle had been assigned.

```
GET /fleet/duty?service=2259BNGHMP&date=2026-09-25        # the canonical form
GET /fleet/duty/BNG-HSP-20260925-2259                     # by this service's own id
```

**The canonical form takes the pair the other side actually holds**, and the
shape is the one the BPP's specification already names for a lookup it says is
work in this repository: `?service=...&date=...`, with `serviceId` committed as
*"the same string in this provider's fixtures, in Tatak's dataset and in whatever
roster the simulator builds."*[^bpp-reserved] Adopting their spelling rather than
asking three projects to converge on this one's internal `dutyId` costs nothing
and removes a translation layer nobody would own.

| Parameter | Required | Meaning |
|---|---|---|
| `service` | yes, in the canonical form | The operator's own run code. The agreed join key. |
| `date` | yes | An ISO `YYYY-MM-DD` **travel** date, or a GTFS `YYYYMMDD` **service** date. Both are accepted and the response echoes both, because they are not always the same day - see below. |
| `{dutyId}` | yes, in the by-id form | This service's own composite id, as returned by every other endpoint. |

**A travel date and a service date differ for a departure after midnight**, and
the response states both rather than silently picking one. A coach booked for
travel on 26 September departing at 00:30 belongs to GTFS service date
`20260925`; a caller passing `2026-09-26` gets the right duty and is told, in
`duty.serviceDate` and a `note`, how this service filed it. Guessing which of the
two a caller meant, and saying nothing, is how two correct systems disagree
quietly for a month.

`200 OK`:

```jsonc
{
  "duty": {
    "id": "BNG-HSP-20260905-2259",
    "service": { "id": "2259BNGHMP", "number": "2259BNGHMP", "headsign": "Hampi" },
    "serviceDate": "20260905",
    "corridor": { "id": "BNG-HSP", "name": "Bengaluru - Hosapete - Hampi", "nameLocal": null },
    "scheduledDeparture": "2026-09-05T17:29:00Z",
    "scheduledArrival":   "2026-09-06T01:00:00Z"
  },
  "assignment": {
    "status": "assigned",              // "assigned" | "not_yet_assigned" | "superseded"
    "assignedAt": "2026-09-05T04:00:00Z",
    "source": "roster",
    "supersededAt": null,
    "previousBin": null
  },
  "vehicle": {
    "bin": "KBS-01847",
    "plate": { "display": "KA-01-ZZ-4417", "normalised": "KA01ZZ4417", "since": "2026-02-14" },
    "corporation": { "code": "KSRTC", "name": "Karnataka State Road Transport Corporation" },
    "serviceClass": { "id": "pallakki", "name": "Pallakki", "reserved": true }
  },
  "tracking": { /* identical shape to resolve's tracking */ },
  "meta": { "simulated": true, "seed": 1, "generatedAt": "2026-09-05T22:17:54Z" }
}
```

**A duty further out than `INTERCITY_ASSIGNMENT_HORIZON_HOURS` has no vehicle
yet, and that is a `200`.**

```jsonc
{
  "duty": { /* the duty is real and every field is populated */ },
  "assignment": {
    "status": "not_yet_assigned",
    "assignsAfter": "2026-09-24T18:30:00Z",
    "reason": "beyond_assignment_horizon"
  },
  "vehicle": null,
  "tracking": null,
  "meta": { "simulated": true, ... }
}
```

The reasoning is `SPEC.md` section 6.5's sixth row, applied to a different fact.
A `404` would tell a caller its duty id is wrong when it is right. Real operators
allocate a specific vehicle to a block the day before or the morning of; naming a
plate for a coach three weeks out would assert an operational commitment nobody
has made, which is the same class of fabrication as an unmeasured occupancy.

**This does not weaken determinism, and the distinction is worth being precise
about.** The assignment function is seeded and pure - `bin = f(seed, corridor,
serviceId, serviceDate)` - so the answer three weeks out is perfectly computable.
The horizon does not govern whether the answer exists; it governs **when the
service is willing to state it as a fact about the world**. The determinism
guarantee says the answer never changes once given. The horizon says when it may
first be given. Both hold at once, and conflating them would have this service
publishing a plate whose only backing is its own random seed.

**A substitution supersedes an assignment without changing the duty.** When a
vehicle is substituted before departure (section 12.5), `assignment.status`
becomes `superseded`, `previousBin` names the vehicle that was assigned, and
`vehicle` names the one that is. **This is why a ticket carries provenance with
an as-of date.** `SPEC.md` section 6.7 already says a ticketing service stores
what was true when the ticket was issued and calls this service for what is true
now; a coach substitution at 21:00 on the day of travel is the case that makes
the rule bite, and a ticket rendered from a copy taken three weeks ago will name
the wrong plate unless the app re-resolves.

Errors:

| Situation | Status | `error` |
|---|---|---|
| No such duty id on any corridor | `404` | `unknown_duty` |
| Duty exists, does not run on that service date | `404` | `duty_not_scheduled`, carrying the nearest dates it does run |
| `date` missing or not `YYYYMMDD` | `400` | `invalid_request` |
| Date outside the roster window | `400` | `outside_roster_window`, carrying the window |

### 10.4 `GET /fleet/corridors`

The intercity analogue of `/fleet/routes`, and it exists for the same reason:
**it is what makes the geometry and coverage stories demonstrable rather than
asserted.**

```jsonc
{
  "corridors": [
    {
      "id": "BNG-HSP",
      "name": "Bengaluru - Hosapete - Hampi",
      "corporations": ["KSRTC", "KKRTC"],
      "lengthMetres": 341880,
      "standCount": 9,
      "geometry": { "routed": 7, "osmRelation": 0, "interpolated": 1 },
      "segments":  { "highway": 6, "urban": 2 },
      "deadZones": { "count": 2, "shareOfRoute": 0.14, "totalMetres": 47700 },
      "departuresToday": [
        { "dutyId": "BNG-HSP-20260905-2259", "serviceId": "2259BNGHMP",
          "departsAt": "2026-09-05T17:29:00Z", "serviceClass": "pallakki",
          "assignment": "assigned", "vehicleBin": "KBS-01847" }
      ],
      "coverage": { "tracked": 2, "untracked": 0, "share": 1.0 },
      "provenance": { "stands": "authored_secondary", "departures": "authored_secondary" }
    }
  ],
  "meta": { "simulated": true, "seed": 1, "generatedAt": "..." }
}
```

`geometry.interpolated` and `provenance` are the fields that keep section 9
honest in public rather than in a document. A corridor with an interpolated
segment says so on an endpoint anyone can curl.

### 10.5 `PUT` / `DELETE /fleet/manifest`

Specified in full in section 7.4: the BPP pushes a booking count keyed on
`(serviceId, travelDate)`, split so that the provider's own seeded fill cannot
cross the boundary as though it were a sale.

**It is gated on `MANIFEST_TOKEN` and not on `ADMIN_TOKEN`**, and it does not sit
under `/admin/`. The BPP is a peer service rather than an operator of this one,
and putting the two writes behind one credential would let a ticketing platform
force a coach dark. Both tokens are **absent-by-default with a `404` rather than
a `401`**, on the same reasoning `/admin/scenario` already carries: a deployment
that forgets to set one has no surface rather than a guessable one.

A demo that wants to force a manifest by hand sets `MANIFEST_TOKEN` locally and
curls the same endpoint. There is one door, and it is the same door whether the
caller is a BPP or a person.

### 10.6 `POST /admin/scenario` gains two targets

```jsonc
{
  "target": { "duty": "BNG-HSP-20260905-2259" },      // or bin, corridor, all
  "set": {
    "tracking": "dark",
    "deadZone": true,                                  // NEW: force into the next authored zone
    "halt": "meal_halt"                                // NEW: force a halt at the next stand
  },
  "ttlSeconds": 600
}
```

The mandatory TTL rule is unchanged, and so is `meta.overridden: true` on every
response about an overridden vehicle. A nine-hour duty is precisely the case
where a demo cannot wait for a dead zone to arrive by driving to it.

### 10.7 `GET /` and `GET /readyz`

Root discovery gains the three new paths and `suggestedPollSeconds` (section
8.1). `/readyz` gains four counts, because a readiness probe that cannot see
whether the roster exists is not watching the thing that breaks:

```jsonc
{
  "status": "ready",
  "geometryLoaded": true,
  "routes": 10, "metroLines": 3,
  "corridors": 5,                    // NEW
  "vehicles": 60,
  "coachesRostered": 34,             // NEW: duties in the roster window
  "coachesActive": 11,               // NEW: in flight right now
  "rosterWindow": { "from": "20260904", "to": "20260906" },   // NEW
  "lastTickAt": "...", "tickLagMs": 12, "seed": 1
}
```

`503` conditions gain one: **the roster window does not contain today**. A
process whose roster ran out yesterday answers every duty lookup with
`outside_roster_window` while `/readyz` says ready, and that is exactly the
silent-failure shape `/readyz` exists to catch.

### 10.8 GTFS-Realtime for a long-distance trip

Both feeds carry coaches alongside buses and trains, in one `FeedMessage`, for
the reason `SPEC.md` section 7.2 already gives: splitting them would model the
simulator's internals rather than the domain. `?class=coach` is supported as the
same convenience `?class=bus` already is.

A long-distance trip does things a city trip never has to.

**Service dates, and times past 24:00:00.** `trip.start_date` is the GTFS
**service** date and `trip.start_time` is noon-relative and may exceed
`24:00:00`. The 06:15 arrival on a 22:59 departure's service date is `30:15:00`
in the static feed. On the realtime side there is no ambiguity at all, because
`StopTimeEvent.time` is a POSIX instant, so the whole difficulty lives in the
static feed a consumer must already hold - and **the bundled static feed for a
corridor therefore has to actually emit times past `24:00:00`**, which the BMTC
bundle never does. Section 15 makes it a criterion rather than trusting a comment
that describes the convention correctly.

**A halt is a `STOPPED_AT` with a `stop_id`.** `vehicle.current_status` is
`STOPPED_AT` and `vehicle.stop_id` names the halt, which is how a consumer
reading nothing but the standard feed tells a scheduled stop from a stuck
vehicle. That requires the meal halts to **be stops in the static feed**, so a
rider's stop list contains a dhaba. That is correct rather than awkward: GTFS
defines a stop as a location where passengers board or alight, passengers do
alight at a meal halt, and omitting it would make the stop sequence disagree with
the vehicle's own behaviour. Whether a halt is a *boarding point* for ticketing
is a fare-model question and not this feed's business.

**A dark coach still gets predictions; a dark bus does not.** `SPEC.md` section
7.3 rule 4 emits a dark vehicle's `TripUpdate` with every stop as `NO_DATA`. For
a 40-minute dead zone that would blank the destination arrival for forty minutes,
for a vehicle whose position is better known than a dark city bus's ever is.

The distinction is worth making carefully, because it adjusts a rule `SPEC.md`
deliberately made strict. A dark city bus is genuinely unlocatable: stopped at a
junction, diverted, or three kilometres on, with no bound on any of it. A dark
coach is inside an authored dead zone on a divided highway it cannot leave,
entered at a known distance and a known speed. Those are different amounts of
ignorance, and treating them alike discards information the service has.

So **through a dead zone, `trip-updates` keeps publishing predictions with the
band multiplied by `INTERCITY_DEAD_ZONE_UNCERTAINTY_MULTIPLIER` (default 2.5),
and `vehicle-positions` publishes nothing new at all.** The position stays the
last real fix carrying its true old `vehicle.timestamp`, unfreshened, exactly as
criterion 32 requires. The asymmetry is the one `SPEC.md` section 7.3 already
drew and named: **a position is a measurement and a prediction is an opinion.** A
measurement nobody took cannot be manufactured. An opinion can honestly be
widened and kept.

**`VehicleDescriptor` uses all three fields for a coach, which nothing else
does.**

| Field | Bus | Metro | Coach |
|---|---|---|---|
| `id` | BIN | BIN | BIN |
| `license_plate` | Current plate, normalised | Omitted | **Current plate, normalised** |
| `label` | Omitted | Line and destination | **`KSRTC Pallakki · Bengaluru to Hampi · 22:59`** |

A bus's label would duplicate the route number painted on its destination board,
so `SPEC.md` omits it. A coach's label is not a duplicate: it is what the
destination board says and what the announcement calls out, and at a dark stand
it is the string a rider is scanning forty parked coaches for. So a coach carries
both a plate and a label, `SPEC.md`'s criterion 34 is restated rather than
reused, and section 15 asserts a three-way split instead of the old two-way one.

**`occupancy_status` is omitted for a reserved coach unconditionally**, manifest
or no manifest. Not `NO_DATA_AVAILABLE`, for the reason argued in section 7.2:
that value asserts an on-vehicle counting capability which does not exist. And
not set from a manifest either, for the reason argued in section 7.5: a count of
bookings made through one sales channel is a different quantity from how full a
vehicle is, permanently rather than temporarily, and this enum has no honest slot
for it. It is set only from the demand model, and only for an unreserved
intercity duty.

**The manifest therefore has no GTFS-Realtime representation at all**, and that
is the right answer rather than a gap. GTFS-Realtime describes vehicles in
motion; a booking count is a fact about a sales channel, and inventing an
extension field for it would put a number in a feed where every consumer would
read it as crowding. It lives on the JSON surfaces, under a name that says what
it counts, and nowhere else.

**Feed size inverts.** The city feed's problem is too many entities; the coach
feed's is almost none at 14:00 and a handful at 02:00. That is correct and must
not be padded. A consumer polling at midday sees a nearly empty coach section
beside a full bus section, which is what a state network actually looks like at
midday.

---

## 11. The world model statewide: what it costs

### 11.1 Simulate corridors, not fleets

The obvious reading of "19,000 buses" is to generate 19,000 vehicles.

**Do not.** `SPEC.md`'s fidelity table already records that this project runs
tens of vehicles and that nothing here exercises a consumer against a feed with
thousands of entities. Generating 19,000 fabricated coaches would not fix that
limitation; it would multiply a fabrication by three hundred and produce a feed
whose size is real and whose contents are not. The scale gap is honest and stays
honest.

The unit of scope is the corridor. Five fixture corridors, one to three
departures a day per direction, gives about 30 to 34 duties per service day.

**Most of the fleet is not moving.** A nine-hour duty is in flight for
three-eighths of a day, so at any instant roughly 11 coaches are on the road out
of 34 rostered, and at 14:00 on a corridor set dominated by overnight services it
is closer to 4. That asymmetry is the whole cost model.

### 11.2 Memory: geometry dominates, and simplification is the answer

Current Bengaluru build: 20 shapes, about 8,000 shape points across ten routes,
a bundle of roughly 2.2 MB uncompressed and 0.5 MB gzipped.

A routed highway polyline at an engine's full output precision runs to roughly
one point every 10 to 30 m. At 20 m, a 340 km corridor is about 17,000 points,
and five corridors in two directions is on the order of **170,000 points**. A
`ShapePoint` is four numbers, but as a V8 object in an array the realistic cost
is nearer 100 bytes with the header and the array slot, so **about 17 MB** - some
thirty times the current geometry, and the single largest new cost in the
service.

**Simplify with Douglas-Peucker at a tolerance the device noise already
swamps.**

```
INTERCITY_GEOMETRY_SIMPLIFY_METRES     default 15
```

A bus fix already carries `accuracyMetres` of 12 (one sigma of
`BUS_GPS_NOISE_METRES`), and an intercity fix carries at least as much. A 15 m
simplification is therefore invisible in the published position, and on the long
straight sections of a divided highway it removes most of the points, which is
where most of the points are. The expected result is on the order of 25,000
points and about 2.5 MB. **That is an estimate and the spike measures it**
(section 18, stage 0); it is not a figure to plan against until it has been run.

A second measure, worth naming and worth *not* taking first: storing lat, lon and
cumulative distance in three `Float64Array`s instead of an array of objects
would cut the cost to a flat 24 bytes per point with no headers, and
`positionAt`'s binary search works unchanged against a typed array. It is cheaper
still and loses no geometry. It is second because it changes `ShapeIndex`'s
public shape, which the metro track also uses, and a change that touches working
metro code to solve a coach problem should wait until the cheap measure has been
measured and found insufficient.

Everything else is negligible: a few hundred stands, 34 roster entries per day
across a three-day window, a handful of dead zones per corridor.

**On disk**, five corridors of simplified geometry gzipped lands in the
few-hundred-kilobyte range, comfortably inside the bar that
`git clone && docker compose up` needs **no download and no network access at
all**. That bar is not negotiable and section 15 keeps it as criterion 46.

### 11.3 Startup and the tick

**Load** is a single JSON parse of the committed corridor file, exactly like
`metro-topology.json`, plus `buildShapeIndex` per corridor direction. Building a
25,000-point index is a sort and one pass, well under 100 ms each.

**Stand projection is the one load-time cost worth watching.** `projectStop`
scans a shape's points per stop. Forty stands against 25,000 points across ten
corridor-directions is on the order of ten million haversine evaluations, which
is one to two seconds. It happens once, at load, and `/readyz`'s twenty-second
budget absorbs it, but it is worth knowing before someone adds a twentieth
corridor and wonders why boot got slow. If it becomes a problem the fix is a
coarse bounding-box pre-filter per stand, not a different algorithm.

**The tick is fine, and it is fine for a structural reason.** `tickAt` today
iterates every vehicle in one map. With a coach roster, most of those vehicles
are not running, and advancing a cursor for a coach that is parked in a depot
until tomorrow night is pure waste. So the world holds two collections:

```
#roster   every duty in the window, with its assignment. Read on lookup.
#active   the duties dispatched and not yet arrived. Iterated every tick.
```

`tickAt` iterates `#active` only, plus a cheap scan of the roster for departures
due since the last tick and arrivals to retire. At about 11 active coaches the
per-tick cost is a small fraction of the existing 60-bus loop.

The intercity device model is also *cheaper* than the urban one: `activeDropout`
scans eight minute-buckets per vehicle per call, while a dead-zone check is a
comparison of `cursor.distanceMetres` against a list of two or three intervals.
`tickLagMs` continues to publish the truth on `/readyz` either way.

---

## 12. Configuration

The rule from `SPEC.md` decision 8 is unchanged: nothing anywhere hardcodes a
port, a hostname or `localhost` outside `src/config.ts`, every variable has a
named local default, and `.env.example` lists every one of them. Criterion 41
already parses both files and requires the sets to be identical, so a variable
added here without a line in `.env.example` fails the build, which is the
behaviour to want.

Per-service-class overrides use the `__<CLASSID>` suffix, uppercased, matching
the existing `METRO_HEADWAY_SECONDS_PEAK__YELLOW` convention.

### 12.1 Corridors and fleet composition

| Variable | Default | Notes |
|---|---|---|
| `INTERCITY_CORRIDORS` | *unset* | Comma-separated corridor ids. **Unset means no coaches at all** - section 14. |
| `INTERCITY_TOPOLOGY_PATH` | `./data/bundle/corridor-topology.json` | |
| `INTERCITY_ROSTER_PATH` | `./data/bundle/corridor-roster.json` | Deliberately a second file - section 13.2. |
| `INTERCITY_ROSTER_DAYS` | `3` | Service days held at once. Must be at least 2 for a duty that crosses midnight. |
| `INTERCITY_ASSIGNMENT_HORIZON_HOURS` | `36` | Beyond this, `not_yet_assigned`. Section 10.3. |
| `INTERCITY_SERVICE_CLASSES` | `karnataka_sarige,rajahamsa_executive,airavat,airavat_club_class,ambaari_utsav,pallakki` | Must all exist in the topology's class table or startup fails, naming the missing ones. |
| `INTERCITY_HUB_CODES` | `KBS,MYS,MDK,HUB,HSP` | Three letters each, no `I` or `O`. |

### 12.2 Device and coverage

| Variable | Default | What it demonstrates |
|---|---|---|
| `INTERCITY_COVERAGE_SHARE__RESERVED` | `0.92` | Better-fitted premium stock. Section 6.2. |
| `INTERCITY_COVERAGE_SHARE__ORDINARY` | `0.70` | The old rural end of the same fleet, below the city bus's 0.75. |
| `INTERCITY_FIX_INTERVAL_SECONDS` | `30` | The attested moving interval.[^ais140-freq] |
| `INTERCITY_FIX_INTERVAL_STATIONARY_SECONDS` | `120` | A halted coach does not emit ninety identical fixes. Section 4.3. |
| `INTERCITY_FIX_JITTER_SECONDS` | `8` | |
| `INTERCITY_STALE_AFTER_SECONDS` | `180` | See the note below. |
| `INTERCITY_DARK_AFTER_SECONDS` | `600` | A dead zone is minutes, not seconds. |
| `INTERCITY_GPS_NOISE_METRES` | `12` | Unchanged from the bus. A satellite does not care about the road class. |

**`INTERCITY_STALE_AFTER_SECONDS=180` puts a fix outside GTFS-Realtime's
90-second data-age guidance while this service still calls it `live`, and that is
a deliberate departure that has to be stated rather than quietly taken.**[^gtfsrt-bp]
The two claims are separable and both are kept honest. The **feed** stays
conformant and unfreshened: `vehicle.timestamp` is the measurement instant,
`header.timestamp - vehicle.timestamp` is the true age, and criterion 32 asserts
nothing is backdated or forward-dated to look better. What changes is only **this
service's own editorial vocabulary**: at 65 km/h a 90-second-old fix puts the
coach 1.6 km further on, which on a 340 km run is not worth flagging to a rider,
and calling it `stale` would spend the word on a non-event and leave nothing to
say when a fix is genuinely twenty minutes old. `fixAgeSeconds` is published
either way and a consumer that disagrees can threshold it itself.

### 12.3 Dead zones

| Variable | Default | Notes |
|---|---|---|
| `INTERCITY_DEAD_ZONE_COUNT_PER_CORRIDOR` | `3` | Build-time; the zones are written into the topology. |
| `INTERCITY_DEAD_ZONE_SHARE_OF_ROUTE` | `0.12` | Total, across all zones on a corridor. |
| `INTERCITY_DEAD_ZONE_MIN_METRES` | `8000` | |
| `INTERCITY_DEAD_ZONE_MAX_METRES` | `40000` | 40 km at 65 km/h is a 37-minute dark period. |
| `INTERCITY_DEAD_ZONE_UNCERTAINTY_MULTIPLIER` | `2.5` | Applied to the prediction band while inside a zone. Section 10.8. |
| `INTERCITY_URBAN_DROPOUT_RATE_PER_HOUR` | `1.5` | The city process, on the urban segments only. Same default as `BUS_DROPOUT_RATE_PER_HOUR` because it is the same phenomenon. |

### 12.4 Halts and dwell

| Variable | Default | Notes |
|---|---|---|
| `INTERCITY_BOARDING_SECONDS_MEAN` / `_SD` | `180` / `60` | City-side pickup. |
| `INTERCITY_STAND_SECONDS_MEAN` / `_SD` | `420` / `180` | A taluk or district stand. |
| `INTERCITY_HALT_SECONDS_MEAN` / `_SD` | `1800` / `420` | The meal halt. The `_SD` of seven minutes is the largest single variance term in the whole model and section 5.3's `PER_HALT` band is derived from it. |
| `INTERCITY_CREW_CHANGE_SECONDS_MEAN` / `_SD` | `420` / `120` | |

### 12.5 Duty, roster and substitution

| Variable | Default | Notes |
|---|---|---|
| `INTERCITY_DUTY_CONFIRMED_SHARE` | `0.80` | |
| `INTERCITY_DUTY_INFERRED_SHARE` | `0.15` | |
| `INTERCITY_DUTY_UNKNOWN_SHARE` | `0.03` | |
| `INTERCITY_DUTY_OUT_OF_SERVICE_SHARE` | `0.02` | Must sum to 1.0 within 1e-6 or startup fails, naming all four and the sum. |
| `INTERCITY_VEHICLE_SUBSTITUTION_RATE_PER_DUTY` | `0.06` | Applied **at dispatch only**. |

**An intercity duty is better known than a city duty and worse known than a metro
duty**, and the shares say so: `confirmed` at 0.80 against the bus's 0.60 and the
metro's 0.99. The reason is that a reserved coach has a named run code sold weeks
in advance and a driver who signed on to that specific block, so the roster record
is real and recent in a way a city bus's morning document is not. What it does
not have is the metro's structural guarantee that a train cannot be anything but
what the signalling system says it is.

**Mid-run reassignment does not happen and the model must not produce it.**
`DUTY_SWAP_RATE_PER_DAY` fires in `maybeSwapDuty` on every tick for a bus, moving
a `confirmed` duty to `inferred` or `unknown` while the vehicle keeps running.
A coach 200 km from the nearest depot cannot be reassigned to another block. What
happens instead is **vehicle substitution before departure**: the rostered coach
fails its check, a spare takes the run, and the duty is untouched. So
`INTERCITY_DUTY_SWAP_RATE_PER_DAY` is `0` and not configurable upward, and
substitution is a separate mechanism that changes the BIN bound to a duty and
leaves `duty.status` `confirmed`.

That is a genuinely different shape from the bus swap and it produces a
genuinely different demo: **the duty is identical and the vehicle changed**,
which is the mirror image of `SPEC.md` section 5's money shot where the vehicle
is identical and the duty changed. Both are visible through `/fleet/duty`'s
`assignment.supersededAt`.

### 12.6 Speed, by segment kind

| Variable | Default | Notes |
|---|---|---|
| `INTERCITY_CRUISE_KPH_MEAN` | `62` | Highway segments. |
| `INTERCITY_CRUISE_KPH_SD` | `8` | |
| `INTERCITY_CRUISE_KPH_MIN` / `_MAX` | `30` / `85` | |
| `INTERCITY_URBAN_KPH_MEAN` | `17` | Bengaluru's measured city-wide average.[^blr-speed] |
| `INTERCITY_URBAN_KPH_SD` | `4` | |

**One mean across both kinds is what would make a 340 km run come out ninety
minutes wrong.** A coach spends about 25 km getting out of Bengaluru at city
speed and 290 km on divided highway at nearly four times that, and averaging them
into a single draw gets both segments wrong in opposite directions. So the
corridor file marks each segment `highway` or `urban` and the cursor draws
against the segment it is on, which is a small change to `drawBusSpeedKph`'s
signature and no change at all to the cursor's arithmetic.

`BUS_PEAK_WINDOWS` and `BUS_PEAK_SPEED_FACTOR` apply to urban segments and not
to highway ones. A highway does not have a rush hour in the sense the peak factor
models, and applying a 0.7 multiplier to a coach on NH-48 at 08:00 would slow it
for a reason that is not there.

### 12.7 Predictions

| Variable | Default | Notes |
|---|---|---|
| `INTERCITY_UNCERTAINTY_BASE_SECONDS` | `120` | Section 5.3. |
| `INTERCITY_UNCERTAINTY_PER_HIGHWAY_KM_SECONDS` | `1.5` | |
| `INTERCITY_UNCERTAINTY_PER_HALT_SECONDS` | `420` | Matches `INTERCITY_HALT_SECONDS_SD`, deliberately. |
| `INTERCITY_UNCERTAINTY_URBAN_APPROACH_SECONDS` | `600` | Applied once when the remaining path enters a city. |
| `INTERCITY_PREDICTION_HORIZON_SECONDS` | `21600` | Six hours. Section 5.4. |
| `INTERCITY_SUGGESTED_POLL_SECONDS` | `120` | Published on `/`. Section 8.1. |

### 12.8 The manifest

| Variable | Default | Notes |
|---|---|---|
| `MANIFEST_TOKEN` | *unset* | Gates `PUT`/`DELETE /fleet/manifest`. Unset means `404`, not `401`. Deliberately not `ADMIN_TOKEN` - section 10.5. |
| `INTERCITY_MANIFEST_MAX_AGE_SECONDS` | `3600` | Beyond this a stored manifest is expired and the `manifest` key disappears. Never replaced by a modelled figure. |
| `INTERCITY_MANIFEST_TTL_MAX_SECONDS` | `86400` | Ceiling on a push's own `ttlSeconds`. |
| `INTERCITY_PROGRESS_LOG_MAX_ENTRIES` | `40` | Section 8.3. |

There is deliberately **no** variable that enables an occupancy for a reserved
duty, from a model or from a manifest. A knob that turns the refusal off would be
a knob that turns the fabrication on, and a deployment could set it by accident.
Section 7's rule is not configurable, and section 15 makes that a test.

There is also no variable that lets a pushed `simulated` seat count reach a
response. It is accepted at the door, recorded, and never published (section
7.4), and no configuration changes that.

---

## 13. The fixture

The bar is unchanged and it is the one `SPEC.md` section 9.1 sets:
`git clone && docker compose up` on a clean machine gives a running simulator
**with no download, no Overpass call and no network access at all**.

### 13.1 Five corridors, and why these five

| Corridor | Corporations | Class mix | Why it is in the set |
|---|---|---|---|
| `BNG-HSP` Bengaluru - Hosapete - Hampi | KSRTC + KKRTC | Pallakki | The overnight sleeper the whole document is shaped around: 22:59 departure, 06:30 arrival, crossing midnight, a meal halt, and the corporation-disclosure gap in one route **[S]**[^hampi] |
| `BNG-MAA` Bengaluru - Chennai | KSRTC | Airavat, Airavat Club Class, Ambaari Utsav, Rajahamsa | Multiple classes on one corridor, and multi-point boarding on the far side, so the class-conditional coverage rule has something to bite on **[S]**[^abhibus] |
| `MYS-MDK` Mysuru - Madikeri | KSRTC | Ordinary and express seater | A short daytime hill run, and the counter-example: no reservation, so the demand model applies and section 7's refusal does not **[S]** |
| `BNG-HUB` Bengaluru - Hubballi | NWKRTC | Airavat, Rajahamsa | Exercises the second corporation and a second hub code |
| `PVG-BNG` Pavagada - Bengaluru | KSRTC | Karnataka Sarige | **The only corridor OSM has actually mapped** (relation `15728171`), which makes it the one place the routing pipeline can be checked against independent geometry. Section 9.4, check 7. |

`PVG-BNG` is in the set for a reason that has nothing to do with demonstrating
anything to a rider. It is the ground truth.

### 13.2 Geometry and roster live in separate files

```
data/bundle/
  corridor-topology.json.gz     geometry, stands, segments, dead zones
  corridor-roster.json.gz       departures per corridor per service date
  corridor-classes.json         the service-class table of section 2.2
```

**Geometry and roster are separate files because they carry different licences
and different confidence.** The topology is derived from OpenStreetMap and is a
derived database under **ODbL** (section 9.6). The roster is authored from
secondary sources - an aggregator route page whose primary fetch failed, a news
report of a launch - and is this repository's own fabrication in the same sense
every plate is. Merging them into one file would make the ODbL claim on the whole
thing murky and would let a reader assume the departure times inherit OSM's
provenance, which they do not.

`SOURCE.md` gains a section per file recording, for the topology: the Geofabrik
extract and its date, the routing engine and version, the Overpass queries and
each response's own `timestamp_osm_base`, and the simplification tolerance. For
the roster: every corridor's stand list and departure times with the confidence
label of the source they came from, carried through from section 1 rather than
flattened.

### 13.3 The roster is a fixture, not a timetable

**Nothing in `corridor-roster.json` is a claim about when a KSRTC coach actually
leaves.** The Bengaluru-Hampi 22:59 departure is in the file because a route
aggregator page reported it and the reporting is plausible; the primary fetch of
that page failed with a DNS error and was never independently re-verified
**[S]**.[^hampi] Every other departure in the fixture is invented outright to
give the corridor a plausible cadence.

That has to be said in three places, not one: in `SOURCE.md`, in the fidelity
table (section 17), and on `/fleet/corridors` as
`provenance.departures: "authored_secondary"`. A departure time is exactly the
kind of number a screenshot turns into a fact.

### 13.4 Goldens

The sixteen existing resolve goldens stay untouched, byte for byte, and section
14 makes that the migration test.

Coaches get **eight new goldens**, and deliberately not another
four-by-four sweep. The four duty states crossed with the four tracking states
are already covered by the bus goldens and the projection code is shared; a
second sixteen would be sixteen files churning on every field rename for no new
coverage. What the coach goldens cover is what is genuinely new:

| Golden | What it pins |
|---|---|
| `coach__halt` | `dwell.kind: meal_halt`, a non-zero `endsAtUncertaintySeconds`, `currentStatus: STOPPED_AT`, `live` tracking |
| `coach__dead_zone` | `dark` with a non-null `deadZone` and a stale last position |
| `coach__recovered` | `recovery` with both ends of a 40 km gap |
| `coach__crosses_midnight` | `serviceDate` behind the calendar date, `startTime` past `24:00:00` in the static join |
| `coach__reserved_no_manifest` | **No `occupancy` key and no `reservation.manifest` key anywhere in the body** |
| `coach__reserved_with_manifest` | `reservation.manifest` with its `covers` and its age, and **still no `occupancy` key** |
| `coach__unreserved_modelled` | Karnataka Sarige with `occupancy.source: "modelled"` and no `reservation` object |
| `coach__not_yet_assigned` | `/fleet/duty` at horizon + 1 hour: `vehicle: null`, `200` |

Generated once, reviewed by a human, diffed thereafter, exactly as `SPEC.md`
section 14.3 layer B specifies and for the same stated reason: **this is what
stops a field being renamed without the sibling project finding out.**

### 13.5 The consuming app's fixture

`SPEC.md` section 1.1 and the consuming app's own configuration both make the
in-repo fixture the default source, and that is settled: a journey plan must not
degrade because a container on somebody's laptop is down. So the consuming app's
fixture has to grow a coach of its own.

The obligation this document takes on is narrow and checkable: **the fixture
coach's body shape must be identical to the real one**, and the goldens above are
what makes that checkable across two repositories without either importing the
other. A fixture that drifts from the service is worse than no fixture, because
it lets a screen be built against a shape the service does not emit.

---

## 14. Migration and backward compatibility

### 14.1 The default is off

`INTERCITY_CORRIDORS` is **unset by default**. With it unset, the corridor files
are not read, no coach is generated, no new field appears on any response, and
every existing body is byte-identical to today's.

That is a deliberate departure from how metro was added. Metro shipped with
`METRO_LINES` defaulted on because its topology was bundled and nothing existing
changed shape. Coaches change `/readyz`'s counts, add entities to both feeds and
add a class value a consumer may not recognise. **A consumer already polling
`/gtfs-rt/vehicle-positions` every fifteen seconds should not find new entities
in it because it pulled a release.** Ship it off, let the consuming app opt in,
turn it on by default one release later.

### 14.2 The one real break, named at the line

`vehicle.class` gains the value `"coach"`, and the consuming app rejects it
today.

- `src/fleet/types.ts:33` declares `export type VehicleClass = 'bus' | 'metro'`.
- `src/fleet/http.ts:114`, inside `readPosition`, returns `null` for anything
  else: `if (body.class !== 'bus' && body.class !== 'metro') return null`.
- A `null` from `readPosition` becomes `unreachable: bad_body`, which that
  client's own documentation defines as *we could not ask* - so a perfectly good
  answer about a coach would surface as a network failure, which is exactly the
  category error that client's `unreachable` arm exists to prevent.

**So `coach` cannot ship until that check widens**, and the ordering is: widen the
consumer's union, release it, then turn `INTERCITY_CORRIDORS` on. Section 14.1's
default-off is what makes that ordering possible without coordinating two
deployments.

The equivalent check in `readResolution` does not test `class` and is unaffected,
and `trackingHolds`, which is the strict one, tests only `state`, `position` and
`fixAgeSeconds` - all unchanged in shape. The new `deadZone`, `recovery` and
`dwell` objects are additive and that reader preserves unknown fields on purpose,
so they reach a screen without a release, which is what `SPEC.md` section 6.4
asked for and what that client's rule 3 delivers.

### 14.3 What does not change

- **The sixteen bus goldens.** Criterion 105.
- **`/fleet/resolve` for a metro BIN** stays `422 not_a_resolvable_code`.
- **The error taxonomy** of `SPEC.md` section 6.5, every status code and every
  `error` string. Three new `error` strings are added (`unknown_duty`,
  `duty_not_scheduled`, `outside_roster_window`) and none is redefined.
- **`meta.simulated`, `X-Simulated`, `X-Request-Id`, `Cache-Control: no-store`**
  on the JSON paths.
- **The three-file class-branch rule.** Adding a third class must not add a
  fourth file to `sourceBoundaries.test.ts`'s allow-list. The pressure point is
  `src/sim/occupancy.ts`, and it is resolved rather than exempted: the refusal
  branches on `input.reservation`, a property of the duty, so the existing regex
  neither fires nor should. The test was measuring the right thing.
- **Determinism, the check character, the two distinct not-founds, the mandatory
  uncertainty band.** `SPEC.md`'s never-cut list is not shortened by anything
  here.

### 14.4 Config migration

Every variable in section 12 has a default, so an existing `.env` keeps working
untouched. Criterion 41 already parses `src/config.ts` and `.env.example` and
requires the two sets to be identical, so a variable added without its
documentation line fails the build. That test is the migration guarantee and it
needs no extension.

---

## 15. Acceptance criteria, and the tests

Numbered continuing from `SPEC.md`'s 45, so a criterion number means one thing
across both documents.

**Geometry**

46. `docker compose up` on a clean clone with `INTERCITY_CORRIDORS` set reaches
    `/readyz` `200` **with no network access**, in under 30 seconds.
47. `check-corridor-topology` passes all seven checks of section 9.4 against the
    bundled topology, and CI runs it.
48. Every corridor's routed length is within `CORRIDOR_MAX_DETOUR_RATIO` of the
    great-circle distance between its endpoints.
49. Stand order is never re-sorted by coordinate: a topology with two stands
    swapped fails the gate, and the test constructs one.
50. Every corridor's cumulative distance is monotonic; a shape that is not falls
    back to haversine and reports `distanceSource: "haversine"`.
51. No dead zone overlaps a stand, a halt, or the 500 m either side of one.
52. `PVG-BNG`'s routed geometry is within `CORRIDOR_MAX_DETOUR_RATIO` of OSM
    relation `15728171`'s own stitched way geometry. **The only independent check
    of the routing pipeline in the suite.**

**Identity**

53. Every generated coach BIN passes its own Damm check digit, and every hub code
    is three letters containing neither `I` nor `O`.
54. `classify()` never returns `bin` for a plate or `plate` for a BIN, over the
    extended hub-code set. The disjointness proof of `SPEC.md` section 6.3 is
    structural and adding hub codes cannot break it; the test asserts that rather
    than assuming it.
55. Every generated coach plate uses the `ZZ` series. **Zero exceptions**, and
    the assertion names any that do not.
56. Every generated coach carries a non-null `corporation` and `serviceClass`,
    and every metro vehicle carries neither.
57. Per BIN, exactly one plate has `until: null`; no periods overlap; no
    normalised plate is current for two BINs, across the whole statewide fleet.
58. A coach's `serviceClass.reserved` matches the class table, and no rule
    anywhere in `src/` reads `corporation` to decide whether a duty is reserved.
    A source scan, in the style of the existing boundary tests.

**Duty and the calendar**

59. A duty dispatched at 22:59 and observed at 03:00 the next calendar day
    reports `serviceDate` equal to the **departure's** service date, not the
    observation's.
60. Two processes started on different calendar days, with the same seed and the
    same `?at=` inside the roster window, produce identical duty status for the
    same duty. **This is the section 3.1 test and it is the one that catches the
    service-date key.**
61. A trip whose arrival falls after midnight emits a `startTime` and static
    `stop_times` past `24:00:00`, and the loader parses them.
62. A coach that reaches its terminal stops. It does not turn round, its cursor
    enters the terminal state, and it leaves `#active`.
63. At any instant, `#active` contains exactly the duties whose scheduled
    departure has passed and whose arrival has not, and `tickAt` iterates no
    other vehicle.
64. `/readyz` returns `503` when the roster window does not contain today.
65. A duty looked up outside the roster window returns `400
    outside_roster_window` carrying the window, never `404`.
66. `INTERCITY_DUTY_SWAP_RATE_PER_DAY` is `0` and no code path moves a coach's
    duty from `confirmed` while it is in flight.

**Halts**

67. A coach at a meal halt reports `tracking.state: "live"`,
    `currentStatus: "STOPPED_AT"`, `position.speedKph: 0`, a non-null `dwell`
    with `kind: "meal_halt"`, and `tracking.reason: null`.
68. `dwell.endsAtUncertaintySeconds` is present and **never zero** on every dwell
    the service emits.
69. A dropout during a halt reports the dropout: `dwell` stays populated,
    `tracking.state` ages through `stale` into `dark`, and `reason` is set. Two
    facts, both published.
70. A halted coach's fix interval is `INTERCITY_FIX_INTERVAL_STATIONARY_SECONDS`
    and a moving coach's is `INTERCITY_FIX_INTERVAL_SECONDS`, asserted by counting
    emitted fixes over a fixed window.

**Device and dead zones**

71. With `INTERCITY_COVERAGE_SHARE__RESERVED=0.0`, every reserved coach is
    `untracked` with `position: null` and `reason: "no_device_fitted"`, and zero
    coach entities appear in `/gtfs-rt/vehicle-positions`.
72. Reserved coverage is strictly greater than ordinary coverage at their
    defaults, and ordinary is at or below `BUS_COVERAGE_SHARE`. **The mode
    contrast must be observable in the fleet**, not only in the config.
73. **Two different coaches on the same corridor go dark over the same interval
    of route distance.** The geographic model's whole point, and a Poisson model
    cannot pass it.
74. The same coach on two successive service dates goes dark over the same
    interval.
75. A dark coach inside an authored zone carries a non-null `tracking.deadZone`;
    a dark coach outside one carries `null`, and its `recovery.cause` is
    `unknown` rather than `dead_zone`.
76. On recovery, `recovery.gapMetres` equals the distance between the two
    published fixes to within one metre, and `gapSeconds` their true difference.

**Prediction**

77. Every predicted arrival carries `uncertaintySeconds`, **never omitted and
    never zero**, across a full-day sweep of every fixture corridor.
78. The band equals `base + perKm * remainingHighwayKm + perHalt * haltsRemaining
    + urbanApproach`, asserted against the config rather than against literals.
    **`predictNextStops`'s hardcoded `45 + index * 30` is a bug and this criterion
    is what removes it.**
79. **For a fixed stand within one run, `uncertaintySeconds` is non-increasing
    between successive observations.** Section 5.5.
80. `uncertaintySeconds` is non-decreasing along a trip's `stop_time_update`
    list at a single instant. `SPEC.md` criterion 36, restated for corridors.
81. Stands beyond `INTERCITY_PREDICTION_HORIZON_SECONDS` carry
    `schedule_relationship: NO_DATA` and **no** `arrival` or `departure`; stands
    inside it carry both, including the destination on a six-hour horizon.

**Occupancy: the refusal**

82. **Over a full-day sweep of every fixture corridor, and with a manifest held
    for every reserved duty, no observation of a reserved duty carries an
    `occupancy` key** - not in `/fleet/resolve`, `/fleet/vehicle/{bin}/position`,
    `/fleet/duty` or either GTFS-Realtime feed. The sweep runs **with** manifests
    precisely so the criterion cannot be passed by having nothing to publish.
    This is the section 7 criterion and it is the one that must never regress.
83. `occupancyFor` returns `withheld` for every reserved duty, **before** any
    demand-model function is called, and the manifest store is never a parameter
    to it. Asserted with a spy on `headcountFor` and a type-level check that
    `OccupancyOutcome` has no arm carrying a measured figure, in the same shape as
    `SPEC.md` criterion 14's spy on the registry.
84. No environment variable, scenario override, query parameter or manifest push
    causes any occupancy to be emitted for a reserved duty. A config-surface scan
    plus an exhaustive sweep of `/admin/scenario`'s and `/fleet/manifest`'s
    accepted bodies.
85. A reserved coach with a manifest publishes `reservation.manifest` carrying
    `seatsBooked`, `seatsTotal`, `asOf`, `ageSeconds` and
    `covers: "bookings_through_this_network_only"`, and **`seatsBooked` equals
    the `booked` field of the push**, never `booked + held` and never
    `booked + simulated`.
86. **A push's `simulated` and `held` counts never appear in any response.** A
    push carrying `simulated: 17` and `booked: 0` yields `seatsBooked: 0`. This is
    the criterion that stops the provider's seeded fill acquiring a second
    source.
87. A push whose `asOf` is not strictly newer than the stored one is accepted with
    `200` and discarded, and the response names the manifest still held. Asserted
    by pushing a cancel and a confirm out of order.
88. A manifest past `INTERCITY_MANIFEST_MAX_AGE_SECONDS`, or past its own TTL,
    removes the `manifest` key entirely, with no reason field and no last-known
    count kept alive.
89. `STANDING_ROOM_ONLY`, `CRUSHED_STANDING_ROOM_ONLY` and `FULL` are never
    emitted for a reserved duty, at any manifest value.
90. `PUT /fleet/manifest` with a valid `ADMIN_TOKEN` and no `MANIFEST_TOKEN` is a
    `404`, and `POST /admin/scenario` with a valid `MANIFEST_TOKEN` is a `404`.
    The two credentials do not substitute for each other.
91. A push naming a travel date whose departure falls after midnight resolves to
    the previous GTFS service date, and the response echoes both dates and the
    note. **The two-date trap, made a test.**
92. An unreserved intercity duty **does** carry a modelled occupancy with
    `source: "modelled"`. The refusal is about reservation, not about distance,
    and this is the test that proves it.

**The API surface**

93. `/fleet/resolve` answers `200` for a coach BIN and a coach plate, and
    `422 not_a_resolvable_code` for a metro BIN. Unchanged for buses.
94. `duty.corridor` and `duty.route` are never both non-null and never both null
    on a `200`.
95. `confirmation.verify` carries three entries for a coach with a known duty and
    one for a coach whose duty is `unknown`, and a consumer rendering it verbatim
    needs no change.
96. `GET /fleet/duty?service=&date=` and `GET /fleet/duty/{dutyId}` return
    identical bodies for the same duty, and both accept an ISO travel date and a
    GTFS service date for the same day.
97. `/fleet/duty` beyond `INTERCITY_ASSIGNMENT_HORIZON_HOURS` returns **`200`**
    with `vehicle: null` and `assignment.status: "not_yet_assigned"`. **This one
    must not regress to a `404`.**
98. `/fleet/duty` inside the horizon returns the same BIN on every call and
    across two fresh processes with the same seed; after a forced substitution it
    returns `superseded` with the previous BIN named.

**Feeds**

99. Coach entities carry **both** `license_plate` and `label`; bus entities carry
    a plate and no label; metro entities carry a label and no plate. `SPEC.md`
    criterion 34, restated three ways.
100. A coach in a dead zone has a `TripUpdate` with predictions and a widened
     band, and a `VehiclePosition` whose `vehicle.timestamp` is genuinely older
     than `INTERCITY_DARK_AFTER_SECONDS`. **The feed must not be freshened.**
101. A coach trip crossing midnight emits `trip.start_date` equal to its service
     date and static stop times past `24:00:00`, and a conforming consumer joining
     the two resolves the right instant.
102. `occupancy_status` is absent, not `NO_DATA_AVAILABLE`, on every reserved
     coach entity, **including one with a full manifest**. The manifest has no
     GTFS-Realtime representation at all. Section 10.8.

**Determinism, the log, and migration**

103. **A process restarted mid-run reproduces the duty's `progressLog` exactly**,
     by replay, for every entry within the cap. Section 8.3, and the strongest
     determinism test in the suite because it exercises nine hours of seeded draws
     rather than one instant.
104. With `SIM_SEED` fixed and `SIM_CLOCK` frozen, two fresh processes produce
     byte-identical `/fleet/corridors` and identical coverage, dead-zone and
     assignment sets.
105. **With `INTERCITY_CORRIDORS` unset, all sixteen existing bus goldens match
     byte for byte and no new field appears on any response.** The migration
     test.
106. With `SIM_SPEEDUP` greater than 1, seeded draws bucket on simulated elapsed
     time, so a coach crossing three dead zones at speedup crosses three at
     `SIM_SPEEDUP=1` over the same simulated interval. Section 3.6.
107. `.env.example` contains every variable `src/config.ts` reads and no others,
     including all of section 12. `SPEC.md` criterion 41, unextended and
     sufficient.
108. `Math.random` appears nowhere in `src/`, and no vehicle-class branch appears
     outside `sim/profile.ts`, `sim/device.ts` and `sim/duty.ts`. Unchanged.
109. **`src/` contains no outbound HTTP client**, which is also why section 7.4's
     ingress is a push. `scripts/build-corridors.ts` makes outbound calls and is
     excluded, as `scripts/` already is.

### 15.1 The tests, by layer

The layers of `SPEC.md` section 14.3 are unchanged in kind. Two of them grow in
a way worth naming.

**Layer A, pure unit tests**, gains the highest-value new tests in the suite:
the band arithmetic of criterion 78, the dead-zone interval logic of 73 and 74,
and the occupancy refusal of 83. None of them needs a server, a container or a
clock, and every one of them is where a misreading of this document does the most
damage for the least cost to catch.

**A new layer, and it is the interesting one: the full-day sweep.** Criteria 77,
82 and 92 are not assertions about one response; they are assertions about
*every* response the service can produce over a service day. The sweep drives a
frozen-clock world forward at one-minute steps across a full 24 hours for every
fixture corridor, collecting every observation, and asserts the invariants over
the whole set. It is the same instrument the occupancy commit already used to
establish that `FULL` is reachable at about a third of a percent of fleet-minutes,
generalised: **an honesty rule that holds at one instant and fails at 03:40 has
not held.** It runs in seconds because the world is a pure function of the clock.

---

## 16. The demo

Ninety seconds, like `SPEC.md` section 15's, and built around a different
contrast. That demo's argument is *a confident metro leg beside a hedged bus leg,
from one service, in one second*. This one's is **the same service saying less
about a coach than it says about a bus, on purpose, and being able to explain
why.**

| Time | Screen | Said |
|---|---|---|
| 0:00-0:10 | A ticket for tonight's 22:59 to Hampi. No plate on it. `GET /fleet/duty/2259BNGHMP?date=20260905` returns `not_yet_assigned`, `vehicle: null`, `200`. | "This ticket was bought three weeks ago. No coach was assigned then, so this service will not name one. Not a 404 - the duty is real, the vehicle is not decided." |
| 0:10-0:22 | Same call, on the day of travel. A BIN, a plate, a corporation. | "Assigned this morning. `KA-01-ZZ-4417`, Pallakki, and the operating corporation is KKRTC - which no booking surface in Karnataka tells you today." |
| 0:22-0:36 | 02:14. The coach stationary for eighteen minutes. `tracking.state: live`, `speedKph: 0`, `dwell.kind: meal_halt`, `endsAt` with a seven-minute band. | "It has not moved in eighteen minutes and nothing is wrong. That is the Hiriyur meal halt, it leaves around 02:32, give or take seven minutes. **A simulator that could only say 'stopped' would have this look like a breakdown.**" |
| 0:36-0:52 | 02:41. `dark`. Side by side: `reason: no_fix_since`, and `deadZone` naming the interval and an expected exit. Then the coach behind it, going dark over the same two kilometre marks. | "No signal for the next 34 km, and back around 03:19. And the coach behind it loses signal in exactly the same place, because **a dead zone is a piece of geography, not a coin toss.**" |
| 0:52-1:04 | The recovery frame. `recovery.gapMetres: 44810`, both fixes plotted, the gap drawn as a gap. | "Thirty-eight minutes and 45 km with nobody watching. The service publishes both ends so the app can draw the hole instead of animating a teleport across it." |
| 1:04-1:20 | Two bodies side by side. The Karnataka Sarige: `occupancy.source: "modelled"`, a percentage. The Pallakki: **no `occupancy` key at all.** | "This ordinary bus reports how full it is, because nobody counts and a modelled figure is the best honest answer. **This sleeper reports nothing, because its occupancy is a manifest somebody else holds, and inventing a number for a fact that has an owner is the one thing this service will not do.**" |
| 1:20-1:30 | The fidelity table, both columns. | "The corridor geometry, the identifiers, the encoding and every way the tracking fails are real. The coaches, the departure times and the dead-zone locations are not, and here is which is which." |

Rules for the recording, extending the ones `SPEC.md` section 15 already sets.

1. **The frame at 1:04 is the argument.** A body with a number beside a body with
   no field at all. Hold both panes and read the reason out loud; it is the whole
   document in one screenshot.
2. **Freeze the clock and pick 02:14.** `SIM_CLOCK` at a real overnight instant,
   `SIM_SEED` fixed. Criterion 104 is what makes the second take the first take.
3. **Never say "the coach is 34 km from Hosapete."** Say "about 34 km, and it
   reaches Hosapete around 06:05, give or take fourteen minutes." The band is the
   product and a six-hour horizon does not change that.
4. **Do not speed the demo up to show the whole run.** Use `?at=` inside the
   roster window with `SIM_ALLOW_TIME_TRAVEL=true` and cut between instants.
   `SIM_SPEEDUP` at the rate a nine-hour run would need desynchronises the seeded
   buckets from the calendar (section 3.6) and the demo would show a behaviour the
   deployed service does not have.

---

## 17. Fidelity, stated honestly

`SPEC.md` section 13's table is published, not buried, and belongs on screen in
the demo. These rows extend it. Nothing here replaces a row there.

### 17.1 Faithful to a real intercity operation

| Aspect | What is real | Where |
|---|---|---|
| **Corridor road geometry** | The routed polyline is real OSM road geometry, routed over a dated Geofabrik extract by a named engine at a named version. A coach is on a road that exists. | §9.3 |
| **The one mapped corridor** | `PVG-BNG` is checked against OSM relation `15728171`'s own way geometry, which is the single independent validation of the routing pipeline. | §9.4 |
| **Stand coordinates, where sourced** | 171 `amenity=bus_station` nodes and 328 ways exist statewide in OSM, and 42 KSRTC stands sit in the bundled BMTC feed already. Where a stand comes from one of those, its coordinate is real. | §9.2 |
| **Service classes and their layouts** | Real product names, real seating layouts, real corporations. Pallakki is 2+1 with 30 berths; Ambaari Utsav is a 2+1 Volvo sleeper launched February 2023. Each carries its own confidence label. | §1.2 |
| **The four-corporation split and the shared brand** | Real, including the disclosure gap: three corporations share one booking backend and one class-naming scheme, and no consumer surface examined says which one runs a given coach. | §1.1 |
| **Reservation as a service-class property** | Real. The same corporations run walk-up Karnataka Sarige and seat-numbered Pallakki, and the distinction is the class, not the operator or the distance. | §1.2 |
| **A long dwell that is not a failure** | Real in kind. Meal halts and intermediate stands are scheduled, long, and observably different from a dropout in fields a consumer already has: fresh fixes, zero speed, `STOPPED_AT`. | §4 |
| **Coverage and continuity as separate facts** | Real, and the intercity case genuinely inverts them: newer premium stock under a registration-linked fitment mandate, crossing districts with no cellular service. | §6.2 |
| **Dead zones as geography** | Real in kind and in structure. A coverage gap is in the same place for every vehicle on every run, and its duration is a consequence of speed. | §6.3 |
| **Store-and-forward gaps published as gaps** | Real: both fixes were genuine observations, and publishing them together rather than overwriting the first is retention, not invention. | §6.4 |
| **The occupancy refusal** | **The most faithful thing in this document.** A reserved coach's load is knowable and this service does not know it, and it says nothing rather than something plausible. | §7 |
| **A duty crossing midnight, in GTFS terms** | Real: service dates distinct from calendar dates, stop times past `24:00:00`, and a static/realtime join that resolves to the right instant. | §3.2, §10.8 |
| **Vehicle assignment resolved late** | Real in kind. Operators allocate a vehicle to a block the day before or the morning of, and a reservation made three weeks out genuinely does not name one. | §10.3 |

### 17.2 Stubbed, simulated, or absent

| Aspect | What is not real | Consequence |
|---|---|---|
| **Every coach** | No BIN, plate, corporation assignment or position corresponds to anything. Fixture plates use the `ZZ` series. | Nothing here is evidence about any real coach. |
| **The `ZZ` guarantee is weaker than BMTC's** | `SPEC.md` pins fixture plates to a series BMTC does not run. For three corporations across thirty districts there is no published fleet register and nobody has checked whether `ZZ` is in issue. | The guard is unchanged and the confidence behind it is lower. `meta.simulated` and `X-Simulated`, not the series, are what a consumer asserts on. §2.4. |
| **The RTO district-code table** | Not verified against the Karnataka Transport Department's own list. | A plate may name the wrong district. It still cannot collide, because the series carries that. Open question 2. |
| **Departure times** | The Bengaluru-Hampi 22:59 is secondary-sourced from an aggregator page whose primary fetch failed. Every other departure in the fixture is invented. | **The roster is a fixture, not a timetable**, and it says so in `SOURCE.md`, here, and on `/fleet/corridors`. §13.3. |
| **Stand lists** | Authored from secondary sources for four of five corridors. Which stands a coach actually calls at, and in what order, is not published anywhere machine-readable. | A corridor's stop sequence is plausible and unverified. |
| **Dead-zone locations** | Entirely fabricated. No usable public cellular-coverage map exists at 35 km resolution; TRAI publishes district-level claims, which is the wrong granularity by two orders of magnitude. | The *shape* of the failure is real; the *places* are invented. A consuming app must not learn where signal drops on NH-48 from this service. |
| **Coverage shares** | 0.92 reserved and 0.70 ordinary are chosen, not measured. No public source states any of the three corporations' AIS-140 fitment rate, and the K-BREEZE appraisal's "weak data integration" framing suggests the operators may not hold a clean figure either. | The *direction* of the ruling is argued from fleet age and commercial exposure. The magnitudes are demo parameters and are environment variables for that reason. §6.2. |
| **The stationary fix interval** | 120 s is a plausible choice. AIS-140's own figure for the stationary state is behind a paywalled standard and a scanned PDF, exactly as for the moving interval. | Configurable, and the observable behaviour (fewer fixes while halted) is right whatever the number. |
| **The prediction band's shape** | Linear in remaining kilometres and in remaining halts, uncalibrated against any real run-time distribution. Real intercity variance is not linear in either and correlates across the two. | Honest in kind and wrong in shape, the same caveat `SPEC.md` already carries. **A consuming app must not tune a threshold to these numbers.** |
| **Prediction skill** | The prediction knows the ground truth, because the simulator generated both. A six-hour horizon does not change that; it makes it more visible. | It cannot be wrong the way a real prediction is wrong. A real coach occasionally arrives ninety minutes late for a reason nothing here models. |
| **What a manifest count covers** | `seatsBooked` counts bookings made through one Beckn provider. It excludes counter sales, direct AWATAR sales and every aggregator, and it counts bookings rather than boardings. | **Structurally a lower bound on sales and never a measure of how full the coach is**, permanently rather than until the data improves. It is published under a name that says so, beside a `covers` field, and never as an occupancy. §7.5. |
| **Where a manifest comes from before the BPP is real** | Nowhere. There is no manifest source today, and until `ondc-transit-bpp/docs/reserved-intercity.md` is implemented every reserved coach publishes no count at all. | The honest answer to an absent counterparty is silence, and it needs no mechanism. §7.6. |
| **The provider's own seeded fill** | The BPP's seat map is partly seeded rather than booked, by its own specification, and marks the difference on the wire. | This service accepts the split at the door and **publishes only the booked half**, so a fabrication cannot acquire a second source by crossing a service boundary. §7.4. |
| **Seat totals** | `capacity` per class is secondary-sourced from aggregator and encyclopaedia material, never an operator spec sheet, and `capacitySource` says `"secondary"` on every row today. | A manifest's denominator is only as good as that figure. §2.2. |
| **Fares, seats, bookings, cancellation slabs** | Wholly absent. This service knows nothing about money and holds no inventory. | The manifest comes in through one door and is a count, never a booking. §7.4. |
| **Scale** | Five corridors and tens of coaches, against roughly 19,000 buses across the three corporations. | Unchanged from `SPEC.md`'s own scale row and deliberately not fixed by generating 19,000 fabricated vehicles. §11.1. |
| **Substitution realism** | Vehicle substitution fires at a configured rate at dispatch. Real substitutions cluster around breakdowns, festivals and weather, none of which is modelled. | The mechanism is real; its timing is a Poisson draw. |
| **Interstate operation** | A corridor ending in Chennai runs entirely on this service's own simulated vehicle. SETC, the Tamil Nadu operator running the other half of that corridor commercially, does not exist here. | A bilateral corridor is simulated unilaterally. |

**The one-sentence version, for a slide:** *the roads are real, the classes and
corporations are real, and every way an overnight coach loses touch is real; the
coaches, the departure times and the places the signal drops are not, and the
occupancy of a reserved coach is a fact this service refuses to invent.*

---

## 18. Effort

Engineer-days, one person, at the pace `SPEC.md` costed itself against.

| Stage | Work | Days |
|---|---|---|
| **0. Spike** | Route one corridor with an offline engine over a Karnataka extract, simplify at 15 m, measure point count and resident memory. **Settles whether §11.2's simplification estimate holds and whether the typed-array measure is needed.** | **0.5** |
| **1. Corridor geometry** | `build-corridors.ts`, the stand authoring, segment classification, dead-zone placement, `check-corridor-topology.ts`'s seven checks, the bundle and `SOURCE.md`. | **1.5** |
| **2. Roster and calendar** | Service dates as a first-class field, the multi-day roster window, dispatch by departure rather than by spread, run completion and the terminal cursor state, the `#roster`/`#active` split, `/readyz`'s new counts and its new `503`. | **1.5** |
| **3. Identity** | `corporation`, `serviceClass` and its data table, division hub codes, the district-series generator, registry assertions across the statewide fleet. | **0.75** |
| **4. Halts** | Dwell kinds, the `dwell` object, the stationary fix interval, the halt-versus-dropout separation. | **0.5** |
| **5. Device and dead zones** | The intercity device profile, geographic zones, the urban process on urban segments only, recovery with both ends of the gap. | **1.0** |
| **6. Prediction** | The two-term band, the time horizon, the dead-zone multiplier, and removing `predictNextStops`'s hardcoded literals. | **0.75** |
| **7. Occupancy and the manifest ingress** | `OccupancyOutcome` with no measured arm, the refusal branch, `PUT`/`DELETE /fleet/manifest` with `MANIFEST_TOKEN`, the booked/held/simulated split, `asOf`-as-version ordering, the manifest store with TTLs, the travel-date/service-date reconciliation. | **1.0** |
| **8. HTTP surface** | `resolve` and `position` extensions, `/fleet/duty` in both forms with its four errors, `/fleet/corridors`, the two new scenario targets, root discovery. | **1.25** |
| **9. GTFS-Realtime** | Coach entities in both feeds, the three-way `VehicleDescriptor` split, the dead-zone prediction rule, the omitted `occupancy_status`. | **0.75** |
| **10. Config and migration** | `config.ts` additions with fail-fast validation, `.env.example`, the default-off wiring, the byte-identical migration check. | **0.5** |
| **11. Tests** | Criteria 46-109, the eight coach goldens, the full-day sweep harness, the cross-day determinism test, the replay test. | **1.5** |
| **12. Documentation** | The fidelity extension, `docs/consuming.md`'s intercity section, README, `THIRD_PARTY_NOTICES.md`. | **0.5** |
| | **Total** | **12.0** |

**The number assumes two dependencies and absorbs neither.**

**The GTFS-Realtime feeds do not exist yet.** `docs/acceptance-audit.md` marks
criteria 30 through 39 `NOT MET` and records that the protobuf work is ordered
after metro. Stage 9 above costs coach handling *within* those feeds, and it
cannot start until `SPEC.md`'s own stage 7 (0.75 days) has landed. If the feeds
are cut, stage 9 goes with them and the total is **11.25**, with the single-vehicle
JSON endpoint carrying the same bands - the same trade `SPEC.md` section 16.4
already makes.

**The corridor stand lists and departure times are not costed here.** Section 9.5
puts them outside this repository's boundary, and the consuming project costs its
own three-operator dataset at 20 to 30 engineer-days.[^tatak-spec] The five
fixture corridors above are hand-authored at the fidelity section 17.2 admits,
which is a fraction of a day inside stage 1 and is not the same work.

**Where this could go wrong**

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
| **Routing produces a corridor that fails the detour check** | Medium | Low | The interpolated fallback already exists and is surfaced. Do not block on perfect geometry; fix the stand coordinate that caused it. |
| **The simplified geometry is still too large** | Medium | Medium | Stage 0 settles it in half a day. Fallback is the typed-array `ShapeIndex`, which is bounded work and touches metro code. §11.2. |
| **The occupancy refusal gets softened by a later well-meaning change** | Low | **High** | Criteria 82, 83 and 84, and the `OccupancyOutcome` type that makes `withheld` carry no number to serialise. The type is the real guard; the tests catch the route around it. |
| **A service-date bug survives to production because every test runs at noon** | **High** | Medium | Criterion 60 runs two processes on different calendar days. Write it in stage 2, not stage 11. |
| **`coach` ships before the consuming app widens its class union** | Medium | Medium | Default-off, §14.1, and the break is named at the file and line in §14.2. |
| **The fixture roster gets read as a timetable** | Medium | **High** | It is marked in three places (§13.3) and one of them is an endpoint - a screenshot is all it takes otherwise. |
| **Scope creep into fares, seats or bookings** | Medium | Medium | The manifest comes in through one door as a count. §7.4, and §17.2 lists the rest as absent. |

---

## 19. Open questions

Collected so they can be worked in one sitting. None blocks starting.

| # | Question | How to settle it | Blocks |
|---|---|---|---|
| 1 | How many points does a routed 340 km corridor produce, and how much does Douglas-Peucker at 15 m remove? | Stage 0. Route `BNG-HSP`, count before and after, measure resident memory. Half a day. | §11.2, the stage-1 estimate |
| 2 | The Karnataka RTO district-code table. | The Karnataka Transport Department's own RTO list. An hour. | Nothing. A wrong district produces a plate that is wrong about a district and still cannot collide. §2.4. |
| 3 | Does the Bengaluru-Hampi service actually depart at 22:59, and does route `2259BNGHMP` still run? | The primary fetch of the route page failed with a DNS error and was never re-verified **[S]**. Retry, or drop the specific number and keep the shape. | Nothing structural. It is a fixture either way, and §13.3 says so. |
| 4 | Is `ZZ` a registration series any of the four corporations runs? | No published fleet register was found. Would need an operator's own vehicle documentation. | Nothing today. It is the residual honesty risk of §2.4 and it should stay named rather than quietly forgotten. |
| 5 | AIS-140's stationary transmission interval, clause and figure. | Inherits `SPEC.md`'s open question 3 unchanged: a paywalled ARAI standard and a scanned state protocol PDF.[^ais140-odisha] An OCR pass, or a request to ARAI. | Nothing. The interval is configurable. |
| 6 | Does `ondc-transit-bpp` accept §7.4's push shape, its `booked`/`held`/`simulated` split and its `asOf`-as-version rule? | Its `docs/reserved-intercity.md` specifies the inventory and names the lookup it needs from this side, but neither document specifies the ingress. This one now does; the other side has to agree to it, and a push it will not send is worse than no push. **Settle before either project builds.** | §7.4, and the reserved-coach half of §7 |
| 7 | Should `/fleet/duty` also accept a booking reference or PNR? | Ask the ticketing side once it issues one. | Nothing. The service and the date are the join key either way and a PNR would be an alias. |
| 8 | Three service days in the roster window, or a rolling window keyed on the longest duty in the fixture? | Cheap to change, and a boundary bug here is expensive to find. Decide before stage 2 rather than after. | §12.1 |
| 9 | Should the progress log be memoised as the tick produces it, or recomputed lazily on every read? | Measure the replay cost once stage 2 exists. Criterion 103 holds either way and is the reason the choice is free. | Nothing. §8.3. |
| 10 | Are the 42 KSRTC stands in the bundled BMTC feed usable as boarding-point coordinates? | Count and inspect them directly against `data/bundle/gtfs/stops.txt`. That figure is the consuming project's stated fact and was not re-counted here. | Nothing. If they are usable, stage 1 gets cheaper; if not, the stands are hand-authored. |
| 11 | Should an unreserved intercity duty get an intercity demand shape, or keep the city curve? | It currently gets a corridor-shaped curve rather than a CBD-centre one (§3.7), and neither is fitted to anything. | Nothing. Both are marked modelled and §17.2 says so. |

---

[^bpp-spec]: `ondc-transit-bpp/SPEC.md` section 9's fidelity table, line 1225: "Seat/quantity inventory | No inventory model. Every `select` succeeds. | No out-of-stock path." That row describes the shipped platform's two catalogue categories, `TICKET` and `PASS`, neither of which has any inventory. It is not a statement about reserved intercity.
[^bpp-reserved]: `ondc-transit-bpp/docs/reserved-intercity.md`, written 5 September 2026, build-ready and not yet implemented. Section 1's comparison table (line 66) sets the three categories side by side and gives `RESERVED` "Finite. Numbered seats, exhaustible, held" against the other two's "None". Section 6 specifies deterministic occupancy seeded from service identity and travel date, and section 6.4 splits a seat's state into seeded occupancy (marked `simulated: true`, "not" a fact the provider holds), live holds, and confirmed bookings. Section 8.1 sets `RESERVATION_HOLD_TTL_SECONDS` to 600 as an absolute, non-renewing expiry. Section 9 specifies the passenger manifest. Section 18 commits `serviceId` as the join key across all three projects, names the `?service=...&date=...` lookup shape as work in this repository, and rules that a corporation attached to a generated vehicle renders "under the same 'simulated' framing, never in the disclosure slot".
[^kbreeze]: World Bank, K-BREEZE project appraisal (P517113, "Initial Environmental and Social Review Summary", 19 May 2026), a live operation covering KSRTC, NWKRTC and KKRTC jointly, putting the three at about 19,000 buses and naming "fragmented institutional systems and weak data integration" as a barrier the project is funded to address. Read first-party by the consuming project's statewide design; not independently re-fetched for this document.
[^tatak-spec]: The consuming project's statewide design, `docs/superpowers/specs/2026-09-05-karnataka-statewide-design.md`, sections 8 and 12: the three-operator dataset costed at 20 to 30 engineer-days with a 25-day point estimate, and the independent Overpass count of 944 `route=bus` relations statewide of which 853 are BMTC and exactly one is a mapped intercity corridor.
[^kkrtc]: Kalyana Karnataka Road Transport Corporation. Founded 15 August 2000 as NEKRTC; renamed KKRTC by gubernatorial order on 6 July 2021. Territory: Kalaburagi, Vijayapura, Bidar, Yadgir, Raichur, Koppal, Ballari, Vijayanagara. https://en.wikipedia.org/wiki/Kalyana_Karnataka_Road_Transport_Corporation
[^nwkrtc]: North Western Karnataka Road Transport Corporation, formed 1 November 1997, HQ Hubballi, nine divisions. https://en.wikipedia.org/wiki/North_Western_Karnataka_Road_Transport_Corporation
[^awatar]: AWATAR, the shared advance-reservation portal and app for KSRTC, NWKRTC and KKRTC, documented on KKRTC's own site. https://kkrtc.karnataka.gov.in/info-2/awatar+booking+and+counters/en
[^sarige]: Karnataka Sarige, the ordinary non-AC 3+2 seater class; 5,874 buses, KSRTC's largest single fleet. https://en.wikipedia.org/wiki/Karnataka_Sarige
[^rajahamsa]: Rajahamsa Executive Class, non-AC ultra-deluxe 2+2 seater; 127 buses across KSRTC, NWKRTC and KKRTC; excluded from the Shakti free-travel scheme. https://en.wikipedia.org/wiki/Rajahamsa_Executive_Class
[^airavat-club]: Airavat, launched 16 May 2012 on Volvo B9R/B11R, Mercedes-Benz and Scania chassis, and Airavat Club Class, reported at a 53-seat configuration on the Bengaluru-Chennai service. https://en.wikipedia.org/wiki/Airavat_Club_Class
[^ambaari-utsav]: Ambaari Utsav, launched 21 February 2023; 40 buses; Volvo 9600 multi-axle AC sleeper seating 40 in berth configuration; KKRTC runs a parallel branded service, Kalyana Ratha. https://en.wikipedia.org/wiki/Ambaari_Utsav_Class
[^pallakki]: Pallakki Class, non-AC sleeper, 2+1 with 30 berths, Ashok Leyland Viking 222, BS-VI, silver livery, shared across KSRTC, NWKRTC and KKRTC. https://en.wikipedia.org/wiki/Pallakki_Class
[^ksrtc-terms]: KSRTC reservation terms and conditions: 30-day advance booking window, bookings closing 30 to 45 minutes before departure, and the cancellation slabs (10% deducted more than 72 hours out, 25% from 72 to 24 hours, 50% from 24 to 2 hours, no refund inside 2 hours or after departure). https://www.ksrtc.in/reservation_terms and https://ksrtc.karnataka.gov.in/info-2/Reservation+Terms+&+Conditions/en
[^hampi]: Bengaluru-Hampi Pallakki sleeper service, route `2259BNGHMP`: reported departing Kempegowda Bus Station at 22:59, Hosapete about 06:00, Hampi about 06:30, nine stops. Secondary-sourced via a route-aggregator page (`ksrtcbus.in/route-2259bnghmp/`) whose direct fetch failed with a DNS error and was not independently re-verified. Also reported by https://newsable.asianetnews.com/gallery/karnataka-news/ksrtc-bengaluru-to-hampi-pallakki-sleeper-bus-service-check-timings-route-fare-online-booking-details-here-x3n9e30
[^abhibus]: Bengaluru-Chennai KSRTC services: 347 km, about 8 hours, running Airavat, Airavat Club Class, Ambaari Utsav, Rajahamsa Executive and non-AC sleeper, with multi-point boarding on the Chennai side. Aggregator-sourced and not a published timetable. https://www.abhibus.com/bus-tickets/ksrtc-karnataka-bangalore-chennai-bus-booking
[^bmtc-gtfs]: `Vonter/bmtc-gtfs`, the unofficial community GTFS dataset for BMTC, built by reverse-engineering the Namma BMTC app. Bengaluru-only; no equivalent exists for KSRTC, NWKRTC or KKRTC on GitHub, Kaggle, transit.land, the Mobility Database or Hugging Face, checked directly by the consuming project's acquisition research. https://github.com/Vonter/bmtc-gtfs
[^ais140-morth]: On the MoRTH mandate making AIS-140 a condition of registration for new public service vehicles. https://www.autocarpro.in/news-national/ais-140-norm-public-transport-vehicles-mean-28696
[^ais140-freq]: VLTD transmission intervals as reported by device vendors and integrators: 30 seconds while moving, longer while stationary. Secondary source; see open question 5. https://blog.fleetx.ai/blog-vltd-ais-140-vehicle-location-tracking-device-guide/
[^ais140-odisha]: Odisha State Transport Authority, "AIS-140 Protocol", version 1.0, 20 September 2022. A scanned PDF; text not machine-extractable. https://vltd.odishatransport.gov.in/ODSTA-AIS-140_Protocol_Version_1.0.20092022.pdf
[^gtfsrt-ref]: GTFS-Realtime reference, including `StopTimeEvent.uncertainty` and the `NO_DATA` semantics requiring that arrival and departure not be supplied. https://gtfs.org/documentation/realtime/reference/
[^gtfsrt-bp]: GTFS-Realtime best practices: refresh at least every 30 seconds; data within the feed no older than 90 seconds for Trip Updates and Vehicle Positions. The 90-second figure is the one section 12.2 departs from, deliberately and only in this service's own vocabulary. https://gtfs.org/documentation/realtime/realtime-best-practices/
[^plate-format]: Vehicle registration plates of India: two-letter state code, district RTO number, one-to-three-letter series omitting `I` and `O`, four-digit serial. Rule 50, Central Motor Vehicles Rules 1989. https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_India
[^bmtc-fleet]: BMTC's fleet passed 7,000 buses in 2025, roughly one in five of them electric. https://www.sustainable-bus.com/news/bangalore-buses-one-fifth-fleet-7000/
[^blr-speed]: Bengaluru's measured average traffic speed, about 17.4 km/h city-wide and about 18 km/h in rush hour. https://www.deccanherald.com/india/karnataka/bengaluru/bengaluru-third-slowest-city-in-the-world-3352211
[^osm-copyright]: OpenStreetMap data is licensed under the Open Database Licence (ODbL) 1.0 and requires attributing "© OpenStreetMap contributors". https://www.openstreetmap.org/copyright
