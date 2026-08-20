# transit-fleet-sim

A simulated bus and metro fleet for Bengaluru, serving live vehicle positions
over GTFS-Realtime and a fleet registry that maps a stable vehicle identifier to
a number plate and the duty it is running.

> **Not affiliated with BMTC, BMRCL or any transport authority.** Every vehicle,
> every number plate and every position this software serves is fabricated. See
> [Honesty](#honesty).

**The specification is [`SPEC.md`](SPEC.md).** It is complete enough to build
from and cites a source for every external protocol claim. This file is the
short version.

---

## What this is

Between a bus and a transit app there is a layer most app developers never see:
a GPS device bolted to the vehicle, a cellular link, a server that ingests
positions, a step that works out which trip the vehicle is running, a prediction
engine, and a published feed. When an app says "your bus is 4 minutes away", that
whole stack is what the claim rests on.

Without an operator's live feed you cannot build against that layer. This is
that layer, simulated: real route geometry, fabricated vehicles, and **the
failure modes deliberately left in**.

It exists so that a transit app and a ticketing service can be built and
demonstrated against live tracking without real vehicles, real devices or a real
operator feed.

## Why the unreliability is the product

A simulator controls reality. It could therefore state arrival times perfectly,
and that would make it worthless, because an app built against a feed that is
always right grows a visual language it cannot keep on contact with a real one.

So this service models the uncertainty real systems have, and every part of it is
configurable so a demo can show each in turn:

- **Staleness.** A fix is 10 to 30 seconds old by the time an app sees it. The
  vehicle keeps moving in between, and the published position is the one taken at
  the last fix. `fixAgeSeconds` says how far behind it is.
- **Dropouts.** Tunnels, dead SIMs, devices switched off. Buses go dark for
  minutes and come back.
- **Partial coverage.** Real fleets are never fully instrumented. A configurable
  share of buses have no device at all, so a consuming app can demonstrate
  falling back to the timetable and saying so.
- **Prediction bands.** Arrival predictions carry an error bar that widens with
  distance, in GTFS-Realtime's own `uncertainty` field, and past a short horizon
  the feed says `NO_DATA` rather than guessing.
- **Roster uncertainty.** Which vehicle is running which duty is the least
  reliable thing in real operations. Buses get swapped mid-day.

## Buses and trains are not the same problem

Both modes are simulated, and the differences are the point.

A bus position is a noisy GPS estimate from a cellular device that frequently is
not fitted at all. A metro train's position comes from a signalling system that
knows which block it occupies; there is no GPS, no drift, and no map matching
even in the real world. So the honesty profile inverts between the two, and a
journey planned across both modes should visibly behave differently on each leg.

| | Bus | Metro |
|---|---|---|
| Position | Noisy GNSS fix | Signalling block occupancy |
| Coverage | Partial by default | Complete |
| Dark periods | Routine | Rare, and an incident |
| Duty certainty | Often inferred | Almost always confirmed |
| Rider-verifiable identity | The number plate | The line, direction and platform |

## Two questions, never collapsed into one

Every vehicle carries two independent states, and keeping them apart is the
central design decision:

- **`duty.status`** answers *what is this bus doing?* - `confirmed`, `inferred`,
  `unknown`, `out_of_service`.
- **`tracking.state`** answers *where is it?* - `live`, `stale`, `dark`,
  `untracked`.

A bus can be confidently on a route with a dead GPS. A bus can be transmitting
perfectly with nobody sure what duty it runs. A single `status` field cannot say
either of those things, and an app built on one will tell a rider that a bus
which is definitely coming is missing.

## Three identifiers, three jobs

| | Example | Who uses it |
|---|---|---|
| Number plate | `KA-01-F-1234` | The rider. Painted on the bus. |
| **BIN** (Bus Identification Number) | `BLR-04126` | The system. Stable, never changes. |
| Route number | `500-D` | The rider. On the destination board. |

Plates change, so the BIN-to-plate mapping is temporal, with validity periods.
The BIN is the stable spine.

**The interface rule: show the rider what they can verify with their eyes.** For
a bus that is the plate and the route number. For a train it is the line, the
direction, the destination and the platform. **The BIN never appears in an
interface**; it is plumbing, and its one visible role is provenance on a ticket.

The BIN carries a check character, so a single mistyped digit fails on the
rider's phone rather than silently resolving to a real different bus.

## The interface

Available in the bus increment:

```
GET /fleet/resolve?code=BLR-04126        # BIN, from a QR scan or typed
GET /fleet/resolve?code=KA01ZZ4464       # generated fixture plate, typed
GET /fleet/vehicle/{bin}/position        # JSON, one vehicle, cheap to poll
GET /healthz
GET /readyz
```

Ordered next, and deliberately not stubbed yet:

```
GET /fleet/metro/arrivals?station=...    # which trains are approaching
GET /gtfs-rt/vehicle-positions           # protobuf
GET /gtfs-rt/trip-updates                # protobuf
```

One resolve endpoint for both entry paths, because a rider does not know which
kind of code they are holding. Full payload shapes, the error taxonomy, and why
a real bus with no duty today is a `200` rather than a `404` are in
[`SPEC.md` section 6](SPEC.md).

## Who it is for

- **Anyone building a transit app** who needs live vehicle tracking to develop
  and demonstrate against, including the parts of it that fail.
- **Anyone building a ticketing service** that binds a ticket to a vehicle. The
  resolve endpoint is the whole interface, and it is designed so the ticketing
  side stores no fleet facts it would then have to keep current.
- **Anyone who wants a GTFS-Realtime feed to test a consumer against**, with
  configurable staleness, dropouts and coverage gaps that a real feed will not
  produce on demand.

Nothing here depends on any particular app. It is a standalone service with no
database, no external dependency and no outbound network call at runtime.

## Data

| Mode | Source | Note |
|---|---|---|
| Bus routes, stops, shapes | [`Vonter/bmtc-gtfs`](https://github.com/Vonter/bmtc-gtfs) | Community-maintained, unofficial. A five-route subset is committed so the project runs with no download. |
| Metro line order and coordinates | OpenStreetMap `route=subway` relations | Not the vendor dataset, whose station order is representational rather than routable. An integrity gate keeps a reversed run from coming back. |

The upstream BMTC feed is 44 MB compressed and 202 MB unpacked. The bundled
subset is about 2 MB, so `docker compose up` on a clean clone needs no network
at all.

## Honesty

This governs everything in the repository.

- **No vehicle in this system exists.** Every BIN, plate and position is
  fabricated. No real bus, train or device is contacted, read or impersonated.
- **The fixture plates cannot collide with real vehicles.** They use a
  registration series BMTC does not run.
- **The geometry is real; the movement is not.** Routes, stops, station order and
  coordinates come from published open data. Every position on them is generated.
- **Every response says so.** `meta.simulated` is always `true` and never
  configurable, and every response carries an `X-Simulated: true` header,
  including errors.
- **The uncertainty is deliberate.** It is not a limitation of the simulator; it
  is the reason to use one.

[`SPEC.md` section 13](SPEC.md) is a full table of what is faithful to a real
vehicle-tracking system and what is stubbed, line by line. Map matching is the
largest thing absent, and it says so.

## Run it

The committed five-route bundle is the default, so the running service does not
download transit data or call an external service.

```sh
docker compose up --build
curl http://localhost:8080/readyz
curl 'http://localhost:8080/fleet/resolve?code=BLR-04126&entry=manual'
```

For local development:

```sh
npm ci
npm test
npm run dev
```

All configuration is documented in [`.env.example`](.env.example). Invalid
values are reported together at startup. The default fleet is deterministic;
set `SIM_CLOCK` to an RFC 3339 instant to freeze every response.

## Status

**The bus and ticketing increment plus metro topology and arrivals are
implemented.** It includes the
offline GTFS bundle, geometry, Damm-checked fleet identity, deterministic bus
movement, independent duty and tracking state machines, resolve and
single-vehicle JSON endpoints, probes, config and Docker, plus bundled OSM
metro geometry and `/fleet/metro/arrivals`. GTFS-Realtime remains next.

The checked wire output is under [`evidence/`](evidence/), the sixteen complete
resolve-body goldens are under [`tests/api/goldens/`](tests/api/goldens/), and
the criterion-by-criterion result is
[`docs/acceptance-audit.md`](docs/acceptance-audit.md).

## Attribution

- Bus route, stop and shape data from [`Vonter/bmtc-gtfs`](https://github.com/Vonter/bmtc-gtfs)
  by Vivek Matthew, scraped from the Namma BMTC app. **The upstream repository
  carries no licence file**; it is used with attribution and the bundled subset
  is a cache, not a dependency. The underlying network is operated by the
  Bengaluru Metropolitan Transport Corporation.
- Metro topology derived from OpenStreetMap. © OpenStreetMap contributors, data
  available under the [Open Database Licence](https://www.openstreetmap.org/copyright).
  The derived topology file in this repository is published under ODbL.
- `gtfs-realtime.proto` from [`google/transit`](https://github.com/google/transit),
  Apache 2.0.

## Licence

MIT. See [`LICENSE`](LICENSE). The bundled data files carry their own terms; see
Attribution above and `THIRD_PARTY_NOTICES.md` once the data bundle lands.
