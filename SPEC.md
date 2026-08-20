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
