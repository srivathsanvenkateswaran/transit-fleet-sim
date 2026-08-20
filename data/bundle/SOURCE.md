# Bundled BMTC GTFS source

- Upstream: https://raw.githubusercontent.com/Vonter/bmtc-gtfs/main/gtfs/bmtc.zip
- Repository: https://github.com/Vonter/bmtc-gtfs
- Commit: `9b10e7bacbd5f81b5df9b2dd5de7b9d9d8b4d52c`
- Feed version: `20260712`
- Fetched: 2026-08-20
- Routes: 500-D, 500-A, G-4, 335-E, 401-K

This is an attributed five-route cache of the unofficial community BMTC feed.
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
| 335-E | V-335E DOWN | yes | 27653.1 | 27618 | 0.127% | 83.8 | 0 |

Result: `shape_dist_traveled` is consistent and is used directly. Every shape
is monotonic and within 5 percent of haversine length. G-4 UP has one projected
stop-order reversal in the source stop sequence; changing the shape-distance
calculation would not repair that independent source-data anomaly. The loader
still falls back to recomputed haversine cumulative distance if a future shape
fails the distance gate.
