# transit-fleet-sim performance audit (2026-09-07)

Research only. Nothing in this document has been applied. Branch `research/perf-audit-2026-09-07`. The cross-service summary and the platform findings are in `Tatak/docs/perf-audit-2026-09-07.md`.


All numbers below are measured on this machine (Apple Silicon, macOS, Node v26.5.0), running the
actual compiled `dist/src/index.js` the Dockerfile ships, not `tsx watch` (which reports a
different, misleading RSS because it's a wrapper process around the real worker). Where a number
can't be produced offline  -  Heroku's cgroup memory accounting, shared-CPU throttling, real request
concurrency  -  that's called out rather than guessed.

## Correction against production before reading further

The measurements below were taken with the repository's default `BUS_ROUTES` (391 routes, 1,376 buses) and 8 corridors. The deployed `tatak-fleet-sim` dyno does not run that: its Heroku config sets `BUS_ROUTES` to 69 routes with `BUSES_PER_ROUTE=6` and 12 corridors, and its boot log on 2026-09-07 12:02 UTC reads `buses:644, coaches:169, tracked:657, untracked:156`. Re-running the compiled build locally with exactly the production env gives:

| Production-like env (69 routes, 12 corridors) | value |
|---|---|
| buses / coaches generated | 644 / 169 (matches the dyno's own log) |
| RSS after 45 s idle | 262 MB |
| Headroom on a 512 MB Eco dyno | ~250 MB |

So finding 1 (RSS at 460 MB, ~50 MB headroom) describes what would happen if the repo default were deployed, not what is deployed. The fleet dyno is not at its memory ceiling today. Everything else in the audit (the `Intl.DateTimeFormat` hot spots, the duplicate metro topology, the per-request feed rebuild) is independent of fleet size and stands. Do not raise `BUS_ROUTES` on Heroku towards the repo default without re-measuring: 1,376 buses plus coaches was measured at 457-460 MB.

Also: the fleet endpoints Tatak calls answer in about 1 ms on the dyno (Heroku router, 369 samples of `/fleet/resolve`, ~300 of `/fleet/vehicle/.../position`). This service is not why the app feels slow. Its only visible cost is that its Eco dyno sleeps, which is covered in the platform section of the Tatak document.

## What got heavier, and why (measured at repo defaults, see correction above)

The headline is not the coaches. Three days ago a separate commit, in the same window, put the bus
fleet on a schedule-derived roster across every real BMTC route instead of a fixed ten-route demo
list:

- `0365c3b` "Put a bus on every route a rider round here actually takes" (2026-09-06) changed
  `BUS_ROUTES` from 10 routes (`500-D,500-A,G-4,335-E,401-K,KIA-4,KIA-8,KIA-9,KIA-10,KIA-15`) to
  391 routes, and replaced the flat `BUSES_PER_ROUTE=6` with a per-route roster computed from real
  GTFS trip density (`src/sim/busRoster.ts`). At `BUSES_PER_ROUTE=6` × 10 routes the old fleet was
  exactly 60 buses, matching what the owner remembers. Today it boots **1,376 buses**.
- The intercity work landed on top of that already-23x-larger base: 122 coaches, a 393-duty
  three-day roster, 35 duties running at any moment, over 8 corridors.

| Measurement | No intercity (1,376 buses) | With intercity (1,376 buses + 122 coaches) |
|---|---:|---:|
| Boot time (compiled `dist`, cold) | ~3.0 s | ~4.5 s |
| RSS, settled | ~275 MB | ~457-460 MB |
| RSS headroom on a 512 MB Eco dyno | ~237 MB | **~52-55 MB** |
| Idle CPU (60 s, no requests) | ~0.0% avg | ~0.3% avg |
| `/fleet/resolve` (bus) | 0.6 ms | 0.6 ms |
| `/fleet/vehicle/{bin}/position` (bus) | 0.6 ms | 0.6 ms |
| `/fleet/vehicle/{bin}/position` (coach) | n/a | 0.8 ms |
| `/fleet/duty/{id}` (coach) | n/a | 0.5 ms |
| `/fleet/metro/arrivals` | **18-20 ms** | **18-20 ms** |
| `/fleet/corridors` (not called by Tatak) | n/a | 1-2.4 ms |
| `/gtfs-rt/vehicle-positions` (not called by Tatak) | 50-63 ms, 101 KB | 50-75 ms, 107 KB |
| `/gtfs-rt/trip-updates` (not called by Tatak) | 88-92 ms, 523 KB | 103-109 ms, 533 KB |

All timings are curl `time_total`, 5 runs, median reported (they were tight  -  max/min spread under
15%). `/fleet/resolve`, `/fleet/vehicle/{bin}/position`, and `/fleet/duty` are the endpoints Tatak
actually calls (confirmed against `src/live/http.ts`, `src/fleet/http.ts` in the Tatak repo  -  no
`gtfs-rt` fetch exists there, and `/fleet/corridors` is mentioned only in a comment). Those three
are fast and stayed fast after the intercity change: registry lookups are `Map`-based (O(1)),
and the coach "replay" is memoised and stays warm once a duty is ticked. **The real cost of the
last three days is memory, boot time, and one specific endpoint, not per-vehicle-lookup latency.**

The bus GTFS bundle itself grew to match: `shapes.txt.gz` 121 KB → 2.6 MB, `stop_times.txt.gz`
389 KB → 1.9 MB (`git show 0365c3b --stat`). Parsing that is most of what boot-time CPU goes to
(confirmed with a `--cpu-prof` capture  -  see finding 6).

## Ranked findings

### 1. RSS sits at ~460 MB on a 512 MB dyno  -  this is almost certainly the "feels slow" (risky, un-shipped as-is / needs a decision)

**Evidence.** `node dist/src/index.js` with the exact intercity env from the brief settles at
457-460 MB RSS after 60 s idle, measured twice independently (`ps -o rss`). Heroku Eco dynos are
512 MB total, shared with the OS and any Docker/Heroku process overhead. That leaves roughly
50 MB of headroom for: the ~530 KB JSON responses this service already builds, V8's own GC
overhead (which needs headroom to avoid full-heap collections on every allocation), and any burst
in concurrent requests. A dyno that's this close to its memory ceiling on a *shared* CPU tier
degrades in a specific, recognisable way  -  GC pause frequency goes up as available headroom drops,
and if Heroku's memory quota is actually exceeded (R14) the OS starts swapping or the dyno gets
recycled, both of which look exactly like "the deployed system feels slow" from the outside.

Without intercity the same process settles at ~275 MB  -  comfortable. Intercity itself adds
~180 MB: `corridor-topology.json` (2.1 MB on disk, but shape/segment arrays balloon substantially
once parsed into per-point JS objects across 8 corridors), the 393-duty roster with a
`ScheduledCall` per stand per duty, and 122 coaches' duty/device state.

**Impact:** high  -  this is a capacity-limit problem, not a hot-loop problem. It's the most likely
explanation for "feels slow" given everything else measured cleanly.

**Concrete change:** no code change is "safe now" here  -  the two real levers are (a) move to a
larger dyno tier, or (b) cut what's held in memory (see findings 2 and 6, which both reduce this
without changing behavior). I'd ship 2 and 6 first, remeasure RSS, and only then decide whether a
dyno upgrade is still needed.

**Risk:** informational finding, not a patch. The decision (upgrade dyno vs. trim memory vs. both)
needs the owner.

**Verify:** `ps -o rss` on the running dyno (`heroku ps:exec`, or watch `heroku logs` for R14/R15
lines), or repeat the local measurement above after any memory-reducing change lands.

---

### 2. Boot-time GTFS parsing is now the dominant CPU cost, and it's driven by the 391-route expansion, not intercity (medium)

**Evidence.** A 120 s `--cpu-prof` capture (server booted, then hit with a request-load loop) shows
the *non-idle* CPU dominated by `csv-parse`'s row parser (`__onRecord`, `parse`), `haversineMetres`
(`src/geometry/haversine.ts:3`), and `projectStop` (`src/geometry/projectStops.ts:1`)  -  all boot-time
GTFS ingestion for `loadGtfs()` (`src/geometry/loadGtfs.ts`). `stop_times.txt` alone is now parsed
row-by-row through `csv-parse`, filtering to the wanted trip IDs *after* each row is fully parsed  - 
`files.rows('stop_times.txt', (row) => tripIds.has(...))` in `src/geometry/loadGtfs.ts:91` still pays
the parse cost for every row in the file before the predicate discards it.

Boot time went from ~3.0 s (no intercity) to ~4.5 s (with intercity, dist build)  -  the extra 1.5 s
is `corridor-topology.json` (2.1 MB) plus `buildRoster`/`assignFleet` over 393 duties, not the bus
side. On Heroku this matters less for a running dyno, but it directly extends how long a
cold-started Eco dyno (30 min idle → sleep) takes to answer its first real request, and this is one
piece of that.

**Impact:** medium. Doesn't affect steady-state request latency, but affects every cold start, and
Eco dynos cold-start often.

**Concrete change (safe-now):** none required to ship  -  this is inherent to the bundle size the
route-expansion commit chose. If boot time on cold start becomes a real problem, the actual lever
is trimming `BUS_ROUTES` or `BUS_ROSTER_SCALE` (already a supported env knob,
`src/sim/busRoster.ts`), which is a data/config decision for the owner, not a code fix.

**Risk:** n/a (no code change proposed here).

**Verify:** `time node dist/src/index.js` (kill after "ready" logs), or repeat the `--cpu-prof`
capture.

---

### 3. `/fleet/metro/arrivals` costs 18-20 ms per request, entirely from constructing `Intl.DateTimeFormat` in a loop (safe-now)

**Evidence.** `src/sim/metro.ts`'s `candidates()` (lines 141-171) walks every scheduled departure
from first train to last train, once per direction, calling `isPeak()` → `localMinutes()` →
`localParts()` on each iteration (`src/sim/metro.ts:270-278`). `localParts` constructs a **new**
`new Intl.DateTimeFormat(...)` every call (line 265). With headways of 480-720 s over an
~18-hour service window, that's roughly 200-300 iterations per request, each building a fresh
formatter.

Isolated microbenchmark, 300 `Intl.DateTimeFormat` constructions + `formatToParts` calls:
**19.4 ms**  -  matches the measured endpoint latency (18-20 ms, 5/5 runs, both with and without
intercity) almost exactly. This is the actual cost, not fleet size: the endpoint is exactly as slow
with 0 coaches as with 122.

This is a real regression from the last three days: `26de1a5` "Open and close the metro on its real
timetable" (2026-09-06) is what introduced the per-request departure walk. Before that commit, metro
arrivals presumably didn't compute a full-day timetable per request.

**Impact:** medium-high for this specific endpoint. It's one of the four endpoints Tatak actually
calls, and 18-20 ms is 20-30x slower than the other three (all sub-millisecond). At any real
request volume this is the one place a shared-CPU Eco dyno would visibly show up in Tatak's own
latency graphs for a fleet-sim call.

**Concrete change:** cache the `Intl.DateTimeFormat` instance instead of constructing one per call.
`Intl.DateTimeFormat` output is a pure function of its constructor args for a given instant, so a
module-level `Map<timezone, Intl.DateTimeFormat>` (there's only ever one timezone,
`SIM_TIMEZONE`, in practice) makes `localParts` reuse one formatter across all calls with byte-identical
output. Apply the same fix to the same pattern in `src/sim/profile.ts:69` and
`src/sim/occupancy.ts:328` (see finding 4)  -  all three are the same bug shape.

**Risk:** safe-now. Pure refactor, zero output change (Intl.DateTimeFormat has no internal state
that depends on call history), and every existing golden/contract test that pins metro-arrivals
output would still pass since the computed values are identical  -  only re-derived without
reallocating the formatter.

**Verify:** `npm test` (in particular `tests/api/metroArrivals.test.ts`), then re-run the curl
timing above and confirm it drops toward ~1 ms.

---

### 4. The same `Intl.DateTimeFormat`-per-call pattern also runs on the hot path for every bus, continuously, not just on request (safe-now)

**Evidence.** `src/sim/profile.ts:68-82`'s `isPeak()`  -  called from `drawBusSpeedKph`, which fires
every time any bus finishes a segment and needs its next speed draw (`src/sim/cursor.ts:98`, inside
`advanceCursor`, which the tick loop calls for all 1,376 buses every second)  -  constructs a fresh
`Intl.DateTimeFormat` **and** re-parses `profile.peakWindows.split(',')` on every single call. This
isn't gated behind an HTTP request at all: it runs continuously as the simulation advances, for
every bus, at every stop.

The `--cpu-prof` capture (finding 2) shows `isPeak @ profile.js:29` at 140 self-hits and
`localMinutes @ occupancy.js:183` at 31  -  both real, both firing during ordinary ticking, not just
under the request-load loop that was running at the time. `src/sim/occupancy.ts:327-337` has an
identical `localMinutes`/`Intl.DateTimeFormat` construction, called from `occupancyFor` on every
`observe()`  -  i.e., on every `/fleet/resolve` and `/fleet/vehicle/.../position` request too, which
is why those endpoints cost ~0.6-0.8 ms rather than the ~0.1 ms a pure map lookup would take.

Also worth noting in passing: `config.busPeakWindows` (`src/config.ts:212`) is stored as the raw
string `'07:00-10:00,17:00-21:00'` and re-parsed (`split`, `split`, two `Number()` calls) on every
`isPeak` call rather than once at config load  -  a second, smaller inefficiency in the same
function.

**Impact:** medium. Each individual call is cheap (sub-millisecond), which is why idle CPU measured
near-zero  -  but this now runs across 1,376 buses continuously (23x more often than three days ago,
because that's how much the fleet grew), all day, on a dyon whose CPU is shared with other tenants.
It's background cost, not request-time cost, so it won't show up in an endpoint timing test, but it
is exactly the kind of thing that keeps an Eco dyno "busy" and therefore unable to sleep, and adds
up under `%CPU` on a constrained tier even when nobody is polling the API.

**Concrete change:** same fix as finding 3  -  a shared, cached-formatter helper (one module, reused
by `metro.ts`, `profile.ts`, `occupancy.ts`, and the two other `Intl.DateTimeFormat` call sites in
`serviceDate.ts` and `errors.ts` if they're ever proven hot). For `profile.ts` specifically, also
parse `peakWindows` once into `{start, end}[]` at config load time instead of on every call.

**Risk:** safe-now for the formatter caching (same reasoning as finding 3). Pre-parsing
`peakWindows` once is also safe but touches `config.ts`'s shape slightly  -  do it as a derived value
alongside `busPeakWindows`, not by changing what the raw string means.

**Verify:** `npm test` (`tests/sim` covers `profile.ts`/`occupancy.ts` behavior via bus/coach
determinism tests), then re-run the 60 s idle CPU measurement and confirm `ps -o %cpu` doesn't
regress (it's already near-zero locally, so the real confirmation is on Heroku: watch dyno CPU
metrics before/after).

---

### 5. `/gtfs-rt/vehicle-positions` and `/gtfs-rt/trip-updates` rebuild the entire fleet's entities from scratch on every request (medium  -  but currently unused by Tatak)

**Evidence.** `buildFeedEntities` (`src/api/gtfsRealtime.ts:125-215`) iterates
`registry.vehicles` (all 1,376 buses + 122 coaches), calling `world.observe()` and
`world.scheduleUpdates()` for each one, on every single request. Measured: 50-75 ms / 107 KB for
vehicle-positions, 103-109 ms / 533 KB for trip-updates. The response carries
`cache-control: public, max-age=15` (`src/api/server.ts:221`), which signals an intended 15 s
cache window but there's no server-side memoization backing it  -  every request inside that window
still does the full O(fleet) rebuild; only a downstream HTTP cache honoring that header would ever
avoid it.

Confirmed via `grep` against the Tatak repo (`src/live/http.ts`, `src/fleet/http.ts`,
`app/api/fleet/*`) that Tatak does not call `gtfs-rt` today, so this isn't contributing to the
"feels slow" complaint right now. Flagging it because it scales directly with the fleet size that
just grew 23x, and it's the kind of endpoint a future GTFS-RT consumer (a transit aggregator, a
future Tatak feature) would reach for.

**Impact:** medium, contingent  -  zero today, meaningful if anything starts polling this feed.

**Concrete change (medium, not safe-now  -  needs a decision on staleness tolerance):** memoize the
built entity list keyed on `world.now()` bucketed to the tick, invalidate on the next tick rather
than rebuilding per request. This changes observable behavior subtly (two requests inside the same
tick window return byte-identical output where today they'd already coincidentally match at
`SIM_TICK_MS=1000`, since `world.observe` is itself deterministic per instant)  -  worth a test
before shipping, not a pure refactor.

**Risk:** medium  -  touches a response consumers may already be caching/diffing.

**Verify:** `npm test` (`tests/api/gtfsRealtime.test.ts`), then repeat the curl timing/size
measurements above.

---

### 6. Two independent copies of the metro topology are loaded and held in memory; one is dead (safe-now)

**Evidence.** `src/sim/world.ts`'s `SimWorld` constructor takes `metroTopology` (loaded via
`loadMetroTopology()` in `createWorld`, `src/sim/world.ts:494`) and builds its own `#metro`
(`MetroSimulation` instance, `src/sim/world.ts:135`), exposing a `metroArrivals()` port method
(`src/sim/world.ts:169`). **Nothing calls it**  -  confirmed with
`grep -rn "world.metroArrivals\|\.metroArrivals(" src/` returning no matches outside the method's
own definition. The actual `/fleet/metro/arrivals` route (`src/api/server.ts:189`) calls the
free-standing `metroArrivals()` function in `src/api/metroArrivals.ts`, which does its own
module-level `readFileSync(config.metroTopologyPath)` + `JSON.parse` (line 6) and builds a
**second**, entirely separate `MetroSimulation` instance from the same 306 KB
`metro-topology.json`.

So every boot parses and holds two independent in-memory graphs of the same topology file, and one
of them (`SimWorld.#metro`, and the `metroLines` count derived from it) does nothing for the live
API except appear in `/readyz`'s `metroLines` field, which could be read off the topology directly
without keeping a whole unused `MetroSimulation`.

**Impact:** low-medium on its own (one extra ~306 KB JSON parse and object graph at boot,
plus a `MetroSimulation` instance that's never queried)  -  but it's free memory and boot time back,
and it's exactly the kind of duplication worth cutting before deciding whether a dyno upgrade is
needed (finding 1).

**Concrete change:** either (a) delete `SimWorld.#metro` and `metroArrivals()` port method entirely
and have `/readyz`'s `metroLines` come from a lighter read of the topology (station/line count
only, not a full `MetroSimulation`), or (b) have `src/api/metroArrivals.ts` reuse the topology
`SimWorld` already loaded via `world.status()`/a small new accessor instead of loading its own
copy. (a) is the smaller change since the module-level instance already fully replaces (b)'s
functionality today.

**Risk:** safe-now if done as (a)  -  it's dead code removal with no behavioral surface (the
`metroArrivals()` port method has no caller, and `WorldPort`'s type would need the method dropped,
which is a compile-time-checked, mechanical change). Double-check `tests/contract` and
`tests/fakes/coachWorld.ts` don't implement `metroArrivals` in a way that assumes it's load-bearing
before removing it.

