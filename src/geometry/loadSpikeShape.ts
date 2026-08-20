import { createGunzip } from 'node:zlib'
import { createReadStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'
import { config } from '../config.js'
import { buildShapeIndex, type RawShapePoint, type ShapeIndex } from './shape.js'

interface ShapeRow {
  shape_id: string
  shape_pt_lat: string
  shape_pt_lon: string
  shape_pt_sequence: string
  shape_dist_traveled: string
}

export async function loadSpikeShape(): Promise<ShapeIndex> {
  const rows: ShapeRow[] = []
  const parser = createReadStream(`${config.gtfsPath}/shapes.txt.gz`)
    .pipe(createGunzip())
    .pipe(parse({ columns: true, bom: true, skip_empty_lines: true }))
  parser.on('data', (row: ShapeRow) => rows.push(row))
  await finished(parser)
  const shapeId = rows.find((row) => row.shape_id.startsWith('500-D'))?.shape_id
  if (shapeId === undefined) throw new Error('Bundled shapes.txt.gz is empty')
  const points: RawShapePoint[] = rows
    .filter((row) => row.shape_id === shapeId)
    .map((row) => ({
      lat: Number(row.shape_pt_lat),
      lon: Number(row.shape_pt_lon),
      sequence: Number(row.shape_pt_sequence),
      sourceDistanceMetres: Number(row.shape_dist_traveled),
    }))
  return buildShapeIndex(shapeId, points)
}
