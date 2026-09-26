# Imported 3D characters

A game can ship its own GPU-skinned character, render it with PBR or cel shading,
replace the hammer and the pot with rigid models, and let players switch between
that character and a 2D sprite character. The engine owns the machinery; a game supplies
only data: GLBs, a bone map and a profile. Everything below is authored in
**Workshop / Character** and stored in the character / sprite profile, so Save,
Revert, JSON export/import and `GAME_SPRITES` carry it.

A typical 3D character is three models: a skinned body, the pot and the hammer.
Physics never depends on these models. Colliders, masses, hammer length, reach,
grips, contacts, saves and level state are identical in every character type and
with every model.

## Skinned avatar

Choose **Use Avatar**, then pick a **Skinned avatar GLB**. The model replaces the
built-in avatar mesh in Avatar mode (`avatar-3d`). The pot and hammer stay separate
visuals, as with the built-in avatar. Choose **Use built-in avatar mesh** to go back.

### Requirements

- A self-contained, uncompressed binary glTF 2.0 file with embedded textures, the
  same format rules as Appearance imports. Limits are `MODEL_LIMITS` in
  `src/model-data.ts`: 20 MiB, 128 meshes, 250,000 triangles, 2048 nodes and
  4096-pixel texture edges. Textures must be PNG, JPEG or WebP so that builds can
  read their sizes.
- At least one skinned mesh, with inverse bind matrices that describe the bind
  pose. The bind pose is read from those matrices, whatever pose the file's nodes
  store, so a file saved mid-animation still binds correctly.
- At most 4 joint influences per vertex (`JOINTS_0`/`WEIGHTS_0` only), with
  weights that sum to 1 for every vertex.
- +Y up and the character facing +Z, glTF's convention. Units are free: the model
  is scaled uniformly so that its upper-arm joints are as far apart as the built-in
  avatar's shoulders (0.34 m), and their midpoint sits at the built-in shoulder
  height, 0.74 m above the player root. Proportions are preserved.

Animation clips, cameras and lights are ignored. Morph targets load but are not
driven.

### Bone map

The bone map names one skin joint for each of eight avatar joints:

| Avatar joint | Driven by | Typical Mixamo joint |
| --- | --- | --- |
| `body` | the torso frame | `Hips` |
| `head` | head gaze, about the joint's bind position | `Head` |
| `left-upper-arm`, `left-forearm`, `left-hand` | the left arm IK and left grip | `RightArm`, `RightForeArm`, `RightHand` |
| `right-upper-arm`, `right-forearm`, `right-hand` | the right arm IK and right grip | `LeftArm`, `LeftForeArm`, `LeftHand` |

Left and right are **screen sides**. The character faces the camera, so a rig's
anatomical right arm is on the viewer's left and drives the `left-*` joints. A map
that puts the `left-*` chain on the viewer's right fails with `crossed-arms`.

Mixamo-style names, with or without a `mixamorig:` prefix, are mapped automatically
on import. Blender-style `.L`/`.R` suffixes and `UpperArm`/`LowerArm` names are
recognized too. Otherwise, choose the joints in the **Bone map** selectors. A map
applies only once all eight joints resolve; until then the import stays pending,
with its error shown, and the current avatar is unchanged. **Discard bone map
changes** returns to the applied map.

Mapped joints must form ancestor chains: `body` above the head and both upper
arms, each upper arm above its forearm, and each forearm above its hand. They
need not be direct children: a clavicle between the spine and upper arm is
fine. Unmapped joints, such as spine, neck, clavicles, fingers, twist bones and
legs, follow their nearest mapped ancestor rigidly in their bind-pose offset.
Joints above the body stay in their bind pose. The Character tab lists every
unmapped joint and what it follows.

### Motion

The mapped joints receive exactly the frames that drive the built-in avatar:

- **Arms.** The shared two-bone IK runs with the model's own shoulders and its
  bind-pose upper-arm and forearm lengths. It uses the same grip targets on the
  physical shaft, the same body-relative elbow hints (Workshop / Appearance), the
  same bend-rate limit and the same arm forward distance. Hands take the
  built-in avatar's grip orientation: along the shaft, facing the camera. In the
  bind pose the virtual shaft runs along each forearm.
