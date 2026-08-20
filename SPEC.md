# A simulated transit fleet for Bengaluru, and the tracking service in front of it

**Status:** build-ready specification. No code has been written yet.
**Audience:** an engineer who knows Node, TypeScript and Docker, and knows
neither this domain, nor GTFS-Realtime, nor Indian bus fleet operations.
**Written:** 20 August 2026. **Deadline it is written against:** 27 August 2026.

---

## 0. Read this first: the decisions this document takes

This is a mock of the layer a real transit operator runs between the vehicle and
the app: devices on buses reporting position, a server ingesting them, and feeds
an app consumes. It exists so that a transit app and a ticketing service can be
built and demonstrated against live tracking without real vehicles.

Nine decisions are already taken. They are stated here so nobody has to read
sixteen sections to find them, and the rest of the document specifies them.

1. **Two vehicle classes, one design.** BMTC buses and Namma Metro trains are
   both simulated, and they are deliberately *not* the same thing with a
   different colour. A bus position is a noisy GPS estimate from a cellular
   device that frequently is not there at all; a train position comes from a
   signalling system that knows which block the train occupies. The honesty
   profile inverts between them, and that contrast is the most useful thing this
   service gives the consuming app. Section 3.3.

2. **Three identifiers for a bus, and the BIN is the spine.** Number plate for
   the rider, BIN for the system, route number for the rider. Plates change; the
   BIN never does; so the BIN-to-plate mapping is temporal. Section 4.

3. **For metro, the useful identity is the trip, not the vehicle.** A rider on a
   platform cannot read a rake number and nothing makes them want to. What they
   can verify is the line, the direction, the destination on the headboard and
   the platform. So metro gets its own endpoint shaped around *which trains are
   approaching this station*, and `/fleet/resolve` stays a bus concept.
   Section 4.4 and section 6.6.

4. **Two independent state machines, and keeping them apart is the point.**
   `duty.status` answers *what is this bus doing?*; `tracking.state` answers
   *where is it?*. A bus can be confidently on a route with a dead GPS, or
   transmitting perfectly with nobody sure what duty it runs. Collapsing them is
   the mistake that makes the consuming app lie. Section 5.

5. **Manual entry gets three things a scan does not**: a check character on the
   BIN so a single typo fails locally rather than resolving to a real different
   bus; explicit confirmation of plate and route after a typed code but not
   after a scan; and a not-found taxonomy that distinguishes "no such BIN" from
   "that BIN is not in service today". Section 6.

6. **Predictions are published, with a band, always.** `trip-updates` is served,
   and every `StopTimeEvent` carries a non-omitted `uncertainty`. Beyond a
   configurable horizon, stops are marked `NO_DATA` rather than guessed. The
   argument both ways is in section 7.3; this is the side it lands on, and the
   reason is that GTFS-Realtime has a field for exactly this and refusing to
   publish would push the arithmetic into the consuming app where it would be
   done without a band.

7. **Geometry is real and bundled.** Bus shapes and stop sequences come from the
   community BMTC GTFS feed; metro line order and station coordinates come from
   OpenStreetMap route relations, because the vendor metro file's station order
   is not trustworthy. A five-route bus subset plus three metro lines is
   committed to the repository so a stranger can `docker compose up` with no
   download at all. Section 9.

8. **Nothing hardcodes a port, a hostname or `localhost`** anywhere except one
   file, `src/config.ts`, which reads every one of them from the environment and
   names a local default. Deploying is a matter of changing environment
   variables. Section 10.

9. **The full scope does not fit before 27 August.** Six and a quarter
   engineering days of work, seven calendar days left, and this is the third of
   three parallel efforts. Section 16 names the smallest shippable increment and
   the order to cut in. It is 2.5 days, it is bus-only, and it still delivers the
   seam the ticketing service needs.

**What is deliberately skipped, and why:** map matching. A real AVL server takes
a raw GPS fix that may be forty metres off the carriageway and snaps it to a
route polyline, and that is a hard, interesting problem. It is skipped here
because a simulated bus is on the polyline by construction: the position is
generated *from* the shape, so there is nothing to match. Section 2.3 lists the
rest.

---

## 1. What this is, and the gap it fills

A transit app that says "your bus is 4 minutes away" is making a claim, and the
claim rests on a stack that most app developers never see:

> a device bolted to the bus, a cellular link, an ingest server, a map matcher,
> a trip inference step, a prediction engine, and a published feed.

Without access to an operator's live feed, an app developer building against
that stack has three options. Hardcode a fixture and demonstrate nothing. Point
at a public feed from a city on the other side of the world and get geometry
that does not match the app's own map. Or write the layer themselves.

This is the third, done properly: a service that behaves like the real layer,
including the parts of it that are unreliable, so that an app built against it
is an app that will survive contact with a real operator feed.

### 1.1 It is a sibling project, and the boundary is one endpoint

There is a companion repository, `ondc-transit-bpp`, which is a real ONDC TRV11
provider platform: a service that sells transit tickets over India's open
commerce network. That project and this one **compose without either importing
the other**.

- **This service owns the fleet registry.** BIN, number plate, plate history,
  today's duty, live position. It is the only thing that knows any of it.
- **The ticketing service is a consumer and stores no fleet facts.** It may
  copy a plate and a route number onto a ticket as provenance, frozen at the
  moment of issue, and it must never treat that copy as current.
- **The one interface is `GET /fleet/resolve`.** Section 6.

There is no shared library, no shared database and no build-time dependency in
either direction. If this service is down, the ticketing service must still sell
tickets; it simply sells them without a vehicle bound to them.

### 1.2 The honesty contract

This governs the entire service and every byte it emits.

- **No vehicle in this system exists.** Every BIN, every plate, every position
  is fabricated. No real BMTC bus, no real Namma Metro train, and no real device
  is contacted, read, impersonated or inferred from.
- **The plates are synthetic and must stay that way.** Section 4.3 pins the
  registration series used for fixtures to a range that BMTC does not use, so
  that no fixture plate can collide with a real vehicle on a real road.
- **The geometry is real; the movement is not.** Routes, stops, shapes, station
  order and coordinates come from published open data. Every position on them is
  generated.
- **The uncertainty is the product, not a defect.** A simulator that controls
  reality could state arrival times perfectly, and that would be worthless. The
  staleness, the dropouts, the missing devices and the growing prediction band
  are the features this service exists to provide.
- **Any consuming application must say all of this in its own interface**, not
  only here. A ticket carrying a plate copied from this service must be able to
  say where it got it and when.

---

## 2. Background: the layer being mocked

An engineer who has never worked with vehicle tracking needs this section to
understand which of the following decisions are arbitrary and which are copying
something real. Every external claim carries a citation.

### 2.1 A real bus AVL stack, stage by stage

**AVL** is Automatic Vehicle Location: the general term for the operator-side
system that knows where its vehicles are. A typical Indian intracity bus AVL
stack has six stages.

| Stage | What happens | In this simulator |
|---|---|---|
| **1. Fix** | A device on the bus reads a GNSS position. In India this device is governed by **AIS-140**, an Automotive Industry Standard published by ARAI titled *Intelligent Transportation Systems (ITS) - Requirements for Public Transport Vehicle Operation*.[^ais140-wiki] It specifies a **VLTD** (Vehicle Location Tracking Device) combining GPS, India's IRNSS/NavIC constellation, and a GSM/GPRS modem.[^ais140-wiki] MoRTH made it a condition of registration for new public service vehicles.[^ais140-morth] | Generated from the route polyline, plus configurable positional noise. |
| **2. Transmit** | The device pushes a packet to a backend over the cellular network at a fixed interval, with immediate transmission on emergency events. Secondary sources consistently report a 30-second interval while moving and a longer one while stationary.[^ais140-freq] `UNRESOLVED:` the clause number and exact figures in the standard itself. The ARAI document is paywalled and the state protocol document that would settle it is a scanned PDF.[^ais140-odisha] | `BUS_FIX_INTERVAL_SECONDS`, default 20, with jitter. Section 8.5. |
| **3. Ingest and decode** | A server terminates thousands of long-lived TCP sessions and decodes a binary packet format into a row. This is where real operators spend their reliability budget. | Skipped. There is no wire protocol; the engine writes positions into memory. |
| **4. Map match** | The raw fix is snapped onto a route polyline. A fix can be tens of metres off the carriageway in an urban canyon, and matching it to the right one of two parallel roads is genuinely hard. | **Skipped deliberately.** A simulated bus is on the polyline by construction. Section 2.3. |
| **5. Trip inference** | Given a matched position and a duty roster, decide *which scheduled trip* this vehicle is running. This is the least reliable stage in real operations, because buses get swapped, run late enough to be ambiguous, and are reassigned mid-day. | Modelled explicitly, and it is the reason `duty.status` exists. Section 5.1 and section 8.7. |
| **6. Predict and publish** | Arrival times are estimated and published, almost always as **GTFS-Realtime**. | Sections 7.2 and 7.3. |

### 2.2 GTFS and GTFS-Realtime, in one page

**GTFS** (General Transit Feed Specification) is the static half: a zip of CSV
files describing an operator's routes, stops, trips, timetable and route
geometry. The files this project uses are `routes.txt`, `trips.txt`,
`stops.txt`, `stop_times.txt` and `shapes.txt`.

**GTFS-Realtime** is the live half: a **Protocol Buffers** binary feed served
over plain HTTP, which a consumer fetches on a poll. The canonical `.proto` is
published by Google in the `google/transit` repository under the protobuf
package `transit_realtime`, and the current `gtfs_realtime_version` string is
`"2.0"`.[^gtfsrt-proto]

A feed is a single `FeedMessage`:[^gtfsrt-ref]

```
FeedMessage
  header : FeedHeader          (required)
    gtfs_realtime_version : string   (required)  "2.0"
    incrementality        : enum     (required)  FULL_DATASET | DIFFERENTIAL
    timestamp             : uint64   (required)  POSIX seconds
  entity : FeedEntity[]        (repeated)
    id           : string      (required)
    vehicle      : VehiclePosition
    trip_update  : TripUpdate
    alert        : Alert
```

`DIFFERENTIAL` is documented as "currently unsupported"; every feed this service
publishes is `FULL_DATASET`.[^gtfsrt-ref]

The three field groups that carry the whole design of this project:

**`VehiclePosition`** - where a vehicle is.[^gtfsrt-ref] `position` is a
`Position` with required `latitude` and `longitude` and optional `bearing`,
`odometer` and `speed`. `current_status` is a `VehicleStopStatus`, one of
`INCOMING_AT`, `STOPPED_AT`, `IN_TRANSIT_TO`. `timestamp` is defined as the
"Moment at which the vehicle's position was measured. In POSIX time".[^gtfsrt-ref]
**That definition is the entire staleness story**: the timestamp is when the fix
was *taken*, not when the feed was *built*, and the difference between it and
`header.timestamp` is how old the data is. Section 7.2.

**`VehicleDescriptor`** - who the vehicle is.[^gtfsrt-ref] Three fields, and
they map exactly onto this project's three identifiers:

| GTFS-RT field | Spec's own words | This project |
|---|---|---|
| `id` | "internal system of identification for the vehicle. Should be unique to the vehicle" | The **BIN**. This is what a BIN *is*. |
| `label` | "a user visible label - for example the name of a train" | Not used for buses; the metro line + destination for trains. |
| `license_plate` | "the actual license plate of the vehicle" | The **plate**, in its normalised form, as of now. |

That the specification already separates an internal stable id from a
user-visible label from a plate is not a coincidence this project discovered; it
is the shape of the problem, and it is worth knowing that the standard agrees.

