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
