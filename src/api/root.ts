import { config } from '../config.js'

export function root(intercityEnabled = false) {
  return {
    name: 'transit-fleet-sim',
    description: intercityEnabled
      ? 'Simulated bus, metro and intercity coach fleet for Karnataka'
      : 'Simulated bus and metro fleet for Bengaluru',
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
      {
        method: 'GET',
        path: '/gtfs-rt/vehicle-positions',
        description: 'GTFS-Realtime VehiclePosition feed',
        example: '/gtfs-rt/vehicle-positions?class=coach',
      },
      {
        method: 'GET',
        path: '/gtfs-rt/trip-updates',
        description: 'GTFS-Realtime TripUpdate feed',
        example: '/gtfs-rt/trip-updates',
      },
      // docs/intercity-coaches.md §10.7: the three intercity paths appear on
      // discovery only when they exist. With `INTERCITY_CORRIDORS` unset they
      // are an ordinary 404, and advertising a path that answers 404 would be
      // worse than not advertising it.
      ...(intercityEnabled
        ? [
            {
              method: 'GET',
              path: '/fleet/duty',
              description: 'Which vehicle is running a service on a date, and where it is',
              example: '/fleet/duty?service=2259BNGHMP&date=2026-09-05',
            },
            {
              method: 'GET',
              path: '/fleet/corridors',
              description: 'Intercity corridors, their geometry provenance and today’s departures',
              example: '/fleet/corridors',
            },
            {
              method: 'PUT',
              path: '/fleet/manifest',
              description:
                'Booking count pushed by a ticketing peer, keyed on (serviceId, travelDate). Gated on MANIFEST_TOKEN.',
              example: 'PUT /fleet/manifest',
            },
          ]
        : []),
      { method: 'GET', path: '/healthz', description: 'Liveness probe' },
      { method: 'GET', path: '/readyz', description: 'Readiness probe' },
    ],
    /**
     * §8.1: "The suggested poll interval is published rather than left to
     * folklore." An overnight rider polls nothing for six hours and opens the
     * phone once at 05:40; designing for a ten-second poll would guarantee a
     * dead battery by 04:00.
     */
    ...(intercityEnabled ? { suggestedPollSeconds: config.intercitySuggestedPollSeconds } : {}),
    meta: {
      simulated: true,
    },
  }
}
