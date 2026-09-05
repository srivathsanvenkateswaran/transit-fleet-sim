import { createApiServer } from './api/server.js'
import { config } from './config.js'
import { generateCoachFleet, generateFleet } from './fleet/generate.js'
import { FleetRegistry } from './fleet/registry.js'
import { log } from './log.js'
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
const buses = generateFleet()
const coaches =
  intercity === null
    ? []
    : generateCoachFleet({
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
const world = await createWorld(fleet, intercity)
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