- **Unreachable grips.** As with the built-in avatar, the arm straightens toward
  the grip, the upper arm keeps its length, the forearm stretches along its
  axis, and the hand stays exactly on the grip. The hammer never moves to suit
  an arm. A realistically proportioned humanoid reaches the grips less often
  than the built-in avatar's long arms, so expect more stretching.
- **Head.** Gaze rotates the head joint about its own bind position, with the
  same smoothing and yaw/pitch limits as the built-in avatar.

The pot hides the body behind its walls through the depth buffer, but does not
clip it. The pot's bottom is 1.22 m below the fitted shoulders; anything lower,
such as long legs, shows beneath it. A [pot model](#pot-model) can be shaped to
suit the body.

### Errors

Every model and bone-map failure is a `CharacterModelError` (`src/character-profile.ts`)
with a machine-readable `code` and the joints it concerns. Callers and tests branch
on `code`, never on the message. The editor shows the code in its status
(`data-code`), and `window.gettingOver.sprites().modelIssue` reports it.

| `code` | Cause |
| --- | --- |
| `invalid-model` | Not a valid self-contained GLB, or a hammer or pot that ignores its convention |
| `model-limits` | A `MODEL_LIMITS` overrun: bytes, meshes, triangles, nodes or texture edge |
| `no-skin` | An avatar model without a skinned mesh |
| `unexpected-skin` | A hammer or pot model with a skin |
| `invalid-skin` | Missing inverse bind matrices, joints outside the scene, or bad skin accessors |
| `missing-joint` | The bone map leaves an avatar joint unmapped |
| `unknown-joint` | A mapped name is not a skin joint of the model |
| `duplicate-joint` | Two avatar joints map to the same skin joint |
| `ambiguous-joint` | Several skin joints share a mapped name |
| `broken-chain` | Mapped joints are not ancestor chains body → upper arm → forearm → hand, with the head under the body |
| `crossed-arms` | The `left-*` chain is on the viewer's right |
| `degenerate-rig` | Coincident shoulders, or an upper arm or forearm without length in the bind pose |
| `too-many-influences` | `JOINTS_1`/`WEIGHTS_1`: more than 4 influences per vertex |
| `unnormalized-weights` | A vertex whose weights do not sum to 1, or a negative weight |

The same checks run at import, when a profile loads, and when a release is built.
They are implemented without a DOM in `src/character-model-inspect.ts`.

## One-model hammer

Pick a **Hammer GLB** to replace the two-part hammer, which stretches a shaft
between the physical endpoints and places a separate head. The model follows the
physical tool frame rigidly, without stretching, in every character type,
including 2D, and in the hammer's foreground pass. **Use two-part hammer**
restores the default.

Model it in metres, with its origin at the butt of the handle and the handle
along +X. The physical head sits at x = 1.5 m. Its collision block spans
x = 1.4 to 1.6 m and y = -0.29 to 0.29 m; toggle the collision overlay (**D**) to
compare. The grips are 0.04 m and 0.22 m along the handle. The hammer must be a
static mesh; its bounds must reach at least 0.1 m along +X, extend further along
+X than along -X, and stay within 4 m of the origin. In 2D, hammer sprite layers
still draw if the profile has them.

Appearance's shaft and head imports are hidden while a hammer model is present.

## Pot model

Pick a **Pot GLB** to replace the pot. The model follows the physical pot body
rigidly, without stretching, in every character type, including 2D, at the pot's
own depth. It draws in the main pass, so its front wall hides the lower part of a
body inside it through the depth buffer, while the body shows above the rim.
**Use default pot** restores the procedural pot.

Model it in metres with +Y up, its origin at the bottom-centre of the pot, and its
front facing +Z (toward the camera). The physical pot is 0.80 m tall. Measured
from that origin, its collision outline is:

| Height | Radius | Where |
| --- | --- | --- |
| 0 m | 0.20 m | base, on the ground |
| 0.19 m | 0.44 m | lower wall |
| 0.60 m | 0.50 m | widest point |
| 0.80 m | 0.43 m | rim |

The outline is the polygon through (±radius, height). Collision is always this 2D
outline, whatever the model's shape; toggle the collision overlay (**D**) to
compare. The player root, which the pot pivots about, is 0.48 m above the base.
The body stands there, 0.05 m in front of the pot's centre (toward the camera).

The pot must be a static mesh. Its lowest point must be within 0.05 m of the
origin, it must rise at least 0.1 m, the origin must lie in the middle half of its
footprint along X and Z, and it must stay within 4 m of the origin. Models built
around their centre, with Z up, or in centimetres fail these checks with
`invalid-model`. In 2D, pot sprite layers still draw if the profile has them.

Appearance's pot import is hidden while a pot model is present.

## Shading

**Avatar shading** switches between **PBR**, the models' own materials, and
**Cel**: stepped lighting with 2-8 bands and an optional outline. Change the mode,
band count, outline colour and outline width live; the look updates on the same
loaded models, so the two can be compared by flipping back and forth.

Shading styles Avatar mode: the connected avatar (built-in or imported) and its
separate pot and hammer, including the hammer and pot models and Appearance's pot
and hammer imports. Other character types keep their materials, and the setting is
stored for the next Avatar selection.

- **Bands.** Each lit material gets one Three.js `MeshToonMaterial` twin, sharing
  its colour, maps and alpha settings, and one shared stepped gradient. Metalness
  and roughness do not apply to cel shading. Unlit materials stay unlit.
- **Outline.** An inverted hull: a second, back-facing draw of each opaque mesh,
  extruded along its normals by the width in world metres. Skinned hulls share
  their mesh's geometry and skeleton, so the outline deforms with the IK. Hard
  edges are closed by welding coincident normals. Transparent and alpha-tested
  surfaces are not outlined.

Twins, hulls and the gradient are created on the first switch to cel, then only
swapped: later switches and cel edits create no materials, textures or geometry,
and shading does no per-frame work.

## Profile format

These fields are written only while present. Sprite schema 8 adds `models`,
`avatar`, `hammer` and `shading`; schema 9 adds `pot`. A profile with a pot model
saves as schema 9, one with other models or non-default shading as schema 8, and
any other profile keeps saving as schema 6 (or 7 with aim flipbooks), byte for
byte.

```json
{
  "schemaVersion": 9,
  "characterRiggingType": "avatar-3d",
  "armForwardDistance": 0.25,
  "images": [], "layers": [], "skeleton": null, "presentation": null,
  "models": [
    { "id": "avatar", "name": "Hero", "source": "data:model/gltf-binary;base64,..." },
    { "id": "hammer", "name": "Mallet", "source": "data:model/gltf-binary;base64,..." },
    { "id": "pot", "name": "Urn", "source": "data:model/gltf-binary;base64,..." }
  ],
  "avatar": {
    "model": "avatar",
    "boneMap": {
      "body": "Hips", "head": "Head",
      "left-upper-arm": "RightArm", "left-forearm": "RightForeArm", "left-hand": "RightHand",
      "right-upper-arm": "LeftArm", "right-forearm": "LeftForeArm", "right-hand": "LeftHand"
    }
  },
  "hammer": { "model": "hammer" },
  "pot": { "model": "pot" },
  "shading": { "mode": "cel", "bands": 3, "outline": { "color": "#1f2428", "width": 0.02 } }
}
```

- `models` lists 1-3 GLBs, each used by exactly one of `avatar`, `hammer` and
  `pot`; roles never share a model. The editor embeds them as
  `data:model/gltf-binary;base64,` sources. At runtime a source may also be a
  public HTTP(S) URL or a `/site-relative` path; release builds require embedded
  models so they can validate them.
- `avatar` is used in `avatar-3d` and dormant in other types; `hammer` and `pot`
  are used in every type. `characterRiggingType` still selects the type.
- `shading` is absent for the default look (`pbr`, 3 bands, outline `#1f2428` at
  0.02 m). `outline` is `null` for none; colours are lowercase `#rrggbb`; widths
  are 0.002-0.1 m.
- Models have their own budget, so they do not count against the 24 MiB sprite
  budget. Each model can be up to 20 MiB, and a profile file up to about 104 MiB.

A schema 1-7 document with any of these fields is rejected, as is a schema 1-8
document with `pot`. Releases from before schema 8 reject schema-8 profiles, and
releases from before schema 9 reject profiles with a pot model. Keep an older
export for rollback.

## Releases with two characters

`GAME_SPRITES` selects the release's character profile, as before.
`GAME_ALTERNATE_SPRITES` adds a second one, typically a 2D sprite character and
a skinned 3D avatar:

```sh
GAME_SPRITES=skins/paper.json GAME_ALTERNATE_SPRITES=skins/hero.json npm run build:game
GAME_LEVEL=levels/my-level.json GAME_SPRITES=skins/paper.json \
  GAME_ALTERNATE_SPRITES=skins/hero.json npm run dev:game
```

The build validates both profiles and each character GLB with the checks above,
failing on any error. Each distinct GLB and PNG becomes one hashed asset, outside
executable JavaScript. A release that uses models includes the GLB loader; one
without models omits it.

Players choose **CHARACTER: 2D / 3D** in the release's corner control. The
labels follow each profile's type, numbered if they match. The choice is stored
in `localStorage` under `over-the-edge:play:character` and restored on the next
visit; a stale or unavailable value falls back to the first profile. Both profiles
load completely before play. Switching, including mid-level, only swaps what is
attached and visible: nothing reloads, and physics, the timer and the level
continue. An inactive profile is detached from the scene and does no per-frame
work. A release with only `GAME_SPRITES` behaves exactly as before and shows no
control.

## Runtime API

Hosts inject model loading, so a game without models ships no GLB loader:

```ts
import { createCharacterModelLoader } from './character-model-loader';

const game = new Game({ ...options, characterModels: createCharacterModelLoader() });
await game.loadSprites(primaryProfile);
await game.loadAlternateSprites(secondProfile);
game.selectCharacter(1);
game.characterSelection(); // { active: 1, count: 2, types: ['sprite-2d', 'avatar-3d'] }
```

`GameView` accepts the same `characterModels` option, `createAlternateCharacter()`
returns the second profile's `SpriteRig`, and `selectCharacter(index)` switches
profiles. `SpriteRig` stays independent of Three.js model loading: its
`characterAssets.prepare(document, signal)` option loads and validates a
document's models before the rig commits it, and `setShading()` applies a shading
change without reloading anything. Without a host, documents with models are rejected.

## Performance

Imported avatars are built once when their profile loads. Each frame writes the
seven driven bone matrices, with no allocation. Unmapped joints keep static local
matrices. The hammer and pot models copy one matrix each. This cost does not
depend on the level. In the editor, `window.gettingOver.level().rendering` reports
`importedAvatar` (joints, unmapped joints, chains and cumulative `boneWrites`),
`hammerModel` and `potModel` (transform, drawn material types and cumulative
`matrixWrites`), `shading`, `characters` and `renders`.

## Verification

`scripts/verify-character.mjs`, part of `npm run verify`, generates a
Mixamo-named skinned humanoid, a hammer and a pot. It checks every typed error
code and the pot conventions, automatic mapping, IK at reachable and unreachable
grips, the hammer frame in each 3D type, and the pot's base on its physical
bottom in 3D and 2D. It also checks live shading flips without new materials,
per-frame writes on a large course, and schema 8/9 save, restore, export and byte
identity. `npm run verify:game` builds a two-profile release whose 3D profile has
all three models. It checks the toggle mid-level, single asset loads, persistence,
exact pot tracking, identical physics while switching, and failing builds for
invalid models, bone maps and pot profiles. All fixtures are
generated procedurally; no third-party artwork is involved.