**`StopTimeEvent.uncertainty`** - how sure the prediction is.[^gtfsrt-ref] The
specification is explicit: "The uncertainty roughly specifies the expected error
in true delay as an integer in seconds", and gives a worked example - a bus
predicted 15 minutes late "within a 4 minute window of error (+2/-2 minutes)
will have an Uncertainty value of 240".[^gtfsrt-tripupdates] Crucially: "If
uncertainty is omitted, it is interpreted as unknown. To specify a completely
certain prediction, set its uncertainty to 0."[^gtfsrt-ref]

**This field is the reason section 7.3 decides to publish predictions.** The
honest thing a simulator can say about an arrival time already has a home in the
standard.

One more normative figure, from GTFS-Realtime best practices: a feed should be
refreshed **at least once every 30 seconds**, and the data inside it should not
be older than **90 seconds** for Trip Updates and Vehicle Positions.[^gtfsrt-bp]
Those two numbers set the defaults for `FEED_TTL_SECONDS` and
`BUS_STALE_AFTER_SECONDS` in section 10.

### 2.3 The metro case: position is known, not inferred

Everything above describes a bus. A metro train is a different problem, and
pretending otherwise would throw away the most useful contrast this service has.

A metro is a **closed, signalled, gated** system:

- **The signalling system already knows where every train is.** Namma Metro's
  Purple and Green lines run Alstom's Urbalis 200 automatic train control; the
  Yellow Line, opened 11 August 2025, runs **CBTC** - communications-based train
  control - and operates driverless.[^nammametro][^yellowline] A CBTC system
  tracks train position continuously as a condition of being allowed to move
  trains at all. There is no GPS, no urban canyon, and **no map matching even in
  the real world**: a train's position is close to ground truth.
- **A train cannot leave its line.** Where a bus can be diverted, stuck, or
  running an entirely different route from the one the roster says, a train's
  possible positions are a one-dimensional interval.
- **A train does not get reassigned mid-run.** Bus duty swaps are routine
  operations. A metro train completes its trip.
- **Boarding is gated.** Nobody scans a QR code on the side of a train. A rider
  taps in at a gate and taps out at another. There is no moment in the journey
  at which a rider identifies a *vehicle*.

The consequences run through the whole design, and they are the reason metro is
specified as a distinct vehicle class rather than a second fleet:

| | Bus | Metro |
|---|---|---|
| Position source | GNSS fix from an AIS-140 device | Signalling / block occupancy |
| Positional error | Metres, configurable noise | Effectively zero along the line |
| Map matching needed in reality | Yes, and it is hard | No |
| Coverage in a real fleet | Partial. Devices fail, get switched off, are never fitted | Complete. A train with no position does not move |
| Dark periods | Routine. Tunnels, dead SIMs, unpaid data | Rare, and an incident when they happen |
| `duty.status` in practice | The full range, `inferred` most of the time | `confirmed`, almost always |
| Rider-verifiable identity | Number plate, painted on the bus | Line, direction, destination, platform |
| Ticketing seam | Scan or type a code on *this bus* | Tap in at a gate; the ticket is a journey, not a vehicle |

**The demo value is the contrast.** A journey that involves a bus leg and a
metro leg should visibly behave differently in the consuming app: the metro leg
confident and specific, the bus leg hedged or falling back to the timetable and
saying so. Coverage is configurable per mode (section 10) precisely so that a
single demo can show a well-instrumented mode and a badly instrumented one in
the same journey.

### 2.4 What this simulator skips, and why

| Skipped | Why |
|---|---|
| **Map matching** | A simulated bus is generated *from* the polyline. There is no fix to snap. This is the single largest piece of real AVL work not represented here, and section 13 says so in the fidelity table rather than hiding it. |
| **The device wire protocol** | AIS-140 packet framing, TCP session management, store-and-forward replay of buffered fixes. The observable consequence of buffering - a burst of backdated fixes after a dropout - *is* modelled (section 8.5); the bytes are not. |
| **NVLT / regulatory backhaul** | AIS-140 devices transmit to a government backend as well as the operator's. Nothing here talks to any government system, and nothing should. |
| **Occupancy** | GTFS-RT has `occupancy_status` and this service does not populate it. Nothing in the consuming app uses it, and inventing crowding data would be inventing a claim the app would then display. |
| **Service alerts** | The `Alert` entity is not produced. Out of scope. |
| **Real depot operations** | Refuelling, breakdowns, driver shift changes as first-class events. `duty.status: out_of_service` is the one visible consequence, and it is generated by rate, not simulated in detail. |
| **Fares, ticketing, payment** | Wholly the sibling project's job. This service knows nothing about money. |

---

## 3. Scope

### 3.1 In

- **A fleet registry**: BIN, plate, plate validity history, today's duty, for
  both vehicle classes.
- **A simulation engine** that walks vehicles along real route geometry at
  plausible speeds, on plausible headways, and models the ways real tracking
  fails.
- **One resolve endpoint**, `GET /fleet/resolve`, taking a BIN or a plate. This
  is the entire interface to the ticketing service.
- **One metro arrivals endpoint**, `GET /fleet/metro/arrivals`, because a rider
  on a platform has a different question from a rider at a bus stop.
- **One single-vehicle position endpoint**, `GET /fleet/vehicle/{bin}/position`,
  JSON, so an app tracking one bus after a purchase does not parse a fleet-wide
  protobuf every ten seconds.
- **Two GTFS-Realtime feeds**, `vehicle-positions` and `trip-updates`, in
  protobuf, covering both vehicle classes.
- **Configurable unreliability**: fix staleness, dropouts, partial device
  coverage, prediction bands that widen with distance, and roster uncertainty.
  Every one of them an environment variable, so a demo can show each in turn.
- **A scenario control surface** so a demo can force a specific bus dark, or
  force a duty to `unknown`, on cue rather than by waiting.
- **Docker**: one service image, one Compose file, runnable standalone with no
  external service and no download.

### 3.2 Out, explicitly

| Out | Why |
|---|---|
| Persistence of any kind | The world is a pure function of a seed and the clock (section 8.8). There is no database, no volume, and no state to migrate. A restart reproduces the same fleet. |
| Authentication on the read surface | Every endpoint in section 6 and 7 is public and read-only. The scenario control surface in 7.4 is the exception and is gated on a token. |
| Ingesting a real feed | This service produces feeds. It does not consume one. A future `GTFS_RT_UPSTREAM` mode is named in section 18 and is not built. |
| The AIS-140 wire protocol | Section 2.4. |
| Occupancy, alerts, fares, payment | Section 2.4. |
| Historical playback | No "replay yesterday" mode. `SIM_CLOCK` can freeze the world at an instant for a reproducible demo (section 10), which covers the need without a store. |
| Cities other than Bengaluru | The geometry loader is not city-specific, but nothing else is generalised and no second city is bundled. |
| Writing to the ticketing service | Strictly one direction. This service never calls out. |

### 3.3 Two vehicle classes, one design

The engine has one notion of a vehicle and one notion of a trip. What differs
between a bus and a train is a **profile**: a set of parameters and two
behavioural overrides.

```
Vehicle
  bin          : Bin              stable, never changes
  class        : "bus" | "metro"
  plate        : Plate | null     null for metro, and the null is meaningful
  profile      : VehicleProfile   speed, dwell, device, duty behaviour
  duty         : Duty             what it is doing        (state machine A)
  tracking     : Tracking         where it is             (state machine B)
```

The two overrides:

1. **Position generation.** `bus` adds Gaussian positional noise and emits on a
   jittered device interval; `metro` emits on a fixed short interval with
   negligible cross-track error, because a signalling system is reporting block
   occupancy rather than a satellite fix. Section 8.6.
2. **Duty assignment.** `bus` draws `duty.status` from a configurable
   distribution across all four states and can swap duty mid-day; `metro` is
   `confirmed` unless explicitly forced otherwise. Section 8.7.

Everything else - the cursor walking a polyline, the two state machines, the
GTFS-RT projection, the position endpoint, determinism - is shared code with
different numbers in it. **If a reviewer finds a `if (class === 'metro')` branch
outside `src/sim/profile.ts`, `src/sim/device.ts` and `src/sim/duty.ts`, that is
a design smell and should be pushed into the profile.**

---

## 4. Identity

### 4.1 Three identifiers for a bus, three jobs

| | Example | Who uses it | Changes? |
|---|---|---|---|
| **Number plate** | `KA-01-F-1234` | The rider. Painted on the bus, front and rear. | Yes. Re-registration, replacement vehicles, transfers between depots. |
| **BIN** (Bus Identification Number) | `BLR-04127` | The system. Never shown to a rider. | **Never.** This is the whole point of it. |
| **Route number** | `500-D` | The rider. On the destination board. | Per duty. The same bus runs different route numbers on different days. |

These are three different questions wearing similar clothes, and conflating any
two of them produces a specific bug:

- **Plate as the key** breaks the moment a bus is re-registered, because
  yesterday's ticket now points at a plate that is on a different vehicle, or on
  none.
- **Route number as the key** is not an identifier at all. Twenty buses run
  `500-D` at once.
- **BIN shown to the rider** asks them to verify something they cannot see. It
  is not painted on the bus.

### 4.2 The BIN, and the check character

**Format.** `^[A-Z]{3}-[0-9]{5}$`, canonical form with the hyphen.

```
BLR - 0412 7
 |     |   |
 |     |   check digit
 |     four-digit serial, allocated sequentially within the hub
 three-letter hub code, from a closed set
```

**Normalised form** for lookup and comparison: uppercase, all non-alphanumerics
removed. `BLR-04127` and `blr04127` both normalise to `BLR04127`. The canonical
hyphenated form is what the service emits; the normalised form is what it
accepts.

**Hub codes** are a closed set held in the registry, three letters, never
containing `I` or `O` (section 4.3 explains why those two letters are avoided).
The bundled fixture set uses `BLR` for buses and `MTR` for metro trains.

**The check digit is the Luhn algorithm** over the four serial digits, appended
as the fifth digit. Luhn is specified in ISO/IEC 7812-1 Annex B and is the
algorithm behind payment card numbers.[^luhn] The reference implementation is
four lines and needs no dependency.

Worked example, and it is worth doing by hand once:

```
serial               0  4  1  2
double alternate,
from the right       0  8  1  4      (4 -> 8, 2 -> 4; digits over 9 subtract 9)
sum                  0 + 8 + 1 + 4 = 13
check digit          (10 - 13 mod 10) mod 10 = 7

BIN = BLR-04127
```

**What this buys, precisely.** Luhn detects **every single-digit substitution**
and **every adjacent transposition except `09` <-> `90`**.[^luhn] A rider who
mistypes one digit of a BIN gets a local validation failure, instantly, without
a network round trip and without the risk of silently resolving to a real
different bus. That is the requirement.

**What it does not buy, stated plainly.** The `09` <-> `90` gap is real. `0904`
and `9004` both carry check digit `3`, so a rider transposing those two digits
would pass validation and resolve to the wrong vehicle. Two responses, and this
document takes the first:

1. **Accept the gap and cover it downstream.** The typed-entry flow already
   requires explicit confirmation of the plate and route before the code is used
   (section 6.4). A rider who transposed `09` into `90` is shown a plate that is
   not the one on the bus in front of them, and stops. The check character is a
   first filter, not the only one.
2. **Use the Damm algorithm instead**, which detects all single-digit errors
   *and* all adjacent transpositions with no exceptions.[^damm] This is
   strictly stronger. It is not chosen because the check digit for serial `0412`
   under Damm is `6`, not `7`, which would make `BLR-04127` - the identifier
   used throughout this document, in the sibling project, and in every worked
   example - invalid. **If the fixture BINs are ever regenerated, switch to
   Damm at the same time.** The interface is one function,
   `src/fleet/checkChar.ts`, and nothing else changes.

**Validation is local.** A consuming app must be able to reject a malformed BIN
without calling this service, so the algorithm is documented here in full and
must be reimplementable from this section alone.

### 4.3 Plates, and why the mapping is temporal

