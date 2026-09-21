# Sprite visuals

## Authoring

Open **Workshop / Sprites**. Choose an anchor and a PNG to add a named layer.
Layers have independent width, height, local X/Y/Z offsets, and local Z rotation
in degrees. Select a layer to edit it; changes preview immediately, including
while physics is paused. An unbound layer inherits its anchor's translation,
rotation, and scale. Bone attachments and weighted meshes instead use the custom
skeleton described below. Artwork stays in its local XY plane; it is not an
automatically camera-facing billboard.

**Replace** hides the anchor's procedural visual or GLB replacement.
**Overlay** keeps that underlay visible. Several layers can share an anchor;
removing or hiding the last replacing layer restores the correct underlay, including a
GLB imported while sprites covered it. A single shared visibility owner prevents
the model and sprite systems from undoing each other's choices.

**Save** persists the complete layout and uploaded PNGs in this browser.
The acknowledged save restores on startup. **Revert** restores it without
overwriting it; imports, deletions, and offset edits remain drafts until Save.
JSON import/export transfers the same layout between browsers. Selecting a
different layer does not discard edits. Unreadable saves are reported and kept;
failed imports leave the previous rendering and draft intact.

Sprite storage is a separate IndexedDB database, `over-the-edge:sprites`.
Existing GLB, level, tuning, and IK records are unchanged. Saves are local to the
site/origin and are not uploaded. Different tabs do not synchronize live edits;
the last successful explicit Save becomes the next startup layout.

## Hybrid 2D rigging

The Sprites tab can author one skeleton per layout, without changing gameplay
physics. Use cutout images for rigid pieces, weighted grids for bending artwork,
or both in the same document. A skeleton can be saved before adding artwork.

### Bones and attachments

Choose the skeleton's host anchor, then create parented bones. Each bone has a
name, local X/Y position, rotation in degrees, and length. Its tip lies along
local **+X**. The diagram selects bones; the numeric controls edit their bind
pose. Bone coordinates are world-sized units, not image pixels.

The skeleton follows its host's world translation only. It does not inherit
host rotation or scaling, including a fully collapsed hammer shaft. A bone-bound
layer uses that bone's position and rotation plus the layer's placement. Its
**Anchor** still identifies which original visual Replace hides. For example,
a custom upper-arm bone can carry an image while replacing the original
upper-arm visual. Position a +X-oriented arm image halfway along its bone.

For a deforming image, place its rectangle in skeleton-root coordinates, choose
grid columns/rows and influencing bones, then bind the mesh. Automatic weights
use distance to bone segments, with at most four influences per vertex. The
vertex-weight controls allow explicit refinement. Grid vertices run left to
right, starting at the image's top row. Weights must sum to one. A skinned layer
cannot also attach to a single bone or use shaft tiling.

Changing the bind pose rebinds existing meshes; it does not decode images again.
Bone deletion is rejected while children, attachments, weights, poses, or
constraints still reference it. Remove or reassign those references first.

### Facing and animation

Layer direction masks support **right, up-right, up, up-left, left, down-left,
down, and down-right**. Facing is selected from the aiming direction; arm IK
continues to track continuously within each sector. Use separate layers for
different images, offsets, and front/back depth ordering in each direction.
Hidden layers do not cover their underlying visuals.

Author directional bone poses and named animation clips with duration, looping,
and timed keyframes. Pose values are offsets from the bind pose, not absolute
world positions. Missing bone entries mean zero offset. Angles interpolate as
authored, including full **0 to 360 degree** turns. Directional poses precede
animation and IK. Select a default clip for gameplay; it uses simulation time
and pauses with the game.

The pose preview can scrub a clip or edit offsets without running gameplay.
The diagram always shows the bind pose; disable constraints in an explicit
preview to adjust artwork without IK or hair taking over. Return to live view
to use actual aiming, the default clip, and secondary motion. Preview controls are transient; saved
clips, directional poses, and the default clip travel with the layout.

Direction masks cannot invent unseen artwork. Supply the front/back/side images
you need; a single PNG is not converted into a rotating 3D character.

### Hands and the extendable hammer

Add a two-bone IK chain with an upper bone, lower bone, hand bone, and target.
The lower and hand origins must be at their parent's tip:
`x = parent.length`, `y = 0`. Edit bend direction, blend, oriented grip offsets,
and wrist rotation. Constrained child joints can rotate but cannot translate
in saved poses. Unreachable targets clamp to the chain's length; IK never
moves the physical hammer to compensate.

This game supplies `left-grip` and `right-grip` from the same actual grip
positions used by its existing arms. It also supplies `hammer-base`, `aim`,
and the thirteen visual anchors as target ports. Offsets follow the target's
orientation, so a grip adjustment rotates with the shaft.

