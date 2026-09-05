# Section 14 acceptance audit

Audited against `SPEC.md` section 14 after the bus increment and metro geometry
plus arrivals. `PASS` means the
criterion is implemented and checked. `PARTIAL` names the missing portion.
`NOT MET` is used for work deliberately ordered after the increment.

| # | Status | Qualification |
|---:|---|---|
| 1 | PARTIAL | `docker compose up` reaches readiness using the committed bundle with no runtime data download. A first image build still needs normal access to the Node base image and npm packages, as the specified Dockerfile itself requires. |
| 2 | PARTIAL | Readiness reports 5 routes, 30 vehicles and tick lag below one tick. The bundled topology has 85 stations, but readiness does not yet expose metro runtime counts. |
| 3 | PASS | All 10 bundled shapes are monotonic and differ from summed haversine length by 0.119 to 0.171 percent. Per the build instruction, a future bad source falls back to recomputed haversine distance instead of failing. |
| 4 | PASS | Bundled OSM topology has Purple 37, Green 32 and Yellow 16 stations and passes gap and duplicate-id validation. |
| 5 | PASS | Missing configured bus routes fail startup and name every missing route. |
| 6 | PASS | Damm maps `0412` to `6`; all 450,000 single-digit mutations over every serial are rejected. |
| 7 | PASS | The literal criterion is a stale Luhn remnant that conflicts with decision 4.2. Under Damm, all 27,000 changing adjacent serial transpositions are rejected, including `09` and `90`. |
| 8 | PARTIAL | The three patterns are structurally disjoint and tested across representative forms, but the classifier test is not an exhaustive generated language proof. |
| 9 | PASS | Generated BINs are created through `formatBin` and the registry rejects any invalid BIN. |
| 10 | PASS | Every generated plate is asserted to use the `ZZ` series. |
| 11 | PASS | Registry startup assertions cover exactly one current plate, non-overlap and current-plate uniqueness. |
| 12 | PASS | Canonical, lower-case and space-separated BIN forms return identical frozen bodies. |
| 13 | PASS | Scan is non-blocking; manual and omitted entry both require confirmation. |
| 14 | PASS | A spy proves a bad check character returns before registry access. |
| 15 | PASS | A generated valid but absent BIN returns `404 unknown_bin`. |
| 16 | PASS | A real withdrawn BIN resolves `200` with `out_of_service`, never `404`. |
| 17 | PASS | Retired-plate bodies contain only the retirement fact and expose neither BIN nor current plate. |
| 18 | PASS | The contract returns `422 not_a_resolvable_code` and the metro arrivals path for a metro BIN. |
| 19 | PASS | Server middleware adds `meta.simulated` on success and `X-Simulated` on every response, including errors; route tests cover both. |
| 20 | PASS | Unknown duty nulls every duty descriptor and manual confirmation contains only the plate. |
| 21 | PARTIAL | All four tracking states are produced and asserted, but the admin scenario route was deliberately cut and is absent. |
| 22 | PASS | Untracked has no fix or position; dark retains its old position and ages it past the threshold. |
| 23 | PASS | One response projector derives fix age from served and observed instants; API and committed-wire tests assert the equality. |
| 24 | PARTIAL | Coverage zero makes every bus untracked. The GTFS-Realtime entity assertion waits for the protobuf feed. |
| 25 | PARTIAL | Same seed and frozen clock produce byte-identical world and resolve output. `/fleet/routes` was deliberately cut. |
| 26 | PASS | Both config startup and duty construction reject shares whose sum differs from one and report the values. |
| 27 | PASS | Sixteen full-body goldens enforce confidence only for inferred duty, within the configured range. |
| 28 | PASS | A forced-rate roster swap changes duty and leaves the complete retained tracking object unchanged. |
| 29 | PARTIAL | Bundled metro topology and station-pair arrivals are implemented; full signalling cursor, headway dispatch and metro position endpoint remain. |
| 30 | PASS | Both feeds are served as `transit_realtime.FeedMessage` protobuf, encoded by `src/api/protobuf.ts` rather than by a vendored runtime, and decoded back in `tests/api/gtfsRealtime.test.ts` rather than trusted. Header version, incrementality and timestamp are asserted. |
| 31 | PASS | One entity per vehicle with a position. `untracked` vehicles are absent from `vehicle-positions`, asserted at coverage zero. |
| 32 | PASS | `vehicle.timestamp` is the fix instant and is never freshened; a coach dark in a dead zone carries a timestamp genuinely older than `INTERCITY_DARK_AFTER_SECONDS`. |
| 33 | PASS | `Position.speed` is emitted in metres per second, not km/h, and the decoder test asserts the magnitude. |
| 34 | PARTIAL | Restated three ways by criterion 99. Bus and coach are asserted. **Metro is not reachable**: no metro vehicle exists in the registry and `MetroSimulation` models a headway table rather than per-train vehicles, which predates this document. |
| 35 | PASS | Every emitted `StopTimeEvent` carries a non-zero `uncertainty`, over a full-day coach sweep and on the bus path through `SimWorld.scheduleUpdates`. |
| 36 | PASS | Non-decreasing along a trip at a single instant, asserted for corridors as criterion 80. |
| 37 | PASS | Stops beyond the horizon carry `NO_DATA` with no arrival and no departure, in both the stop-count (bus) and time (coach) forms. |
| 38 | PASS | A vehicle with `unknown` or `out_of_service` duty produces no `TripUpdate`. A dark bus emits its trip with every stop `NO_DATA`, honouring `TRIP_UPDATES_OMIT_UNTRACKED`. |
| 39 | PARTIAL | `Cache-Control: max-age=FEED_TTL_SECONDS`. An `ETag` is not emitted; a polling consumer cannot take a `304` and re-fetches the body. |
| 40 | PARTIAL | Metro topology, JSON arrivals and both GTFS-Realtime feeds are built. Metro vehicles are still not simulated as entities, so no metro row appears in either feed. |
| 41 | PASS | A test parses `src/config.ts` and `.env.example` and requires their variable sets to be identical. |
| 42 | PARTIAL | Executable source is clean and enforced. Planning documents necessarily contain the forbidden words while stating this rule, so a literal whole-repository grep would flag the specification itself. |
| 43 | PASS | ESLint and a source-scan test independently forbid unseeded random calls. |
| 44 | PARTIAL | Bundled mode makes no outbound call. The explicitly required `GTFS_SOURCE=url` loader uses an outbound fetch, contradicting this literal criterion. A source scan (criterion 109) asserts that `src/` holds no other outbound client, which is the structural ground the manifest ingress being a push rests on. |
| 45 | PASS | A source-scan test keeps explicit class comparisons out of shared code and outside the three profile modules. |