**Real format.** Under Rule 50 of the Central Motor Vehicles Rules 1989, an
Indian registration is a two-letter state code, a one-or-two-digit RTO district
number, a one-to-three-letter series, and a four-digit serial from 1 to
9999.[^plate-format] The letters `I` and `O` are not used in the series, to
avoid confusion with `1` and `0`.[^plate-format] `KA` is Karnataka; `KA-01` is a
Bengaluru RTO.

**Accepted pattern**, after normalisation (uppercase, strip non-alphanumerics):

```
^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$      standard series
^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$              Bharat (BH) series
```

The BH series is included because it exists and a defensive parser should not
reject a valid plate; **no fixture vehicle uses it**, and a BH plate always
resolves to `not_found`.

**Canonical display form** inserts hyphens at the group boundaries:
`KA01F1234` renders as `KA-01-F-1234`. The service stores normalised and emits
both; the `plate.display` field is what a UI shows.

**The mapping is temporal.** A plate belongs to a BIN *for a period*. The
registry holds a history, not a value:

```jsonc
{
  "bin": "BLR-04127",
  "plates": [
    { "normalised": "KA01FA9902", "display": "KA-01-FA-9902",
      "since": "2023-06-01", "until": "2026-02-14",
      "reason": "original_registration" },
    { "normalised": "KA01F1234",  "display": "KA-01-F-1234",
      "since": "2026-02-14", "until": null,
      "reason": "re_registration" }
  ]
}
```

Rules, and they are load-bearing:

- **Exactly one plate has `until: null`** per BIN. That is the current plate.
- **Periods do not overlap** for one BIN, and **no normalised plate may be
  current for two BINs at once**. Both are startup assertions (section 14).
- `/fleet/resolve` returns **only the current plate**, with its `since`. It does
  not return the history, because no consumer has a use for it and shipping it
  invites a consumer to key off an old one.
- **A plate lookup matches only the current period.** Resolving a
  previously-valid plate returns `not_found` with reason
  `plate_no_longer_current`, and names the date it stopped being current.
  Section 6.5. A ticket issued in January carrying `KA-01-FA-9902` is not wrong;
  it is a record of what was true then, and the honest answer to looking it up
  today is "that plate was retired on 14 February 2026", not "no such bus".

**Fixture plates must not collide with real vehicles.** Every generated fixture
plate uses the series letters `ZZ` (`KA-01-ZZ-nnnn`, `KA-41-ZZ-nnnn`, ...), a
series BMTC does not run. The worked examples in this document use realistic
series for legibility; **the generator does not**, and section 14 asserts it.
This is the honesty contract in section 1.2 made mechanical.

`UNRESOLVED:` whether BMTC operates a public internal fleet-numbering scheme
that the BIN could be modelled on. BMTC buses carry a visible fleet number in
practice, but no published specification of its format was found. Settling it
would let the fixture BINs resemble the real thing more closely; it changes
nothing structural, because the BIN's contract is "stable, opaque, checkable",
and that holds whatever the digits look like.

### 4.4 Metro: the trip is the identity, not the vehicle

**A metro train does not get a rider-facing identifier, because there is nothing
for the rider to check.** BMRCL publishes no passenger-facing train or rake
number, and nothing on a platform display shows one; the platform information
display shows the **destination and the time to arrival**. `UNRESOLVED:` whether
BMRCL exposes a rake identifier anywhere passenger-visible. The research found
none, and the design does not depend on the answer, because even if a small
number is stencilled on a cab end, no rider standing at the platform edge is
going to read it and match it against a screen.

What a rider **can** verify with their eyes, on a Namma Metro platform:

| Fact | Where they verify it |
|---|---|
| **Line** | Colour-coded signage throughout the station; the line colour on the train |
| **Direction / destination** | The headboard on the train and the platform information display |
| **Platform** | Numbered, signed |
| **Station** | They are standing in it |

So the UI rule (section 4.5) applied to metro yields: **line, direction,
destination, platform, and a time.** Not a vehicle.

**Do metro vehicles get a BIN at all? Yes, and it is pure plumbing.** Three
reasons it is worth having rather than special-casing metro out of the vehicle
model:

1. GTFS-Realtime's `VehicleDescriptor.id` needs a stable per-vehicle identifier,
   and inventing a second concept for one feed field is worse than reusing the
   one that exists.
2. `GET /fleet/vehicle/{bin}/position` then works uniformly for both classes,
   which matters for an operations view and for tests.
3. The simulation engine is shared. A train is a cursor on a polyline with a
   different profile; giving it a different identity type would fork the engine.

Metro BINs use the hub code `MTR` (`MTR-00187`), the same format and the same
check digit. **They are never resolvable through `/fleet/resolve`**, and the
endpoint says so explicitly rather than returning `not_found`:

```
GET /fleet/resolve?code=MTR-00187
-> 422 { "error": "not_a_resolvable_code", "class": "metro", ... }
```

with a body that names `/fleet/metro/arrivals` as the endpoint for this
question. Section 6.5. Returning `404 not_found` there would be a lie: the
vehicle exists, and the request is the wrong question about it.

**`plate` is `null` for a metro vehicle, and the null is a statement**, not a
missing value. The response carries `plateAbsentReason: "metro_no_plate"` so a
consumer never has to guess whether the plate is unknown or does not exist.

### 4.5 The UI rule

> **Show the rider what they can verify with their eyes.**

For a bus, that is the **plate** and the **route number**. Both are painted on
the vehicle, and a rider standing next to it can confirm both in a second.

For a train, it is the **line**, the **direction**, the **destination** and the
**platform**.

**The BIN never appears in an interface.** It is plumbing. Its one visible role
is **provenance on a ticket**: a ticket may record the BIN alongside the plate
and route it was issued against, so that "which vehicle was this ticket for" has
a stable answer six months later when the plate has changed. A ticket rendering
may show it in small type in a provenance block; it must never be presented as
something to check.

**The corollary, for the consuming app:** a screen that says "bus `BLR-04127` is
4 minutes away" has failed the rule twice. The rider cannot verify `BLR-04127`,
and section 7.3 has something to say about the 4.

---

## 5. Two state machines

`duty` and `tracking` are independent. Every combination of the two is
reachable, several are common, and **keeping them separate is the single most
important structural decision in this document**, because collapsing them is
what makes a consuming app state things it cannot support.

### 5.1 `duty.status` - what is this bus doing?

| State | Meaning | How the simulator produces it |
|---|---|---|
| `confirmed` | The operator's roster says this vehicle is on this trip, and the vehicle's position is consistent with it. A depot dispatch record or a driver sign-on backs it. | Assigned at dispatch and not disturbed. |
| `inferred` | Nobody signed anything. The system matched the vehicle to a trip from its position and timing, and it is probably right. **This is the normal state in real operations, not a degraded one.** | Assigned at dispatch, then the roster record is withheld; `confidence` is populated. |
| `unknown` | The vehicle is moving and the system cannot say which trip it is running. Two candidate trips fit equally well, or it is off-pattern. | Duty withheld entirely; `alternatives[]` may carry the candidates. |
| `out_of_service` | The vehicle is not carrying passengers. Deadheading to a depot, on a break, withdrawn. | Assigned by rate, and by an explicit scenario override. |

**`confidence`** is a number in `[0, 1]`, present when `status` is `inferred`,
absent otherwise. It is **not** a probability derived from anything; it is
generated, and section 13 says so. Its purpose is to let a consuming app build
and demonstrate a UI that degrades with confidence.

Transitions the simulator produces:

```
                 dispatch
   out_of_service ─────────► confirmed ──────► inferred ──────► unknown
        ▲                        │                 │                │
        │                        │  roster lost    │  ambiguous     │
        │                        ▼                 ▼                │
        └────────────── end of duty ◄──────────────┴────────────────┘
                                     re-identified
```

A **mid-day swap** (`DUTY_SWAP_RATE_PER_DAY`) is the interesting one: the
vehicle keeps running, the roster record is invalidated, and the duty drops from
`confirmed` to `inferred` or `unknown` **without the tracking state changing at
all**. That is the whole reason the two machines are separate, and it is the
scenario the demo should show.

### 5.2 `tracking.state` - where is it?

| State | Meaning | Trigger |
|---|---|---|
| `live` | A fix arrived recently enough to trust. | `fixAgeSeconds <= *_STALE_AFTER_SECONDS` |
| `stale` | The last fix is old enough to be worth flagging but recent enough to show. The vehicle has moved since, and the position is behind. | `STALE_AFTER < fixAgeSeconds <= DARK_AFTER` |
| `dark` | The device has stopped reporting. **The last known position is still returned**, with its age, because "it was here four minutes ago" is useful and "we have no idea" is not. | `fixAgeSeconds > *_DARK_AFTER_SECONDS` |
| `untracked` | **There is no device on this vehicle at all.** `position` is `null`. This is not a failure; a real fleet is never fully instrumented. | Fixed at fleet generation from `*_COVERAGE_SHARE` |

`stale` and `dark` are the same underlying condition at different ages, and
`STALE_AFTER_SECONDS` defaults to **90** to match the GTFS-Realtime best-practice
ceiling on data age.[^gtfsrt-bp]

**`untracked` is the state the consuming app most needs and is most likely to
forget.** A bus with no device is not late, not missing and not broken. It is
running, on the timetable, and the app's only honest move is to fall back to the
scheduled departure and say that is what it is doing. `*_COVERAGE_SHARE` exists
so that this path can be demonstrated on demand rather than hoped for.

```
   untracked          (terminal: no device was ever fitted)

   live ──────► stale ──────► dark
     ▲            │             │
     └────────────┴─────────────┘
              fix arrives
```

A fix arriving after a dark period returns the vehicle to `live` directly.
Section 8.5 specifies the burst of backdated fixes that a real store-and-forward
device produces on reconnection, and what the feed does with them.

### 5.3 The sixteen cells, and the four that matter

Every combination is reachable. Four of them are the reason the machines are
separate, and a consuming app that handles these four correctly handles the
rest.

| | `live` | `stale` | `dark` | `untracked` |
|---|---|---|---|---|
| **`confirmed`** | The easy case. Show the bus, show the route, show a position. | Show the position, age it. | **A.** | **B.** |
| **`inferred`** | The common case. Everything works, and the route is a good guess rather than a fact. | | | |
| **`unknown`** | **C.** | | | **D.** |
| **`out_of_service`** | Do not show it to a rider at all. | | | |

- **A. `confirmed` + `dark`.** *We know exactly what this bus is doing and we
  have lost sight of it.* The honest app shows the route, the last known
  position with its age, and the scheduled arrival - and marks the position
  stale. It must not extrapolate. This is a tunnel, or a dead SIM.
- **B. `confirmed` + `untracked`.** *We know exactly what this bus is doing and
  it has no device.* The app falls back entirely to the timetable and **says
  so**. No map dot. This is the case that partial coverage exists to force.
- **C. `unknown` + `live`.** *We can see it perfectly and we do not know what it
  is.* A dot on a map with no route. Useful to an operations view, close to
  useless to a rider, and an app that renders it as "your bus" is lying.
- **D. `unknown` + `untracked`.** *We have a registry row and nothing else.* The
  resolve endpoint still answers, because the BIN is real and the plate is real,
  and both of those are facts. Everything else is `null`.

**The collapse to avoid.** A single `status` field with values like
`on_route | delayed | missing` cannot express A or B. `confirmed + dark` and
`unknown + live` would both have to become "missing", and the app would tell a
rider standing at a stop that a bus which is definitely coming is missing. That
is the bug this design exists to prevent, and it is worth restating in the
consuming app's own code review checklist.

### 5.4 Per-mode defaults, and the contrast

The same two machines, with different distributions per vehicle class. These are
defaults; every one is an environment variable (section 10).