**Verify:** `npm run typecheck`, `npm run lint`, `npm test`  -  removing a genuinely-dead method
should compile clean and change zero test outcomes since nothing exercises it end-to-end (route
handler never reaches it).

---

### 7. `/fleet/corridors` does an O(corridors × duties) scan plus a repeat `observe()` per running duty (low risk today, worth a comment)

**Evidence.** `CoachSimulation.corridors()` (`src/sim/coachWorld.ts:509-605`) calls
`this.#duties.filter(...)` and `activeAt(this.#duties, at)` once **per corridor** inside `.map()`
(lines 530, 536), and for each corridor's running duties calls `this.observe(bin, at)` again
(line 540) purely to compute a tracked/untracked coverage share  -  duplicating work the tick loop
already did for the same instant. At today's scale (8 corridors × 393 duties) this measured
1-2.4 ms, genuinely fine. It gets worse linearly with either more corridors or a longer
`INTERCITY_ROSTER_DAYS` window, and Tatak doesn't call this endpoint today (confirmed by grep), so
there's no urgency.

**Impact:** low today, flagged for awareness if corridor count or roster window grows.

**Concrete change (medium, later):** compute `activeAt(this.#duties, at)` once per request and
group by corridor, instead of re-filtering the full duty list inside the corridor loop; and reuse
`tickAt`'s already-warm run state instead of re-observing.

