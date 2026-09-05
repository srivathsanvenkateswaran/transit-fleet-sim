/**
 * docs/intercity-coaches.md §9.4, criterion 47: "`check-corridor-topology`
 * passes all seven checks of §9.4 against the bundled topology, and CI runs
 * it." Six of the seven run inside `validateCorridorTopology` (check 7,
 * Pavagada against OSM relation 15728171, has no corridor to run against
 * until `PVG-BNG` is built - see the note on `PAVAGADA_OSM_RELATION_ID` in
 * `src/geometry/corridorTopology.ts`), which `loadCorridorTopology` already
 * runs on every process start. This script exists so CI can run the same
 * gate explicitly and fail the build on it by name, rather than only ever
 * discovering a broken bundle indirectly through
 * `tests/geometry/corridorTopology.test.ts`.
 *
 * (`scripts/fetch-metro-topology.ts` has no equivalent script for its own
 * four-check gate - `metro-topology.json` is validated only by
 * `loadMetroTopology` at load time and by its own test file. This script
 * closes that gap for corridors rather than repeating it, and is wired into
 * `.github/workflows/ci.yml` as its own step for the same reason.)
 */
import { config } from '../src/config.js'
import { loadCorridorTopology } from '../src/geometry/corridorTopology.js'

const topology = await loadCorridorTopology(config.intercityTopologyPath)
console.log(
  JSON.stringify({
    ok: true,
    corridors: topology.corridors.map((corridor) => ({
      id: corridor.id,
      lengthMetres: corridor.lengthMetres,
      stands: corridor.stands.length,
      segments: corridor.segments.length,
      deadZones: corridor.deadZones.length,
    })),
  }),
)