| | Bus | Metro | Why |
|---|---|---|---|
| `duty: confirmed` | 60% | 99% | A train is not reassigned mid-run. |
| `duty: inferred` | 25% | 1% | |
| `duty: unknown` | 10% | 0% | |
| `duty: out_of_service` | 5% | 0% | Metro out-of-service stock is in a depot, not on the line. |
| coverage (not `untracked`) | 75% | 100% | A train with no position does not get a movement authority. |
| dropouts per vehicle-hour | 1.5 | 0.05 | |
| `STALE_AFTER_SECONDS` | 90 | 30 | |
| fix interval | 20 s (jittered) | 5 s | |

**A demo that plans one journey across both modes shows a confident metro leg
and a hedged bus leg, from the same service, at the same moment.** That is the
single most useful thing this project produces for the consuming app, and
section 15 builds the demo around it.

---

## 6. The interface between the projects

### 6.1 `GET /fleet/resolve`

**One endpoint for both entry paths.** A rider either scans a QR code stuck on
the bus, which encodes a URL ending `?code=<BIN>`, or types a code by hand. Both
land here.

```
GET /fleet/resolve?code=BLR-04127          # BIN, from a scan or typed
GET /fleet/resolve?code=KA01F1234          # plate, typed
GET /fleet/resolve?code=KA-01-F-1234       # plate, typed with separators
```

| Parameter | Required | Values | Meaning |
|---|---|---|---|
| `code` | yes | 1-32 chars | A BIN or a plate, in any casing, with or without separators. |
| `entry` | no | `scan` \| `manual` (default `manual`) | How the rider supplied the code. Drives `confirmation` in the response. Section 6.4. |
| `at` | no | RFC 3339 instant | Resolve as of this moment instead of now. For tests and for a frozen demo. Rejected with `400` unless `SIM_ALLOW_TIME_TRAVEL=true`. |

**`entry` defaults to `manual`, deliberately.** A caller that forgets to set it
gets the *stricter* behaviour, which is a confirmation step it did not ask for,
rather than the weaker behaviour of skipping a check the rider needed.

**Why one endpoint and not two.** A rider does not know or care which kind of
code they are holding, and the QR path and the typed path converge on the same
question: *which bus is this, and what is it doing?* Two endpoints would push
format detection into every caller and would double the surface that has to stay
consistent. The formats are disjoint by construction (section 6.3), so the
disambiguation is free.

### 6.2 The response, in full

`200 OK`, `Content-Type: application/json`, `Cache-Control: no-store`.

```jsonc
{
  "bin": "BLR-04127",
  "matchedOn": "bin",                      // "bin" | "plate"

  "vehicle": {
    "class": "bus",                        // "bus" | "metro"
    "plate": {
      "display": "KA-01-F-1234",           // what a UI shows
      "normalised": "KA01F1234",           // what a caller compares
      "since": "2026-02-14"                // ISO date this plate became current
    },
    "plateAbsentReason": null,             // "metro_no_plate" when plate is null
    "hub": { "code": "BLR", "name": "Bengaluru Central" }
  },

  "duty": {
    "status": "confirmed",                 // confirmed|inferred|unknown|out_of_service
    "confidence": null,                    // number 0..1 iff status == "inferred"
    "route": {
      "id": "1066",                        // GTFS route_id
      "number": "500-D",                   // GTFS route_short_name. The rider-facing one.
      "name": "Central Silk Board to Hebbala Bridge",
      "nameLocal": null                    // Kannada, when the source carries it
    },
    "headsign": "Hebbala Bridge",
    "directionId": 0,                      // GTFS direction_id
    "trip": {
      "id": "1042",                        // GTFS trip_id
      "startTime": "09:15:00",             // GTFS noon-relative time, may exceed 24h
      "startDate": "20260820",             // GTFS YYYYMMDD, service date not calendar date
      "startedAt": "2026-08-20T03:45:00Z"  // RFC 3339 instant, unambiguous
    },
    "since": "2026-08-20T03:45:00Z",       // when this duty was assigned
    "source": "roster",                    // "roster" | "position_match" | "none"
    "alternatives": [],                    // candidate duties when status == "unknown"
    "reason": null                         // set when status is unknown|out_of_service
  },

  "tracking": {
    "state": "live",                       // live|stale|dark|untracked
    "fixAgeSeconds": 14,                   // age of `observedAt` at response time
    "observedAt": "2026-08-20T09:41:12Z",  // when the fix was TAKEN, not served
    "servedAt":   "2026-08-20T09:41:26Z",  // when this response was built
    "position": {
      "lat": 12.97843,
      "lon": 77.64081,
      "bearing": 118.4,                    // degrees clockwise from true north
      "speedKph": 21.6,
      "accuracyMetres": 12
    },
    "progress": {
      "nextStop": {
        "id": "20985",
        "name": "Domlur",
        "nameLocal": "ದೊಮ್ಮಲೂರು",
        "sequence": 14                     // GTFS stop_sequence within the trip
      },
      "currentStatus": "IN_TRANSIT_TO",    // GTFS-RT VehicleStopStatus
      "distanceAlongRouteMetres": 8241.5,
      "routeLengthMetres": 21903.0
    },
    "source": "simulated_gnss",            // "simulated_gnss" | "simulated_signalling"
    "reason": null                         // why not live; see below
  },

  "confirmation": {
    "required": true,
    "prompt": "Check the bus in front of you.",
    "verify": [
      { "label": "Number plate", "value": "KA-01-F-1234" },
      { "label": "Route",        "value": "500-D" }
    ]
  },

  "meta": {
    "simulated": true,                     // ALWAYS true. Never omitted.
    "seed": 1,
    "generatedAt": "2026-08-20T09:41:26Z"
  }
}
```

**Field rules a builder must not get wrong:**

- **`meta.simulated` is always present and always `true`.** It is not
  configurable. Any consumer can assert it and refuse to bill a rider against
  it.
- **`bin` is always the canonical hyphenated form**, whatever was passed in.
- **`matchedOn` tells the caller which path resolved.** A caller that asked with
  a plate and got `matchedOn: "bin"` has a bug on its side.
- **`plate.since` is a date, not an instant.** Registrations change on a day,
  not at a moment, and pretending to a second of precision would be fabrication.
- **`duty.trip.startDate` is a GTFS *service* date.** A trip starting at 00:30
  belongs to the previous service date, and `startTime` may exceed `24:00:00` -
  this is normal in GTFS and a consumer must not parse it as a wall clock.
  `startedAt` is provided as an unambiguous RFC 3339 instant so no consumer has
  to implement that rule.
- **`tracking.observedAt` and `tracking.servedAt` are different fields on
  purpose**, and `fixAgeSeconds` is their difference. A consumer must render age
  from `fixAgeSeconds`, never from `servedAt` alone, because its own clock may
  be wrong.
- **`tracking.position` is non-null in `live`, `stale` and `dark`**, and `null`
  only in `untracked`. In `dark` it is the last known fix, and `fixAgeSeconds`
  is how stale it is. **Never extrapolate a dark position forward**; the
  simulator does not, and neither should a consumer.
- **`duty.route` is `null`** when `duty.status` is `unknown` or
  `out_of_service`. A consumer must handle that; it is not an error.

**`tracking.reason` values**, non-null whenever `state != "live"`:

| Value | State |
|---|---|
| `fix_ageing` | `stale` |
| `no_fix_since` | `dark`, general dropout |
| `device_offline` | `dark`, modelled as an unpowered or failed device |
| `no_device_fitted` | `untracked` |

**`duty.reason` values**, non-null whenever `status` is `unknown` or
`out_of_service`:

| Value | Status |
|---|---|
| `ambiguous_trip_match` | `unknown` - two or more candidates fit |
| `off_pattern` | `unknown` - the vehicle is not on any known shape |
| `roster_swapped` | `unknown` - the roster record was invalidated mid-day |
| `deadheading` | `out_of_service` |
| `on_break` | `out_of_service` |
| `withdrawn` | `out_of_service` |

**`duty.alternatives[]`**, present and possibly non-empty only when `status` is
`unknown`, each entry `{ route: {...}, headsign, directionId, confidence }`,
sorted by `confidence` descending, capped at three. A consumer may show them as
"one of these"; it must not pick one.

### 6.3 Disambiguating a BIN from a plate

Normalise first: uppercase, strip everything that is not `[A-Z0-9]`. Then:

| Normalised matches | Interpreted as |
|---|---|
| `^[A-Z]{3}[0-9]{5}$` | BIN |
| `^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$` | plate, standard series |
| `^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$` | plate, BH series |
| anything else | `400 malformed_code` |

**These are disjoint, and the proof is structural, not empirical.** A BIN opens
with exactly three letters and then only digits. A standard plate opens with
exactly two letters, then at least one digit; even the shortest possible plate
with no series letters (`KA011234`, two letters then six digits) cannot match
the BIN pattern, which requires a third leading letter. A BH plate opens with a
digit. **This must be a test, not a comment** (section 14).

**Order of evaluation is BIN first**, because it is the tightest pattern, and
because a scan always produces a BIN and the scan path should never touch plate
parsing.

**A BIN that fails its check digit is `400`, not `404`.** The distinction is the
whole reason the check digit exists:

```
GET /fleet/resolve?code=BLR-04128
-> 400 {
     "error": "bad_check_character",
     "message": "That code did not pass its own checksum. Please retype it.",
     "code": "BLR-04128",
     "hint": "check_digit"
   }
```

The service **must not** look this up. `BLR-04128` might be a real BIN under a
different scheme, or a real vehicle if someone regenerated the fleet; either way
the rider mistyped and the correct answer is "retype it", not a lookup that
might succeed against the wrong bus. **A check-digit failure returns before any
registry access**, and section 14 asserts it.

### 6.4 A scan and a typed code are not the same event

They differ in exactly one way, and the difference is `confirmation`.

| | Scan (`entry=scan`) | Typed (`entry=manual`) |
|---|---|---|
| Check character | Validated. A scanned QR that fails is a corrupt or forged sticker, and returns `400 bad_check_character` like any other. | Validated, and this is where it earns its keep. |
| `confirmation.required` | `false` | **`true`** |
| What the app does | Proceeds | **Shows the plate and route number and waits for the rider to confirm** |

**Why the asymmetry.** A scan is a *physical act performed at the vehicle*. The
rider is standing at the bus, the QR is stuck to the bus, and the act of
scanning is itself the confirmation that this code belongs to this vehicle.
Asking them to re-confirm a plate they just walked up to is friction that
teaches them to tap through confirmations.

A typed code has no such anchor. The rider may have copied it from a screenshot,
from a friend's message, from a stop-side sign, or mistyped a digit that passed
the checksum by luck. **The check character catches a typo; it does not catch a
correct code for the wrong bus.** Only the rider's eyes can do that, and
`confirmation.verify` gives them exactly the two facts they can check from where
they stand: the plate and the route number - the two things painted on the
vehicle (section 4.5).

**The consuming app must honour this.** `confirmation.required: true` means a
blocking step before the code is used for anything. Specifically:

- The ticketing service **must not bind a ticket to a BIN** whose response
  carried `confirmation.required: true` until the rider has confirmed.
- The confirmation UI **must show `confirmation.verify` verbatim** rather than
  re-deriving labels, so that adding a third fact later does not require an app
  release.
- `confirmation.prompt` is copy, and the app may replace it; the `verify` array
  is data, and the app may not.

**When `duty.status` is `unknown`, there is no route to confirm.** The response
then carries a single-entry `verify` array with the plate only, and
`confirmation.prompt` changes to name what cannot be checked. An app must render
whatever length array it receives.

### 6.5 Not-found, told honestly

**"No such BIN" and "that BIN is not in service today" are different facts and
must not share a status code path.** A rider who typed a wrong code needs to
retype; a rider looking at a real bus that is parked in a depot needs to be told
that, not told their code is wrong.

