# Feature request: rotating and turning placed objects

**Date:** 2026-10-09 · **Baseline:** `87266ea` · **Status:** requested; nothing is implemented.

Objects with a rotation already store one, but the Workshop offers no direct way to change it, and 3D models cannot
turn to show another side:

- Terrain (`TerrainObject.angle`), decorations (`DecorationObject.angle`), the start (`StartObject.angle`, the hammer's
  starting angle) and projectile traps (`ShooterObject.angle`, their aim) **tilt** in the view plane, about the
  camera's axis. The only control is the **Rotation / hammer angle (°)** field in Level / Object properties
  (`#level-angle`, `src/editor/level-editor.ts`). There is no on-canvas handle and no key; the level editor's keys are
  V, M, Enter, Delete, Backspace, Escape, + / - and 0.
- Nothing **turns** an object about its own vertical axis. Decorations never collide, so turning one changes only how
  it looks. Mesh terrain does collide, and its collision comes from its GLB as the camera sees it (`meshTerrain`,
  `src/mesh-collision.ts`): the declared simple shape, or outlines generated at 384 cells across the mesh's longer
  side, either its **slice** on the obstacle line or, when declared, its **projection** along the view. The level
  stores those outlines in the mesh's unit box (`MeshCollision`, `src/level.ts`). Tilting, resizing and mirroring scale
  or turn them exactly, but turning would change the slice or the silhouette itself.

This request adds a tilt handle and keys for every object with a rotation, a **Turn** for decorations, and a Turn for
GLB terrain meshes whose collision is baked again for each turn.

## Rules every stage keeps

- **Collision always matches the drawing.** The level never holds collision baked for another turn: a turn is
  committed to the level together with the collision baked for it, so a save, an autosave, an export, a playtest, a
  release or the Workshop's running game can never see a stale pair.
- **Releases never bake.** Baked outlines stay in the level, so releases still need no GLB parsing for physics.
- **The same bake everywhere.** The Workshop, the project server, the course kit and the generators run one function,
  so a mesh at a turn always collides alike.
- **No per-frame cost.** Turning writes instance matrices only when an object changes, like every other edit.
- **Keys stay clear of the game's.** The game binds R (reset), P and Space (pause) and C (recenter)
  (`DEFAULT_INPUT_BINDINGS`, `src/input.ts`), so rotation uses other keys. The level editor's keys apply while the
  Level tab is shown, as today, and win over a game's own bindings there.

## Stage A: direct tilt for every object with a rotation

- **Handle.** A selected terrain object, decoration, start or projectile trap shows a round rotate handle on a short
  arm from its anchor, drawn with the other gizmos (`src/editor/object-gizmos.ts`). Dragging it tilts the object about
  its anchor, previewing as a move does and committing on release; holding Shift snaps to 15°. The start's handle aims
  its hammer, and a trap's its muzzle, so each reads as what it turns.
- **Keys.** Q and E tilt the selection, or the object about to be placed, 15° counterclockwise and clockwise, as M
  mirrors it. Each press is one edit.
- **Field.** The Rotation field stays, relabelled per kind: Tilt for terrain and decorations, Hammer angle for the
  start, Aim for a trap.
- Bonfires, enemies, triggers, pools, platforms and axes have no rotation and get no handle: platforms, pools and
  trigger boxes stay upright in the physics, enemies face left or right, and an axe swings in and out of the view.

## Stage B: turn decorations

- `DecorationObject` gains `turn`, −π to π, the model turned about its own vertical axis before it tilts and is placed.
  `decorationMatrix` (`src/decoration-view.ts`) applies it; mirroring still reflects the model left to right.
- Level / Object properties shows a **Turn (°)** field for decorations. [ and ] turn the selection or the object about
  to be placed by 15°. A second handle, a short dial under the object's base, turns it by dragging left or right, with
  Shift snapping to 15°.
- Level schema 12. Every bundled level's decorations gain `"turn": 0`, written by their generators where they have
  them.

## Stage C: turn GLB terrain meshes, baking their collision

- The asset mesh gains `turn`: `{ type: 'asset', assetId, turn, collision }`. Its collision is that of the GLB turned
  `turn` about its vertical axis: the declared simple shape, which does not change, or the slice or projection of the
  turned mesh. Built-in shapes and drawn outlines have no `turn`: they are extrusions, whose slice a turn would
  stretch and clip, so they only tilt. Keeping `turn` on the asset mesh makes those states impossible.
- **The box fits the turned mesh.** `width`, `height` and `depth` fill the bounds of the turned mesh, as they fill the
  unturned one today, so resizing, mirroring and tilting scale or turn the baked outlines exactly and need no bake.
  Only a change of turn bakes. Turning keeps the object's scale: the editor carries each axis's scale over to the new
  bounds.
- **One bake.** `src/mesh-collision.ts` splits parsing from baking: parse a GLB once into its triangles, then bake its
  collision at a turn by rotating them and running the same slice or projection, trace and simplification.
  `meshTerrain(assetId, data, turn)` returns the turned entry and its box, for the project server
  (`/api/projects/{id}/art/assets/{assetId}/terrain?turn=`), the course kit and the generators.
- **In the Workshop.** The project session keeps parsed triangles per asset beside its `courseMeshTerrain` cache. A
  turn shows at once as a preview, and a worker bakes its collision when the turn settles: on releasing the handle, on
  each key press and on leaving the Turn field. The turn and its collision are then committed as one edit. A newer
  turn of the same object supersedes a bake still running, and a refused bake, such as a turned slice that no longer
  fits the level's outline limits, leaves the object unchanged and says why.
- **Drawing.** `CourseArtView` (`src/course-art-view.ts`) keeps sharing one geometry per mesh and writes each
  instance's matrix from its turn, with the turned bounds computed once per mesh and turn. The shapes look, which draws
  a mesh as its collision, needs nothing new.
- **Bake time.** Baking costs about what placing a mesh costs today. For a typical course mesh of a few thousand
  triangles that is roughly 10–50 ms, and a few hundred milliseconds at most for the largest mesh allowed, 50,000
  triangles. These are estimates from the algorithm, not measurements. Collision isn't needed while you edit, but
  the Workshop's game runs and autosaves as you edit, so baking right after each turn in a worker is how it's ready
  before any play without a dirty state.
- Level schema 12 with Stage B. Every bundled level's asset meshes gain `"turn": 0`.

## Docs

`docs/course-artwork.md` (turning meshes and their collision), `docs/decorations.md` (turn), the README's level editing
section (handles and keys), `docs/projects.md` and `server/api-manual.ts` (the level format, schema 12, and the terrain
endpoint's `turn`), and `docs/course-kit.md` (`meshTerrain`'s turn).

## Not planned

- Turning built-in shapes and drawn outlines.
- Pitch, or any free 3D orientation of terrain: collision is the slice or silhouette on the obstacle line, a 2D shape.
- Rotating objects that have no rotation: bonfires, enemies, triggers, pools, platforms and axes.
- A dirty state with a batch re-bake: the level never holds collision baked for another turn.

## Open questions

- Should Q / E and [ / ] go through `input.bindings` so a game can move them, or stay fixed Workshop keys?
- Should the turn dial show on terrain whose mesh declares a simple shape, where a turn changes only the look?

## Context

Level designers place scenery and mesh terrain from the Workshop's libraries and want to rotate them in place: tilting
today means typing degrees, and turning a 3D model to show another side means rotating it in a modelling tool and
importing it again.
