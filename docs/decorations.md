# Decorations

Decorations are scenery: models placed around a course purely for their look. They never
collide, never affect the physics, and can stand anywhere from the far horizon to just in
front of the climb, which is how a level sets its mood. The engine ships a library of 26
original, low-poly placeholder models in a dark-fantasy style, built from code at runtime,
so a level can be blocked out before any art exists. When the art arrives, your own GLB
models replace the placeholders by model ID (see [your own models](#your-own-models)).

Make every prop a decoration. Terrain is for what the player climbs: small colliders
close together, such as headstones, posts or rubble within about 1.2 m of each other,
leave slots that trap the pot and the hammer head.

## Placing decorations

Open **Workshop / Level / Decoration library**, choose a category and a model, then click or
tap where its base should stand. Before clicking, **Object properties** shows the model
about to be placed: set its depth, height, tilt, turn, tint and mirror there, press **M** to
mirror it, **Q** / **E** to tilt it or **[** / **]** to turn it 15° either way. The next decoration you
place keeps the turn, as it keeps the mirroring. A translucent preview follows the pointer at the chosen depth. Near the course
(within 20 m of it) the base rests on the terrain top under the pointer, so graves and
braziers sit on the ground.

After placing, the Workshop switches to **Select decorations**, with the new decoration
selected. This tool picks the nearest decoration under the pointer and drags it in its own
depth plane, so it stays under the pointer however deep it is. Its round handle tilts it about
its base, Shift snapping to 15°, as **Q** / **E** do. The dial under it, a turntable whose knob
marks where the model's front faces, turns it as you drag left or right, Shift snapping to 15°,
as **[** / **]** do; **Delete selected object** or
the Delete key removes it. Ordinary selecting never picks decorations, so scenery never gets in
the way of editing the course; click **Select decorations** again to go back to it.

| Property | Meaning |
| --- | --- |
| Position X / Y | The centre of the model's base, in metres |
| Depth | Distance behind the [obstacle line](../README.md#obstacle-line) (negative, down to -1000 m) or toward the camera (positive, up to 15 m) |
| Height | The model is scaled uniformly to this height, 0.1-1000 m |
| Tilt | Turns the model in the view plane, about its base |
| Turn | Turns the model about its own vertical axis, -180° to 180°, to show another side; 0 is as modelled |
| Mirror | Flips the model left to right, after it turns |
| Tint | Multiplies the model's colours; white keeps them |

## Depth, camera and fog

Decorations are laid out in real 3D depth. With the theme's
[perspective camera](projects.md#section-reference), distant decorations look smaller and
drift slowly as the player climbs, while those in front of the course are larger and pass
quickly, which is what makes a far castle feel far. With the orthographic camera depth only
decides what stands in front of what, so scale distant decorations down yourself. See
[depth and parallax](depth-and-parallax.md) for how fast each depth moves and how to layer,
scale, fog, blur and tint scenery so it reads as distant.

The course itself is a slab around the [obstacle line](../README.md#obstacle-line): each terrain
object reaches half its depth behind the line and half in front, and nothing lies beyond that unless
you put something there. A prop standing on a collider must stand within that collider's depth, and
one behind the path must also keep clear of the pot, which reaches half its width behind the line
(0.5 m for the default jar). A
decoration behind the line draws with the course; one on or in front of it draws after the
characters, always covering the body but never a 3D character's arms or the hammer, so
keep it clear of the jar, which reaches as far toward the camera. Seen
through a perspective camera from above, a tree standing on empty ground behind the course
seems to float as the player climbs past it. Give background scenery ground to stand on with
**Rock shelf** models, whose tops reach 30 m back, or stand it on hills and crags of its own.

Theme fog applies to decorations like everything else: a decoration deeper than the fog end
disappears into the fog. To show the far horizon, raise **Fog end** in **Project / Theme**
(up to 2,000 m; Ashen Ascent uses 1,150 m). The theme's backdrop mountains stand about 10-25 m behind
the course and hide anything behind them; hide them in the theme when decorations provide
the horizon instead.

## The library

Each model starts at a height and depth where it reads well through a perspective camera.

| Category | Model | ID | Starts at | Use |
| --- | --- | --- | --- | --- |
| Ruins | Ruined pillar | `ruined-pillar` | 6 m, 3 m back | A broken column on its plinth, rubble at its feet |
| Ruins | Broken arch | `gothic-arch` | 11 m, 15 m back | Half a pointed arch on one pier; the other has fallen |
| Ruins | Crumbling wall | `broken-wall` | 6 m, 4 m back | Fortification with arrow slits and a ragged top |
| Ruins | Ruined watchtower | `watchtower` | 22 m, 80 m back | A round tower with fallen crenels and one lit window |
| Ruins | Distant cathedral | `cathedral` | 75 m, 400 m back | Twin spires and a glowing rose window |
| Ruins | Castle on the horizon | `castle` | 110 m, 600 m back | Curtain walls, round towers, a great keep, lit windows |
| Ruins | Viaduct | `stone-bridge` | 36 m, 200 m back | Four arches carrying a road across a gorge |
| Ruins | Rune obelisk | `obelisk` | 9 m, 12 m back | A tapering monolith with faintly glowing runes |
| Ruins | Knight statue | `knight-statue` | 7 m, 5 m back | A hooded knight resting on a planted greatsword |
| Wilds | Dead tree | `dead-tree` | 8 m, 3 m back | A gnarled, leafless tree |
| Wilds | Golden great tree | `great-tree` | 240 m, 900 m back | A colossal tree whose canopy glows gold on the horizon |
| Wilds | Thorn bush | `thorn-bush` | 1.2 m, 1.5 m back | A knot of black thorns for path edges |
| Wilds | Rock spire | `rock-spire` | 18 m, 60 m back | A jagged, mossy crag |
| Wilds | Rock shelf | `rock-shelf` | 4 m, 16 m back | A broad shelf reaching 30 m back: ground for scenery behind the course to stand on |
| Wilds | Mountain ridge | `mountain-ridge` | 200 m, 1,000 m back | A snow-capped range for the far horizon |
| Relics | Graves | `graves` | 1.4 m, 1.2 m back | Leaning headstones and a cross over fresh mounds |
| Relics | Sword grave | `sword-grave` | 5 m, 2 m back | A giant's sword driven into a mound |
| Relics | Skull pile | `skull-pile` | 1 m, 1 m back | A heap of skulls and bones |
| Relics | Hanging cage | `hanging-cage` | 6 m, 2 m in front | A gibbet cage on a long chain |
| Relics | Tattered banner | `banner` | 6 m, 1.5 m back | A torn war banner with a faded gold emblem |
| Relics | Hanging chains | `chains` | 8 m, 4 m in front | Chains from a beam, to frame a scene from the foreground |
| Relics | Iron fence | `iron-fence` | 2.2 m, 1 m back | Wrought iron between stone posts, a few bars bent |
| Fire & light | Ember cairn | `ember-cairn` | 1.6 m, 1 m back | A blade planted in warm, glowing ash |
| Fire & light | Brazier | `brazier` | 1.8 m, 1 m back | An iron fire bowl on three legs |
| Fire & light | Candelabra | `candelabra` | 2.4 m, 1.5 m in front | A tall iron candelabrum with uneven candles |
| Fire & light | Lantern post | `lantern-post` | 3.5 m, 1 m back | A lit lantern hung from a post |

The models are original and built from simple solids with vertex colours; glowing parts
(fire, windows, runes) are unlit so they shine in dark themes. Every model is built the
first time a level or the library needs it, in a few milliseconds, and between about 100
and 3,600 triangles.

## Your own models

A game replaces placeholders with its own static GLB models, with PBR materials and
textures, through [course artwork](course-artwork.md#decoration-models). Map a model ID to a
GLB in the `decorations` section of the `npm run pack:course` assets file, or in the
project's `art.decorations` through the project API. Every decoration of that model then
draws the GLB, in the Workshop as in releases, which keeps its own proportions, is scaled to
the decoration's height and stands on the decoration's position. The Workshop loads each GLB
as the level first draws it, so a decoration shows its GLB a moment after the project opens;
selection, outlines and placement use the model as drawn.

The IDs of your own models need not be in the library: a model like `stone-idol` is drawn
only by its GLB. GLBs follow the course artwork limits: static meshes,
up to 16 meshes and 50,000 triangles each, shared with the terrain's budget of 64 GLBs per
course.

## Level format

A decoration is a level object like terrain or an enemy:

```json
{
  "kind": "decoration", "id": "keep-banner-1", "model": "banner",
  "x": -12.5, "y": 360, "z": -1.5, "height": 6, "angle": 0, "turn": 0, "mirror": false, "tint": 16777215
}
```

`angle` (tilt) and `turn` are radians, -π to π.

`model` is a lowercase ID of letters, numbers and single hyphens, up to 40 characters. A
level may name a model that is neither in the library nor in its course artwork: the
Workshop still opens it and simply does not draw that decoration, while a game build,
publishing or saving a project fails and names the decoration, so a release never silently
loses scenery. A level holds up to 1,000 decorations.

## Performance

Decorations are drawn with instancing: one batch per model, mirror side and chunk of the
course, where chunks are 32 m wide near the course and double in size with each band of
depth. Far scenery, visible from almost anywhere, therefore shares a few large batches,
while near scenery is culled chunk by chunk. A representative level with 1,000 decorations
of every model, each at its natural depth and half of them mirrored, draws in about 60 calls.
An edit rewrites only the changed decoration's instance, idle frames upload nothing, and the
physics never sees decorations at all.

A game-only release includes the decoration renderer and library only when its level places
at least one decoration. It includes the GLB loader only when it draws meshes.

A GLB model batches like a placeholder, one batch per model, side and chunk, and shares its
geometry, materials and textures across every copy. Flat-shaded placeholders mirror by a
negative scale in the same batch as unmirrored copies. A GLB's smooth normals need real
mirrored geometry, built once per model, so its mirrored copies draw in a batch of their own.
