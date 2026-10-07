# Feature request: level streaming roadmap

**Date:** 2026-10-07 · **Baseline:** `7b32b4e` · **Status:** requested; nothing is implemented.

A level is one document. `LevelDefinition` (`src/level.ts`) is a flat `objects` array; the Workshop edits it whole, the
project server versions it whole, and a release embeds it in its content manifest. As courses grow toward
`LEVEL_LIMITS` (1,000 terrain objects and 1,000 decorations across ±2,048 m, decorations up to 1,000 m behind the
course), should the engine stream, keeping only what is near the player and freeing the rest?

**In short:** yes, for course artwork, which is the one cost that grows with the whole level today. Rendering is already
batched by area, and collision, gameplay state and the level document are small in every shipped level or already
follow the player. Nothing may be dropped on the grounds that the player will not return: a fall can carry the player
back down through every area below in seconds. Residency is therefore demand-driven and reversible.

## Where the engine stands

| Area | Today | Grows with |
| --- | --- | --- |
| Level data | One JSON document. The largest shipped level, `examples/projects/ashen-ascent`, has 687 objects over about 1,070 × 630 m in 135 KB; `levels/skyward-ruins.json` climbs 600 m in 159 KB. `LEVEL_LIMITS.fileBytes` allows 8 MiB. | The level, within limits; the legal worst case is unmeasured |
| Collision | `TerrainWorld` builds one static body per terrain object at load. Mesh terrain collides as the slice or shape stored in the level, so physics never needs its GLB. Static bodies cost next to nothing per step until something moves near them. | The level, in memory only |
| Simulation | Already follows activity. Enemies wake within 18 m and sleep beyond 26 m (`ENEMY_BEHAVIOR`). Triggers, bonfires, pools and axes are found by `DynamicTree` queries around the player. Platforms step only their moving set, shooters fire from a due-time heap, and projectiles are the live prefix of a fixed pool. | Activity |
| Rendering | Already batched by area. `TerrainView` and `CourseArtView` key their instanced batches by 32 m chunk, and `DecorationView` by chunks that double with each band of depth, so frustum culling skips whole chunks. Every chunk batch stays in the scene, though, and three.js visits and frustum-tests each one every frame. | Visible area for drawing; the level for traversal and resident GPU memory |
| Course artwork | A release lists every course-art GLB in `bootSources()` (`src/content.ts`) and holds play until all are fetched, parsed and pinned (`src/release.ts`). `CourseArtView` counts each asset's terrain uses and frees unused, unpinned ones, but not decoration uses: a decoration-only asset survives only by being pinned. | **The whole level**: download, parse and GPU memory |
| Content delivery | Content-addressed files in the `game/` group behind one `ContentAccess.grant`. `ContentSession` caches only prefetched files and forgets them after boot. Phantom packs already load as the player first nears them, and stay. | Grants are per group |

The camera frames about 8.5 m of height by default (`src/view-frame.json`), but a perspective camera can see scenery
far behind the course, and a game can replace the camera director, so what is visible is a frustum, not a box around
the player.

## Rules every stage keeps

- **Gameplay never depends on residency.** Collision, triggers, enemies, hazards, bonfires, liquids, the run's object
  state and the phantom course stay whole-level, so physics and recordings are identical with streaming on or off.
  Unloading colliders would let a falling player pass through missing ground, and would change Planck's body and
  contact order mid-run.
- **Residency is reversible.** Whatever leaves comes back whenever it is needed again: on a climb, a fall, a reset or a
  respawn.
- **Streaming work follows change.** Demand is re-evaluated only on a quantized change of view, not every frame, and
  loading is scheduled within a per-frame time budget.
- **The authored level is never touched.** Residency is runtime state of the view and the content session, never
  written into the level or its saves.
- **Releases carry no editor code.** Streaming lives in runtime and release modules.
- **Each visible behaviour is a typed point.** What the player sees while art loads, and the residency policy, are
  extension points with the engine's behaviour as their default, and are documented with them.
- **No compatibility.** A content format change bumps `CONTENT_SCHEMA_VERSION`; nothing reads the old format.
- **Validation** is the project's: type-checking and code review. The measurements below come from the diagnostics,
  read while following a written protocol.

## Stage 0: measure, then decide

Every later stage starts only if a measurement misses its budget.

- **Diagnostics,** in the Workshop's `window.gettingOver` and in releases:
  - for rendering, chunk batches, meshes, instance capacity, draw calls and triangles per frame (`src/view.ts` already
    sets `renderer.info.autoReset = false`), and render time at p95, p99 and worst;
  - for each course-art asset, compressed bytes, decoded texture and geometry bytes, and parse and upload time;
  - for a release, the bytes fetched and the time until input is enabled, and peak resident and transient memory.
- **Benchmark levels,** generated with the course kit:
  1. objects spread across the limits with repeated assets, for chunk traversal;
  2. one dense area of many unique multi-part assets, for draw calls and uploads;
  3. a perspective camera with deep, tall decorations and distant fog;
  4. the legal worst case of terrain count and slice complexity, for collision memory at 240 Hz.
- **Protocol:** climb, fall from the top to the bottom, reset and respawn at a bonfire. Do it cold and warm, on a
  throttled network, on a low-end device class.
- **Budgets** per device class for time to first play, peak memory and render time.
- **Gates:** Stage 1 if rendering misses its budget; Stage 2A if time to first play does; Stage 2B if memory after a
  full traversal does. If the worst-case level misses its collision memory budget, tighten `LEVEL_LIMITS` or store
  slices more compactly. Do not unload colliders.

