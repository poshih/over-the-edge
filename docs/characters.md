# Imported 3D characters

A game can ship its own GPU-skinned character, render it with PBR or cel shading,
replace the hammer and the pot with their own models, and let players switch between
that character and a 2D sprite character. The engine owns the machinery; a game supplies
only data: GLBs, a bone map and a profile. Everything below is authored in
**Workshop / Character** and stored in the character / sprite profile, so Save,
Revert, JSON export/import and `GAME_SPRITES` carry it.

A typical 3D character is three models: a skinned body, the pot and the hammer.
Physics never depends on these models. Colliders, masses, hammer length, reach,
contacts, saves and level state are identical in every character type and with
every model. The hands hold the handle where the profile's [grips](../README.md#hand-grips)
put them, and its [arm lengths](../README.md#arm-lengths), when set, size the arms.

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
legs, follow their nearest mapped ancestor rigidly in their bind-pose offset,
except the joints of [hair chains](#hair), which swing.
Joints above the body stay in their bind pose. The Character tab lists every
unmapped joint and what it follows.

### Motion

With the `standard` driver, mapped joints receive the frames that drive the built-in avatar:

- **Arms.** The shared two-bone IK runs with the model's own shoulders and its
  bind-pose upper-arm and forearm lengths, or the profile's arm lengths, which stretch
  the arm bones along their length. It uses the same grips on the physical
  shaft, placed by the profile's grips, the same body-relative elbow hints (Workshop / Appearance), the
  same bend-rate limit and the same arm forward distance. Hands take the
  built-in avatar's grip orientation: along the shaft, facing the camera. In the
  bind pose the virtual shaft runs along each forearm.
- **Unreachable grips.** As with the built-in avatar, the arm straightens toward
  the grip, the upper arm keeps its length, the forearm stretches along its
  axis, and the hand stays exactly on the grip. The hammer never moves to suit
  an arm. Keep a realistically proportioned humanoid's grips **sliding**, the
  default: its hands then stay within the slide point of its shoulders wherever
  the handle allows, and a longer handle with a shorter extension keeps the reach.
  With fixed grips the hands follow the butt through the whole slide, so expect
  stretching.
- **Head.** Gaze rotates the head joint about its own bind position, with the
  same smoothing and yaw/pitch limits as the built-in avatar.

The pot hides the body behind its walls through the depth buffer, but does not
clip it. The pot's bottom is 1.22 m below the fitted shoulders; anything lower,
such as long legs, shows beneath it. A [pot model](#pot-model) can be shaped to
suit the body.

### Hair

An imported avatar can swing chains of its own skin joints as spring-bone hair, with the
solver sprite skeletons use ([spring-bone hair](sprites.md#spring-bone-hair)). Skin the
hair's geometry to a chain of joints in the GLB and list the chain in `avatar.hair`:

```json
"hair": {
  "chains": [{ "id": "braid", "joints": ["Braid0", "Braid1", "Braid2", "Braid3"],
               "stiffness": 0.05, "damping": 0.12, "gravity": 9.81, "radius": 0.03 }],
  "colliders": [{ "id": "torso", "joint": "body", "x": 0, "y": 0.6, "radius": 0.25 }]
}
```

- A chain is one continuous parent-to-child run of unmapped skin joints, root first,
  at least two. The root hangs from a joint that follows a mapped joint, usually
  under `head`, and stays where that joint carries it; the joints after it swing.
  Chains may not share joints, hang from another chain or carry a mapped joint.
- Every frame, after the head and arms, each chain gets its rest pose: the root rides
  rigidly on its mapped joint, and every later joint rests at its bind-pose offset from
  the root in the body's frame, so the hair keeps hanging as authored while the head
  turns. The rest positions are the solver's targets. It moves the joints in the game's
  X-Y plane with world-space inertia, `gravity` (m/s², positive down), a pull toward the
  target (`stiffness`, 0-1), velocity lost on each 1/60 s step (`damping`, 0-1) and the
  rest pose's segment lengths. Each joint keeps the depth of its rest position and turns
  by the least rotation from its rest segment to the simulated one, so the skin bends
  along the chain and anything below its last joint follows it. Hair in front of or
  behind the body therefore swings across the view, not into it.
- `colliders` are circles in the X-Y plane: `x` and `y` place the centre at bind in the avatar's fitted frame (metres,
  +Y up, the shoulders 0.74 m above the player root), and `radius` is in metres. Each rides with a frame (`joint`):
  - an avatar joint (`body`, `head` or an arm joint), whose motion carries it, including the upper body's
    [waist lean](sprites.md#waist-lean);
  - `pot`, the jar, which stays with the physical pot. Use it for the jar a braid drapes over.

  A chain keeps its joints its own `radius` clear of every collider; pinned roots and segment lengths win where both
  cannot hold.
- The simulation freezes while time stands still, catches up at most 15 steps, and
  restarts from the rigid pose on a rewind, a restart or a new avatar. Hair never
  drives IK, gameplay or physics.
- `{ "chains": [], "colliders": [] }` keeps every unmapped joint rigid, at no cost.
  At most 16 chains, 64 joints over all chains and 32 colliders.
- Chains are checked against the model wherever the bone map is: `unknown-joint`,
  `ambiguous-joint`, `duplicate-joint` (a joint the bone map drives) and
  `broken-chain` (not a parent-to-child run, not hanging from a mapped joint, hanging
  from another chain, or carrying a mapped joint).

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
physical tool frame in every character type, including 2D, and in the hammer's
foreground pass. **Use two-part hammer** restores the default.

Model it in metres on the 1.5 m reference handle that all shaft artwork uses: origin
at the butt, handle along +X and the head centred at x = 1.5 m, where its collision
block spans x = 1.4 to 1.6 m and y = -0.29 to 0.29 m; toggle the collision overlay
(**D**) to compare. The model then fits any handle length the game sets. The handle
from the butt to x = 1.3 m, which hands can hold, stretches along the handle to 0.2 m
short of the physical head. Its head end, the head and the last 0.2 m of handle, keeps
its size and centres on the physical head. Anything behind the butt stays with the
butt. Each mesh draws its own copy of the model's geometry, rewritten only when the
handle length changes; the Character tab shows the open game's fit. The grips never
move the model. The hammer must be a static mesh; its bounds must reach at least 0.1 m
along +X, extend further along +X than along -X, and stay within 4 m of the origin.
In 2D, hammer sprite layers still draw if the profile has them.

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

## Server models

A Workshop can share avatars, hammers and pots with everyone who opens it, so designers
pick them instead of passing GLB files around. Put GLBs in the `models` folder of the
Workshop's repository, one folder per part:

```text
models/avatar/knight.glb
models/hammer/maul.glb
models/pot/urn.glb
```

Each file is checked like a GLB imported for that part when the Workshop builds or its
development server starts, and one that fails stops it, naming the file. A model shows
under its file name without `.glb`.

**Picking.** Workshop / Character's **Skinned avatar (GLB)**, **One-model hammer (GLB)**
and **Pot model (GLB)** sections list the server's models of their part. **Use server
avatar** (hammer, pot) applies the chosen one exactly as if that file were chosen from the
computer: an avatar maps Mixamo-style joints or opens its bone map, and the model is stored
in the character profile. Workshop / Project / Model library offers the same models with
**Add server avatar** (hammer, pot). The character downloads one model at a time and is not
held meanwhile: if it changes before the model arrives, for example through another import,
Revert or opening a project, that change wins and the model is not used. The model library
holds the open project while a model downloads for it, so the project cannot change first.

**Delivery.** The models never ship with the Workshop. A build lists only their names,
sizes and SHA-256 digests, and writes the files to `dist-content/models/<sha256>.glb` for a
CDN. The Workshop downloads a model only when one is picked, from `WORKSHOP_CONTENT_URL`,
and refuses one whose size or digest differs from the build's.

- The content URL is an HTTP(S) URL or a path relative to the Workshop, ending in `/`. It
  defaults to `content/`, beside the Workshop, where `npm run dev` and `npm run preview`
  serve the models.
- To deploy, upload `dist-content/` to the content URL with CORS for the Workshop's origin;
  see the [README](../README.md#run). A model's URL changes only with its bytes, so it can
  be cached indefinitely.
- Downloads send cookies only to the Workshop's own origin, so a CDN on another origin
  serves the models publicly.

**In releases.** A picked model belongs to the profile or project like any imported GLB, so
a release packages it with the game's content, and players download it from the game's
CDN; see [content delivery](content-delivery.md).

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

Profiles use **schema version 16**. Every profile has `waistLean`, the most a 3D character's upper body leans toward
the hammer in degrees (0-45; see [waist lean](sprites.md#waist-lean)), and `grips`: the placement, each
hand's distance from the butt (0-3 m), the slide point `slideAt`, a share of each
arm's length (0.4-1), and `rotation`, each 3D hand's turn on its grip about `x`, `y`
and `z` in degrees (-180 to 180; see [hand grips](../README.md#hand-grips)). It also has
`arms`, `null` for each type's own arm lengths or each side's `upper` and `forearm`
(0.1-2 m). The model and shading fields below are present only while used.

```json
{
  "schemaVersion": 16,
  "characterRiggingType": "avatar-3d",
  "armForwardDistance": 0.25,
  "waistLean": 20,
  "grips": {
    "placement": "sliding", "left": 0.04, "right": 0.22, "slideAt": 0.85,
    "rotation": { "left": { "x": 0, "y": 0, "z": 0 }, "right": { "x": 20, "y": 0, "z": -10 } }
  },
  "arms": { "left": { "upper": 0.5, "forearm": 0.48 }, "right": { "upper": 0.5, "forearm": 0.48 } },
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
    },
    "driver": { "id": "standard", "config": null },
    "hair": { "chains": [], "colliders": [] }
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
- `avatar.driver` is `{ "id", "config" }`, the [rig strategy](#rig-strategies) that fits the
  model and poses its arms. `standard` is the only built-in strategy and accepts a `null`
  config; a profile whose driver no host registered fails to load with `unknown-strategy`
  rather than falling back to another rig.
- `avatar.hair` is the avatar's [hair](#hair), bound to its model's joints like the bone map.
- `shading` is absent for the default look (`pbr`, 3 bands, outline `#1f2428` at
  0.02 m). `outline` is `null` for none; colours are lowercase `#rrggbb`; widths
  are 0.002-0.1 m.
- Models have their own budget, so they do not count against the 24 MiB sprite
  budget. Each model can be up to 20 MiB, and a profile file up to about 104 MiB.

Profiles in any other schema version are rejected, not converted.

## Rig strategies

An imported avatar says how it is fitted and posed through its `driver`. The built-in
`standard` strategy sizes the arms from the model's own shoulders and bind-pose arm lengths
(or the profile's arm lengths) and places the hands on the physical grips, exactly as
described above. A game can add strategies by naming a side-effect-free module with
**`AVATAR_RIG_MODULE`**, a `.ts` or `.js` file inside the repository. The build imports it
through its own resolver rather than the app's bundle, so it uses relative paths and bare
package imports, not the app's aliases or `virtual:` modules.

```ts
import { AVATAR_RIG_API_VERSION, AvatarRigError } from '../../src/avatar-rig';
import type { AvatarRigModule, AvatarRigStrategy } from '../../src/avatar-rig';

const strategy: AvatarRigStrategy = {
  id: 'my-rig',
  prepare(config, binds) {
    // Validate config here once; reject bad data with AvatarRigError('invalid-config', ...).
    // Return { writeFramePlan(context, out), writePose(context, out) }.
  },
};

export default { apiVersion: AVATAR_RIG_API_VERSION, strategies: [strategy] } satisfies AvatarRigModule;
```

The module's default export is an `apiVersion` and its strategies. A strategy is trusted host
code, not content: it is pure numeric code that never sees a scene, material or renderer, and
frame plans are passed explicitly between phases; scratch belongs to one avatar, never a global.
When the profile rotates a hand, the engine turns a copy of that side's frame plan about the
hand's grip after phase 1: its `offset`, `shaft` and `forward` all turn, so the arms reach the
turned wrist and phase 2 receives the turned plan. The plan phase 1 wrote is never rewritten.
A module that is not an object, declares another API version, has malformed strategies, or duplicates
an ID (including `standard`) fails with a typed `AvatarRigError`. The factory always supplies the
standard strategy. Only a direct registry constructor that omits it produces `missing-standard`.
Configured modules exporting null are invalid, not an unconfigured-host fallback.

The same registry is used by every check: importing or opening a project, the project server's
writes, packaging a release and the running release, so a driver is accepted or rejected
identically everywhere. It is built once when the dev server, build or project server starts,
so changing the module needs a restart. A driver whose strategy is not registered, or whose
`config` the strategy refuses, fails with an `AvatarRigError` and a `code`: `unknown-strategy`,
`invalid-config`, `invalid-strategy`, `api-version`, `duplicate-strategy` or
`missing-standard`. Callers branch on `code`, never on the message.

## Releases with two characters

`GAME_SPRITES` selects the release's character profile, as before.
`GAME_ALTERNATE_SPRITES` adds a second one, typically a 2D sprite character and
a skinned 3D avatar:

```sh
GAME_SPRITES=skins/paper.json GAME_ALTERNATE_SPRITES=skins/hero.json npm run build:game
GAME_LEVEL=levels/my-level.json GAME_SPRITES=skins/paper.json \
  GAME_ALTERNATE_SPRITES=skins/hero.json npm run dev:game
```

A [game project](projects.md) stores the same two profiles as
`characters/primary.json` and `characters/alternate.json`, and `GAME_PROJECT` builds
them exactly like these variables.

The build validates both profiles and each character GLB with the checks above,
failing on any error. Each distinct GLB and PNG becomes one content file, named by its
SHA-256, outside the release's shell; see [content delivery](content-delivery.md). A
release that uses models includes the GLB loader; one without models omits it.

Players choose **CHARACTER: 2D / 3D** in the release's corner control. The
labels follow each profile's type, numbered if they match. The choice is stored
in `localStorage` under `over-the-edge:play:character` and restored on the next
visit; a stale or unavailable value falls back to the first profile. Both profiles
load completely before play. Switching, including mid-level, only swaps what is
attached and visible: nothing reloads, and physics, the timer and the level
continue. An inactive profile is detached from the scene and does no per-frame
work. A release with only `GAME_SPRITES` behaves exactly as before and shows no
control.

## Model library and runtime swaps

A [project](projects.md) can list extra avatars, hammers and pots in its **model
library**, and a release can show any of them in place of the characters' own models,
each part on its own: a player might use one library avatar with the profile's hammer
and another library pot. The game's backend decides which library model each part
uses, stores that choice, and grants the model's content; the release only asks it
and shows its answers. A modified client therefore cannot use a model the backend
did not select, and the release keeps nothing about the choice in the browser.

**Authoring.** Workshop / Project / **Model library** lists each part's models.
**Add avatar / hammer / pot GLB** checks a file like the profile's own model of that
part, and **Add server avatar / hammer / pot** does the same with one of the Workshop's
[server models](#server-models). An avatar maps Mixamo-style joints automatically; otherwise its bone map opens
and the avatar is added once all eight joints resolve. **Bone map** edits an avatar's
map later. An avatar entry carries its rig `driver`, its [hair](#hair) and what depends on its
proportions: its bone map, grips, arm lengths and arm forward distance. A new avatar starts
without hair and takes the grips, arm lengths and arm forward distance of the open character,
and **Use character settings** takes them again, so tune them in Workshop / Character first. **Preview** shows a library model in the Workshop's game
exactly as a release shows it; previews are not saved. The project server stores the
library as `models/<part>/<id>.glb` with its entries in `project.json`, with
[API routes](projects.md#api-for-scripts-and-language-models) for each model.

**What shows.** A library avatar replaces the avatar of an Avatar (3D) character and
brings its own settings; the profile keeps everything else, such as its shading.
Library hammers and pots show in every character type, fitted and shaded like the
profile's own. The selection belongs to the player, so switching characters keeps it.

**Content.** Each library GLB is its own content group, `library/<part>/<id>`, which
the release's shell does not list; see [content delivery](content-delivery.md). The
release fetches a library model only after the backend selects it, through a grant
for that group, so the backend and its CDN can refuse models the player does not own.

**The backend's contract.** The game's module adds `select(request, signal)` to its
content access. With `null` it returns the stored selection, `{ avatar, hammer, pot }`
of library IDs or `null` for the profile's own model; with `{ role, id }` it asks the
backend to change one part, and returns the selection the backend then stores. The
backend may refuse by throwing a `ContentError`, or answer with any selection:

```ts
export async function start(host: ReleaseHost): Promise<ReleaseModule> {
  const access: ContentAccess = {
    grant: (request, signal) => backend.grant(request, signal),
    // Checks the player's entitlements, stores the result and answers it.
    select: (request, signal) => backend.select(request, signal),
  };
  return {
    access,
    modelFailed: (error) => host.notice(error.message, 'error'),
    ready: (api) => shop.onEquip((role, id) => api.modelLibrary.swap(role, id)),
  };
}
```

- At boot the release reads the stored selection alongside the game's first grant,
  loads the selected models, and starts with them showing. Parts it replaces never
  load the profile's own models.
- `api.modelLibrary.swap(role, id)` relays one change and resolves with the
  selection in use once the backend's answer shows. Requests go to the backend one
  at a time, in order; a newer swap of the same part replaces one not yet sent,
  which fails with `superseded`. IDs the release does not list fail with
  `unknown-model` without a request. `available(role)` lists the IDs, `active(role)`
  the one showing, and `refresh()` reads the stored selection again, for example
  after it changed elsewhere.
- An answer shows as a whole: every part it changes loads and shows. A part that
  cannot, for example because its grant is refused, keeps its model and fails the
  swap that asked for it, or reaches `modelFailed` when no swap asked; at boot it
  starts with the profile's own model.
- Without `select()`, parts use the profiles' models and swaps fail with `unavailable`.

The release keeps the model each part shows and the most recent other one per
part, so swapping back to it, or to the profile's own model, fetches nothing. A
swap builds one part view; it adds no per-frame work, and its cost does not depend
on the level.

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
matrices; hair chains add their joints' matrices and at most 15 solver steps, bounded by
their joints and colliders. The hammer and pot models copy one matrix each; a new handle length
rewrites the hammer model's vertices once. This cost does not depend on the level.
In the editor, `window.gettingOver.level().rendering` reports `importedAvatar`
(joints, unmapped joints, chains and cumulative `boneWrites`), `hammerModel` and
`potModel` (transform, drawn material types and cumulative `matrixWrites`; the
hammer's `fit` gives its handle length and fitted bounds), `shading`, `characters`
and `renders`.

## Verification

`scripts/verify-character.mjs`, part of `npm run verify`, generates a
Mixamo-named skinned humanoid, a hammer and a pot. It checks every typed error
code and the pot conventions, automatic mapping, IK at reachable and unreachable
grips, set arm lengths on the imported arm bones, the hammer frame in each 3D type, and the pot's base on its physical
bottom in 3D and 2D. It also checks live shading flips without new materials,
per-frame writes on a large course, and that profiles save, restore and export byte
for byte. `scripts/verify-grips.mjs` first sweeps the placement itself over whole
slides and full turns with the game's shoulders and tool depth: extending by a millimetre
moves no hand more than a millimetre, bisection finds no jump, and the hands slide by the
least amount that keeps both within the slide point. It then sets a 2.1 m handle with a
0.55 m extension in Physics, checks the rebuilt rig and start pose, and sweeps aims and
extensions with 0.55 m arm segments: the rendered grips are the placement of what the view
measures, hands hold their grips, slide both ways and hold the butt, and no arm stretches.
It then sets each hand's grip, the slide point and the handle length from the Character
tab and resizes the mesh-part arms per side. Retracted past the body, it checks that a 2D
character without arm chains reaches like the built-in arms and one with chains reaches in
its drawing plane at their lengths, then stretches those chains while its elbow caps and
gloves keep their size. Last, it fits a cel-outlined hammer model to four handle lengths:
each mesh's fitted bounds are the documented map of its authored ones, and the head keeps
its size on the physical head. `npm run verify:game` builds a two-profile release whose 3D profile has
all three models. It checks the toggle mid-level, single asset loads, persistence,
exact pot tracking, identical physics and each profile's own grip placement while
switching, and failing builds for
invalid models, bone maps and pot profiles. `npm run verify:model-swap` builds a
project with a model library on a large course and plays it with a test backend and
CDN: the stored selection shows at start without fetching replaced models, each part
swaps on its own with one grant and one fetch per new model, the backend's refusals
and different answers win, requests stay in order and superseded swaps are never
sent, and nothing is stored. It also checks that builds and the project server refuse
invalid library models, and the Workshop's library, previews and saving. All fixtures
are generated procedurally; no third-party artwork is involved.
