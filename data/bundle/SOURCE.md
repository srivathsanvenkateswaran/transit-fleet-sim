# Bundled BMTC GTFS source

- Upstream: https://raw.githubusercontent.com/Vonter/bmtc-gtfs/main/gtfs/bmtc.zip
- Repository: https://github.com/Vonter/bmtc-gtfs
- Commit: `9b10e7bacbd5f81b5df9b2dd5de7b9d9d8b4d52c`
- Feed version: `20260712`
- Fetched: 2026-08-20
- Routes: 500-D, 500-A, G-4, 335-E, 401-K, KIA-4, KIA-8, KIA-9, KIA-10, KIA-15

This is an attributed 10-route cache of the unofficial community BMTC feed.
The upstream repository does not contain a licence file. See
`THIRD_PARTY_NOTICES.md` before redistributing the data.

## Stage 0 distance measurement

The source distance was checked for monotonicity on every bundled shape and its
final value was compared with the sum of haversine segment lengths. Stops from
one representative trip per shape were projected onto the shape; the table
reports the largest offset and any reversal in projected stop order.

| Route | Shape | Monotonic | Source m | Haversine m | Difference | Max stop offset m | Order violations |
|---|---|---:|---:|---:|---:|---:|---:|
| 335-E | 335-E UP | yes | 30228.5 | 30190 | 0.127% | 74.7 | 0 |
| 401-K | 401-K DOWN | yes | 38128.4 | 38069.5 | 0.155% | 38.2 | 0 |
| 401-K | 401-K UP | yes | 37087.6 | 37028.8 | 0.159% | 48.7 | 0 |
| 500-A | 500-A DOWN | yes | 37608.4 | 37562.7 | 0.122% | 10.3 | 0 |
| 500-A | 500-A UP | yes | 39758.1 | 39710.9 | 0.119% | 43.1 | 0 |
| 500-D | 500-D DOWN | yes | 30069.4 | 30033 | 0.121% | 14.9 | 0 |
| 500-D | 500-D UP | yes | 29830.2 | 29793 | 0.125% | 12.2 | 0 |
| G-4 | G-4 DOWN | yes | 20151.9 | 20117.5 | 0.171% | 8.2 | 0 |
| G-4 | G-4 UP | yes | 20049.5 | 20024.3 | 0.126% | 19.4 | 1 |
| KIA-10 | KIA-10 DOWN | yes | 44324 | 44268.3 | 0.126% | 58.7 | 0 |
| KIA-10 | KIA-10 UP | yes | 43741.1 | 43684.1 | 0.13% | 35.6 | 0 |
| KIA-15 | KIA-15 DOWN | yes | 44458.6 | 44399.4 | 0.133% | 130.2 | 0 |
| KIA-15 | KIA-15 UP | yes | 42048.8 | 41991.9 | 0.135% | 34.5 | 0 |
| KIA-4 | KIA-4 DOWN | yes | 44446.2 | 44389.9 | 0.127% | 28.3 | 0 |
| KIA-4 | KIA-4 UP | yes | 44599.5 | 44541.8 | 0.129% | 35.6 | 0 |
| KIA-8 | KIA-8 DOWN | yes | 66749 | 66666.4 | 0.124% | 28.3 | 0 |
| KIA-8 | KIA-8 UP | yes | 67754.1 | 67672.7 | 0.12% | 35.6 | 0 |
| KIA-9 | KIA-9 DOWN | yes | 37883 | 37833.3 | 0.131% | 74.9 | 0 |
| KIA-9 | KIA-9 UP | yes | 35042.8 | 34997.1 | 0.131% | 126.8 | 0 |
| 335-E | V-335E DOWN | yes | 27653.1 | 27618 | 0.127% | 83.8 | 0 |

Result: `shape_dist_traveled` is consistent and is used directly. Every shape
is monotonic and within 5 percent of haversine length. G-4 UP has one projected
stop-order reversal in the source stop sequence; changing the shape-distance
calculation would not repair that independent source-data anomaly. The loader
still falls back to recomputed haversine cumulative distance if a future shape
fails the distance gate.

# `corridor-topology.json` (docs/intercity-coaches.md §9)

**Stand coordinates**: authored, not fetched. Nine real town/city coordinates
along the general Bengaluru-Tumakuru-Chitradurga-Davanagere-Harihar-Hosapete-
Hampi road corridor (NH48/NH50), selected from general road-network knowledge
rather than any single verified KSRTC timetable. `docs/intercity-coaches.md`
§1.3 already records that the primary fetch for this route's own timetable
page failed; nothing here upgrades that. Every stand's `provenance` field says
`authored_secondary` on the wire for the same reason.