**Risk:** medium  -  touches response-shape-adjacent code, worth a dedicated test pass rather than a
same-day patch.

**Verify:** `npm test tests/sim/corridorRoster.test.ts` and any `/fleet/corridors` contract test,
plus the curl timing above.

---

### 8. Coach replay-catch-up cost: investigated, ruled out as a problem

Given the "replay from departure, memoised" design in `CoachSimulation` (`src/sim/coachWorld.ts`,
`REPLAY_STEP_SECONDS = 15`), I suspected a coach's first observation after a long time on the road
(or right after a cold dyno restart, catching up 35 active duties at once) could be an expensive
synchronous replay blocking the event loop. Measured directly: a duty 9+ hours into a Bengaluru-
Hosapete-Hampi run (`BNG-HSP-20260907-0930`, ~2,160 replay steps) answered its **first**
`/fleet/duty/{id}` request in 4.6 ms cold, 1.2 ms warm. Each `step()` call costs roughly
1.5-2 microseconds  -  cheap enough that even the worst case (a full day's duty replayed from
scratch) stays in single-digit milliseconds. Extrapolated to all 35 currently-active duties
replaying in the same first tick after a cold restart, that's roughly 150 ms of one-time
synchronous work  -  real, but bounded and not a repeat cost. **Not a priority fix.**

