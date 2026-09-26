# Course artwork from your own pipeline

Over the Edge is meant to be self-hosted and does not include an asset-generation
service. You design a course's collision as 2D polygons in **Workshop / Level**.
The game draws every terrain object as a 2.5D extrusion of its collision outline,
so the default look always matches what the hammer and pot touch.

To give a course bespoke artwork, make static GLB meshes with whatever tools you
prefer, such as a modelling package, a procedural generator, or an image-to-3D
service. Then package them with the level. The game fits each mesh onto its
terrain object. Collision is never derived from a mesh, and the editor never
generates artwork. A [game project](projects.md) can carry a packed course's GLBs;
your own project server stores them with the rest of the game.

## How a mesh matches its collision

A terrain object in level JSON is defined by:

- **Outline:** `shape` is a built-in type (`box`, `ramp`, `triangle`, `circle`,
  `hexagon`) or a `polygon` whose counter-clockwise vertices are normalized to
  the range -0.5 to 0.5 on both axes.
- **Placement:** the outline is scaled by `width` × `height` (metres), rotated
  by `angle` (radians, counter-clockwise) and centred on `x`, `y` (Y is up).
  Circles are true circles with diameter `width`.
- **Depth:** the default rendering extrudes the outline from its front face at
  z = 0 back to z = -`depth`. Depth affects only the look, not collision.

An assigned mesh replaces that extrusion. The game measures the GLB's bounding
box and maps it onto the object's box before rotating it:

| GLB bounds | Placed at |
| --- | --- |
| minimum/maximum X | `x - width / 2` to `x + width / 2` |
| minimum/maximum Y | `y - height / 2` to `y + height / 2` |
| maximum Z (front, toward the camera) | z = 0 |
| minimum Z (back) | z = -`depth` |

glTF's axes are used as-is: +X is right, +Y is up, and +Z faces the camera.
Mirror `x` reflects the mesh left to right. Mirror `diagonal` reflects it across
the line y = -x, which matches how the set piece tool mirrors ramps.

To match the collision silhouette exactly, build each mesh from the object's
normalized outline extruded along -Z, and keep decoration inside that outline's
bounding box. Anything that extends past the box squeezes the rest of the mesh
to fit. One GLB can serve any number of objects, but each placement is stretched
to its own object's box, so reuse meshes across objects with similar proportions.
Compare the look with `GAME_ART_MODE=shapes` and `GAME_ART_MODE=meshes` in
`npm run dev:game`.

## Workflow

1. Design the course in **Workshop / Level**, then **Export level JSON**, for
   example to `levels/my-level.json`. Assignments refer to terrain object IDs,
   so keep the IDs of dressed objects stable.
2. Make the GLBs with your own pipeline. Use the level JSON as its input: each
   terrain object's outline, size, rotation, and depth.
3. Write an assignments file that maps terrain IDs to GLB paths, relative to the
   assignments file. An entry can also choose a mirror:

   ```json
   {
     "floor": "art/floor.glb",
     "ledge-1": "art/stone.glb",
     "ledge-2": { "file": "art/stone.glb", "mirror": "x" }
   }
   ```

4. Pack the course, then build or preview it:

   ```sh
   npm run pack:course -- levels/my-level.json levels/assignments.json levels/my-course.json
   GAME_LEVEL=levels/my-course.json npm run dev:game
   GAME_LEVEL=levels/my-course.json npm run build:game
   ```

`pack:course` identifies each GLB by the SHA-256 hash of its contents and embeds
each distinct file once. It sets `art` on assigned terrain objects and removes it
from unassigned ones: the assignments file is the source of truth. It fails,
without writing anything, on unknown terrain IDs, unsupported mirrors, missing or
non-GLB files, and size limits. Packages default to meshes; add `--mode=shapes`
to package the artwork but release the extruded shapes unless overridden.

To change the collision later, import the level JSON (not the package) into the
Workshop. Terrain `art` references survive editing and export. Re-pack afterwards.
Moving or resizing an object keeps its mesh fitted to the new box. If you change
an object's outline, update its mesh as well.

## Release modes

```sh
# Use the look saved in the package:
GAME_LEVEL=levels/my-course.json npm run build:game

# Explicitly override it:
GAME_LEVEL=levels/my-course.json GAME_ART_MODE=shapes npm run build:game
GAME_LEVEL=levels/my-course.json GAME_ART_MODE=meshes npm run build:game
```

`GAME_ART_MODE` also works with `npm run dev:game`. Plain level JSON and the
built-in course default to shapes. Meshes mode needs a package containing every
referenced GLB. Unknown modes, missing assets, invalid GLBs, and content/hash
mismatches fail the build instead of producing a misleading release.

Shape-only releases include no GLBs, no GLTF loader, and no mesh renderer. Mesh
releases emit each referenced GLB once and load all of them before play starts.
Both are static, editor-free builds that need no backend.

## Course package format

`pack:course` writes this JSON. Other tools may write it directly:

```json
{
  "format": "over-the-edge-course",
  "schemaVersion": 1,
  "mode": "meshes",
  "level": { "schemaVersion": 2, "labels": [], "objects": [] },
  "assets": [
    { "id": "asset-<sha256 hex of the GLB>", "name": "stone.glb", "source": "data:model/gltf-binary;base64,..." }
  ]
}
```

`level` is an ordinary level definition. A terrain object that uses a mesh adds
`"art": { "assetId": "asset-...", "mirror": "none" }`, where mirror is `none`,
`x`, or `diagonal`. Every referenced asset must be embedded exactly once, and
each asset ID must match the SHA-256 hash of its GLB bytes. Asset names need
1-80 characters.

## Limits

Each GLB must be self-contained and uncompressed: no external URIs, Draco,
Meshopt, or KTX2. It must also be static: no skins, morph targets, animations,
or GPU-instanced nodes. Textures must be PNG, JPEG, or WebP (convert AVIF first),
so the build and game can enforce decoded image budgets before a browser
allocates them. Per GLB: 20 MiB, 16 meshes, 50,000 triangles, and textures up to
4096 pixels on a side. Per course: 64 distinct GLBs, 64 MiB of GLBs, and 32
million decoded texture pixels. A course package can be at most 96 MiB.

Opaque placements share geometry and materials, and are instanced in 32 m spatial
chunks. Only edited transforms and dirty chunk bounds are uploaded, and fades
update only active fading batches. Reusing a GLB never duplicates its textures.

## Verification

```sh
npm run verify:art
```

This packs a course with the command above, including its error cases. It
builds and plays both release modes, and checks the following in a real browser:
- Mesh bounds match collision boxes for every built-in shape and a custom
  polygon, across rotations and mirrors.
- A 1,000-object, 600 m course reuses one mesh.
- Illusion fade, disappearance, and reset work with meshes.
- PNG, JPEG, and WebP textures load.
- Editing a level in the Workshop keeps its `art` references.

`npm run verify` runs it after the other suites.