For a seamless extending shaft, attach a layer to **hammer-shaft**, choose
Replace, and set its **tile length**: the world length represented by one
horizontal image repeat. The shaft repeats its UVs as physical length changes,
rather than stretching the pattern. An active, anchor-bound tiled replacement
spans the hinge/carrier to the head, so it visibly telescopes with reach.
Its grip frame uses fixed-size offsets from that base, clamped when the shaft
fully retracts. Legacy sprites and GLB shafts retain the full sliding handle.
Use tileable left/right image edges.
Keep the head and grip artwork on separate anchors/bones so their size stays
fixed. Tiling changes artwork density, not the physics reach limit.

### Spring-bone hair

Choose a continuous chain of bones and adjust stiffness, damping, gravity, and
collision radius. Add bone-attached circular body colliders to keep strand
particles outside the body. A chain's root is pinned; its remaining joints
maintain segment lengths and world-space inertia as the character moves.
Rotated parents, animation, and IK update before hair.
Gravity is positive downwards; a negative value lifts the strand.

Hair is cosmetic spring-bone motion, not a full cloth, hair-to-hair, or terrain
collision solver. Use several short chains or a weighted hair image for long
hair. Distinct constraints cannot share bones. IK, separate hair chains, and
body colliders cannot depend on already simulated hair ancestors. Use one
continuous chain rather than nesting independent hair solvers.
Place circles and roots so the strand can escape: pinned roots and bone lengths
take precedence when overlapping colliders make a collision-free pose impossible.

The runtime advances bounded fixed substeps, freezes on the same simulation
time, and resets on backward scrubbing or a restart. Hair never adds forces,
bodies, or collision fixtures to the game.

## Game-agnostic contract

`src/sprite-data.ts` and `src/skeleton-data.ts` own the immutable, validated
document format. `src/skeleton-pose.ts` evaluates poses, IK, and hair independently
of Three.js. `src/sprite-rig.ts` knows only named scene anchors and sprite rigs; it does not
import this game's body-part IDs, physics, editor, or game-specific assets.

```ts
const anchors = new Map([
  ['accessory', {
    node: attachmentNode,
    setCovered: state => visibility.setCovered(state),
  }],
]);
const rig = new SpriteRig(anchors, {
  root: scene,
  targetIds: [...anchors.keys(), 'grip'],
});
await rig.replace(document, { signal: lifecycle.signal });
// Each rendered frame; target positions are world XY, angles are radians.
rig.update({
  time: simulationTime,
  aim: aimDirection,
  targets: new Map([['grip', { x: gripX, y: gripY, angle: gripAngle }]]),
});
rig.upsert(editedLayer);
rig.remove(layerId);
rig.dispose();
```

Anchors are injected by the host game. `GameView` supplies this game's thirteen
body/tool anchors, their stable fitting bounds, and visibility ownership.
Arms use local Y along the segment; the full hammer shaft uses local X.
Head coordinates are torso-local, so its fitting center is above the origin.
Shaft replacement also selects the full rendered shaft's grip frame for IK.
Visuals do not create bodies or change colliders, masses, reach, or simulation.
Coverage callbacks only update the host's underlay visibility; they must not
re-enter the rig. Replacements snapshot validated metadata before awaiting
image loading, so later caller edits cannot change an in-flight import.

The portable JSON shape is:

```json
{
  "schemaVersion": 2,
  "skeleton": null,
  "images": [
    { "id": "badge", "name": "Badge", "source": "/sprites/badge.png" }
  ],
  "layers": [
    {
      "id": "badge-layer",
      "name": "Badge",
      "anchor": "accessory",
      "image": "badge",
      "width": 0.4,
      "height": 0.3,
      "offset": { "x": 0, "y": 0.2, "z": 0.05 },
      "rotation": 0,
      "underlay": "overlay",
      "bone": null,
      "directions": ["right", "up-right", "up", "up-left", "left", "down-left", "down", "down-right"],
      "skin": null,
      "tileLength": null
    }
  ]
}
```

This example's arbitrary `accessory` anchor demonstrates the generic contract;
use a registered body/tool anchor when importing into this game's Workshop.
Images can use embedded `data:image/png;base64,...`, public HTTP(S) URLs,
or `/site-relative` paths. Imported files become embedded PNGs. Repeated layers
reference the same image ID; IDs must be unique and unused images are rejected.
Unknown anchors, fields, formats, or image references fail before replacement.
Schema-1 layouts remain importable as unbound layers visible in all directions.
Reading an old save does not rewrite it; an explicit Save/export writes schema 2.
Keep an original export if it must also work in older releases.