---

### 9. Idle tick-loop CPU is genuinely cheap; this was not the bottleneck

`SimWorld.tickAt` (`src/sim/world.ts:344`) is O(buses) every second  -  1,376 iterations of cheap
arithmetic (`advanceCursor`, `updateDevice`, `maybeSwapDuty`)  -  plus `CoachSimulation.tickAt`
calling `activeAt(duties, at)` twice per tick (`src/sim/coachWorld.ts:236-240`, a trivial
double-scan of 393 duties that's not worth touching). Measured over 60 s of pure idle (no HTTP
requests): RSS stayed flat, cumulative CPU time grew ~0.2 s over 60 ticks  -  **~0.33% average CPU**.
This rules out the tick loop itself as the "feels slow" cause; the real costs are the ones in
findings 1-4 (memory footprint, boot time, and specific per-request/per-draw hot paths).

## What I could not measure

- **Actual Heroku Eco dyno behavior** (shared-CPU throttling, cgroup memory accounting, whether R14
  quota-exceeded events are actually firing)  -  I only have local `ps`/`--cpu-prof` numbers on
  different hardware. The RSS numbers (finding 1) are the most transferable since they measure
  actual bytes resident, not CPU-relative timing; the CPU/latency numbers should be read as
  "which code paths are expensive relative to each other," not as literal Heroku milliseconds.
