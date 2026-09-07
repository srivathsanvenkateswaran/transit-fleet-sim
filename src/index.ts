import { createApiServer } from './api/server.js'
import { config } from './config.js'
import { generateCoachFleet, generateFleet } from './fleet/generate.js'
import { FleetRegistry } from './fleet/registry.js'
import { loadGtfs } from './geometry/loadGtfs.js'
import { log } from './log.js'
import { computeRouteRosterSizes } from './sim/busRoster.js'
import { createClock } from './sim/clock.js'
import { defaultScheduleProfile } from './sim/coachProfiles.js'
import { coachSlotsFor, createWorld, loadIntercity } from './sim/world.js'

// docs/intercity-coaches.md §3.5: the coach fleet size falls out of the
// roster rather than being configured, so the roster has to be read before
// identity is generated - the registry must already contain a coach for
// `/fleet/resolve` to answer about one. §14.1: with INTERCITY_CORRIDORS unset
// this is null and `coaches` is empty, so the fleet is byte-for-byte the
// thirty buses it is today.
const intercity = await loadIntercity()
// Loaded once, here, so both the schedule-derived roster below and
// `createWorld` read the exact same parse of the (September 2026 expansion's
// several-hundred-route) bundle rather than paying to parse it twice.
const gtfs = await loadGtfs()
// September 2026 coverage expansion (see scripts/build-bundle.ts and
// src/sim/busRoster.ts): each route's bus count comes from its own real GTFS
// timetable - the fewest vehicles that could run that route's actual trips
// back to back - rather than one flat BUSES_PER_ROUTE for every route from a
// once-a-day branch pattern to an all-day trunk corridor.
const busRosterSizes = computeRouteRosterSizes(gtfs, config.busRoutes, {
  turnaroundSeconds: config.busTerminalLayoverSeconds,
  minimumPerRoute: config.busRosterMinPerRoute,
  scale: config.busRosterScale,
})
// One plate pool shared between the two fleets: KSRTC coaches draw from the
// same `01` RTO district BMTC buses do (`DISTRICT_CODE_BY_CORPORATION`), and
// `FleetRegistry` refuses two vehicles sharing a normalised plate. At the
// original 60 buses that pool was sparse enough for a coincidence never to
// surface; at the several-hundred-bus roster the coverage expansion now
// generates, generating buses and coaches against two independent `Set`s
// produced exactly that collision on this project's own first run at scale -
// see `generateCoachFleet`'s doc comment for the full story.
const usedPlates = new Set<string>()
const buses = generateFleet({
  usedPlates,
  busesPerRouteByRoute: new Map(
    [...busRosterSizes.values()].map((size) => [size.routeNumber, size.vehicles]),
  ),
})
const coaches =
  intercity === null
    ? []
    : generateCoachFleet({
        usedPlates,
        slots: coachSlotsFor(
          intercity,
          config.intercityCorridors,
          createClock(config.simClock).now(),
          config.intercityRosterDays,
          defaultScheduleProfile,
        ),
      })
const fleet = [...buses, ...coaches]
const registry = new FleetRegistry(fleet)
const world = await createWorld(fleet, intercity, gtfs)
await world.start()
const server = createApiServer(world, registry, {
  ...(world.coaches === null ? {} : { intercity: world.coaches }),
})
const status = world.status(world.now())
const untracked = fleet.filter(
  (vehicle) => world.observe(vehicle.bin, world.now())?.tracking.state === 'untracked',
).length
log('info', 'geometry_loaded', { source: config.gtfsSource, routes: status.routes })
log('info', 'fleet_generated', {
  buses: buses.length,
  coaches: coaches.length,
  tracked: fleet.length - untracked,
  untracked,
  // How many of the configured routes actually carried a real trip in the
  // bundled GTFS - a route requested but rostered at zero real trips still
  // gets `busRosterMinPerRoute` vehicles (see busRoster.ts), so this is the
  // number worth watching for "did the route selection actually resolve",
  // not the vehicle count itself.
  busRoutesConfigured: config.busRoutes.length,
  busRoutesWithRealTrips: [...busRosterSizes.values()].filter((size) => size.realTripCount > 0).length,
})

server.listen(config.port, config.host, () => {
  log('info', 'listening', { seed: status.seed, host: config.host, port: config.port })
  log('info', 'ready', { tickMs: config.simTickMs, tickLagMs: world.status(world.now()).tickLagMs })
})

async function shutdown(): Promise<void> {
  server.close()
  await world.stop()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
