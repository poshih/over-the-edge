# Course kit

[`scripts/course-kit/`](../scripts/course-kit) is a plain Node authoring kit for generated
courses. It places engine terrain meshes, checks their **authored collision**, and maps
that same collision. Built-in shapes, drawn outlines and GLB slices all use the engine's
geometry authority; concavity, disconnected islands and holes need no special placement
API. [Ashen Ascent](ashen-ascent.md) is an in-repository consumer.

| Module | Contents |
| --- | --- |
| `engine.mjs` | `loadCourseEngine(server)`, loading the engine through a caller-owned Vite server |
| `job.mjs` | `createCourseJob(engine, options)`, template caches, work accounting and prepared snapshots |
| `errors.mjs` | Typed errors with a stable `code`, original `cause` and actionable `repair` |
| `course.mjs` | `CourseBuilder(library, job)`, terrain, triggers, enemies, scenery, set pieces and group metadata; seeded `random` |
| `trail.mjs` | `Trail`, a route cursor for floors, steps, stairs and set pieces |
| `pieces.mjs` | `PIECE_PATHS`, designed entry, exit and ground for library pieces |
| `checks.mjs` | Blocking overlap, reservation, vent and component-clearance checks; advisory reach modelling and suggestions; `budget` |
| `scenery.mjs` | Perspective-camera depth placement for non-colliding decorations |
| `map.mjs` | Collision SVG maps and optional Playwright PNG crops |

The typed, DOM-free, three.js-free query kernel is
[`src/collision-queries.ts`](../src/collision-queries.ts). It imports no editor modules.
The Workshop's set-piece library is loaded separately at the authoring boundary, never
by runtime geometry code.

## Building a course

The caller starts and closes Vite. The kit neither starts a server nor imports raw
TypeScript from Node:

```js
import { createServer } from 'vite';
import { loadCourseEngine } from '../course-kit/engine.mjs';
import { createCourseJob } from '../course-kit/job.mjs';
import { CourseBuilder, random } from '../course-kit/course.mjs';
import { Trail } from '../course-kit/trail.mjs';
import {
  overlaps, keepOut, ventShafts, crampedColliders, reachGraph, reachSuggestions,
  ENGINE_DEFAULT_REACH,
} from '../course-kit/checks.mjs';
import { courseMap } from '../course-kit/map.mjs';

const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: 'silent',
  server: { middlewareMode: true }, appType: 'custom',
});
try {
  const engine = await loadCourseEngine(server);
  const library = await server.ssrLoadModule('/src/editor/set-pieces.ts');
  const job = createCourseJob(engine);
  const builder = new CourseBuilder(library, job);
  builder.beginZone({ code: 'z1', palette: { rock: 0x5b5f5a, stone: 0x7b7d76 } });
  builder.add({ kind: 'start', id: 'start', x: 1, y: 0.65, angle: 0, reach: 1.7 }, 'z1:start');
  const trail = new Trail(builder, random(1), 0, 0);
  trail.floor(6, { tone: 'stone' });
  trail.piece('first-boulder', { tone: 'rock' });
  trail.stairs(8, 6, { shapes: ['shelf', 'slab'], tones: ['rock', 'stone'] });

  const snapshot = job.prepare(builder.level(engine.level.LEVEL_SCHEMA_VERSION));
  const problems = [
    ...overlaps(snapshot, builder.groups, builder.supports),
    ...keepOut(snapshot, builder.groups, builder.pieces, builder.allowed),
    ...ventShafts(snapshot, builder.groups),
    ...crampedColliders(snapshot, builder.groups, builder.pieces),
  ];
  const reach = reachGraph(snapshot, builder.groups, builder.pieces, builder.links,
    ENGINE_DEFAULT_REACH, { x: trail.x, y: trail.y });
  const suggestions = reachSuggestions(reach);
  if (suggestions.length > 0) {
    console.warn('Reach suggestions (non-blocking): ' +
      'the model cannot prove or disprove physics-based play.');
    console.warn(suggestions.join('\n'));
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else {
    const map = courseMap(snapshot, {
      sky: ['#1d1b1f', '#2b2a33', '#4a3f3a'], reach,
    });
    // Export snapshot.level, not the job, snapshot indexes or builder metadata.
  }
} finally {
  await server.close();
}
```