| Situation | Status | `error` | Body carries |
|---|---|---|---|
| Malformed, matches no pattern | `400` | `malformed_code` | the submitted code |
| BIN pattern, check digit fails | `400` | `bad_check_character` | the submitted code, `hint: "check_digit"` |
| Well-formed BIN, no registry row | `404` | `unknown_bin` | the normalised BIN |
| Well-formed plate, never registered | `404` | `unknown_plate` | the normalised plate |
| Plate was current, is not now | `404` | `plate_no_longer_current` | `retiredOn`, and **nothing else** |
| **BIN is real, has no duty today** | **`200`** | - | the full response, `duty.status: "out_of_service"`, `duty.reason: "withdrawn"` |
| BIN is real, is a metro vehicle | `422` | `not_a_resolvable_code` | `class: "metro"`, `seeInstead: "/fleet/metro/arrivals"` |
| `at` supplied, time travel disabled | `400` | `time_travel_disabled` | - |

**The sixth row is the important one and it is a `200`, not a `404`.** A bus
that exists and is not running today is a successful resolution of a real
identifier. The answer to "what is this bus doing" is "nothing today", and that
is information, not an error. Returning `404` would tell the rider their code
was wrong when it was right, which is exactly the failure this section exists to
prevent.

**`plate_no_longer_current` returns the retirement date and nothing else.**
Specifically **not** the BIN, and **not** the vehicle's current plate. Resolving
a retired plate to the vehicle that used to wear it would let anyone holding an
old ticket enumerate the current fleet, and the rider standing at a bus stop
gains nothing from it. The honest and sufficient answer is:

```
GET /fleet/resolve?code=KA01FA9902
-> 404 {
     "error": "plate_no_longer_current",
     "message": "That registration was retired on 14 February 2026.",
     "retiredOn": "2026-02-14"
   }
```

**Every error body has the same three keys** - `error`, `message`, and zero or
more context keys - and `message` is human-readable English safe to show a
rider. Localisation is the consuming app's job; the machine-readable `error`
string is the contract.

### 6.6 `GET /fleet/metro/arrivals`

Metro needs its own endpoint because the rider's question is different. On a
platform, nobody asks "which train is this"; they ask **"when is the next one
towards where I am going, and which platform"**.

```
GET /fleet/metro/arrivals?station=<stopId>&towards=<terminalStopId>&limit=3
```

| Parameter | Required | Meaning |
|---|---|---|
| `station` | yes | GTFS `stop_id` of the station |
| `towards` | no | GTFS `stop_id` of a terminal. Omit for both directions. |
| `line` | no | Line id (`purple`, `green`, `yellow`). Omit for all lines serving the station. |
| `limit` | no | 1-10, default 3, per direction |

`200 OK`:

```jsonc
{
  "station": {
    "id": "MTR-PPL-018",
    "name": "Indiranagar",
    "nameLocal": "ಇಂದಿರಾನಗರ"
  },
  "arrivals": [
    {
      "line":     { "id": "purple", "name": "Purple Line",
                    "nameLocal": "ನೇರಳೆ ಮಾರ್ಗ", "colour": "#9C27B0" },
      "towards":  { "stopId": "MTR-PPL-037", "name": "Whitefield (Kadugodi)",
                    "nameLocal": "ವೈಟ್‌ಫೀಲ್ಡ್" },
      "platform": "2",
      "eta": {
        "seconds": 214,
        "uncertaintySeconds": 20,          // ALWAYS present. Never null.
        "basis": "tracked"                 // "tracked" | "scheduled"
      },
      "tracking": { "state": "live", "fixAgeSeconds": 3,
                    "source": "simulated_signalling" },
      "duty":     { "status": "confirmed", "confidence": null },
      "trip":     { "id": "MTR-PPL-U-0413", "startTime": "09:22:00",
                    "startDate": "20260820" },
      "vehicle":  { "bin": "MTR-00187", "displayToRider": false }
    }
  ],
  "meta": { "simulated": true, "seed": 1,
            "generatedAt": "2026-08-20T09:41:26Z" }
}
```

**Rules:**

- **`vehicle.displayToRider` is `false` and is never `true`.** It exists so that
  a reviewer reading the consuming app's code can see the rule being obeyed
  rather than assumed. The BIN is here for correlation with
  `/fleet/vehicle/{bin}/position` and the GTFS-RT feeds, and for nothing a rider
  sees. Section 4.5.
- **`eta.uncertaintySeconds` is always present**, on the same principle as
  section 7.3: a metro ETA is *good*, not *certain*, and a number without a band
  invites the app to render a countdown it cannot support.
- **`eta.basis: "scheduled"`** means no train was tracked for this slot and the
  figure comes from the headway model. The uncertainty is correspondingly wide.
  The consuming app must render the two differently.
- Arrivals are sorted by `eta.seconds` ascending, per direction, and a train
  already at the platform has `eta.seconds: 0` with
  `tracking.progress.currentStatus: "STOPPED_AT"` in the position endpoint.

### 6.7 What the ticketing service may and may not store

This is a boundary rule, and violating it is how two services become one.

**May store, frozen at issue, as provenance:**

| Field | Why it is safe |
|---|---|
| `bin` | Immutable by definition. This is the join key. |
| `plate.display` and `plate.since` | A record of what was painted on the bus at that moment. |
| `duty.route.number` and `duty.headsign` | A record of what the bus was running. |
| `meta.generatedAt` | **Required.** Without it the copy has no as-of date and cannot be reasoned about. |

**Must not store, or store and then trust:**

| Field | Why |
|---|---|
| `tracking.*` | Live data. A cached position is a wrong position within a minute. |
| `duty.status`, `duty.confidence` | Change during the trip. |
| Anything as *current* | Every stored field is a historical record. A ticket that says "Bus KA-01-F-1234" is saying "the bus this was issued against was, on 20 August 2026, wearing that plate". |

**The rule in one line:** *the ticketing service stores what was true when the
ticket was issued, and calls this service for what is true now.*

A ticket rendering should be able to say, in small type, "vehicle details as of
20 August 2026", and that is the entire reason `meta.generatedAt` is not
optional.

---

## 7. The rest of the HTTP surface

| Method | Path | Content type | Purpose |
|---|---|---|---|
| `GET` | `/fleet/resolve` | JSON | Section 6.1 |
| `GET` | `/fleet/metro/arrivals` | JSON | Section 6.6 |
| `GET` | `/fleet/vehicle/{bin}/position` | JSON | 7.1 |
| `GET` | `/gtfs-rt/vehicle-positions` | `application/x-protobuf` | 7.2 |
| `GET` | `/gtfs-rt/trip-updates` | `application/x-protobuf` | 7.3 |
| `GET` | `/gtfs-rt/vehicle-positions.json` | JSON | 7.2, debug only |
| `GET` | `/gtfs-rt/trip-updates.json` | JSON | 7.3, debug only |
| `GET` | `/fleet/routes` | JSON | 7.4 |
| `GET` | `/healthz` | JSON | 7.4 |
| `GET` | `/readyz` | JSON | 7.4 |
| `POST` | `/admin/scenario` | JSON | 7.5, token-gated |
| `DELETE` | `/admin/scenario` | JSON | 7.5, token-gated |

### 7.1 `GET /fleet/vehicle/{bin}/position`

**Why this exists.** After buying a ticket, an app tracks exactly one bus. Making
it fetch, decompress and parse a fleet-wide protobuf every ten seconds to find
one entity is wasteful on a phone on a mobile connection, and it forces a
protobuf dependency into an app that otherwise needs none. This endpoint is the
same data for one vehicle, in JSON, cheap.

`200 OK`, `Cache-Control: no-store`.

```jsonc
{
  "bin": "BLR-04127",
  "class": "bus",
  "tracking": { /* identical shape to resolve's `tracking`, section 6.2 */ },
  "duty": {
    "status": "confirmed",
    "route": { "id": "1066", "number": "500-D" },
    "trip":  { "id": "1042" }
  },
  "nextStops": [
    { "id": "20985", "name": "Domlur", "nameLocal": "ದೊಮ್ಮಲೂರು", "sequence": 14,
      "eta": { "seconds": 96,  "uncertaintySeconds": 45 } },
    { "id": "21004", "name": "Ejipura", "nameLocal": null,        "sequence": 15,
      "eta": { "seconds": 341, "uncertaintySeconds": 75 } }
  ],
  "meta": { "simulated": true, "seed": 1, "generatedAt": "2026-08-20T09:41:26Z" }
}
```

- **`tracking` is byte-for-byte the same shape as in `/fleet/resolve`.** One
  type, one parser, one set of tests on the consuming side. This is worth more
  than any saving from trimming it.
- **`nextStops` is capped at `PREDICTION_HORIZON_STOPS`** (default 5) and every
  entry carries an `uncertaintySeconds`. It is empty when
  `tracking.state` is `dark` or `untracked`, or when `duty.status` is `unknown`
  - the same rule as section 7.3, because it is the same claim in a different
  wrapper.
- `404 unknown_bin` for a BIN with no registry row. **No check-digit
  validation here**: this is a machine-to-machine path where the BIN came from a
  previous response, not from a rider's fingers, and rejecting it on a checksum
  would only mask a bug in the caller. That asymmetry with section 6.3 is
  deliberate and section 14 tests both halves.
- **`Cache-Control: no-store`**, not a TTL. A position that a CDN can serve
  twice is a position that is silently older than its `fixAgeSeconds` claims.

### 7.2 `GET /gtfs-rt/vehicle-positions`

`200 OK`, `Content-Type: application/x-protobuf`, body is a serialised
`transit_realtime.FeedMessage`.[^gtfsrt-proto]

```
header.gtfs_realtime_version = "2.0"
header.incrementality        = FULL_DATASET
header.timestamp             = now, POSIX seconds
```

One `FeedEntity` per vehicle that has a position - that is, every vehicle whose
`tracking.state` is `live`, `stale` or `dark`.

| GTFS-RT field | Source |
|---|---|
| `entity.id` | The BIN, canonical form: `BLR-04127` |
| `vehicle.vehicle.id` | The BIN, canonical form |
| `vehicle.vehicle.license_plate` | Current plate, normalised: `KA01F1234`. **Omitted for metro.** |
| `vehicle.vehicle.label` | **Omitted for buses.** For metro: `Purple Line to Whitefield (Kadugodi)` |
| `vehicle.trip.trip_id` | `duty.trip.id`, **omitted when `duty.status` is `unknown`** |
| `vehicle.trip.route_id` | `duty.route.id`, omitted likewise |
| `vehicle.trip.start_time` / `start_date` | `duty.trip.startTime` / `startDate` |
| `vehicle.trip.schedule_relationship` | `SCHEDULED` |
| `vehicle.position.latitude` / `longitude` | The fix |
| `vehicle.position.bearing` | Degrees clockwise from true north |
| `vehicle.position.speed` | **Metres per second**, per the spec's units - not km/h |
| `vehicle.current_stop_sequence` | GTFS `stop_sequence` of the next stop |
| `vehicle.stop_id` | That stop's `stop_id` |
| `vehicle.current_status` | `INCOMING_AT` \| `STOPPED_AT` \| `IN_TRANSIT_TO` |
| `vehicle.timestamp` | **`observedAt`, when the fix was taken.** Not now. |

**The staleness is carried by `vehicle.timestamp`, and that is the whole
mechanism.** The specification defines it as the "Moment at which the vehicle's
position was measured",[^gtfsrt-ref] so `header.timestamp - vehicle.timestamp`
is the fix age, and any conforming consumer already knows how to compute it.
**This service must not backdate the header or forward-date the fix to make the
feed look fresher.** Section 14 asserts that a `stale` vehicle's entity really is
older than `BUS_STALE_AFTER_SECONDS` in the emitted feed.

