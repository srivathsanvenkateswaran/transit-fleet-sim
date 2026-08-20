import { createApiServer } from './api/server.js'
import { config } from './config.js'
import { generateFleet } from './fleet/generate.js'
import { FleetRegistry } from './fleet/registry.js'
import { createWorld } from './sim/world.js'

const fleet = generateFleet()
const registry = new FleetRegistry(fleet)
const world = await createWorld(fleet)
await world.start()
const server = createApiServer(world, registry)

server.listen(config.port, config.host, () => {
  process.stdout.write(`transit-fleet-sim listening on ${config.host}:${config.port}\n`)
})

async function shutdown(): Promise<void> {
  server.close()
  await world.stop()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