## Increment boundary

The service intentionally does not register `/fleet/routes` or
`/admin/scenario`. They return the same ordinary `404` as any unknown path and
have no TODO stubs.

With `INTERCITY_CORRIDORS` unset - the default - `/fleet/duty`,
`/fleet/corridors` and `/fleet/manifest` return the same ordinary `404` for the
same reason, and no new field appears on any existing response. That is
`docs/intercity-coaches.md` §14.1's default-off requirement, and it is what
lets the consuming app widen its `VehicleClass` union and release before this
service turns coaches on.

---

# docs/intercity-coaches.md section 15 acceptance audit

Numbered continuing from `SPEC.md`'s 45, so a criterion number means one thing
across both documents. Audited after stages 1 through 9 of that document's own
effort table.

| # | Status | Qualification |
|---:|---|---|
| 46 | PARTIAL | The committed corridor bundle needs no download and no network access, and `/readyz` reaches `200` well inside 30 seconds. A first image build still needs the Node base image and npm packages, exactly as criterion 1 already records. |
| 47 | PARTIAL | Six of the seven checks run, in `validateCorridorTopology`, on every process start and in `npm run check-corridor-topology`, which CI runs. Check 7 has no corridor to run against - see 52. |
| 48 | PASS | `BNG-HSP` routes 417.7 km against a 292 km great circle, a ratio of 1.43 inside the 1.6 limit. |
| 49 | PASS | Stand order is validated from each stand's own cumulative distance, which is the field a coordinate re-sort corrupts. `tests/geometry/corridorTopology.test.ts` constructs a swapped topology and it fails the gate. |
| 50 | PASS | Monotonic cumulative distance is checked on the committed track, with the same haversine fallback `buildShapeIndex` already reports through `distanceSource`. |
| 51 | PASS | No dead zone comes within 500 m of a stand or a halt, checked on the bundled topology and by a constructed violation. |
| 52 | NOT MET | `PVG-BNG` is not in the fixture set. The gap is named rather than hidden: `PAVAGADA_OSM_RELATION_ID` exists so check 7 runs the moment a corridor claims that relation. **This is the only independent validation of the routing pipeline in the suite, and it is absent.** |
| 53 | PASS | Every generated coach BIN passes its own Damm check digit; every fixture hub code is three letters without `I` or `O`. |
| 54 | PASS | Classification is asserted over the extended hub-code set rather than assumed from the disjointness argument. |
| 55 | PASS | Every generated coach plate uses the `ZZ` series, and the assertion names any that do not. |
| 56 | PASS | Enforced in `FleetRegistry.add` rather than only at generation: a coach must carry both facts and a metro vehicle must carry neither. |
| 57 | PASS | Exactly one current plate per BIN, no overlapping periods, no normalised plate current for two BINs, across buses and coaches together. |
| 58 | PASS | Reservation is read from the class table, never from the corporation. A source scan keeps class comparisons inside the three allow-listed modules and no new file was added to that list. |
| 59 | PASS | A duty dispatched at 22:59 and observed at 03:00 the next calendar day reports the departure's service date and a `22:59:00` start time. |
| 60 | PASS | Two simulations booted on different calendar days agree on status, service date and the whole tracking object for the same duty. |
| 61 | PASS | The Pallakki run's terminal call is `30:xx:00`, and the after-midnight relief is rostered as `24:30` on the previous service date. |
| 62 | PASS | The cursor enters a terminal state and six further hours move it no further. |
| 63 | PASS | The active set is exactly the duties departed and not yet arrived, at three instants, and a coach outside its duty is not observable at all. |
| 64 | PASS | `/readyz` returns `503` with `reason: roster_window_stale` when the window no longer contains today. |
| 65 | PASS | A date outside the window is `400 outside_roster_window` carrying the window, in both lookup forms, never a `404`. |
| 66 | PASS | The swap rate is a constant `0`, absent from `config.ts` and `.env.example` so a deployment cannot raise it, and no duty changes status mid-run over the whole roster. |
| 67 | PASS | A coach at a meal halt is `live`, `STOPPED_AT`, at zero speed, with a non-null `dwell` and a null `tracking.reason`. |
| 68 | PASS | `endsAtUncertaintySeconds` is present and non-zero on every dwell, and is floored in the cursor so a zeroed configuration cannot produce a certain number. |
| 69 | PASS | A dropout during a halt reports the dropout: the state ages and the reason is set, independently of the dwell. |
| 70 | PASS | Asserted by counting distinct fixes per observed minute while halted against while moving. |
| 71 | PASS | At reserved coverage zero every reserved coach is `untracked` with `position: null` and `no_device_fitted`, and no coach entity appears in `vehicle-positions`. |
| 72 | PASS | Reserved 0.92 exceeds ordinary 0.70, ordinary is at or below the city bus's 0.75, and the contrast is observable in the fleet's untracked share, not only in the config. |
| 73 | PASS | Two different coaches on the same corridor go dark over the same intervals of route distance. A Poisson model keyed on the BIN cannot pass it. |
| 74 | PASS | The same coach on two successive service dates goes dark over the same intervals. |
| 75 | PARTIAL | A dark coach inside a zone carries the interval; one outside carries `null` and its recovery cause is `unknown`. **Reaching the second case needed the urban dropout bound raised past the dark threshold**: at the shipped defaults `BUS_DROPOUT_MAX_SECONDS` is 420 and `INTERCITY_DARK_AFTER_SECONDS` is 600, so every `dark` a coach reaches is geographic. That is asserted separately and is a stronger property than the criterion asks for. |
| 76 | PASS | `recovery.gapMetres` is measured between the two published positions, so it agrees to well under a metre by construction, and `gapSeconds` is their true difference. |
| 77 | PASS | Over a full-day sweep of every rostered duty, every predicted arrival carries a finite non-zero band. |
| 78 | PASS | The band is asserted against the configuration rather than against literals, including §5.3's worked example. `predictNextStops`'s hardcoded `45 + index * 30` is removed and now reads the two documented variables. |
| 79 | PARTIAL | Non-increasing for a fixed stand within one run, asserted over samples where the dead-zone multiplier's state is unchanged. The multiplier is a deliberate, published widening (§10.8) and is the one thing that can raise a band; its effect is asserted separately against the configuration rather than allowed to mask a regression. |
| 80 | PASS | Non-decreasing along a trip's stop list at a single instant, over the whole roster. |
| 81 | PASS | Stands beyond the six-hour horizon carry `NO_DATA` with no arrival and no band; the terminal inside it carries both. |
| 82 | PASS | Over a full-day sweep of every reserved duty, **with a sold-out manifest held**, no observation carries an `occupancy` key on any surface. |
| 83 | PASS | `occupancyFor` returns `withheld` on its first branch, before the tracking short-circuit and before any demand function. A source scan asserts `OccupancyOutcome` has no arm carrying a measured figure and `OccupancyInput` has no seat field. |
| 84 | PASS | A config-surface scan finds no variable naming occupancy or a seat count, and an exhaustive sweep of the manifest endpoint's accepted bodies emits none. |
| 85 | PASS | `seatsBooked` is the push's `booked` field, with `seatsTotal`, `asOf`, `ageSeconds` and `covers`. |
| 86 | PASS | A push carrying `simulated: 17` and `booked: 0` stores and publishes `seatsBooked: 0`; `held` and `simulated` are recorded and appear in no response. |
| 87 | PASS | A push whose `asOf` is not strictly newer is accepted with `200`, discarded, and the response names the manifest still held. Asserted by pushing a cancel and a confirm out of order. |
| 88 | PASS | Past its own TTL or past `INTERCITY_MANIFEST_MAX_AGE_SECONDS` the `manifest` key disappears entirely, with no reason and no last-known count. |
| 89 | PASS | No `OccupancyStatus` is emitted for a reserved duty at any manifest value, so the three crowding values are unreachable rather than filtered. |
| 90 | PASS | `ADMIN_TOKEN` on `/fleet/manifest` is `401`; `MANIFEST_TOKEN` on `/admin/scenario` is `404`; an unset `MANIFEST_TOKEN` makes the manifest path a `404` rather than a `401`. |
| 91 | PASS | The 00:30 relief resolves to the previous service date and the response echoes both dates, the duty id and the note. |
| 92 | PASS | An unreserved Karnataka Sarige duty carries a modelled occupancy with a percentage, on the same corridor and the same day. |
| 93 | PASS | A coach BIN and a coach plate both resolve `200` with corporation, service class and division hub. A metro BIN is unchanged. |
| 94 | PASS | `duty.route` is null and `duty.corridor` is populated on every coach `200`. On a vehicle with no duty both are null, which is the existing cell-D behaviour rather than a corridor case. |
| 95 | PASS | Three rows for a coach with a known duty - plate, destination, departure - and one for a coach the world has nothing to say about. |
| 96 | PASS | Both forms return byte-identical bodies, and an ISO travel date and a GTFS service date both resolve. |
| 97 | PASS | Beyond the horizon the answer is `200` with `vehicle: null`, `tracking: null` and `assignsAfter`. |
| 98 | PASS | The same BIN across two fresh simulations with the same seed, and a forced substitution returns `superseded` naming the previous BIN. |
| 99 | PARTIAL | Coach entities carry both `license_plate` and `label`; bus entities carry a plate and no label. **The metro third is not reachable** - see criterion 34. |
| 100 | PASS | A coach in a dead zone carries a `TripUpdate` with predictions and a widened band, and a `VehiclePosition` whose timestamp is genuinely older than `INTERCITY_DARK_AFTER_SECONDS`. Both halves are asserted in one test so the split cannot slide into loosening both. |
| 101 | PASS | `trip.start_date` is the service date, the static calls run past `24:00:00`, and the realtime `StopTimeEvent.time` is an unambiguous POSIX instant. |
| 102 | PASS | `occupancy_status` is absent, not `NO_DATA_AVAILABLE`, on every reserved coach entity including one holding a sold-out manifest, and the string `bookings_through_this_network_only` appears nowhere in the encoded feed. |
| 103 | PASS | A simulation that watched the whole run and one that booted seven hours in produce identical logs, by replay on a fixed simulated-time grid. |
| 104 | PASS | Two fresh simulations produce byte-identical `/fleet/corridors`, identical assignments, identical plates, and byte-identical observations at the same instant. |
| 105 | PASS | `INTERCITY_CORRIDORS` is unset in the test environment, so the sixteen bus goldens run against the default configuration unchanged, and a scan asserts none of the ten new field names reached a committed bus body. |
| 106 | NOT MET | `SIM_SPEEDUP` bucketing on simulated elapsed time landed in the previous pass for the bus model. A coach's own draws live on a replay grid measured from its departure and are unaffected by `SIM_SPEEDUP` at all, which is stronger than the criterion asks for but is not the same statement, and no test drives a coach at a speedup. |
| 107 | PASS | The existing `.env.example` equality test covers every new variable, and a second test asserts the intercity subset specifically and that `INTERCITY_DUTY_SWAP_RATE_PER_DAY` appears in neither file. |
| 108 | PASS | Unchanged. `Math.random` appears nowhere in `src/` and no vehicle-class branch was added outside the three profile modules. |
| 109 | PASS | A source scan finds no outbound HTTP client in `src/` other than `GTFS_SOURCE=url`'s loader, which criterion 44 already records. |

## What stages 4 to 9 did not build

- **Stage 9's metro third.** Both GTFS-Realtime feeds are built, which stage 9
  needed and SPEC's own stage 7 had not landed. Metro trains are not entities
  in them, because the metro simulation has no per-train vehicle to describe.
- **The other four fixture corridors** of §13.1, and with them criterion 52's
  independent check of the routing pipeline against OSM relation `15728171`.
- **The eight coach goldens** of §13.4, which are stage 11.
- **`/admin/scenario`**, which SPEC's own increment deferred and which §10.6
  would extend with `deadZone` and `halt` targets.
