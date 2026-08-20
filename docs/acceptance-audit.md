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
| 30 | NOT MET | GTFS-Realtime is ordered after metro. |
| 31 | NOT MET | GTFS-Realtime is ordered after metro. |
| 32 | NOT MET | GTFS-Realtime is ordered after metro. |
| 33 | NOT MET | GTFS-Realtime is ordered after metro. |
| 34 | NOT MET | GTFS-Realtime is ordered after metro. |
| 35 | NOT MET | GTFS-Realtime is ordered after metro. JSON predictions already carry non-zero uncertainty. |
| 36 | NOT MET | GTFS-Realtime is ordered after metro. JSON prediction uncertainty is non-decreasing. |
| 37 | NOT MET | GTFS-Realtime is ordered after metro. |
| 38 | NOT MET | GTFS-Realtime is ordered after metro. JSON predictions already omit unknown duty. |
| 39 | NOT MET | GTFS-Realtime is ordered after metro. |
| 40 | PARTIAL | Metro topology and JSON arrivals are built. GTFS-Realtime remains ordered next. |
| 41 | PASS | A test parses `src/config.ts` and `.env.example` and requires their variable sets to be identical. |
| 42 | PARTIAL | Executable source is clean and enforced. Planning documents necessarily contain the forbidden words while stating this rule, so a literal whole-repository grep would flag the specification itself. |
| 43 | PASS | ESLint and a source-scan test independently forbid unseeded random calls. |
| 44 | PARTIAL | Bundled mode makes no outbound call. The explicitly required `GTFS_SOURCE=url` loader uses an outbound fetch, contradicting this literal criterion. |
| 45 | PASS | A source-scan test keeps explicit class comparisons out of shared code and outside the three profile modules. |

## Increment boundary

The service intentionally does not register `/fleet/routes`, `/admin/scenario`
or GTFS-Realtime routes. They return the same ordinary `404` as any unknown
path and have no TODO stubs. GTFS-Realtime is next, matching section 16.2.