## Stage 1, only if rendering misses its budget: tune the chunks

- Tune `CHUNK_SIZE` and the decoration depth bands, keeping the world-origin grid, so an edit never rebatches the level.
- If traversal is the cost, keep only the chunk groups that intersect the view in the scene, found through a spatial
  index and updated on quantized view changes.
- **Acceptance:** render time and traversal follow the visible area on benchmark levels 1–3, with no popping: a chunk
  leaves the scene only when wholly outside the view.
- **Rejected:** `BatchedMesh` with per-object culling, which walks every instance every frame, work that grows with the
  level (AGENTS.md).

## Stage 2A: load course artwork on demand

Fetch and parse course artwork as it is needed, and keep it, so a release starts sooner. This alone removes the boot
cost; nothing is freed yet.

- **Demand:** a residency manager in the runtime indexes each placement's transformed bounds, with its depth, across
  every chunk it overlaps. It finds the assets in a conservative view frustum, widened to prefetch: further below than
  above, since a fall is fast and a climb slow. It re-evaluates on a quantized view key: camera chunk, zoom bucket,
  projection and field of view, viewport, recentring, and placement of the player. It works for any camera director.
- **Priority:** visible art first, then the respawn targets (the start and the **current** bonfire), then prefetch.
  Pinning every lit bonfire would hold more of the course with each one the player lights.
- **First play:** play waits only for the art visible from the spawn; everything else streams in. Course art leaves
  `bootSources()`, and the manager computes the initial set.
- **Asset lifecycle:** each asset moves from absent to queued, loading and resident, or to failed. Its terrain and
  decoration demand are counted separately, so decoration-only assets load and stay. A generation token discards stale
  completions. `DecorationView` hears when an asset arrives.
- **Placeholders:** until its art arrives, mesh terrain draws its collision slice extruded at its depth on the obstacle
  line, as the shapes art mode draws terrain, so the course never shows a hole. A decoration shows nothing until it
  loads. Retryable failures keep the placeholder and retry with backoff. Integrity failures and refusals are reported,
  as they are today.
- **Frame budget:** parsing and uploads are scheduled against elapsed milliseconds, and stalls are measured at p95, p99
  and worst. Worker parsing or stricter per-asset limits come only if those measurements require them.
- **Extension points:**
  - A residency policy in the runtime facet. It is called only on quantized changes, with the read-only frustum and
    asset metadata, and returns a capped, prioritised list of known asset IDs. The engine validates the list and keeps
    visible and respawn demand whatever the policy returns. The default is the policy above.
  - The placeholder look, replaceable like any other look.

  Both are documented in `docs/runtime-plugins.md`. Any authored tuning goes into project content with a content schema
  bump.
- **Workshop:** authoring keeps all art resident. Play-tests run the release's residency manager, so a designer sees
  what a player sees.
- **Acceptance:** on the benchmark levels, the bytes and time before play depend on the spawn's view, not on the level.
  The protocol shows no holes, and placeholders stay visible only for the measured time it takes to fetch the art.
  Physics and phantom courses are unchanged.

## Stage 2B, only if memory after a full traversal misses its budget: evict

- Build-time asset weights in the manifest: decoded texture and geometry bytes, primitive count and natural bounds (a
  content schema bump).
- A budget over resident and transient memory. Visible and current-respawn demand is never evicted; prefetched and
  stale assets are evicted first, by weight and distance. An asset larger than the whole budget is refused at build.
- Eviction removes every dependent batch, restores placeholders, then frees the model and its derived resources: baked,
  mirrored and cloned geometry and materials.
- Returning to an area reuses bytes through a bounded byte cache or the HTTP cache, whichever measures better.

## Stage 3, only on demand: zone delivery

Chunks need no authoring. Named zones are worth adding only for delivery: downloading a course chapter by chapter, or
theming the wait for a chapter's art. Releases would package each zone's artwork in its own content group, with shared
art in a shared group, fetched through the existing per-group grants.

This is not access control. The level and its collision ship whole, so a refused group still leaves its layout
playable behind placeholders. A game that must withhold a chapter needs a separate design that gates gameplay data or
progression on its server. The zone schema waits for that concrete need.

## Not planned

- **Unloading collision or simulation.** Both already follow activity in their per-step cost. Unloading them breaks
  falls, determinism and recordings, and if their memory is ever too much, tighter limits are the cure.
- **Splitting the level document.** At 135–160 KB per 600 m it is no memory problem. Splitting it would break trigger
  targets across zones, the single start, the level floor (`levelFloor`), course-kit checks, phantom course hashing,
  level versions and the Workshop.
- **Unloading on the grounds that the player will not return.** Nothing in the game guarantees it.
- **Phantom packs,** which already load on approach: a separate request if Stage 0 shows their memory matters.
- **Workshop overlays of resident chunks, partial loading in the Workshop, levels of detail and occlusion culling:**
  separate requests if a need appears.

## Open questions

- Chunk size, prefetch extents and budgets per device class, from Stage 0.
- Whether prefetch should lead a fast fall by the player's velocity rather than only widen the frustum below.
- The quantization of the view key: too coarse prefetches late, too fine re-evaluates too often.

## Context

The question came from planning larger courses: as a level approaches the limits, all of its geometry stays loaded.
The baseline shows that drawing is already chunked, and that level data, collision and simulation are small in shipped
levels or already follow the player. What still grows with the whole level is course artwork, fetched, parsed and held
before play. The roadmap measures first and then streams that, leaving gameplay whole.
