# Codex prompt

Copy everything below the line into Codex. It is written to be pasted whole.

---

You are building `transit-fleet-sim`, a mock of the layer a real transit
operator runs between the vehicle and the app: devices on buses reporting
position, a server ingesting them, and feeds an app consumes. It exists so a
transit app and a ticketing service can be built and demonstrated against live
tracking without real vehicles.

## Read first, in this order

1. `PLAN.md`. The build order, with a definition of done per stage. Start here.
2. `SPEC.md` section 0. Nine decisions already taken, so you do not reopen them.
3. `SPEC.md` section 18. The questions that are genuinely still open.

`SPEC.md` is 2,800 lines and it is authoritative. Read each stage's sections as
you reach that stage rather than reading it whole up front.

## Scope: build the increment, then stop

Build stages 0, 1, 3, 4, 5, 6-cut and 8 as `PLAN.md` defines them, in that
order. **Report when they land - but do not stop and wait for a reply.** If you
still have time, carry straight on in the order section 16.2 gives: metro
geometry and `/fleet/metro/arrivals` first, then GTFS-Realtime. The order is
what matters, not a pause.

The full build is 7.5 engineering days. The increment is 2.5 and it already
delivers everything the ticketing flow needs: the resolve contract, the check
character, the scan-versus-typed asymmetry, the honest not-found taxonomy, both
state machines and the four honesty knobs. Metro and the protobuf feeds are the
parts a consuming app wants, and they come after.

`SPEC.md` section 16.3's last risk row is why the order matters: metro taking
the whole week while the bus path never lands is the one failure that leaves
nothing to show.

## What makes this project unusual

The point is not that it reports positions. It is that it reports them **the way
real systems do, badly and incompletely.** A simulator that knows everything
perfectly is worthless here, because the consuming app's whole character is
refusing to state what it cannot support, and it needs something to refuse.

So the uncertainty is the feature, and all of it is configurable: fixes are
stale by ten to thirty seconds, buses go dark and come back, and a configurable
share of the fleet carries no device at all.

## The four things that matter most

### 1. Two state machines, kept apart. Section 5.

```
duty.status     confirmed | inferred | unknown | out_of_service
tracking.state  live | stale | dark | untracked
```

`duty.status` answers *what is this bus doing?*. `tracking.state` answers
*where is it?*. A bus can be confidently on route 500-D with a dead GPS.
Another can be transmitting perfectly with nobody sure what duty it runs.

Collapsing them into one field is the single outcome this project exists to
prevent, because it is what makes the consuming app lie. Section 5.3 names the
four cells that matter. Make sure all four can actually be produced, and write
a test for each.

One cell is worth stating on its own: **`out_of_service` + `live`** is a bus
that is moving and is not in service. A depot run is moving, tracked, and
unsellable, and a build that reasons "it has a fix, so it must be running"
sells a ticket for a bus going to a garage.

### 2. Determinism. Section 8.8.

A seeded PRNG in `src/sim/rand.ts`, and **no `Math.random()` anywhere, ever.**
Add the lint rule on the first day, not the last. The symptom it prevents is
"it worked when I recorded the demo", which is miserable to chase.

### 3. The check character on the BIN. Section 4.2.

**Damm, not Luhn.** One 10 x 10 table and a five-line loop, no dependency. The
check character is the interim digit left after folding the payload through the
table; a BIN is valid when the fold continued over the check digit lands on 0.

A BIN wrong by one character must fail on the phone, without a network call,
because otherwise a typo silently resolves to a real different bus and binds a
ticket to a vehicle the rider is not sitting on.

The reason it is Damm and not Luhn is measured, not asserted: over all 10,000
four-digit serials there are 27,000 adjacent transpositions, and Luhn leaves 600
undetected while Damm leaves zero. Those 600 are exactly the failure the check
exists to prevent.

**The canonical BIN is `BLR-04126`** (serial `0412` checks to `6` under Damm)
and the metro example is `MTR-00182`. Generate every check digit with your
function; never type one by hand. A hardcoded check digit is how the two sides
of the wire drift apart.

Test that every single-character substitution and every adjacent transposition
of a valid BIN is rejected.

