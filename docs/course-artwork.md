# Course meshes from your own pipeline

Over the Edge is meant to be self-hosted and does not include an asset-generation
service. You bring the meshes a course is built from: make static GLBs with whatever
tools you prefer, such as a modelling package, a procedural generator, or an image-to-3D
service.

A course's terrain is made of meshes. Every terrain object is a mesh placed in the level,
and the mesh brings its collision:

- **Built-in meshes:** the block (`box`), `ramp`, `triangle`, `circle` and `hexagon`,
  extruded in the object's colour. Each collides as its shape.
- **Drawn shapes:** outlines drawn in **Workshop / Level / Draw shape**, extruded the same
  way. Each collides as its outline.
- **GLB meshes:** any static GLB. It collides as the simple shape it
  [declares](#declared-collision), as its [projection](#generated-collision-the-projection),
  its outermost outline seen along the view, when it declares that, or else as its
  [slice](#generated-collision-the-slice), its cross-section on the
  [obstacle line](../README.md#obstacle-line).

The GLBs are the [game project's](projects.md) course artwork; your own project server
stores them with the rest of the game. They can also draw [decoration models](#decoration-models).

## Placing meshes

In **Workshop / Level / Meshes**, **Import GLB mesh** adds a GLB to the project and arms
it: click or tap the canvas to place it. Every mesh the project has gets a button. A mesh
is placed at its own size in metres, scaled as a whole into the level's size limits when
it is too large or too small. Then move, tilt, resize and mirror it like any terrain, and
[turn](#turning-a-mesh) it to show another side: **M** mirrors it while placing, and **Mirror
left / right** under **Object properties** mirrors it afterwards. **Object properties** also say
how it collides. **Project / Course
artwork** lists the meshes; **Remove** takes out one the level no longer places.

The Workshop draws the course as its releases do. A placed GLB draws as its collision until
it has loaded, and keeps doing so if it cannot load.

Over the [project API](projects.md#api-for-scripts-and-language-models), upload the GLB with
`POST /api/projects/{id}/art/assets`, then `GET /api/projects/{id}/art/assets/{assetId}/terrain`
answers with its natural size and the `mesh` entry to place, collision included; add `?turn=`
with radians for the mesh [turned](#turning-a-mesh).

## How a mesh sits on the course

The 2D physics plays out on the obstacle line, z = 0. A terrain object places its mesh
in a box: `width` × `height` metres, centred on `x`, `y` (Y is up) and tilted by `angle`
(radians, counterclockwise), and `depth` metres deep, centred on the obstacle line. The
game measures the GLB's bounds, as [turned](#turning-a-mesh), and maps them onto that box:

| GLB bounds | Placed at, before tilting |
| --- | --- |
| minimum/maximum X | `x - width / 2` to `x + width / 2` |
| minimum/maximum Y | `y - height / 2` to `y + height / 2` |
| maximum Z (front, toward the camera) | z = `depth` / 2 |
| minimum Z (back) | z = -`depth` / 2 |

glTF's axes are used as-is: +X is right, +Y is up, and +Z faces the camera. The middle
of a mesh's depth always lies on the obstacle line, which is where its collision comes
from. `mirror` reflects the mesh, and its collision with it, left to right after it turns and
before it tilts. One GLB can be placed any number of times, each placement stretched to its own box;
its collision is fitted to the same box, so what you see stays what the hammer and pot
touch.

### Turning a mesh

A placed GLB can turn about its own vertical axis to show another side: the mesh entry's
`turn`, -π to π radians, swings +Z toward +X. The box then fits the turned mesh's bounds, and
the collision is the turned mesh's: the shape it declares, fitted to those bounds, or its
slice or projection, generated again for the turn. Built-in shapes and drawn outlines only
tilt: they are extrusions, whose slice a turn would stretch.

In the Workshop, select the mesh and drag the dial under it left or right, its knob marking
where the front faces and Shift snapping to 15°, press **[** / **]** to turn it 15°, or type
its **Turn** under **Object properties**. The course shows the turn at once while a worker
generates the turned collision off the page's thread; the turn and its collision then
change together as one edit, each axis keeping its scale within the level's size limits, so
the level never holds collision for another turn. A turn baked while you drag something waits
for the drag to end. A newer turn replaces one still generating, and a turn whose collision
cannot be generated leaves the mesh as it was and says why. Over the API, read the mesh
entry at the new turn and multiply `width`, `height` and `depth` by its natural size over the
one at the old turn, keeping them within the level's size limits and a circle's box square.

### Declared collision

A GLB declares its collision with a custom property `collision` on its scene or one of
its root nodes, which glTF exports as `"extras": { "collision": "box" }` (in Blender, a
custom property exported with **Include / Custom Properties**). The value is one of the
built-in shapes, `box`, `ramp`, `triangle`, `circle` or `hexagon`, filling the mesh's box,
`slice` to ask for the slice, or `projection` for the [projection](#generated-collision-the-projection). A circle collides as a true circle and needs a square box,
so it is placed with equal width and height. Declare a shape when the cross-section is not
what should collide, such as a gnarled boulder that should roll like a ball or a crate with
open slats, or for the cheapest, smoothest contact. Declare `projection` when the mesh's
outermost outline should collide wherever it lies in the depth, not its middle. Declaring two
different values fails.

### Generated collision: the slice

A GLB that declares no collision, or declares `slice`, is sliced through the middle of its depth, the plane that
lies on the obstacle line once it is placed. The cross-section is sampled on a grid of 384
cells across the longer side of the mesh's box, with the nonzero rule, so overlapping
parts merge into one solid. It is traced into outlines, and holes stay holes. Outlines
smaller than 0.02% of the box, and at least 9 cells, are dropped, and holes that small are
filled. The grid turns slanted edges into staircases of one-cell steps; each step becomes its
midpoint, so a slope stays one smooth edge rather than a row of tiny ledges the hammer could
hook. The outlines are then simplified as little as fits the level's limits: at most 16
outlines of 64 points each, and 256 points together. Edges stay within a cell where they
can.

For a clean slice:

- Close the mesh where it crosses the middle plane. A few rows that cross an opening are
  bridged from their neighbours; a mesh with more holes there fails.
- Keep its faces facing outward, as glTF's counterclockwise front faces do. Mirroring
  node transforms are allowed.
- Model what should collide through the middle of the depth: a column that only exists
  near the back has no slice.

The default orthographic camera draws a mesh as its silhouette, so wherever the mesh bulges in
front of the obstacle line or behind it, its slice collides inside what you see: the pot can rest
below a visible top edge, overlap rock it seems to stand against, or find no hold on rock it can
see. The perspective camera shows the same bulges, those in front of the line a little larger.
Declare `projection` for meshes like that, or keep their widest outline at the middle of their
depth.

A mesh that cannot be sliced is refused with what to change: declare a collision type, such
as `projection`, or fix the mesh.

### Generated collision: the projection

A GLB that declares `projection` collides as its silhouette seen along the view: every face
projected straight along the depth onto the course plane, whichever way it faces, so the
mesh's outermost outline collides wherever it lies in the depth, in front of the obstacle
line, behind it or across it. A boulder that bulges toward the camera, or a cliff whose
ledges stand out at the back, then collides at the edge you see rather than where its middle
crosses the line. With the default orthographic camera the collision matches the drawn
outline; a perspective camera draws the parts in front of the line a little larger, and
those behind a little smaller, than where they collide.

The projection is sampled on the same grid as a slice, then traced, cleaned and simplified
the same way, within the same limits. Holes stay holes: a gap you can see through, such as an
arch's opening, stays open. The mesh need not be closed, and its faces may turn either way,
but a face seen edge-on casts no shadow, so a mesh needs some area facing the camera.

Slices and projections are generated once for each turn, when a mesh is imported, its
terrain is read or a placement turns.
The collision is stored in the level with each placement, so the physics, phantoms, the
project server and level-only builds never need the GLB. The Workshop and the project server
generate them alike, so the same GLB always gets the same collision.

### In level JSON

```json
{
  "kind": "terrain", "id": "boulder-1",
  "mesh": {
    "type": "asset", "assetId": "asset-<SHA-256 of the GLB>", "turn": 0,
    "collision": { "type": "slice", "loops": [[{ "x": -0.5, "y": -0.5 }, { "x": 0.5, "y": -0.5 }, { "x": 0, "y": 0.5 }]] }
  },
  "x": 4, "y": 2, "width": 3, "height": 1.6, "angle": 0, "depth": 2, "mirror": false,
  "color": 7438714, "illusion": false, "surface": "rock"
}
```

`mesh` is `{ "type": "shape", "shape": "box" }` for a built-in mesh, `{ "type": "outline",
"vertices": [...] }` for a drawn shape, or `{ "type": "asset", "assetId", "turn", "collision" }`
for a GLB turned `turn` radians, whose collision, generated for that turn, is `{ "type": "box" }` (or another built-in shape), or its
generated outlines, `{ "type": "slice", "loops" }` or `{ "type": "projection", "loops" }`.
Outlines and generated loops lie in the unit box, -0.5 to 0.5 on both axes. A drawn outline is
simple and counterclockwise. Generated loops never cross or touch, and keep the solid on
each edge's left: outer loops run counterclockwise and holes clockwise. `color` colours
built-in meshes and drawn shapes, and a GLB drawn as its collision.

Each distinct collision, mirrored or not, is one physics shape and one extruded template;
a level has at most 64. A GLB that declares `box` shares the built-in block's.

## The built-in course

The course every new game starts from is built this way, from the engine's own GLBs in
`src/default-course/meshes/`: a **Ground slab** that declares `box`, a **Cliff** that
collides as its slice, the climb's ledges and its overhang, a **Boulder**, the vault, and a
**Crag** closing each end of the course, mirrored on the right. `src/default-course/course.json`
lists the GLBs with their asset IDs and holds the level, its collision included.

The level also has one of each hazard, none of which collides, on those rocks: a
[bonfire](../README.md#health-and-bonfires) on the first ledge, which a fallen player comes
back to once the hammer has lit it; a [projectile trap](../README.md#traps) set into the left crag, firing over the start
across the second ledge; a shallow swamp [pool](../README.md#liquid-pools) against the fourth
ledge's riser; a swinging axe over the last step below the summit; and a lava lake filling the
basin past the summit's far edge, **over the edge**. So it shows health, and a new game starts
with an example of each to keep, move or delete.

`npm run generate:default-course` makes all of it. It models each rock from an
outline: through the middle of its depth the walls are the outline itself, so the slice is
that outline; toward the front and back they chamfer in and the faces bulge, roughened by
seeded noise. The GLBs have rough, non-metallic PBR materials coloured per vertex and no
normals, so they are drawn flat-shaded. The script slices them with the engine's own slicer,
places them with the hazards and validates the level. About 6,800 triangles and 100 KB together, they load in
the Workshop when it draws them; new server projects copy them, and builds without
`GAME_LEVEL` package them.

## Decoration models

Decorations are placed with the built-in placeholder library, and each names its model
by ID. Mapping a model ID to a GLB in a [course package](#course-packages) replaces the
placeholder of every decoration of that model, including decorations placed after packing,
in the Workshop and in releases alike. A model ID the library lacks, such as `stone-idol`,
is drawn only by its GLB. The Workshop loads a decoration's GLB as the level first draws it,
and selects, outlines and places the decoration by the model as drawn; a GLB that cannot load
is reported, and its decorations draw their built-in model if the library has one.

A decoration model keeps its own proportions, unlike terrain meshes, which stretch to
their box. The game measures the GLB's bounding box and scales it uniformly so its
height equals the decoration's height. It stands the centre of the bottom of that box
on the decoration's position, at the decoration's depth. glTF's axes are used as-is:
+X is right, +Y is up, and +Z faces the camera. A decoration's `turn` turns the model about
its vertical axis, and its tilt then turns it in the course plane. Mirror reflects it left to
right after the turn, and its tint multiplies
the model's material colours, so white leaves them unchanged. The GLB's own materials
and PBR textures are used, and every copy shares them.

## Course packages

A course package is one JSON file holding a level and the GLBs it draws, for
[level-file builds](../README.md#game-only-release) and for importing into a project with
**Project / Course artwork / Import course package**, which replaces the level and brings
the GLBs. Pack one from a level JSON, exported from **Workshop / Level**, and an assets
file listing GLBs relative to itself:

```json
{
  "meshes": ["art/boulder.glb", "art/arch.glb"],
  "decorations": {
    "dead-tree": "art/dead-tree.glb",
    "stone-idol": "art/idol.glb"
  }
}
```

```sh
npm run pack:course -- levels/my-level.json courses/assets.json courses/my-course.json
GAME_LEVEL=courses/my-course.json npm run dev:game
GAME_LEVEL=courses/my-course.json npm run build:game
```

`meshes` lists the GLBs the level's terrain places, matched to its meshes by the SHA-256
hash of their contents; `decorations` maps decoration model IDs to GLBs (see
[decoration models](#decoration-models)). Either can be left out. Each distinct file is
embedded once, even when terrain and decorations share it. `pack:course` fails, without
writing anything, on a listed mesh the level does not place, a placed mesh no listed file
matches, decoration models no decoration in the level uses, missing or non-GLB files, and
size limits. Keep assets files and packages out of `levels/`: the Workshop serves every
file there as a level (see [server levels](../README.md#level-editing)).

Builds take the GLBs from the package. Plain level JSON carries none, so a build from level
JSON whose terrain places GLBs fails, pointing to its course package or a `GAME_PROJECT`;
the [built-in course](#the-built-in-course), built without `GAME_LEVEL`, brings its own GLBs.
Missing assets, invalid GLBs, and content/hash mismatches fail the build instead of
producing a misleading release. Releases package each GLB they draw once as release content
and load all of them, in parallel and verified, before play starts; a release that draws no
GLB includes no GLTF loader and no mesh renderer. Releases are static, editor-free builds;
see [content delivery](content-delivery.md) for how their content is served.

### Course package format

```json
{
  "format": "over-the-edge-course",
  "schemaVersion": 3,
  "level": { "schemaVersion": 12, "name": "Boulder Run", "labels": [], "objects": [] },
  "assets": [
    { "id": "asset-<sha256 hex of the GLB>", "name": "boulder.glb", "source": "data:model/gltf-binary;base64,..." }
  ],
  "decorations": { "dead-tree": "asset-<sha256 hex of the GLB>" }
}
```

`level` is an ordinary level definition. `assets` embeds every GLB its terrain meshes
place, and `decorations` maps decoration model IDs to the asset drawing them, at most 128
models. Every asset is embedded exactly once, and each asset ID must match the SHA-256
hash of its GLB bytes. Asset names need 1-80 characters.

## Limits

Each GLB must be self-contained and uncompressed: no external URIs, Draco,
Meshopt, or KTX2. It must also be static: no skins, morph targets, animations,
or GPU-instanced nodes, and only triangle primitives. Textures must be PNG, JPEG, or
WebP (convert AVIF first), so the build and game can enforce decoded image budgets
before a browser allocates them. Per GLB: 20 MiB, 16 meshes, 50,000 triangles, and
textures up to 4096 pixels on a side. Per course, terrain and decorations together: 64
distinct GLBs, 64 MiB of GLBs, and 32 million decoded texture pixels. A course package
can be at most 96 MiB.

Opaque placements share geometry and materials, and are instanced in 32 m spatial
chunks, turned or not: a turn is part of each placement's transform, worked out once per
mesh and turn, and its normals follow it exactly however the placement is stretched. Only
edited transforms and dirty chunk bounds are uploaded, and fades
update only active fading batches. Reusing a GLB never duplicates its textures, and the
Workshop lets go of a GLB once nothing in the level draws it. Decoration GLBs are
instanced like the placeholders they replace (see
[decoration performance](decorations.md#performance)).