`loadCourseEngine` returns `{ level, queries, mesh, art }`, from four modules loaded
through that same server. A caller may inject that complete contract directly instead;
`createCourseJob` checks required capabilities and fails explicitly if an export is
missing. There is no bounding-box collision fallback.

`prepare(rawLevel)` validates with the engine, returns the immutable validated `level`,
and builds terrain and component spatial indexes **once**. Every check and map takes
that snapshot. Build a fresh snapshot after changing authored content; derived query
data never enters saved/exported level objects.

`job.createIndex(items, boundsOf)` (also on the snapshot) creates a bounded index for
additional authoring data, such as reach points. Its `query(bounds)` shares the job's
accounting and typed errors; it does not rebuild the terrain indexes.

### Terrain and GLBs

`builder.terrain(name, mesh, x, y, width, height, options)` takes a `TerrainMesh`
explicitly. Its options are `angle`, `depth`, `mirror`, `tone` or `color`, `surface`,
`illusion`, `group`, `allowIn` and `support`. `block`, `ramp`, `peak`, `fang`, `hex` and
`plank` obtain their convenience meshes through the injected engine's `shapeMesh`.
Their existing valid calls emit the same level objects; there is no kit shape table.

For a GLB, continue inside the caller's server lifetime and active builder zone:

```js
const { readFile } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');

const glb = await readFile('content/terrain/arch.glb');
const assetId = `asset-${createHash('sha256').update(glb).digest('hex')}`;
const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
const { meshTerrain } = engine.mesh;
const native = meshTerrain(assetId, bytes);
// Native dimensions are the GLB's width/height/depth, not its placed world bounds.
builder.terrain('arch', native.mesh, 6, 12,
  native.width * 1.2, native.height * 0.8, {
    depth: native.depth * 0.9, angle: 0.35, mirror: true, tone: 'rock',
  });
```

`job.readMesh(assetId, bytes)` calls the same `meshTerrain` and wraps its `ArtError` as
`CourseArtError`, preserving the cause and repair advice. Direct `meshTerrain` callers
receive the engine's typed error. The caller packages the GLB and its artwork manifest;
the kit does not upload, register or infer assets from model IDs.

The GLB either declares simple collision or brings its derived middle-depth slice.
The mesh is passed explicitly, including every slice loop. Dimensions must fit the
engine's level limits; they are not clamped. A declared circle must have equal placed
width and height: non-uniform scaling into an ellipse is invalid.

### Zones, trails and set pieces

- `beginZone` sets the zone whose `code` prefixes generated IDs and whose `palette`
  resolves tones. Terrain defaults to Rock; `surface` selects wood, metal, ice or
  rubber. A piece's own parts retain their designed surfaces.
- Trail `floor`, `step` and `stairs` build from and move the cursor; `at`, `go`, `turn`
  and `edge` only move it. Stairs can switch back when their run is too short.
- `trail.piece(id, options)` aligns a library piece's designed entry with the cursor,
  adds its ground, mirrors it for leftward travel and leaves by its designed exit.
  Repeated placements have distinct stamps and IDs, such as `<piece>-<zone>-2-<part>`.
  Options include `gap`, `lift`, `floor: false`, `floorTone`, `floorThickness`,
  `floorDepth`, `floorSurface`, `tone`, `recolor`, `retune` and an alternate `exit`.
- `builder.link(from, to, why)` records a trusted designed move, such as a fling.
  `allowIn: '<piece>'` permits that terrain in the named piece's reservation;
  `support: true` marks ground allowed to merge with neighbouring connectors.
- Piece bounds come from `job.worldBounds(terrainObjects)`. Empty terrain has `null`
  bounds and no reservation; moving a trail to such a piece's terrain edge is an
  explicit query-capability error.

