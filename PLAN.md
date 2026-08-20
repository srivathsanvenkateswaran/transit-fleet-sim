# Build plan

`SPEC.md` says what to build and why. This file says in what order, what
"done" means at each step, and what to drop first if time runs out. It exists
because the spec is 2,808 lines and nobody should have to hold all of it to
know what to do next.

Read [SPEC.md section 0](SPEC.md) before anything else. It lists nine decisions
already taken. None of them are reopened here.

## The arithmetic, stated plainly

SPEC section 16.1 costs the full build at **7.5 engineering days**. Section
16.2 names a **2.5-day increment** and says it "already delivers everything the
ticketing service needs".

The difference between the two is metro tracking, the GTFS-Realtime protobuf
feeds, and the arrivals endpoint. Those are the parts a *consuming app* wants.
The parts a *ticketing flow* needs are all in the 2.5.

**Build the increment first, in the stage order below, and treat everything
after stage 6 as upside.** Section 16.3's last risk row is the reason: metro
taking the whole week while the bus path never lands is the one failure that
leaves nothing to show.

## Stages

Each stage ends with something runnable and committed. Do not start the next
one with the previous one red.

### Stage 0 - the spike (0.5 day)

Load the bundled GTFS subset, index one shape, walk one cursor along it, serve
one JSON position from one hardcoded route.

**It exists to settle one question:** is `shape_dist_traveled` in the community
BMTC feed consistent with the stop coordinates? Measure it. If it is not,
recompute cumulative distance from haversine and ignore the column.

**Done when:** a `curl` returns a position that moves between two calls, and
the commit message states which answer the measurement gave and how it was
measured. Do not assume either answer.

### Stage 1 - bus geometry (0.75 day)

`src/geometry/`: the GTFS loader for all three source modes, the
cumulative-distance shape index, stop projection. `scripts/build-bundle.ts` and
`data/bundle/SOURCE.md`.

**Done when:** `data/bundle/` is committed, five routes, and a stranger who has
cloned the repo can load it with no network access at all.

### Stage 3 - fleet registry (0.5 day)

`src/fleet/`: BIN parse and format, the Luhn check character isolated in its
own file, plate parse and normalise, `classify`, temporal plate history, seeded
fleet generation.

**This is the stage the ticketing flow actually depends on.** SPEC section 4.2
is the reason the check character exists: a BIN wrong by one character must
fail on the phone, without a network call, because otherwise a typo resolves to
a real different bus and binds a ticket to a vehicle the rider is not on.

**Done when:** every single-character substitution and every adjacent
transposition of a valid BIN is rejected, under test.

### Stage 4 - simulation core (1.0 day)

`src/sim/`: the tick, the cursor, bus speed and dwell, headway dispatch,
layovers, trip lifecycle, and the seeded PRNG.

**`Math.random()` appears nowhere, ever.** Add the lint rule on the first day of
this stage, not the last. The failure it prevents is "it worked when I recorded
the demo", which is miserable to chase.

**Done when:** two runs with the same seed produce byte-identical output.

### Stage 5 - the honesty models (0.75 day)

Coverage, fix interval and staleness, dropouts, positional noise, the duty
state machine, mid-day swaps.

**This is the whole point of the project.** A simulator that knows everything
perfectly is worthless: the consuming app's entire character is refusing to
state what it cannot support, and it needs something to refuse.

The two state machines stay separate (SPEC section 5). `duty.status` answers
what this bus is doing; `tracking.state` answers where it is. A bus can be
confidently on route 500-D with a dead GPS. Collapsing them into one field is
the mistake that makes the consuming app lie.

**Done when:** all four cells of SPEC section 5.3 can actually be produced, and
there is a test per cell.

### Stage 6, cut - the two endpoints (0.5 day of the full 0.75)

`GET /fleet/resolve` with the full body of SPEC section 6.2 and the error
taxonomy of 6.5. `GET /fleet/vehicle/{bin}/position`. `/healthz`, `/readyz`.

Not `/fleet/metro/arrivals`, not `/fleet/routes`, not `/admin/scenario`.

**Three things manual entry gets that a scan does not** (SPEC section 6.4 and
6.5), all required: the check character, explicit plate-and-route confirmation
after a typed code but not after a scan, and a not-found that distinguishes "no
such BIN" from "that BIN is not in service today", because the rider's next
action differs.

**Done when:** resolve answers correctly for every combination of duty status
and tracking state.

### Stage 8 - config and Docker (0.5 day)

`src/config.ts` with fail-fast validation, `.env.example`, Dockerfile, Compose.

**Nothing hardcodes a port, a hostname or `localhost` outside `config.ts`**
(SPEC decision 8). Deploying is a matter of changing environment variables.

**Done when:** `docker compose up` works on a clean machine with no download,
and a missing variable fails loudly at startup rather than at first request.

---

**Stop here and report.** That is the 2.5-day increment. It runs, it is
demonstrable, and the ticketing flow can be built against it.

---

## Upside, in the order SPEC section 16.2 wants it

1. **Metro geometry plus `/fleet/metro/arrivals`** (1.0 day). Half a journey
   with no live data is a more visible hole in a demo than a missing protobuf
   feed. Nobody scans a train, so metro is a station-pair concept and
   `/fleet/resolve` stays a bus endpoint.
2. **GTFS-Realtime** (0.75 day). Vendor the `.proto`, do not fetch it at build
   time. Every `StopTimeEvent` carries a non-omitted `uncertainty`; beyond the
   horizon, stops are `NO_DATA` rather than guessed.
3. **`/fleet/routes`, `/admin/scenario`, the golden files, the repo furniture.**

## Cut list, in the order to cut

SPEC section 16.4 has the full list. The short version: cut metro before you
cut bus, cut the protobuf feeds before you cut the JSON endpoints, cut the
golden files before you cut the unit tests, and cut the scenario surface
before any of it.

**Never cut:** determinism, the check character, the two distinct not-founds,
and the mandatory uncertainty band. The first protects the demo and the rest
are the honesty requirement itself.

## Checkpoint

**24 August.** If stages 0, 1, 3, 4 and 5 are not done by then, ship the
increment, record the demo against it, and write plainly that the feeds and the
metro layer are next. An honest partial is worth more than a rushed whole, and
it is consistent with everything else this project says about itself.
