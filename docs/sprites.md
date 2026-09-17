# Sprite visuals

## Authoring

Open **Workshop / Sprites**. Choose an anchor and a PNG to add a named layer.
Layers have independent width, height, local X/Y/Z offsets, and local Z rotation
in degrees. Select a layer to edit it; changes preview immediately, including
while physics is paused. A layer inherits its anchor's translation, rotation,
and scale. It is a flat local-XY card, not an automatically camera-facing billboard.

**Replace** hides the anchor's procedural visual or GLB replacement.
**Overlay** keeps that underlay visible. Several layers can share an anchor;
removing the last replacing layer restores the correct underlay, including a
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

## Game-agnostic contract

`src/sprite-data.ts` owns the immutable, validated document format.
`src/sprite-rig.ts` knows only named scene anchors and PNG layers; it does not
import this game's body-part IDs, physics, editor, or game-specific assets.

```ts
const rig = new SpriteRig(new Map([
  ['accessory', {
    node: attachmentNode,
    setCovered: state => visibility.setCovered(state),
  }],
]));
await rig.replace(document, { signal: lifecycle.signal });
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
  "schemaVersion": 1,
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
      "underlay": "overlay"
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

URLs remain references on export, not downloaded archives. Cross-origin images
must permit CORS; fetches omit credentials. Do not publish private URLs, signed
tokens, or artwork without distribution rights. Embedded PNGs retain their
original bytes, including any metadata; review that content before publishing.

## Resource and lifecycle bounds

| Limit | Value |
| --- | --- |
| Layers / images | 64 / 32 |
| PNG bytes / full JSON bytes | 8 MiB / 24 MiB |
| Texture edge / total unique decoded pixels | 4096 / 16 Mi pixels |
| Width and height | 0.01-16 local units |
| Each offset axis / rotation | -16 to 16 / -180 to 180 degrees |
| Each PNG download | 30 seconds |

The renderer shares one plane geometry and caches textures/materials by source.
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
Layer edits touch only the changed
mesh and affected coverage; there is no sprite update loop, image re-decode,
or editor scan each frame. Each visible card has two triangles and one draw call;
shared materials do not imply instanced draw-call batching.

## Editor-free releases

Export a layout into a JSON file inside the project, then select it explicitly:

```sh
GAME_SPRITES=skins/my-sprites.json npm run build:game
GAME_LEVEL=levels/my-level.json GAME_SPRITES=skins/my-sprites.json npm run build:game
```

The build validates the document and its anchors. Embedded PNGs become separate
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