Add each library piece's route to `PIECE_PATHS`. Coordinates are local to its base
centre, travelling toward +x. `entry` and `exit` at height lie on its outer surfaces.
`floor` is the required ground x-range or `null`; `mirror` chooses the +x orientation,
and `down` marks a descent.

## Collision query semantics

Templates are keyed by engine `geometryKey`, derived from `terrainCollision`. Loop
nesting is computed once: each even-depth loop owns a connected solid component and
its immediate odd-depth children are holes. An island inside a hole is a separate
component. Placements use engine `objectLoops`; mirrors keep the engine's solid-left
winding unchanged. Circles remain analytic disks and never use polygon outlines.

The kernel exports `compileCollision(object, work)` and
`placeCollision(object, template, work) → { solid, components }`. Queries take a solid
and an explicit work accountant; a job supplies that accountant automatically through
`job.queries`, also available as `snapshot.queries`:

| Query helper | Meaning |
| --- | --- |
| `pointLocation(solid, point)` | `'outside'`, `'boundary'` or `'inside'`, using the shared engine predicate with strict geometric boundary membership |
| `intersection(a, b)` | `'disjoint'`, `'touching'` or `'overlapping'`; interiors intersect only in the last case |
| `overlapExceeds(a, b, allowance)` | Whether overlap thickness strictly exceeds the allowance, without measuring its maximum |
| `overlapDepth(a, b, radiusTolerance?)` | Thickness of the overlap, measured to the requested radius tolerance |
| `separation(a, b)` | Minimum boundary gap when disjoint, otherwise zero; includes hole boundaries |
| `standingSurfaces(solid, minUp)` | Oriented edges and analytic top-circle arcs with sufficiently upward world normals |
| `segmentInteriorIntervals(solid, from, to)` | Segment parameter intervals split at analytic boundary events; their open interiors lie inside the solid |
| `rectangle(bounds)` | An explicit rectangular query region using the engine's canonical box, not a substitute for terrain geometry |

Kernel `signedDistance` is positive inside and negative outside; magnitude is distance
to the nearest boundary edge, or analytic circle boundary. Edge trees prune distance
and boundary-event work. A segment wholly along a boundary has no interior interval;
endpoint support contacts alone do not block transit. A zero-length segment has
`[0, 1]` only when its point is strictly inside.

Geometric queries use the engine's even-odd predicate on transformed `objectLoops`,
with zero boundary tolerance. Default `objectPointLocation` and `objectContains`
retain the engine's existing unit-space contact tolerance and unchanged boolean
behaviour. Treating that contact band as geometry could mistake two nearly
coincident, fully overlapping solids for touching. Coincident segment portions are
classified from boundary events, not a rounded midpoint's side of the line.

Full containment and same-side coincident boundaries count as overlapping. An arch
opening stays empty, islands are not joined, and hole floors can face upward while
their ceilings cannot. Normals are calculated **after** size and rotation, including
non-uniform loop scaling. Course bounds are unions of actual collision bounds, or
`null` when empty; bounds serve only the broad phase and deliberate reservations.

### Overlap thickness and allowances

`overlapDepth(a, b)` is the diameter of the largest disk that fits inside **both**
solids:

`2 × max_p min(signedDistance_a(p), signedDistance_b(p))`, or zero without interior overlap.

Circle–circle thickness is analytic. Other pairs use a 2D pole-of-inaccessibility
branch-and-bound over intersected bounds, prioritizing square cells by
`f(center) + halfSize × sqrt(2)`. Signed distance and its minimum are 1-Lipschitz.
`overlapDepth` defaults to **0.05 mm radius tolerance**, hence **0.1 mm diameter
tolerance**. Its optional `radiusTolerance` must be finite and positive, in metres.
The returned diameter is a lower approximation within twice that tolerance, not a
policy allowance. In the kernel its signature is
`overlapDepth(a, b, work, radiusTolerance = OVERLAP_RADIUS_TOLERANCE)`; the job wrapper
supplies `work`. Exceeding work limits throws; it never returns an unfinished estimate.