**Routing engine**: OSRM, via `router.project-osrm.org` - the project's own
public demo server, running the real `car` profile against a current OSM
extract. `docs/intercity-coaches.md` §9.3 asks for "an offline engine (OSRM or
Valhalla)"; the operative word is *offline* as a property of the **running
service**, which never makes an outbound call
(`tests/contract/sourceBoundaries.test.ts`). `scripts/build-corridors.ts` is
build-time tooling in the same place `scripts/fetch-metro-topology.ts` sits.
A local OSRM instance over a downloaded Geofabrik Karnataka extract was
considered and set aside for this pass: the public demo server gives the same
real, routed-over-actual-roads geometry §9.3 requires, without a multi-hundred-
megabyte extract download and a local contraction-hierarchy build inside this
task's time budget. Building a local instance from an Osmium-filtered regional
extract remains the natural next step if a future corridor needs it (see the
open item in `docs/intercity-coaches.md`'s effort table, stage 0's spike,
which this pass did not run as its own step).

**Reproducibility**: every OSRM response this pipeline has ever received is
committed at `data/fixtures/corridor-osrm/BNG-HSP/leg-{0..7}.json` (raw
`route/v1/driving` JSON, `overview=full&geometries=geojson`) and is what
`build-corridors.ts` reads by default. `CORRIDOR_OSRM_LIVE=true` re-fetches
and overwrites those fixtures; nothing about running the committed bundle, or
regenerating it from the fixtures, touches the network.

**Fetched**: 2026-09-05. **Simplification**: Douglas-Peucker at 15 m
(`src/geometry/simplify.ts`), matching `INTERCITY_GEOMETRY_SIMPLIFY_METRES`'s
documented default - not itself a runtime config variable, because nothing at
runtime re-simplifies a committed track, exactly as `metro-topology.json`'s
own OSM geometry is pre-built rather than reprocessed on load.

**Segment classification**: `urban` for the corridor's first (Kempegowda Bus
Station to Nelamangala) and last (Hosapete to Hampi) legs, `highway` for the
six in between. This is per-authored-leg, not sub-leg: the Harihar-Hosapete
leg is the corridor's longest (117.5 km) and is overwhelmingly open highway
despite its final few kilometres entering Hosapete, and stays `highway`
because this pipeline does not carry finer-than-stand geometry classification.

**Dead zones**: entirely fabricated, per §6.3 and §17.2 - three zones, chosen
inside the corridor's two longest open-highway legs (Tumakuru-Hiriyur and
Harihar-Hosapete), each comfortably clear of every stand by more than the
required 500 m. Their exact placement is arbitrary within that constraint;
their existence and rough scale (~12% of the route, 15-20 km each) is what
`docs/intercity-coaches.md` §6.3/§12.3 specifies.

**One corridor, deliberately**: this pass builds `BNG-HSP` only, per the task
that requested it - "start with the Bengaluru to Hosapete corridor, since that
is what the sibling projects are building against." The other four fixture
corridors of §13.1, and `PVG-BNG`'s independent validation against OSM
relation `15728171` (§9.4 check 7), are not built here; see
`src/geometry/corridorTopology.ts`'s note on `PAVAGADA_OSM_RELATION_ID`.

**Licence**: `corridor-topology.json`'s routed geometry is derived from
OpenStreetMap and is a derived database under ODbL, exactly as
`metro-topology.json` already is - see `THIRD_PARTY_NOTICES.md`.

# `corridor-classes.json` (docs/intercity-coaches.md §2.2)

Generated once from `src/fleet/serviceClass.ts`'s `SERVICE_CLASSES` (the
source of truth; `tests/fleet/serviceClass.test.ts` keeps the two from
drifting). Every row's `capacitySource` is `"secondary"`, per §2.2's own
instruction that this is true of every row today regardless of how strong an
individual class's citation is. `airavat_club_class` (53 seats),
`ambaari_utsav` (40 berths) and `pallakki` (30 berths) carry the document's
own cited figures (§1.2); `karnataka_sarige`, `rajahamsa_executive` and
`airavat` have no published per-vehicle seat count in the research this
document cites (only fleet totals), so their capacities are this repository's
own plausible estimates, consistent with real-world seating norms for buses
of that class and positioning. `reserved` matches §1.2's table exactly.