The skeleton format is defined by `SkeletonDefinition` in
`src/skeleton-data.ts`: `anchor`, `bones`, directional `poses`, `clips`,
`animation`, `ik`, `hair`, and `colliders`. `SpriteSkin` stores grid dimensions
and normalized per-vertex bone weights. Runtime `configureSkeleton()` applies
validated skeleton edits without reloading images, and `setPreview()` selects
an explicit `SkeletonPreview` or `null` for live playback.
Skeleton edits default to live playback; pass `{ preview }` as the second
`configureSkeleton()` argument to preserve a valid authoring preview atomically.

URLs remain references on export, not downloaded archives. Cross-origin images
must permit CORS; fetches omit credentials. Do not publish private URLs, signed
tokens, or artwork without distribution rights. Embedded PNGs retain their
original bytes, including any metadata; review that content before publishing.

## Resource and lifecycle bounds

| Limit | Value |
| --- | --- |
| Layers / images | 256 / 128 |
| PNG bytes / full JSON bytes | 8 MiB / 24 MiB |
| Texture edge / total unique decoded pixels | 4096 / 16 Mi pixels |
| Width and height | 0.01-16 local units |
| Each offset axis / rotation | -16 to 16 / -180 to 180 degrees |
| Each PNG download | 30 seconds |
| Bones / clips / total keyframes | 64 / 16 / 128 |
| Clip duration | 0.05-60 seconds |
| IK chains / hair chains / body circles | 8 / 16 / 32 |
| Mesh grid segments per axis | 1-32 |
| Total weighted vertices / influences per vertex | 16,384 / 4 |

The renderer shares one plane geometry for rigid cards and caches textures/materials by source.
It uses unlit sRGB materials with tone mapping disabled for artwork, a 0.5 alpha
cutoff, depth writes, and double-sided cards. It does not change the scene's
lighting or tone mapping for other visuals. Holes are cut out rather than sorted
as translucent layers; avoid coplanar overlaps by authoring distinct depths.

Replacements stage bounded image loads off-scene, then commit atomically.
Failed or cancelled loads retain the previous rig. Disposal cancels pending
work and closes decoded bitmaps as well as releasing GPU resources. Unchanged
sources are reused across replacements. Atomic staging can temporarily retain
both the old and incoming layout's pixel budgets. Native bitmap decoding cannot
be interrupted; after cancellation, further mutations are rejected until its
late result has been closed.

Removing a card leaves its loaded image cached until the next whole-document
replacement or disposal, allowing incremental reuse without decoding again.
Layer edits touch the changed mesh and affected coverage. Weighted grids use GPU
skinning with a shared skeleton; tiled layers own their UV buffers. Poses and
secondary motion update only the active rig, not the level or editor. There is
no per-frame image decoding or geometry allocation. Each visible rigid card
has two triangles; a weighted grid has two triangles per cell. Each visible
layer has one draw call; shared materials do not imply instanced batching.

## Editor-free releases

Export a layout into a JSON file inside the project, then select it explicitly:

```sh
GAME_SPRITES=skins/my-sprites.json npm run build:game
GAME_LEVEL=levels/my-level.json GAME_SPRITES=skins/my-sprites.json npm run build:game
```

The build validates the document, anchors, bones, weights, and IK targets.
Skeletons, clips, directional layers, hair, and tile settings use this same
`GAME_SPRITES` input; there is no separate rig profile. Embedded PNGs become separate
hashed assets, deduplicated by content rather than embedded in executable
JavaScript. Development uses the same document with embedded sources through
the virtual module; changes to the selected file reload the page.

The release waits for its selected sprites before starting gameplay. It loads
no editor UI, import controls, browser saves, GLB importer, or diagnostics.
Without `GAME_SPRITES`, it uses the procedural character and includes no sprite
artwork. Sprite JSON is independent of level JSON and browser physics/IK profiles.

## Self-contained sprite example

`examples/sprites.mjs` uses an original geometric PNG swatch, with no external
files or project dependencies. Pass any anchor registered by the host game.
For this game's existing `pot` anchor:

```sh
node --experimental-strip-types examples/sprites.mjs pot
```

This creates **`artifacts/sprite-example.json`**, an ignored local file that can
be imported through the Sprites tab or selected with `GAME_SPRITES`.
Existing output is never overwritten.

Two layers share one image: a replacing panel and a smaller, rotated overlay
with independent X/Y/depth offsets. The generator does not import game-specific
anchor names, dimensions, or physics. Another host can pass its own anchor,
such as `accessory`, without changing the example or renderer.
