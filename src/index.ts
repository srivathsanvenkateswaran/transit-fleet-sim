import { createApiServer } from './api/server.js'
import { config } from './config.js'
import { generateFleet } from './fleet/generate.js'
import { FleetRegistry } from './fleet/registry.js'
import { log } from './log.js'
import { createWorld } from './sim/world.js'

const fleet = generateFleet()
const registry = new FleetRegistry(fleet)
const world = await createWorld(fleet)
await world.start()
const server = createApiServer(world, registry)
const status = world.status(world.now())
const untracked = fleet.filter(
  (vehicle) => world.observe(vehicle.bin, world.now())?.tracking.state === 'untracked',
).length
log('info', 'geometry_loaded', { source: config.gtfsSource, routes: status.routes })
log('info', 'fleet_generated', {
  buses: fleet.length,
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