### 4. Nothing hardcodes a port, a hostname or `localhost`. Decision 8.

Except `src/config.ts`, which reads every one of them from the environment and
names a local default. Write the test that greps the source and fails if
anything else does. Deploying is then a matter of changing environment
variables.

## Stage 0 settles one real question

Before anything else: load the bundled GTFS subset, index one shape, walk one
cursor along it, serve one JSON position.

Find out whether `shape_dist_traveled` in the community BMTC feed is consistent
with the stop coordinates. If it is not, recompute cumulative distance from
haversine and ignore the column. **State in the commit message which answer you
got and how you measured it.** Do not assume either way.

## The endpoints in this increment

```
GET /fleet/resolve?code=BLR-04126     BIN
GET /fleet/resolve?code=KA01F1234     plate
GET /fleet/vehicle/{bin}/position
GET /healthz    GET /readyz
```

One resolve endpoint, both entry paths, disambiguating by format (section 6.3).
It serves a QR scan and a hand-typed code, and **those are not the same event**
(section 6.4): a typed code needs explicit plate-and-route confirmation
afterwards, a scan does not. Section 6.2 gives the response body in full.

Not-found distinguishes **"no such BIN"** from **"that BIN is not in service
today"** (section 6.5), because the rider's next action differs.

Do not add `/fleet/metro/arrivals`, `/fleet/routes` or `/admin/scenario`. They
are cut from this increment. Do not stub them with TODOs either; simply do not
add the routes.

## The consuming client already exists, and it is not hypothetical

`/Users/srivathsanv/Documents/Personal/Tatak/src/fleet/` is a finished client
of this service, written against this SPEC, with 111 tests. It has a fixture
that produces all sixteen duty/tracking cells, and an HTTP source that will
call you for real.

**Read it before you design your response bodies.** Where your service and that
client disagree, one of you is going to print something false, and it is
cheaper to find that now than on a screen. If you think the client is wrong,
say so rather than matching it - it was written from the same document and it
guessed in a few places.

Two contract points it depends on, both now written into section 6.2:
everything describing a duty goes `null` when `duty.route` does,
`tracking.progress` is non-null only while `live`, and `fixAgeSeconds` is
`null` rather than `0` when `untracked`.

## Do not let a fallback publish something it cannot stand behind

There is a trap this project is unusually exposed to, and it already caught the
sibling repository once. When something cannot be answered - a feed missing, a
source unreachable, a vehicle with no device - it is tempting to fall back to a
plausible default and write a log line about it. **The log is not the
consumer.** A response that carries a placeholder and mentions it only in
stdout has told the rider a lie and told the operator the truth.

So: when this service cannot answer, the *response* says so. That is what the
whole not-found taxonomy, the four tracking states and the mandatory
uncertainty band are for. An honest refusal always beats a plausible default.

## Evidence, the way you did it in the other repository

The strongest thing about the BPP's Phase 1 and Phase 2 was not the code, it
was that the claims could be checked: raw unmodified response bodies committed
under `phase-1/evidence/` and `phase-2/evidence/`, and a test that parses that
committed evidence on every run so the numbers in the write-up cannot drift
from the numbers on the wire. Do exactly that here.

And audit yourself against section 14's acceptance criteria the way you audited
the seventeen in the BPP: a table, one row each, and PASS / PARTIAL / NOT MET
with the qualification written out. Two PARTIALs stated plainly were worth more
than seventeen unexamined PASSes.

## Constraints

- Docker, standalone, one compose command, no download. `data/bundle/` is
  committed. Section 12.
- Runnable by a stranger who has cloned it and has no BMTC data.
- The repository is public and MIT licensed.

## Conventions

- Keep the `AI-Assisted-By: OpenAI Codex` trailer on your commits.
- Commit at every working state; do not accumulate a large uncommitted tree.
- No em-dashes in prose, comments or commit messages. Use a normal dash.
- Tests for anything with logic. Do not commit a red tree.
- Generate golden files last, after the shape stabilises. Generating them early
  turns the suite into noise.
- If `SPEC.md` contradicts itself, the spec loses. Say so in the commit.
- Report what works, what you deliberately left out, what you measured about
  `shape_dist_traveled`, and anything you found wrong or unbuildable.
