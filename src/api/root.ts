export function root() {
  return {
    name: 'transit-fleet-sim',
    description: 'Simulated bus and metro fleet for Bengaluru',
    endpoints: [
      {
        method: 'GET',
        path: '/fleet/resolve',
        description: 'Resolve a vehicle by BIN or number plate',
        example: '/fleet/resolve?code=BLR-04126&entry=manual',
      },
      {
        method: 'GET',
        path: '/fleet/vehicle/{bin}/position',
        description: 'Single-vehicle position and predictions',
        example: '/fleet/vehicle/BLR-04126/position',
      },
      {
        method: 'GET',
        path: '/fleet/metro/arrivals',
        description: 'Metro station arrivals',
        example: '/fleet/metro/arrivals?station=MTR-PPL-018',
      },
      { method: 'GET', path: '/healthz', description: 'Liveness probe' },
      { method: 'GET', path: '/readyz', description: 'Readiness probe' },
    ],
    meta: {
      simulated: true,
    },
  }
}