The four gates use `overlapExceeds` instead of refining every overlap to that precision.
It decides against threshold radius `T = allowance / 2`: any evaluated `f > T`
immediately proves a violation; cells whose upper bound is at most `T` are pruned.
No interior overlap is a fast false, as is a bounds/radius maximum at or below `T`;
circle–circle decisions stay analytic. A drained queue proves false. The allowance
must be finite and nonnegative. Decision queries have no measurement-tolerance band.

Only proven violations with a displayed depth (`overlaps` and `keepOut`) then call
`overlapDepth`, using **0.5 mm radius / 1 mm diameter reporting tolerance**, enough for
the messages' two decimal places. Enemy-start and vent diagnostics do not display a
depth, so they never measure it. Reporting precision cannot suppress a proven violation.

For an axis-aligned rectangular overlap, thickness is the shorter side: exactly the
old projection-overlap depth for identical, contained, corner and sliver box overlaps.
For convex solids, every old projection overlap contains the overlap region's
projection, which contains the inscribed diameter; thickness therefore never exceeds
the old SAT depth. With unchanged geometry, passing convex overlap gates keep passing;
slanted/triangular overlaps may read smaller. Replacing polygon circles with exact
disks is a separate geometry correction and can reveal previously missed contact.

`POLICY_ALLOWANCES` retains these named **seam/merge allowances**, not numerical
tolerances. A gate reports overlap only when thickness is strictly greater:

| Policy | Metres |
| --- | ---: |
| `overlap` | 0.03 |
| `enemyStart` | 0.02 |
| `keepOut` | 0.05 |
| `reservationInset` | 0.1, applied to each reservation side before testing |
| `vent` | 0.02 |

An inset that destroys a reservation is an error, not an inverted rectangle.
Keep-out intentionally reserves empty air inside a piece's footprint; it does not
claim the piece's collision fills its bounds.

**Physics approximation:** `src/terrain-world.ts` welds chain points at or within
Planck's `Settings.linearSlop` before creating fixtures, when a valid loop remains.
That is the engine's millimetre-scale fixture approximation. The kit measures
engine-authored collision (`terrainCollision`, `objectLoops`, containment), does not
copy welding, and does not promise identity with those final welded fixtures.

### Reading collision in your own tools

The kit's former `outline` helper, its `UNIT` shape table and `CourseShapeError` are
gone. Exporters, previews and other course tooling read terrain collision from the
engine and the job instead, never from a hand-maintained outline table, a convex hull or
a bounding box:

- While building, before any snapshot exists, `job.worldBounds(objects)` returns the
  bounds (`{ left, right, bottom, top }`) around the placed engine collision of the
  given terrain objects, or `null` when there are none. It validates each object with
  the engine; pass a one-element list for one object's extents.
- After `job.prepare(level)`, `snapshot.solids` holds one frozen record per terrain
  object: `{ order, object, solid, components, bounds }`. A `solid` of type `'circle'`
  has a `center` and `radius`. One of type `'loops'` has world-space closed `loops` of
  `{ x, y }` points, placed by the engine's `objectLoops`: solid boundaries run
  counterclockwise and holes clockwise, mirrored placements included, and they read
  even-odd. `components` lists the object's connected solids in the same form, and
  `bounds` are its placed collision's bounds. These are the placements the checks and
  maps use; treat them as read-only.
- Without a job, the engine's level module (`engine.level`, from `loadCourseEngine`)
  offers `terrainCollision(object)`, the collision in the object's unit box, and
  `objectLoops(object)`, its world-space loops. A circle's loops are its polygon
  approximation: for the exact disk, check that `terrainCollision(object).type` is
  `'circle'` and use `object.x`, `object.y` and a radius of `object.width / 2`.

These are the authored collision. Physics differs from them only by the welding
described above.

## Checks