**Vehicles with `tracking.state: untracked` are absent from the feed.** There is
no GTFS-Realtime way to say "this vehicle exists and has no device", and
inventing one would be worse than the truth, which is that the feed simply does
not cover the whole fleet - exactly as real feeds do not. A consuming app
discovers coverage gaps the way it would in production: by comparing the feed
against the timetable. `/fleet/routes` (7.4) publishes the per-route coverage
share so a demo can point at the number.

**`Cache-Control: max-age=<FEED_TTL_SECONDS>`**, default 15, comfortably inside
the best-practice guidance that a feed be refreshed at least every 30
seconds.[^gtfsrt-bp] An `ETag` over the serialised body lets a polling consumer
take a `304`.

**Both vehicle classes are in one feed.** Splitting them would be modelling the
simulator's internals rather than the domain: a real city with a bus feed and a
metro feed has two operators, and a consumer that wants one mode filters on
`route_id`. `?class=bus` and `?class=metro` query parameters are supported as a
convenience and change nothing about the default.

### 7.3 `GET /gtfs-rt/trip-updates`, and the decision to publish predictions

**The decision: publish, with a mandatory band on every event, and `NO_DATA`
beyond a short horizon.** Controlled by `PUBLISH_TRIP_UPDATES`, default `true`.

#### The argument for not publishing

It is not a weak argument and it deserves to be stated properly.

A simulator that publishes arrival predictions is publishing a number it made
up. Worse, it made up the ground truth *and* the prediction, so it can make them
agree to the second, and a consuming app built against a feed whose predictions
are always right will quietly grow to depend on that. The first contact with a
real operator feed - where a prediction is wrong by two minutes as a matter of
course - then breaks the app's entire visual language. Not publishing
`trip-updates` at all would force the consuming app to confront, on day one,
that it has vehicle positions and no arrival times, and to design for that.

There is also a smaller, sharper point: **`vehicle-positions` is a measurement
and `trip-updates` is an opinion.** A simulator has some claim to producing
measurements. Its claim to producing opinions is much weaker, because the
opinion of a real prediction engine encodes traffic, dwell behaviour, signal
priority and historical run times that this service models with a constant.

#### The argument for publishing, which wins

1. **The consuming app needs arrival times, and refusing to serve them does not
   remove the requirement - it relocates it.** An app told "here is a bus at
   these coordinates, on this route" and nothing more will compute an ETA from
   distance and speed, in the client, without a band, and display it as a
   number. That is a worse outcome than a server-side prediction with an honest
   uncertainty, because the client has less information and no natural place to
   put the band.

2. **GTFS-Realtime has a field for exactly this, and it is not optional in
   spirit.** `StopTimeEvent.uncertainty` "roughly specifies the expected error in
   true delay as an integer in seconds", and the spec's own worked example is a
   bus predicted late "within a 4 minute window of error" carrying uncertainty
   `240`.[^gtfsrt-tripupdates] The specification also says that if uncertainty is
   omitted "it is interpreted as unknown", and that a certain prediction sets it
   to `0`.[^gtfsrt-ref] A simulator that publishes predictions **with** a band is
   using the standard as designed; one that refuses to publish is leaving a
   documented field unexercised and forcing the consuming app to build the same
   concept badly.

3. **`SKIPPED` and `NO_DATA` exist for the parts we cannot support.** A
   `StopTimeUpdate` with `schedule_relationship: NO_DATA` means "no realtime
   timing available", and the spec requires that arrival and departure then
   **must not** be supplied.[^gtfsrt-ref] That is a first-class way to say "I do
   not know", and it is exactly what a bus with a dead device deserves.

4. **The honesty requirement is satisfiable here in a way it is not in the
   client.** The band widens with distance, the horizon is short, and beyond it
   the feed says nothing. That is a modelled uncertainty, not a fabricated
   certainty.

#### The rules, which are what make it honest

```
header.gtfs_realtime_version = "2.0"
header.incrementality        = FULL_DATASET
header.timestamp             = now
```

One `FeedEntity` per **vehicle with a known trip** - that is, `duty.status` in
`{confirmed, inferred}`. Never more than one `TripUpdate` per trip, per the
spec's "at most one trip update for each scheduled trip".[^gtfsrt-tripupdates]

1. **`uncertainty` is set on every `StopTimeEvent` this service emits. Always.
   Never omitted, and never `0`.** `0` would mean a certain prediction, and
   nothing here is certain. Section 14 asserts it over the whole feed.

2. **The band grows with remaining distance:**

   ```
   uncertaintySeconds =
       PREDICTION_UNCERTAINTY_BASE_SECONDS
     + PREDICTION_UNCERTAINTY_PER_STOP_SECONDS * stopsRemaining
   ```

   Bus defaults: `45 + 30 * n`. So the next stop carries +/- 45 s, the fifth
   carries +/- 165 s. Metro defaults are far tighter, `15 + 5 * n`, because a
   train on a signalled line with a fixed dwell genuinely is more predictable,
   and the consuming app should see that difference.

   It is deliberately **linear, not calibrated**. Real prediction error grows
   super-linearly with the number of intervening signals and stops, and this
   model does not claim otherwise. Section 13 lists it as stubbed.

3. **Beyond `PREDICTION_HORIZON_STOPS`** (default 5), every remaining stop is
   emitted with `schedule_relationship: NO_DATA` and **no** `arrival` or
   `departure`, as the specification requires.[^gtfsrt-ref] Publishing a
   prediction twenty stops ahead of a bus in Bengaluru traffic would be
   fabrication with extra steps.

4. **A vehicle whose `tracking.state` is `dark` or `untracked` produces no
   predictions at all.** Its `TripUpdate` is emitted with every stop as
   `NO_DATA`, or is omitted entirely when `TRIP_UPDATES_OMIT_UNTRACKED=true`
   (default `false`). Emitting the trip with `NO_DATA` is the better default,
   because it tells a consumer the trip is running and the timing is unknown -
   which is more than silence tells it.

5. **A vehicle whose `duty.status` is `unknown` produces no `TripUpdate`.**
   There is no trip to attach one to, and `TripDescriptor.trip_id` is not
   something to guess at.

6. **Delay propagation follows the specification.** Where a stop has no explicit
   update, the delay from the preceding update propagates forward, and a
   `SCHEDULED` or `NO_DATA` relationship stops the propagation.[^gtfsrt-tripupdates]
   The simulator emits explicit updates within the horizon and `NO_DATA` outside
   it, so propagation never runs past the horizon by accident.

**The one-sentence version:** *this service publishes what it can support, with
the error bar attached, and says `NO_DATA` for the rest.*

**The debug JSON mirrors.** `/gtfs-rt/*.json` serve the same `FeedMessage` as
JSON, using the protobuf library's own JSON mapping. They exist so that a demo,
a curl, or a test assertion does not need a protobuf decoder, and they carry a
`X-Debug-Endpoint: true` header. They are **not** a supported consumer interface
and the README says so.

### 7.4 Read-only operational endpoints

**`GET /fleet/routes`** - what the simulator is running, and how well
instrumented it is. This is what makes the coverage story demonstrable rather
than asserted.

```jsonc
{
  "routes": [
    { "class": "bus", "id": "1066", "number": "500-D",
      "name": "Central Silk Board to Hebbala Bridge",
      "shapeIds": ["500-D UP", "500-D DOWN"],
      "vehicleCount": 6,
      "coverage": { "tracked": 4, "untracked": 2, "share": 0.67 } },
    { "class": "metro", "id": "purple", "number": "Purple Line",
      "name": "Challaghatta to Whitefield (Kadugodi)",
      "colour": "#9C27B0", "stationCount": 37,
      "vehicleCount": 8,
      "coverage": { "tracked": 8, "untracked": 0, "share": 1.0 },
      "headwaySeconds": { "peak": 480, "offPeak": 720 } }
  ],
  "meta": { "simulated": true, "seed": 1, "generatedAt": "..." }
}
```

**`GET /healthz`** - is the process alive. `200` with `{ "status": "ok",
"uptimeSeconds": n }`. No dependency checks; a liveness probe that fails on a
downstream is a liveness probe that restarts a healthy process.

**`GET /readyz`** - is the simulator actually simulating. This is the one a
monitor should watch.

```jsonc
{
  "status": "ready",
  "geometryLoaded": true,
  "routes": 5, "metroLines": 3,
  "vehicles": 54,
  "lastTickAt": "2026-08-20T09:41:26Z",
  "tickLagMs": 12,
  "seed": 1
}
```

`503` if geometry failed to load, if no vehicles were generated, or if
`lastTickAt` is older than `SIM_TICK_MS * 5`. **A process that answers `200` on
`/` while the world is frozen is the failure mode this exists to catch.**

### 7.5 The scenario control surface

A demo cannot wait forty minutes for a dropout to happen by chance. Token-gated,
and **absent entirely** - `404`, not `401` - when `ADMIN_TOKEN` is unset, so a
deployment that forgets to set it has no admin surface rather than a guessable
one.

`POST /admin/scenario`, header `Authorization: Bearer <ADMIN_TOKEN>`:

```jsonc
{
  "target": { "bin": "BLR-04127" },        // or { "route": "500-D" } or { "all": true }
  "set": {
    "tracking": "dark",                     // live|stale|dark|untracked, or null to release
    "duty": "unknown",                      // any duty.status, or null to release
    "dutyReason": "roster_swapped"
  },
  "ttlSeconds": 300                         // required, 1..3600. Overrides expire.
}
```

`DELETE /admin/scenario` clears all overrides.

**Every override has a mandatory TTL.** A demo forced into a state and never
released is a simulator that quietly stopped simulating, and `/readyz` would
still say `ready`. The TTL makes the world self-healing.

**Overrides are visible.** Any response about an overridden vehicle carries
`meta.overridden: true`, so nobody debugs a forced state for twenty minutes.

### 7.6 Errors and headers, everywhere

- Every error body: `{ "error": "<machine_readable>", "message": "<human>",
  ...context }`. The `error` string is the contract; `message` is copy.
- `400` for a malformed request, `404` for a well-formed request naming
  something that does not exist, `422` for a well-formed request that names
  something real and is the wrong question about it, `503` when the simulator is
  not ready. No other statuses.
- **CORS**: `Access-Control-Allow-Origin` from `CORS_ALLOWED_ORIGINS`, a
  comma-separated list, default `*`. Every endpoint is public and read-only, so
  `*` is honest; the variable exists because a deployment may want to narrow it.
- **`X-Simulated: true`** on every single response, including errors. Belt and
  braces with `meta.simulated`, and it survives a consumer that only logs
  headers.
- Every response carries `X-Request-Id`, echoed from the request when present.

---

## 8. The simulation engine

### 8.1 The world tick

One timer, one function, no queues.

```
every SIM_TICK_MS (default 1000):
  now = clock()                       # section 8.8
  for each vehicle:
    advanceCursor(vehicle, now)       # 8.2, 8.3
    maybeEmitFix(vehicle, now)        # 8.5, 8.6
    maybeChangeDuty(vehicle, now)     # 8.7
  dispatchNewTrips(now)               # 8.4
  retireFinishedTrips(now)
  expireScenarioOverrides(now)
  lastTickAt = now
```

The whole world is in memory. A 54-vehicle fleet on five bus routes and three
metro lines ticks in well under a millisecond, and `/readyz` publishes
`tickLagMs` so a fleet size that outgrows one tick is visible rather than
silently drifting.

**Requests never advance the world.** A handler reads the current state and
projects it. If `SIM_TICK_MS` is raised to 10000 for a slow demo, responses do
not become stale-by-construction; they become correctly stale, and
`fixAgeSeconds` says so.

### 8.2 A vehicle is a cursor on a polyline

The core abstraction, and it is small.

```
Cursor
  shapeId              : string       which polyline
  distanceMetres       : number       how far along it
  directionId          : 0 | 1        which way the shape runs
  dwellUntil           : epoch | null non-null while stopped at a stop
```

