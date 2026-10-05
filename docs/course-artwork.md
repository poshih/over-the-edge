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
  [declares](#declared-collision), or else as its [slice](#generated-collision-the-slice),
  its cross-section on the [obstacle line](../README.md#obstacle-line).

The GLBs are the [game project's](projects.md) course artwork; your own project server
stores them with the rest of the game. They can also draw [decoration models](#decoration-models).

## Placing meshes

In **Workshop / Level / Meshes**, **Import GLB mesh** adds a GLB to the project and arms
it: click or tap the canvas to place it. Every mesh the project has gets a button. A mesh
is placed at its own size in metres, scaled as a whole into the level's size limits when
it is too large or too small. Then move, rotate, resize and mirror it like any terrain:
**M** mirrors it while placing, and **Mirror left / right** under **Object properties**
mirrors it afterwards. **Object properties** also say how it collides. **Project / Course
artwork** lists the meshes; **Remove** takes out one the level no longer places.

The Workshop draws the course as the project's **Course look** says, as its releases do
(see [course look](#course-look)). A placed GLB draws as its collision until it has loaded,
and keeps doing so if it cannot load.

Over the [project API](projects.md#api-for-scripts-and-language-models), upload the GLB with
`POST /api/projects/{id}/art/assets`, then `GET /api/projects/{id}/art/assets/{assetId}/terrain`
answers with its natural size and the `mesh` entry to place, collision included.

## How a mesh sits on the course

The 2D physics plays out on the obstacle line, z = 0. A terrain object places its mesh
in a box: `width` × `height` metres, centred on `x`, `y` (Y is up) and turned by `angle`
(radians, counterclockwise), and `depth` metres deep, centred on the obstacle line. The
game measures the GLB's bounds and maps them onto that box:

| GLB bounds | Placed at, before turning |
| --- | --- |
| minimum/maximum X | `x - width / 2` to `x + width / 2` |
| minimum/maximum Y | `y - height / 2` to `y + height / 2` |
| maximum Z (front, toward the camera) | z = `depth` / 2 |
| minimum Z (back) | z = -`depth` / 2 |

glTF's axes are used as-is: +X is right, +Y is up, and +Z faces the camera. The middle
of a mesh's depth always lies on the obstacle line, which is where its collision comes
from. `mirror` reflects the mesh, and its collision with it, left to right before it
turns. One GLB can be placed any number of times, each placement stretched to its own box;
its collision is fitted to the same box, so what you see stays what the hammer and pot
touch.

### Declared collision

A GLB declares its collision with a custom property `collision` on its scene or one of
its root nodes, which glTF exports as `"extras": { "collision": "box" }` (in Blender, a
custom property exported with **Include / Custom Properties**). The value is one of the
built-in shapes, `box`, `ramp`, `triangle`, `circle` or `hexagon`, filling the mesh's box,
or `slice` to ask for the slice. A circle collides as a true circle and needs a square box,
so it is placed with equal width and height. Declare a shape when the cross-section is not
what should collide, such as a gnarled boulder that should roll like a ball or a crate with
open slats, or for the cheapest, smoothest contact. Declaring two different values fails.

### Generated collision: the slice

A GLB that declares no shape is sliced through the middle of its depth, the plane that
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

A mesh that cannot be sliced is refused with what to change: declare a collision type,
or fix the mesh.

Slicing happens once, when a mesh is imported or its terrain is read. The collision is
stored in the level with each placement, so the physics, phantoms, the project server and
level-only builds never need the GLB. The Workshop and the project server slice alike, so
the same GLB always gets the same collision.

### In level JSON

```json
{
  "kind": "terrain", "id": "boulder-1",
  "mesh": {
    "type": "asset", "assetId": "asset-<SHA-256 of the GLB>",
    "collision": { "type": "slice", "loops": [[{ "x": -0.5, "y": -0.5 }, { "x": 0.5, "y": -0.5 }, { "x": 0, "y": 0.5 }]] }
  },
  "x": 4, "y": 2, "width": 3, "height": 1.6, "angle": 0, "depth": 2, "mirror": false,
  "color": 7438714, "illusion": false, "surface": "rock"
}
```

`mesh` is `{ "type": "shape", "shape": "box" }` for a built-in mesh, `{ "type": "outline",
"vertices": [...] }` for a drawn shape, or `{ "type": "asset", "assetId", "collision" }`
for a GLB, whose collision is `{ "type": "box" }` (or another built-in shape) or its slice.
Outlines and slice loops lie in the unit box, -0.5 to 0.5 on both axes. A drawn outline is
simple and counterclockwise. A slice's loops never cross or touch, and keep the solid on
each edge's left: outer loops run counterclockwise and holes clockwise. `color` colours
built-in meshes and drawn shapes, and a GLB drawn as its collision.

Each distinct collision, mirrored or not, is one physics shape and one extruded template;
a level has at most 64. A GLB that declares `box` shares the built-in block's.

## Course look

**Project / Course artwork / Course look** chooses how the Workshop and releases draw the
course. **Meshes**, the default, draws every placed GLB. **Extruded collision and
placeholders** draws every terrain object as its collision extruded in its colour, and
decorations as their placeholders, for a quick blockout; such releases include no GLBs,
no GLTF loader and no mesh renderer.

## Decoration models

Decorations are placed with the built-in placeholder library, and each names its model
by ID. Mapping a model ID to a GLB in a [course package](#course-packages) replaces the
placeholder of every decoration of that model in mesh releases, including decorations
placed after packing. The Workshop keeps showing the placeholder. A model ID the library
lacks, such as `stone-idol`, is drawn only by its GLB. The Workshop shows such decorations
nowhere and lists their model as waiting, and shape releases refuse them.

A decoration model keeps its own proportions, unlike terrain meshes, which stretch to
their box. The game measures the GLB's bounding box and scales it uniformly so its
height equals the decoration's height. It stands the centre of the bottom of that box
on the decoration's position, at the decoration's depth. glTF's axes are used as-is:
+X is right, +Y is up, and +Z faces the camera. A decoration's rotation turns the
model in the course plane. Mirror reflects it left to right, and its tint multiplies
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

Packages default to the meshes look; add `--mode=shapes` to package the GLBs but release
the extruded collision unless overridden:

```sh
# Use the look saved in the package:
GAME_LEVEL=courses/my-course.json npm run build:game

# Explicitly override it:
GAME_LEVEL=courses/my-course.json GAME_ART_MODE=shapes npm run build:game
GAME_LEVEL=courses/my-course.json GAME_ART_MODE=meshes npm run build:game
```

`GAME_ART_MODE` also works with `npm run dev:game`. Plain level JSON and the built-in
course default to shapes. Meshes mode needs a package containing every placed GLB.
Unknown modes, missing assets, invalid GLBs, and content/hash mismatches fail the build
instead of producing a misleading release. Mesh releases package each drawn GLB once as
release content and load all of them, in parallel and verified, before play starts. Both
looks are static, editor-free builds; see [content delivery](content-delivery.md) for how
their content is served.

### Course package format

```json
{
  "format": "over-the-edge-course",
  "schemaVersion": 2,
  "mode": "meshes",
  "level": { "schemaVersion": 6, "labels": [], "objects": [] },
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
chunks. Only edited transforms and dirty chunk bounds are uploaded, and fades
update only active fading batches. Reusing a GLB never duplicates its textures, and the
Workshop lets go of a GLB once the level no longer places it. Decoration GLBs are
instanced like the placeholders they replace (see
[decoration performance](decorations.md#performance)).
