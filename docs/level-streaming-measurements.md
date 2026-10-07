# Level streaming measurements

Stage 0 measures the performance baseline before later stages decide whether to stream course
artwork, tune chunk batches, or tighten collision memory limits. The numbers from these
measurements drive all later decisions.

## Purpose and gates

An unknown metric cannot pass a gate. Validation is by code review; these measurements are taken
by a person following this protocol.

- **Stage 1** (tune the existing 32 m render chunks) if rendering misses its budget.
- **Stage 2A** (load course artwork on demand) if time to first play misses.
- **Stage 2B** (evict artwork) if memory after a full traversal misses.
- If collision memory on the slices benchmark misses, tighten `LEVEL_LIMITS` or store slices
  more compactly. Never unload colliders.

## What the Workshop reports

The Workshop exposes performance diagnostics through `window.gettingOver`:

- `window.gettingOver.rendering()` returns the view statistics plus `courseArt`.
- `window.gettingOver.level().rendering` returns the same.

### View statistics

These are totals of the last completed game render across all passes, with instanced draws counted
per instance:

- `calls`: draw call count.
- `triangles`, `lines`, `points`: rasterised primitive counts.
- `geometries`, `textures`: three.js resource counts.
- `renderTime`: CPU time of `GameView.render` on the main thread, not GPU time.
  - `label`: label given to `measurements.start(label)`, or `null` before the first capture. It is never `undefined`, and it keeps the last label after `stop()`.
  - `samples`: number of frames recorded since `start`. The array of retained frame times comes from `window.gettingOver.measurements.samples()`.
  - `retained`: number of frames currently retained, at most 8,192 (about 2.3 minutes at 60 fps).
  - `p95`, `p99`: nearest-rank percentiles, in milliseconds, of the retained frames, or `null` with no samples.
  - `max`: exact maximum since start, or `null` before any sample.

### Terrain

- `instances`: count of placed terrain objects.
- `chunks`: count of spatial cells (32 m squares).
- `batches`: count of instanced draw batches.
- `capacity`: instance capacity.
- `usedInstanceSlots`: slots in use.
- `instanceBufferBytes`: buffer size.

### Decorations

- `instances`: count of placed decorations.
- `chunks`: count of spatial cells (depth-scaled).
- `batches`: count of instanced draw batches.
- `meshes`: number of batch meshes; a batch of a multipart model has one mesh per part.
- `capacity`: placement capacity, first mesh of each batch.
- `instanceCapacity`: capacity for every mesh.
- `usedInstanceSlots`: slots in use.
- `instanceBufferBytes`: buffer size.
- `previewMeshes`: number of meshes in the Workshop's placement preview, the decoration being placed.

### Course art

- `mode`: course look, `'meshes'` or `'shapes'`.
- `loading`: number of assets still loading.
- `failed`: IDs of assets that failed to load.
- `chunks`: count of spatial cells.
- `batches`: count of draw batches.
- `meshes`: number of batch meshes, one per primitive of each batched asset.
- `instanceCapacity`: total instance capacity of every batch mesh, not per asset.
- `usedInstanceSlots`: slots in use.
- `instanceBufferBytes`: buffer size.
- `assets[id]`: per-asset metrics.

#### Per-asset metrics

Each asset's `assets[id]` object contains:

- `compressedBytes`: packaged GLB size (not network bytes).
- `textureBytes`: normalised RGBA8 estimate (4 × width × height for each distinct decoded
  image), not measured GPU memory.
- `modelGeometryBytes`: geometry bytes of the model itself, deduplicated by backing buffer.
- `derivedGeometryBytes`: fitted or mirrored terrain templates and decoration templates,
  deduplicated by backing buffer.
- `loadMs`: wall time of reading and parsing the GLB (concurrent work inflates this).

## What a release marks

User Timing marks track the release boot timeline. Read them in the browser's performance panel
(Timings tab) or in the console:

```js
performance.getEntriesByName('gettingover:release:boot-to-input')
performance.getEntriesByType('mark')  // filter by 'gettingover:release:' prefix
```

### Mark names

- `gettingover:release:start`: boot begins.
- `gettingover:release:attempt-start`: a load attempt begins.
- `gettingover:release:manifest-ready`: manifest is loaded and parsed.
- `gettingover:release:boot-content-loaded`: boot content is loaded and parsed.
- `gettingover:release:loading-unblocked`: loading input block was cleared. READY observers may still pause or block input after it.
- `gettingover:release:input-enabled`: first frame accepts input after loading and READY blocks
  or pauses.
- `gettingover:release:failed`: attempt failed, through a load error or a game that halted itself.
- `gettingover:release:aborted`: release was closed.

### Measure

- `gettingover:release:boot-to-input`: start to input-enabled, in milliseconds.
- `gettingover:release:navigation-to-input`: page time origin to input-enabled, in milliseconds.

### Mark details

Each mark's `detail` carries:

- `attempt`: attempt number (0 before the first load).
- `statistics`: `ContentSession.statistics()` when a session exists.
  - `payloadBytesRead`: response bodies read by the session, including bodies served from the
    browser's HTTP cache on warm boots and failed reads. Not wire bytes; take wire bytes from
    the browser's network panel (transferred) up to the `input-enabled` mark.
  - `verifiedBytes`: verified content bytes.
  - `requests`: request count.
  - `retries`: retry count.