The shape is a list of `(lat, lon, cumulativeDistanceMetres)` points, built once
at load from `shapes.txt` (`shape_pt_lat`, `shape_pt_lon`, `shape_pt_sequence`,
`shape_dist_traveled`) or from the metro topology (section 9.2).

To place a vehicle:

1. Binary-search the cumulative-distance array for the segment containing
   `distanceMetres`.
2. Linearly interpolate `lat`/`lon` within that segment.
3. `bearing` is the initial bearing of that segment, forward-azimuth, in degrees
   clockwise from true north.

**Distances are geodesic, computed with the haversine formula on a mean Earth
radius of 6 371 008.8 m.** Bengaluru spans about 40 km; haversine error at that
scale is metres, far inside the positional noise the device model adds. Do not
reach for Vincenty.

**`shape_dist_traveled` in the bundled BMTC feed is present and in metres**, and
is used directly rather than recomputed. Section 14 asserts, at load, that it is
monotonically non-decreasing per shape and that its final value is within 5% of
the sum of the haversine segment lengths - a shape that fails either is rejected
at startup with the shape id named, because a bad `shape_dist_traveled` produces
buses that teleport and it is far better to find that at boot.

**Stop positions along the shape.** Each stop in the trip's `stop_times`
sequence is projected once, at load, onto its nearest point on the shape, giving
a `stopDistanceMetres`. The cursor's next stop is then the first entry whose
`stopDistanceMetres > distanceMetres` - a comparison of two numbers, no
geometry at request time.

`UNRESOLVED:` whether the community BMTC feed's `shape_dist_traveled` is derived
from the same source geometry as its stop coordinates. If a stop projects more
than `GEOMETRY_MAX_STOP_OFFSET_METRES` (default 150) from its shape, the loader
logs a warning naming the route and stop and keeps going. Failing the build on
it would make the project un-runnable on a feed refresh, and the consequence is
cosmetic: a stop marker slightly off the drawn line.

### 8.3 Speed, dwell, and why the two modes differ

**Bus.** Speed is drawn per vehicle at dispatch and re-drawn on each segment:

```
speedKph = clamp(
    normal(BUS_SPEED_KPH_MEAN, BUS_SPEED_KPH_SD) * peakFactor(now),
    BUS_SPEED_KPH_MIN, BUS_SPEED_KPH_MAX )
```

Defaults `mean 17`, `sd 4`, `min 5`, `max 45`. **17 km/h is not arbitrary**:
Bengaluru's measured city-wide average traffic speed is about 17.4 km/h, and
about 18 km/h in rush hour by another index.[^blr-speed] A bus is at best that
fast between stops and slower overall, which is what the dwell model adds.

`peakFactor(now)` is `BUS_PEAK_SPEED_FACTOR` (default `0.7`) inside
`BUS_PEAK_WINDOWS` (default `07:00-10:00,17:00-21:00` local) and `1.0` outside.

At each stop the cursor sets `dwellUntil = now + max(0, normal(
BUS_DWELL_SECONDS_MEAN, BUS_DWELL_SECONDS_SD))`, defaults `20` and `8`.

**Metro.** Speed follows a trapezoidal profile between stations rather than a
constant, because a train visibly accelerates, cruises and brakes and a constant
speed produces a train that arrives at a platform at 35 km/h:

```
accelerate at METRO_ACCEL_MPS2 (default 1.0) to min(METRO_CRUISE_KPH, v_max_for_gap)
cruise
decelerate at METRO_DECEL_MPS2 (default 1.1) to rest at the platform
dwell METRO_DWELL_SECONDS (default 25, sd 4)
```

`METRO_CRUISE_KPH` defaults to `60`, inside the system's 80 km/h maximum, and
the resulting end-to-end average lands near the published 35 km/h average
once dwells are counted.[^nammametro] Where a station gap is too short to reach
cruise, the profile degenerates to accelerate-then-brake and the peak speed is
whatever the gap allows.

**This is the smaller of the two mode differences and it is worth having anyway**,
because it is what makes a metro ETA legitimately tighter than a bus ETA rather
than tighter by fiat.

### 8.4 Headways and dispatch

**Metro runs to a headway. BMTC does not, and the simulator must not pretend it
does.**

**Metro dispatch** is a clock. A trip departs each terminal every
`METRO_HEADWAY_SECONDS_PEAK` (default 480, eight minutes) inside the peak
windows and `METRO_HEADWAY_SECONDS_OFFPEAK` (default 720) outside, with
`METRO_HEADWAY_JITTER_SECONDS` (default 20) of noise so trains do not run in
lockstep. Per-line overrides exist: `METRO_HEADWAY_SECONDS_PEAK__YELLOW` and so
on. Defaults are grounded in reported service: Purple and Green around eight
minutes at peak and ten to fifteen off-peak, and the Yellow Line worked down to
nine minutes at peak and fourteen off-peak as trainsets arrived through
2026.[^metro-headway][^yellow-headway] The Yellow Line's separate default is
there because it is genuinely the sparser line and a demo showing three
identical lines would be flattering the system.

The train count per line then falls out of the headway and the round-trip time
rather than being configured directly, which is how a real operator thinks about
it:

```
trains = ceil( (2 * lineRunTimeSeconds + 2 * turnaroundSeconds) / headwaySeconds )
```

`METRO_TRAINS_PER_LINE` exists as an override for a demo that wants a specific
number, and is unset by default.

**Bus dispatch** is `BUSES_PER_ROUTE` (default 6) vehicles per route, spread
evenly over the round trip at start-up and thereafter running continuously with
a `BUS_TERMINAL_LAYOVER_SECONDS` (default 300) turnaround. **This is a
simplification and section 13 lists it as one.** Real BMTC service is timetabled
per trip, bunches heavily, and varies enormously by route. Modelling the real
timetable would mean parsing `stop_times` departure times that the feed's own
maintainers describe as "particularly unreliable" for timings,[^bmtc-gtfs] so
the simulator uses an even spread and does not claim it is a schedule. **The
bunching that a real corridor shows emerges anyway**, from the per-vehicle speed
draw and dwell variance, which is the honest way to get it.

### 8.5 The device model: staleness, dropouts, coverage

This is the section that makes the simulator worth building. Four independent
mechanisms, each an environment variable, each demonstrable on its own.

**1. Coverage.** At fleet generation, each vehicle independently gets a device
with probability `BUS_COVERAGE_SHARE` (default `0.75`) or
`METRO_COVERAGE_SHARE` (default `1.0`). A vehicle without one is
`tracking.state: untracked` **forever**; it never reports, never appears in
`vehicle-positions`, and its `tracking.position` is `null` with
`reason: "no_device_fitted"`.

Coverage is drawn from the seed, so **the same BINs are untracked across
restarts**, which matters: a demo that shows an untracked bus needs that bus to
still be untracked on the second take.

**2. Fix interval and staleness.** A device with a fix emits at

```
nextFixAt = lastFixAt
          + BUS_FIX_INTERVAL_SECONDS                       (default 20)
          + uniform(-BUS_FIX_JITTER_SECONDS, +BUS_FIX_JITTER_SECONDS)   (default 10)
```

giving 10-30 second intervals, which is the range real AIS-140 devices report
in.[^ais140-freq] **The vehicle keeps moving between fixes.** The published
position is the one taken at `lastFixAt`, and `fixAgeSeconds` is how far behind
it is. This is not an approximation of staleness; it is staleness, produced the
same way the real thing produces it.

`tracking.state` is then `live` while `fixAgeSeconds <= BUS_STALE_AFTER_SECONDS`
(default 90, matching the GTFS-RT best-practice ceiling on data
age[^gtfsrt-bp]), `stale` up to `BUS_DARK_AFTER_SECONDS` (default 300), `dark`
beyond.

**3. Dropouts.** Tunnels, dead SIMs, unpaid data, a device switched off at a
depot. Modelled as a Poisson process at `BUS_DROPOUT_RATE_PER_HOUR` (default
`1.5`) per vehicle-hour. A dropout suppresses fixes for
`uniform(BUS_DROPOUT_MIN_SECONDS, BUS_DROPOUT_MAX_SECONDS)`, defaults `60` and
`420`, so a bus goes `live -> stale -> dark -> live` over a few minutes.

**On reconnection, a real store-and-forward device flushes its buffer**, and the
server receives a burst of backdated fixes at once. The simulator models the
observable consequence: on the first fix after a dropout, the vehicle's position
jumps to where it actually is now, and the response carries
`tracking.recoveredFromDropout: true` for one fix interval. It does **not**
replay the intermediate fixes into the feed, because GTFS-Realtime is a snapshot
of current state and has nowhere to put them.

Metro uses `METRO_DROPOUT_RATE_PER_HOUR` (default `0.05`), thirty times rarer,
because a train that loses its position on a CBTC line is an incident rather
than a Tuesday.

**4. Positional noise.** A bus fix gets Gaussian cross-track and along-track
error at `BUS_GPS_NOISE_METRES` (default 12, one standard deviation), and
`accuracyMetres` reports it. **This is the one place the simulator deliberately
puts a vehicle off its own polyline**, and it is what a consuming app's map
rendering needs to be robust against.

Metro gets `METRO_POSITION_NOISE_METRES` (default `2`) applied **along track
only**. A signalling system reports block occupancy; the uncertainty is *where
in the block*, not *which side of the rails*. A train never leaves its line, and
a consuming app should never have to draw one that has.

### 8.6 The signalling model for metro

Where the bus model asks *did a packet arrive*, the metro model asks *is the
train in a known block*.

- Position updates every `METRO_FIX_INTERVAL_SECONDS` (default `5`), unjittered.
  A signalling system reports on a cycle, not when a modem manages to connect.
- `tracking.source` is `simulated_signalling`, not `simulated_gnss`, and a
  consuming app may key off it.
- `accuracyMetres` reflects block granularity rather than satellite geometry:
  `METRO_BLOCK_LENGTH_METRES / 2`, default block `200`, so `100` - but *along
  the line only*, which is why the cross-track noise is zero.
- `STALE_AFTER` is `METRO_STALE_AFTER_SECONDS` (default 30) and `DARK_AFTER` is
  `METRO_DARK_AFTER_SECONDS` (default 120). A five-second cycle that has not
  reported in thirty seconds is already worth flagging.

**No map matching is skipped here, because none is required even in reality.**
That is the honest version of "we skipped it": for buses it is a real stage we
are not implementing; for metro it is a stage that does not exist.

### 8.7 Duty, and where roster uncertainty comes from

**The BIN-to-duty mapping is the least reliable thing in real operations**, and
`duty.status: inferred` and `unknown` exist to represent exactly that. Buses get
swapped mid-day, a vehicle fails and a spare takes its block, a driver signs on
to the wrong duty, and the operator's roster is a document about the morning.

At dispatch, a bus draws its `duty.status` from a four-way distribution:

```
DUTY_CONFIRMED_SHARE        default 0.60
DUTY_INFERRED_SHARE         default 0.25
DUTY_UNKNOWN_SHARE          default 0.10
DUTY_OUT_OF_SERVICE_SHARE   default 0.05
```

The four must sum to 1.0 within 1e-6 or the process **refuses to start**, naming
the four values and their sum. Silently normalising them would hide a typo in a
deployment's environment for weeks.

- **`confirmed`**: `source: "roster"`, no `confidence`.
- **`inferred`**: `source: "position_match"`, `confidence` drawn from
  `uniform(DUTY_INFERRED_CONFIDENCE_MIN, MAX)`, defaults `0.55` and `0.95`,
  rounded to two decimals.
- **`unknown`**: `source: "none"`, `route` and `trip` `null`, `reason` drawn
  from `ambiguous_trip_match` / `off_pattern` / `roster_swapped`. When the reason
  is `ambiguous_trip_match`, `alternatives[]` carries one or two real candidate
  routes from the loaded set, with confidences that do not sum to 1 - because a
  real matcher's scores do not either.