- **Sustained/concurrent request load.** All endpoint timings are sequential curls, not concurrent
  load. `REQUEST_TIMEOUT_MS=5000` and Node's single-threaded event loop mean many concurrent
  `/gtfs-rt/trip-updates` requests (103 ms of synchronous-ish work building a 533 KB payload each)
  would serialize and could show real queueing under load, but I didn't load-test that.
  `/fleet/metro/arrivals` at ~19 ms is the one Tatak-facing endpoint where this is worth
  worrying about; the fix in finding 3 removes most of that 19 ms regardless.
- **Whether the `coaches: 70` figure in the brief still matches the current committed fixtures.**
  This run consistently produced `coaches: 122` / `coachesRostered: 393` against the exact env in
  the brief, on a clean `git status` tree at `3987e04`. Worth a quick sanity check with the owner  - 
  either the 70 figure predates `fd6f33c` "Rechain the demo coaches onto hubs Tatak knows" (the
  most recent commit, same day), or something else shifted it. Not a performance finding, flagging
  it because a startup-log number that no longer matches what's documented is worth knowing about.
- **A GC-trace-level breakdown of the 460 MB RSS** (how much is GTFS shapes vs. corridor topology
  vs. duty/roster objects vs. V8 baseline). RSS was measured as one number; a heap snapshot would
  localize it further but wasn't taken (would require instrumenting the process, which felt like
  more invasive tooling than this read-only audit called for).

## Go rewrite

Not warranted, for any piece. The measured hot spots (findings 3, 4) are `Intl.DateTimeFormat`
misuse  -  a JS-specific footgun with a trivial JS-specific fix, not evidence of a language-level
ceiling. The tick loop is already cheap at 1,376 vehicles (finding 9). The one real constraint  - 
memory footprint on a 512 MB dyon (finding 1)  -  is about how much GTFS/corridor data this process
chooses to hold in memory and how, not about Node's per-object overhead being categorically wrong
for the job; a smaller Go process holding the same shape/topology data structures would still need
to hold that data, and V8 object overhead isn't the dominant term here (390 routes' worth of GTFS
CSV rows are). Cutting finding 6's duplication and fixing findings 3-4 gets real memory and CPU
back for free; if RSS is still tight after that, the cheaper next step is trimming `BUS_ROUTES` /
`BUS_ROSTER_SCALE` or moving up a dyno tier, both configuration decisions, before reaching for a
rewrite in a different language.