### Semantics

- `input-enabled` marks the first frame that accepts input after every loading and READY block
  or pause.
- Each attempt ends with at most one of `input-enabled`, `failed` or `aborted`. A game that
  halts itself is `failed`; a release that is closed is `aborted`.
- A disposed release records nothing more.
- Statistics are per attempt: a retry starts a new session, so earlier attempts' bytes are not
  included.
- `boot-content-loaded` marks when boot content is loaded and parsed, not only downloaded.
- If a game halts after `loading-unblocked` but before accepting input, no final mark is
  written; a missing `input-enabled` is the signal.
- Memory: measure the JS heap, process and GPU memory from the browser's memory and performance
  tools and task manager. The engine does not report them.

## Benchmark projects

Generate the four benchmark projects with `npm run generate:streaming` (all) or
`npm run generate:streaming -- <case>` (one case). Each writes the git-ignored
`artifacts/level-streaming/<case>/` (`project.json`, `level.json`, `art/asset-<sha256>.glb`)
only after engine and course-kit validation. Output is deterministic; regenerate rather than
commit it.

Open in the Workshop with:

```sh
GAME_PROJECT=artifacts/level-streaming/<case> npm run dev
```

Serve a game with:

```sh
GAME_PROJECT=artifacts/level-streaming/<case> npm run dev:game
```

Build a release with:

```sh
GAME_PROJECT=artifacts/level-streaming/<case> npm run build:game
```

### Cases

**spread:** 1,000 terrain objects (box-colliding meshes reusing 4 assets) on a 64 m world grid
out to the ±2,048 m coordinate limits, plus 1,000 decorations using the built-in models
`ruined-pillar`, `obelisk`, `dead-tree` and `lantern-post`. The Workshop draws the built-in
models; mesh releases draw the generated GLBs.

**dense:** 64 unique textured meshes of 16 parts each (one 512² image per asset), placed as one
14 × 2 m terrain block of 1.75 m tiles, plus a 2-rung climb.

**perspective:** a perspective camera with fog from 250 m to 1,500 m, and 1,000 decorations from
the course plane back to z = −1000 with heights up to 1,000 m.

**slices:** 1,000 terrain objects over 64 collision shapes, each with 16 loops of 16 vertices,
drawn in shapes art mode. It measures collision memory and makes no reachability claim.

### Common features

Every case has a start, a short climb to a summit flag, a bonfire, and a clear fall lane to the
right. Reach checks are advisory. Use the Workshop's player placement to visit distant parts of
spread and slices.

## Protocol

1. **Record the environment:** revision, device class, OS, browser version, screen resolution,
   pixel ratio, camera projection, power and thermal state, and network settings.

2. **Use real devices for each class.** Desktop CPU throttling is a separately labelled proxy.

3. **Per project, do 5 cold navigations** (empty HTTP cache) and 5 warm ones.
   - Record the boot marks: `start`, `attempt-start`, `manifest-ready`, `boot-content-loaded`,
     `loading-unblocked`, `input-enabled`, `failed`, and `aborted` as they appear.
   - Record `payloadBytesRead` from the statistics.
   - Record wire bytes from the browser's network panel (transferred) up to `input-enabled`.

4. **Repeat with a fixed throttled profile** (proposed 10 Mbit/s and 100 ms RTT), reported
   separately.

5. **In the Workshop, for each phase** (climb, top-to-bottom fall down the fall lane, reset,
   bonfire respawn):
   - Call `window.gettingOver.measurements.start(label)` at the phase start.
   - Call `.stop()` at the phase end.
   - Call `.samples()` to copy the retained frame times in recording order before the 8,192-frame
     window fills.
   - Save samples offline; combine raw samples offline, never average percentiles.

6. **Take `rendering()` snapshots** at spawn, summit, after the fall, after reset, and after
   respawn.

7. **Record memory** after a fixed idle period following a full traversal. Measure the JS heap,
   process and GPU memory from the browser's memory and performance tools.

8. **Run timing passes and memory-profiler passes separately.**

## Proposed budgets

These proposals are pending user approval, not measured capacity. Present measurements against
these targets.

| Class | Render p95 / p99 / max | Cold / warm navigation to input | Settled / peak memory | GPU estimate |
| --- | --- | --- | --- | --- |
| Low-end, 720p, 30 fps target | 16 / 25 / 50 ms | 10 / 3 s | 192 / 256 MiB | 192 MiB |
| Mainstream, 1080p, 60 fps | 8 / 12 / 25 ms | 6 / 2 s | 384 / 512 MiB | 384 MiB |
| Higher-end, 1440p, 60 fps | 6 / 8 / 16 ms | 4 / 1 s | 768 / 1,024 MiB | 768 MiB |

Collision memory (from the slices case) is proposed at 64 / 128 / 256 MiB by class.

## Gates

- **Stage 1:** if rendering p95, p99 or max misses its budget for any class or case.
- **Stage 2A:** if cold navigation time misses its budget for any class.
- **Stage 2B:** if memory after a full traversal misses the settled or peak budget for any class.
- **Collision tightening:** if collision memory from the slices case exceeds the proposal. Do not
  unload colliders; tighten `LEVEL_LIMITS` or store slices more compactly.