- **`out_of_service`**: the vehicle still moves, on a shape, because a
  deadheading bus is on a road. It is absent from `trip-updates` and present in
  `vehicle-positions` with no `trip` set.

**Mid-day swaps** fire at `DUTY_SWAP_RATE_PER_DAY` (default `0.15`) per vehicle
per service day. A swap:

1. Leaves `tracking` **completely untouched**. The device does not know a swap
   happened.
2. Moves `duty.status` from `confirmed` to `inferred` or `unknown`.
3. Sets `duty.reason: "roster_swapped"` and updates `duty.since`.

**This is the demo moment for section 5**, and `/admin/scenario` can force it.

**Metro duty** is drawn from `METRO_DUTY_CONFIRMED_SHARE` (default `0.99`) with
the remainder `inferred`; `unknown` and `out_of_service` are not produced on
line, and `METRO_DUTY_SWAP_RATE_PER_DAY` defaults to `0`. A train that is out of
service is in a depot, and a depot is not on the simulated line.

### 8.8 Determinism, and why there is no database

**The world is a pure function of `(SIM_SEED, clock)`.** There is no persisted
state, no volume, and no migration. A restart at the same wall-clock second
reproduces the same fleet, the same coverage draw, the same duty assignment.

Achieved with one rule: **every random draw is seeded by a hash of the seed, the
BIN, a purpose string, and where relevant a time bucket.**

```
rand(seed, bin, purpose, bucket) = xoshiro128** seeded with
    fnv1a(`${seed}|${bin}|${purpose}|${bucket}`)
```

- Coverage: `rand(seed, bin, "coverage", 0)`. No bucket - it is drawn once and
  never changes.
- Dropout in a given minute: `rand(seed, bin, "dropout", floor(epoch/60))`.
  Recomputable from nothing but the clock, which is why no dropout state has to
  be stored.
- Duty draw: `rand(seed, bin, "duty", serviceDate)`.

`Math.random()` must not appear anywhere in `src/sim/`. Section 14 makes that a
lint rule, because one stray call makes the whole demo unreproducible and the
symptom - "it worked when I recorded it" - is miserable to chase.

**`SIM_CLOCK`** controls time:

| Value | Behaviour |
|---|---|
| `system` (default) | Wall clock. |
| An RFC 3339 instant | **The world is frozen at that instant.** Every response is identical, forever. This is what golden-file tests and a reproducible screenshot use. |
| `offset:<seconds>` | Wall clock shifted, for demoing peak-hour behaviour at 11am. |

`SIM_SPEEDUP` (default `1`) multiplies elapsed time so a demo can watch a bus
cover a route in two minutes. It multiplies **simulated** elapsed time only;
`fixAgeSeconds` and every published timestamp stay in real seconds, because a
consuming app's staleness logic must be exercised against real numbers.

---

## 9. Geometry: where it comes from, and how a stranger runs this

### 9.1 Bus geometry: the community BMTC GTFS feed

Source: **`Vonter/bmtc-gtfs`**, an unofficial community GTFS dataset for BMTC,
scraped from the Namma BMTC app and published as `gtfs/bmtc.zip`.[^bmtc-gtfs]
It is the same source the consuming transit app uses, which matters: **the
simulator's buses must run on the same polylines the app draws**, or every
demonstration shows a bus beside the route rather than on it.

**The size problem is real.** As of the July 2026 snapshot:

| | |
|---|---|
| `gtfs/bmtc.zip`, compressed | **44 MB** |
| Uncompressed | **202 MB** |
| of which `shapes.txt` | 112 MB (2 447 719 points) |
| of which `stop_times.txt` | 80 MB (1 519 120 rows) |
| Routes / trips / stops | 4 381 / 56 855 / 9 887 |
| Whole repository including raw archives | ~1.7 GB |

Making a first-time contributor download 44 MB and unpack 202 MB to run a
simulator of six buses is a bad trade, and making the Docker image carry it is
worse.

**So a subset is bundled, and it is small.** `scripts/build-bundle.ts` extracts
the routes named in `BUS_ROUTES` and everything they reference. Measured against
the real feed for the five default routes - `500-D`, `500-A`, `G-4`, `335-E`,
`401-K`, all genuine BMTC routes:

| | |
|---|---|
| Routes | 5 |
| Trips | 716 |
| Shapes / shape points | 10 / 4 075 |
| Distinct stops | 403 |
| `stop_times` rows | 36 853 |
| **Bundle, uncompressed** | **~2.2 MB** |
| **Bundle, gzipped in the repository** | **~0.5 MB** |

That is committed. `git clone && docker compose up` works with **no download,
no Overpass call and no network access at all**, which is the bar: a stranger
landing on the repository cold gets a running simulator in one command.

**Three loading modes**, `GTFS_SOURCE`:

| Value | Behaviour |
|---|---|
| `bundled` (default) | Read `data/bundle/`. No network. |
| `path` | Read a full GTFS directory or zip at `GTFS_PATH`. For someone who already has the feed - including the consuming app, which does. |
| `url` | Download `GTFS_URL` at boot, cache under `GTFS_CACHE_DIR`. Off by default; a service that fetches 44 MB on every container start is a service that fails on a bad day. |

**Regenerating the bundle** is `npm run build-bundle`, which downloads the
upstream zip, extracts, and rewrites `data/bundle/`. It records
`data/bundle/SOURCE.md` with the upstream URL, the commit SHA, the `feed_version`
from `feed_info.txt`, the fetch date, and the exact `BUS_ROUTES` list used.
**The bundle is data, and undated data is a liability**; the `SOURCE.md` is what
lets someone six months later tell whether the bundle is stale.

**Licence.** `Vonter/bmtc-gtfs` **has no `LICENSE` file**. It carries a
`CITATION.cff` naming Vivek Matthew as the author, an `attributions.txt` inside
the feed naming BMTC as operator and authority, and a `feed_info.txt` naming
Vonter as publisher. Absent an explicit licence the default is all rights
reserved. Consequences, and they are not optional:

- **The bundled subset is attributed in `data/bundle/SOURCE.md`, in
  `THIRD_PARTY_NOTICES.md` and in the README**, with the upstream URL and the
  `CITATION.cff` citation reproduced.
- **`THIRD_PARTY_NOTICES.md` states plainly that the upstream repository carries
  no licence file**, so nobody downstream assumes MIT by proximity to this
  repository's own MIT licence.
- **An issue asking upstream to add a licence is opened**, and its URL recorded
  in `THIRD_PARTY_NOTICES.md`. This costs five minutes and is the difference
  between using someone's work and taking it.
- **`GTFS_SOURCE=url` exists as the escape hatch.** If the licence question is
  ever answered unfavourably, deleting `data/bundle/` leaves a project that still
  runs, one download later. **This is why the bundle is a cache and not a
  hard dependency**, and no code may assume it is present.

### 9.2 Metro geometry: OpenStreetMap route relations

**Not the vendor file, and there is a scar behind that.** The consuming project
originally took Namma Metro station order from a vendor JSON dataset, and that
order was representational rather than routable: it **reversed a six-station run
of the Purple Line, spliced three Green Line stations into the middle of Purple,
and omitted four stations entirely**. Because the planner walked stations in
stored order, the result was wrong journeys and wrong travel times, not a
cosmetic map defect. That project now derives station order and coordinates from
OpenStreetMap and gates on `scripts/check-metro-topology.ts`.

**A simulator inherits the problem in a sharper form.** A train is a cursor
walking a station list; a reversed run makes it travel backwards through six
real stations while reporting perfect confidence. So this project takes the same
source and the same discipline.

**Source.** OSM models a metro line as a `type=route` relation with
`route=subway`, whose members are **ordered**.[^osm-route] One Overpass query
over the city bounding box returns the relations and their member nodes:

```
[out:json][timeout:600];
(
  relation["type"="route"]["route"~"subway|light_rail"]({{bbox}});
);
(._;>;);
out body;
```

Relations carrying a `state` tag (proposed, under construction) are excluded:
OSM models only built infrastructure as an open route relation, and the Pink and
Blue lines have none. Lines are matched to ids by their OSM `ref` tag -
`Purple`, `Green`, `Yellow`.

**Station order comes from OSM member order and is never re-sorted by
coordinate.** Re-sorting is exactly how a line that doubles back gets silently
reversed.

**This is also bundled.** `scripts/fetch-metro-topology.ts` writes
`data/bundle/metro-topology.json` and it is **committed**, for the same reason as
the bus subset and one more: Overpass is a shared public service with rate
limits and variable availability, and a project whose `docker compose up`
depends on it is a project that fails on someone else's bad afternoon.

```jsonc
// data/bundle/metro-topology.json
{
  "source": "openstreetmap",
  "fetchedAt": "2026-08-20",
  "overpassEndpoint": "https://overpass-api.de/api/interpreter",
  "lines": [
    {
      "id": "purple", "ref": "Purple", "name": "Purple Line",
      "nameLocal": "ನೇರಳೆ ಮಾರ್ಗ", "colour": "#9C27B0",
      "osmRelationId": 0000000,
      "stations": [
        { "id": "MTR-PPL-001", "name": "Challaghatta", "nameLocal": "ಚಳ್ಳಘಟ್ಟ",
          "lat": 12.9, "lon": 77.4, "platforms": ["1", "2"],
          "isInterchange": false, "interchangeWith": [] }
      ]
    }
  ]
}
```

**The polyline between stations.** OSM route relations carry the track ways as
well as the station nodes, so the geometry is real track, not a straight line
between platforms. Where a relation's way members cannot be stitched into a
continuous line, **the loader falls back to a straight line between consecutive
stations and records `"geometry": "interpolated"` on that segment**, which is
surfaced in `/fleet/routes`. A straight line between two stations 900 m apart is
a small lie; silently claiming it is the real alignment is a larger one.

**The integrity gate.** `scripts/check-metro-topology.ts` runs in CI and refuses
a topology where:

1. Any line has fewer stations than its known operational count - Purple 37,
   Green 32, Yellow 16 as of the Yellow Line's opening on 11 August
   2025.[^nammametro][^yellowline]
2. Consecutive stations are more than `METRO_MAX_STATION_GAP_METRES` (default
   4000) apart, which is what an omitted station looks like.
3. The sequence of inter-station bearings reverses by more than 150 degrees
   without a corresponding real terminus, which is what a spliced or reversed
   run looks like.
4. A station id appears twice on one line.

**This gate is not optional and it is the reason to trust the metro
simulation at all.** Every one of those four checks corresponds to a defect the
consuming project actually shipped once.

**Licence.** OpenStreetMap data is licensed under the **Open Database Licence
(ODbL) 1.0**, and its use requires attributing "© OpenStreetMap
contributors".[^osm-copyright] The attribution appears in the README, in
`THIRD_PARTY_NOTICES.md`, and in `data/bundle/SOURCE.md`. ODbL's share-alike
obligation attaches to derived *databases*: `data/bundle/metro-topology.json` is
a derived database and is published in this repository under **ODbL**, stated in
`THIRD_PARTY_NOTICES.md`, while the source code stays MIT. Section 17.

`UNRESOLVED:` the OSM relation ids for the three lines. They are read at fetch
time by `ref` tag and written into `metro-topology.json`, so the build does not
need them written down here; they are recorded in the generated file for
traceability.

### 9.3 Kannada names

The bundled BMTC feed ships `translations.txt` (1.3 MB) carrying Kannada names
for stops, and the metro topology carries `nameLocal` per station. Both are
loaded and both are emitted as `nameLocal`, `null` where absent.

**This is not decoration.** The consuming app carries Kannada station names
through to the rider, and a tracking service that drops them forces the app to
re-join against another dataset to put a name on a stop it just got a position
for.