`overlaps`, `keepOut`, `ventShafts` and `crampedColliders` are blocking geometry
gates: they must report no problems before exporting, and engine validation must
pass. Run them against the same prepared snapshot. `standPoints` and `reachGraph`
are advisory authoring tools, not export gates; report their reach findings with
`reachSuggestions` without blocking export. `budget` reports counts and work usage.

| Check | Finds |
| --- | --- |
| `overlaps(snapshot, groups, supports)` | Separately built terrain merging into a piece's parts; enemies starting inside terrain |
| `keepOut(snapshot, groups, pieces, allowed)` | External terrain entering a piece's deliberately reserved bounds |
| `ventShafts(snapshot, groups)` | Non-illusion terrain above an external draft's trigger region, below its first launch event's apex |
| `crampedColliders(snapshot, groups, pieces)` | Two small connected components at or within 1.2 m, except actual parts of one recorded set-piece placement |
| `standPoints(snapshot, groups, reach)` | Advisory sampled eligible resting surfaces with modelled clearance |
| `reachGraph(snapshot, groups, pieces, links, reach, goal)` | Advisory modelled start-to-ending reach, unreached pieces and reachable points with no modelled route to the ending |
| `reachSuggestions(result)` | Non-blocking suggestions for an unreachable ending, pieces never reached and traps in a `reachGraph` result |
| `budget(snapshot)` | Object counts, collision extent (nullable), mesh kinds and work usage |

`CRAMPED.small` is 1.5 m on a component's longest world-bounds side;
`CRAMPED.clearance` is 1.2 m, **inclusive**. Small islands in the same ordinary object
are checked against one another. Only actual `piece.objects` parts of the same
placement are exempt; an ordinary group name or a piece's added supporting ground
does not establish that exemption. Dress a course with non-colliding decorations.

Overlap/enemy/keep-out checks retain the authored-illusion policy; vent obstruction
and reach obstruction ignore illusions. Enemy start regions retain the existing
authoring envelopes (bird half-size 0.26 × 0.26 m; ground enemy 0.26 × 0.7 m).
They are authoring policy, not collision reconstructed from enemy artwork.

## The reach model

The result is labelled `model: 'conservative-authoring-model'` and
`playabilityProof: false`. Exact terrain queries do not turn sampled footholds,
body-column clearance, movement heuristics or trusted authored moves into a physics
simulation or playability proof.

Its findings are advisory suggestions only: a conservative geometric model cannot
prove or disprove physics-based play. Report them with `reachSuggestions(result)` and
never gate export on ending reachability, unreached pieces or traps. The helper
requires a `reachGraph` result with the matching `model` label and throws
`ReachModelError` for a different or missing label. It returns an empty array when
there are no suggestions.

`reachGraph` and `standPoints` require the **complete caller-supplied** model.
They do not fill missing fields or merge defaults. `ENGINE_DEFAULT_REACH` explicitly
carries every prior engine-default distance and body/rig assumption:

| Field | Default | Meaning |
| --- | ---: | --- |
| `shoulder` | 1.15 m | Shoulder above the standing surface |
| `pull` | 2.35 m | Maximum shoulder-to-lip pull |
| `rise` | 2.5 m | Maximum modeled connector climb |
| `hop` | 1.9 m | Maximum horizontal hop |
| `drop` | 9 m | Maximum deliberate drifting drop |
| `maxStandSlope` | 40° | Steepest eligible resting face |
| `shoulderLipOffset` | 0.3 m | Clearance above the destination lip for a pull line |
| `transitHeight` | 1.2 m | Height of hop/drop transit lines |
| `clearanceHeights` | [0.05, 0.45, 0.85] m | Centre clearance probes and continuous segments between them |
| `sideClearanceHeights` | [0.45, 0.85] m | Side clearance probes and continuous segments between them |
| `clearanceHalfWidth` | 0.35 m | Side columns left/right of the stand point |
| `standingInset` | 0.1 m | Sample inset from each eligible surface's ends, capped at half its length |
| `startFootOffset` | 0.65 m | Start position to standing surface |
| `fallDriftBase` | 2.2 m | Initial permitted drift in a deliberate drop |
| `fallDriftPerMetre` | 0.25 | Additional drift per metre fallen |
| `hopDrop` | 2.5 m | Maximum hop descent |
| `hopRise` | 0.6 m | Maximum hop ascent |
| `moveRiseThreshold` | 0.05 m | Above this, different-object moves use the pull rule |
| `fallMinimum` | 0.05 m | Minimum deliberate drifting drop |
| `fallProbeOffsets` | [-2.4, -1.2, 1.2, 2.4] m | Lateral probes for the first stand surface below |
| `fallColumnSpacing` | 0.4 m | Rounded-x bins of downward-sorted stand points |
| `fallInitialProbeHeight` | 0.3 m | Height of each offset launch-clearance probe |
| `fallProbeStartHeight` | 0 m | Vertical fall line start above its source surface |
| `fallSurfaceOffset` | 0.3 m | Minimum first-surface descent and clearance above the landing |
| `anchorRadius` | 1.6 m | Search radius for starts and designed-link anchors |
| `ventRiderMargin` | 1.6 m | Horizontal margin around a draft for riders |
| `ventRiderBelow` | 1 m | Rider margin below its trigger region |
| `ventRiderAbove` | 0.2 m | Rider margin above its trigger region |
| `ventTargetMargin` | 2.6 m | Horizontal margin for draft targets |
| `ventTargetAbove` | 0.3 m | Target allowance above the draft apex |
| `endingBelow` | 0.1 m | Additional ending region translated downward |
| `goalRadius` | 1.5 m | Stand-point distance to a substitute goal when no ending exists |

All scalar fields must be finite and positive, except `fallProbeStartHeight`, which
may be zero; `maxStandSlope` must be below 90°. Clearance arrays are nonempty, finite,
positive and strictly increasing; fall offsets are nonempty, finite, nonzero and
distinct. Derived fall drift and bin coordinates must remain finite. Invalid models
throw `ReachModelError`.

Override fields **at the caller**, for example
`{ ...ENGINE_DEFAULT_REACH, maxStandSlope: 28 }`. Grip is
`sqrt(surfaceFriction * potFriction)` and sliding begins above `atan(grip)`.
Default rock 3 and pot 0.45 give about 49°; rock 0.8 and pot 0.45 give about 31°,
so choose a lower modeled slope. Rig length changes `shoulder`, `pull` and `rise`;
body dimensions also require revising the clearance and transit fields.

Eligible edges and circle arcs use the job's nominal sample spacing, with
`max(1, floor(length / spacing))` divisions, inset endpoints and exact duplicate
removal. Clearance includes the supporting object: its own cave ceiling blocks a
stand point. Lines and falls use analytic interior intervals, not spaced collision
probes. Only boundary/endpoint contact is exempt, not entire source/destination
objects. Fall columns are searched by binary search.

Trusted piece membership remains explicit policy: every member reaches every other
for `direction: 'any'`; descents retain the prior rule permitting lower points and
rises strictly below 0.05 m. A hub or descending ordered chain gives the same
**transitive reachability** without quadratic cliques. Draft rider/target sets use
spatial queries and a hub; `builder.link` retains its designed meaning. Forward and
reverse graph walks use queue head indexes.

That trust does not validate a piece's internal moves against different grip. Choose
pieces suited to the supplied physics: most resting surfaces are 30° or flatter,
but the hut and house roofs, friction slab, tilted slab and scree slope expect more grip.

## Work budgets and failure

`createCourseJob(engine, { workLimits, standingSampleSpacing })` can override exported
defaults. `workLimits` may override individual named counters; it is not a reach
model. Limits must be positive safe integers and spacing finite and positive.
Accounting is **cumulative per job**, including builder bounds, preparation and
every subsequent check. Use a fresh job for an independent authoring run.

| Exported `DEFAULT_WORK_LIMITS` counter | Default | Accounts for |
| --- | ---: | --- |
| `geometry` | 20,000,000 | Geometry preprocessing, boundary/point/distance primitives and narrow-phase tree visits |
| `spatialVisits` | 10,000,000 | Spatial-index building, comparisons, node visits and candidates |
| `cells` | 500,000 | Overlap solver cell creation attempts and priority-queue visits |
| `samples` | 100,000 | Standing sample attempts, including duplicates and blocked samples |
| `reachCandidates` | 4,000,000 | Movement candidates, fall searches/sorts, piece members, vent sets and link-anchor searches |
| `graphNodes` | 120,000 | Stand-point and hub nodes |
| `graphEdges` | 1,000,000 | Unique directed edges |

`DEFAULT_STANDING_SAMPLE_SPACING` is 0.3 m. A finer spacing increases work but never
changes collision geometry. Inspect `job.work.usage` or `budget(snapshot).work`.
Exceeding a limit raises `CourseQueryError` with `code: 'QUERY_WORK_LIMIT'` and cause
`{ counter, requested, limit }`; there is no silent candidate truncation, reduced
precision, automatic geometry coarsening or partial reach result.

Level limits still apply: 1,000 terrain objects, 64 distinct collision geometries,
16 slice loops, 64 points per loop and 256 total slice points. They cannot be raised
by job budgets. The job's normalized-template LRU holds at most 64 entries;
eviction only changes cache residency. Transformed placements and their refitted
edge bounds are snapshot-owned, never cached by world position.

Analytically, template nesting and edge preprocessing are bounded by those limits;
placement refitting is linear in boundary size. Balanced AABB indexes do not replicate
large objects across grid cells. Dense overlaps may still produce quadratic narrow
candidate work, and very thin complex overlaps may consume many solver cells: the
explicit budgets control those cases. For a typical within-allowance seam of length
`L` and maximum overlap radius `r < T`, cell refinement is controlled by the positive
gap `T - r`, not the default 0.05 mm measurement precision: ridge cells prune once
their half-size is at most `(T - r) / sqrt(2)`. The finest-cell count is therefore
proportional to `L / (T - r)` for that seam workload. Very near-threshold or exactly
threshold cases may still exhaust the budget; they throw rather than returning an
unproved decision. These are source-reviewed bounds, **not
measured throughput or a guarantee that a particular large course fits the defaults**.

### Typed errors

All kit error classes extend the JSDoc-typed `CourseError<Code, Cause>`, with `code`,
`cause` and `repair`. Capability causes name `capability` and optionally retain
`detail` or the original loader `failure`.
Engine art/level/query errors remain their typed causes; classification never parses
error messages.

| Error | Code | Cause / repair |
| --- | --- | --- |
| `CourseArtError` | `CONTACT_ART_UNUSABLE` | Engine `ArtError`, with `assetId`; fix/close/simplify the GLB section or declare supported collision |
| `CourseLevelError` | `LEVEL_DATA_INVALID` | Engine `LevelError` or field/value record, plus `objectId` when known; correct the authored data |
| `CourseQueryError` | `QUERY_CAPABILITY_UNSUPPORTED` | Missing capability, loader failure or invalid query options; load matching exports or correct the named input |
| `CourseQueryError` | `QUERY_WORK_LIMIT` | Counter/request/limit record, or kernel query error; simplify/partition the job or explicitly raise the budget |
| `CourseQueryError` | `QUERY_NO_STAND_POINT` | `{ x, y, radius }`; move the anchor or revise its explicit model |
| `ReachModelError` | `REACH_MODEL_INVALID` | Field/value record; supply the complete valid model, or a `reachGraph` result to `reachSuggestions` |
| `CourseMapError` | `MAP_OPTIONS_INVALID` | Field/value record; correct options or supply a viewport for empty terrain |
| `SceneryCameraError` | `SCENERY_CAMERA_INVALID` | Camera field/value record; use a valid perspective camera |

```js
import { CourseError } from '../course-kit/errors.mjs';
try {
  // Prepare and check an authoring job.
} catch (error) {
  if (error instanceof CourseError) {
    console.error(`${error.code}: ${error.message}\nRepair: ${error.repair}`);
  }
  throw error; // Preserve its typed cause; never export substitute geometry.
}
```

### Gate changes when regenerating existing courses

The builder's valid authored output is unchanged, but the checks are deliberately
more faithful. Review blocking geometric gates and advisory reach suggestions on
future regeneration rather than assuming their findings are identical. The
reach-related changes below affect suggestions only, never export gates:

- Exact disks replace inscribed 32-gons: contact, small-component gaps, standing
  samples and, for rotated circles, bounds/reservations may change.
- Inscribed-disk thickness replaces convex SAT depth. Rectangular overlaps match;
  other convex overlaps can be smaller. Concave overlaps, holes and containment use
  real solids rather than convex half-plane/hull assumptions. Gates decide directly
  against their allowance, so a small violation can no longer pass because a measured
  lower approximation fell just below the threshold; only reported depths are approximate.
- Geometric point location uses strict boundary membership instead of contact bands;
  near-boundary clearance may change, and almost-coincident containment remains overlap.
- Component clearance is inclusive at 1.2 m, checks separate islands in one object,
  and exempts actual parts only, not all objects sharing a piece group.
- Continuous clearance includes owning-object ceilings and obstructions between
  the old probe heights. Analytic arcs and duplicate removal change sampled points.
- Exact transit/fall intervals catch terrain between the old samples, including
  source/destination geometry formerly ignored wholesale. Boundary-only transit
  contact can conversely allow a move the old point probes blocked.
- Spatial move envelopes cover all model-valid candidates, also for custom models;
  equidistant anchor ties now choose the lowest stand-point ID deterministically.
- Circular draft and ending regions are handled through engine bounds/containment;
  an apex below the trigger's top has no above-region shaft to reserve.
- Destroyed reservations, invalid complete models, invalid raw terrain angles,
  invalid query arithmetic/options and exceeded work budgets now fail explicitly
  rather than masking or running unbounded.

Trusted piece traversal, designed links, policy allowance values and the engine-default
model's numerical assumptions are retained. Reach findings remain suggestions:
none proves or disproves physics-based play or blocks regeneration.

## Scenery

`sceneryHelpers(theme.camera)` places decorations through a perspective camera,
framing the engine's course view height from `src/view-frame.json` on the obstacle
line, z = 0. Orthographic or invalid perspective cameras throw `SceneryCameraError`.

Colliders stay centred on that line. A background prop standing on terrain must lie
within its depth, between the terrain's `-depth / 2` and -0.5 m where the pot ends.
Give prop-carrying terrain enough depth; 1.5 m depth leaves only 0.25 m there.

- `far(builder, model, from, [dx, dy], z, size)` offsets a decoration as seen from `from`.
- `landmark(builder, model, x, dx, z, size)` does so on the valley floor.
- `shelves(builder, left, right, top, z, height, tint)` lays background rock shelves.
- `row(builder, model, from, to, y, z, height, step)` places an alternating row.
- `depthScale(z)` gives the required size multiplier at that depth.

## Map

`courseMap(snapshot, { sky, scale, viewport, zones, reach })` draws every terrain loop
as one compound even-odd path per object, including holes and disconnected components;
disks are exact SVG circles. World collision coordinates are unrounded, under a single
SVG placement transform. Text remains upright in pixel space. Illusions are dashed;
triggers, drafts, enemies, labels and starts retain their review markings.

`sky` is three hex colours, bottom to top; `scale` defaults to 6 pixels/metre.
`viewport` optionally supplies finite `{ left, right, bottom, top }` with positive
extent, required for empty terrain. `zones` marks boundaries; `reach` must come from
that same snapshot. `renderCrops(map, crops, directory)` consumes that SVG unchanged
and optionally renders PNGs with Playwright. If needed, install Chromium for that
caller with `npx playwright install chromium`; the kit never installs it automatically.
