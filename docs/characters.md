# Imported 3D characters

A game can ship its own GPU-skinned character, rendered with its own PBR materials,
replace the hammer and the pot with their own models, and let players switch between
that character and a 2D sprite character. The engine owns the machinery; a game supplies
only data: GLBs, a bone map and a profile. Everything below is authored in
**Workshop / Character** and stored in the character / sprite profile, so Save,
Revert, JSON export/import and `GAME_SPRITES` carry it.

A typical 3D character is three models: a skinned body, the pot and the hammer.
Live physics never depends on these models. Live colliders, masses, hammer length, reach,
contacts, saves and level state are identical in every character type and with
every model. The hands hold the handle where the profile's [grips](../README.md#hand-grips)
put them, and its [arm lengths](../README.md#arm-lengths), when set, size the arms.
The [character figure](#the-character-figure-and-death)—arm lengths, shoulders,
neck, grips and lean—shapes only the corpse, which never steers the continuing run.
`Game` ignores character settings, selections, part/head changes and sprite loads after stopping
or disposal; a new sprite load resolves without changing anything, and in-flight loads are cancelled.

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
except the joints of [hair chains](#hair), which swing, and those a
[secondary motion](#secondary-motion) moves.
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
  default: its hands then ride with the handle and slide only to stay within the
  slide point of its shoulders, measured as the camera sees them, wherever the
  handle allows, and a longer handle with a shorter extension keeps the reach.
  The depth to the handle is not part of the slide point, so an arm too short for
  the **Arm forward distance** still stretches its forearm to reach that depth.
  With fixed grips the hands follow the butt through the whole slide, so expect
  stretching.
- **Head.** Gaze rotates the head joint about its own bind position, with the
  same smoothing and yaw/pitch limits as the built-in avatar.

The pot hides the body behind its walls through the depth buffer, but does not
clip it. The pot's bottom is 1.22 m below the fitted shoulders with the default jar, and
as far below the player root as the game's [jar outline](../README.md#game-settings) reaches
under it otherwise; anything lower, such as long legs, shows beneath it. A [pot model](#pot-model) can be shaped to
suit the body.

The arms draw over the rest of the avatar and the pot, so they never clip into the
body, jar or head, and share the hammer's depth, so the hands close around the
handle (see [arms over the body](../README.md#custom-visuals)). A
triangle is the arms' when at least two of its vertices are skinned mostly to the
arm joints or to joints that follow them, such as fingers and twist bones; a rigid
mesh attached below an arm joint is the arms' too. A clavicle follows the body, so
the shoulder stays with the torso. The arms keep the model's materials and vertex
buffers, and the model is restored when the avatar is replaced.

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
  restarts from the rigid pose on an explicit placement (restart, checkpoint return or level replacement),
  a new avatar or a gap longer than those 15 steps. Pauses and tab hiding settle interpolation;
  only explicit placements rewind presentation time, and placements also restart hair, with elapsed
  time clamped at zero. Hair never drives IK, gameplay or physics.
- `{ "chains": [], "colliders": [] }` keeps every unmapped joint rigid, at no cost.
  At most 16 chains, 64 joints over all chains and 32 colliders.
- Chains are checked against the model wherever the bone map is: `unknown-joint`,
  `ambiguous-joint`, `duplicate-joint` (a joint the bone map drives) and
  `broken-chain` (not a parent-to-child run, not hanging from a mapped joint, hanging
  from another chain, or carrying a mapped joint).
- Hair is the first built-in [secondary motion](#secondary-motion) and runs through the
  same interface as a game's motions, on the same clock.

### Secondary motion

A game can give its imported avatars motion of its own, such as tails, ears, flaps or
dangling accessories, without editing the engine. A plugin's
[kinds facet](kinds-plugins.md#motion-kinds) registers **motion kinds** beside its
[rig strategies](#rig-strategies), and an avatar lists the kinds it runs in `avatar.motion`,
each by its ID, `<plugin>/<name>`, with configuration only that kind interprets:

```json
"motion": [{ "id": "my-game/charm", "config": { "joint": "Charm", "stiffness": 30, "damping": 4 } }]
```

- Each kind appears at most once per avatar, at most 16 per avatar. `config` is bounded JSON,
  with a driver's limits: depth 8, 512 values and 16 KiB. `[]` runs no motion, at no cost.
  `hair` is the built-in hair's ID: hair stays in `avatar.hair`, and no plugin's kind can take
  that ID.
- When the avatar loads, the engine hands the kind its configuration and read-only facts about
  the model (`AvatarMotionModel`): every skin joint's name, nearest joint ancestor and bind frame
  in the fitted avatar space (metres, +Y up, the model facing +Z, the shoulders 0.74 m above the
  player root), the joints the bone map drives, and the joints hair simulates. The kind validates
  the configuration and returns the motion, which **claims** the unmapped skin joints it will move,
  by index. A configuration the kind refuses fails with the kind's own `AvatarMotionError` code.
- The engine refuses claims with a `CharacterModelError`: `mapped-claim` (a joint the bone map
  drives), `shared-claim` (a joint hair or another motion already moves), `nested-claim` (a joint
  that carries a mapped joint, or carries or hangs below hair's or another motion's joints) and
  `claim-limits` (more than 64 joints over the avatar's motions, hair aside). Claims are therefore
  disjoint and never nest, so the order motions run in cannot change a result.
- Every frame, after the head and arms are posed and the upper body leans, each motion gets
  (`AvatarMotionFrame`):
  - **the clock**: `reset`, start from rest with no steps, or `steps` fixed 1/60 s steps to
    advance. It resets and steps exactly as hair does: frozen while time stands still, at most 15
    catch-up steps, and a reset on an explicit placement, a new avatar or motion, or after the avatar
    was not drawn for longer than those 15 steps. Pauses and tab hiding settle interpolation; only
    explicit placements rewind presentation time, and placements also restart hair and motions,
    with elapsed time clamped at zero. No game code measures time;
  - **placement**: `body`, where avatar space sits in the world, including the waist lean;
    `pot`, the jar's frame, its origin at the jar's bottom-centre; and `jarBottom`, that bottom's
    height about the player root, which the game's [jar outline](../README.md#game-settings) sets
    (-0.48 m for the default jar), so a point (x, y) about the root on the jar is at
    (x, y - jarBottom) in `pot`;
  - **the skeleton**: the mapped joints' frames at bind and now, in avatar space;
  - **rest frames**: each claimed joint's frame this frame if it followed its nearest mapped
    joint rigidly, as unmapped joints do.

  The motion writes each claimed joint's avatar-space frame into `out`. The engine turns those
  frames into bone matrices, and joints below a claimed joint follow it rigidly. Motion that should
  swing with inertia simulates in the world through `body`, as hair does.
- A motion is presentation only: it never drives IK, gameplay or physics, never sees the scene
  graph, and never changes the profile. Its `update` must not allocate.
- An entry naming a kind the registry lacks fails with `unknown-kind`; it is never skipped. Kinds,
  strategies and their checks are one registry, composed from the game's kinds facets, so a
  configuration is accepted or refused identically when a profile, a server avatar's settings or
  a library avatar is imported, stored, packaged or loaded.

A kind, kept in the game's own repository as `games/my-game/charm.ts`:

```ts
import { Matrix4, Vector3 } from 'three';
import { AvatarMotionError } from '../../src/plugins/kinds-sdk';
import type { AvatarMotionKind } from '../../src/plugins/kinds-sdk';

// A charm on one joint that lags behind its rest place in the world, on a damped spring.
export const charm: AvatarMotionKind = {
  id: 'my-game/charm',
  prepare(config, model) {
    const { joint: name, stiffness, damping } = (config ?? {}) as Record<string, unknown>;
    const joint = model.joints.findIndex((candidate) => candidate.name === name);
    if (joint < 0) throw new AvatarMotionError('unknown-joint', `No skin joint is named "${String(name)}".`);
    if (typeof stiffness !== 'number' || typeof damping !== 'number') {
      throw new AvatarMotionError('invalid-spring', 'Give the stiffness and damping as numbers.');
    }
    const position = new Vector3(), velocity = new Vector3(), target = new Vector3(), pull = new Vector3();
    const toAvatar = new Matrix4();
    return {
      claims: [joint],
      update(frame) {
        target.setFromMatrixPosition(frame.rest[0]).applyMatrix4(frame.body);
        if (frame.reset) {
          position.copy(target);
          velocity.set(0, 0, 0);
        }
        for (let step = 0; step < frame.steps; step++) {
          pull.subVectors(target, position).multiplyScalar(stiffness).addScaledVector(velocity, -damping);
          velocity.addScaledVector(pull, frame.stepSeconds);
          position.addScaledVector(velocity, frame.stepSeconds);
        }
        toAvatar.copy(frame.body).invert();
        frame.out[0].copy(frame.rest[0]).setPosition(target.copy(position).applyMatrix4(toAvatar));
      },
    };
  },
};
```

The plugin's kinds facet registers it with `add(AVATAR_MOTIONS, charm)`; see
[kinds plugins](kinds-plugins.md#motion-kinds).

**Workshop controls.** Workshop / Character / **Secondary motion** lists the avatar's hair and
motions. A plugin's workshop facet describes each of its kinds' tunable numbers as data, at
`AVATAR_MOTION_CONTROLS`: a label, a unit, a range, a step, a default and a `path` of object keys
and array indices into the configuration, or a list of them repeated over a list in the
configuration; see [motion controls](workshop-plugins.md#motion-controls). Each motion shows its
controls and a reset to their defaults; a change goes to the draft profile, where the kind checks
it again, and through Save and Revert. Motions that did not change keep moving, and the changed
one restarts from rest. **Sway** rocks the upper body about the waist for a few seconds and
**Jolt** kicks it once, in the running game, so a setting can be judged without playing. Only the
Workshop reads the controls, checked against the registered motion kinds, and releases contain
no editor code.

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
| `mapped-claim` | A motion claims a joint the bone map drives |
| `shared-claim` | A motion claims a joint hair or another motion already moves |
| `nested-claim` | A motion's joint carries a mapped joint, or carries or hangs below hair's or another motion's joints |
| `claim-limits` | The avatar's motions claim more than 64 joints, hair aside |

The same checks run at import, when a profile loads, and when a release is built.
They are implemented without a DOM in `src/character-model-inspect.ts`. A driver or a motion
whose strategy or kind is not registered, or refuses its configuration, fails with an error of
its own, an `AvatarRigError` or an `AvatarMotionError` (see [rig strategies](#rig-strategies)),
and a kinds facet that registers them wrongly with a `PluginError` (see
[kinds plugins](kinds-plugins.md#errors)).

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
rigidly, without stretching, in every character type, including 2D, on the
[obstacle line](../README.md#obstacle-line). It draws in the actors pass with the body, so its front
wall hides the lower part of a body inside it through the depth buffer, while the body shows above
the rim; neither is ever hidden by the course, and a 3D character's arms draw over both.
**Use default pot** restores the procedural pot.

Model it in metres with +Y up, its origin at the bottom-centre of the pot, and its
front facing +Z (toward the camera). The physical pot is the game's jar, whose collision
outline **Physics / Jar** shapes ([`rig.pot`](../README.md#game-settings)); the origin sits at
its lowest point, below the player root. The default jar is 0.80 m tall. Measured from that
origin, its collision outline is:

| Height | Radius | Where |
| --- | --- | --- |
| 0 m | 0.20 m | base, on the ground |
| 0.19 m | 0.44 m | lower wall |
| 0.60 m | 0.50 m | widest point |
| 0.80 m | 0.43 m | rim |

The outline is the polygon through (±radius, height). Collision is always the jar's 2D
outline, whatever the model's shape; toggle the collision overlay (**D**) to
compare. The player root, which the pot pivots about, is 0.48 m above the default jar's base.
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

**Avatar settings.** An avatar can carry its model settings in a JSON file beside it, `models/avatar/knight.json`:
`{ "boneMap", "driver", "hair", "motion" }`, exactly as a profile's `avatar` has them.

- They travel with the model, so a trusted rig strategy's calibration for those exact bytes, its
  [hair](#hair) chains and its [motions](#secondary-motion) are not lost when someone picks it.
- The file is validated and checked against its model with the Workshop's rig strategies and motion kinds, like a
  profile's avatar;
  one that does not fit stops the build or the server, naming the file.
- Settings beside a hammer or pot, or without a model, stop it too.
- An avatar without the file maps its joints when picked, as before.

**Picking.** Workshop / Character's **Skinned avatar (GLB)**, **One-model hammer (GLB)**
and **Pot model (GLB)** sections list the server's models of their part. **Use server
avatar** (hammer, pot) applies the chosen one as if that file were chosen from the computer, and the model is stored
in the character profile. An avatar takes its settings file's bone map, driver, hair and motions; without one, it maps
Mixamo-style joints or opens its bone map. Workshop / Project / Model library offers the same models with
**Add server avatar** (hammer, pot), an avatar with its settings file's bone map, driver, hair and motions and the open
character's hold settings. The character downloads one model at a time and is not
held meanwhile: if it changes before the model arrives, for example through another import,
Revert or opening a project, that change wins and the model is not used. The model library
holds the open project while a model downloads for it, so the project cannot change first.

**Delivery.** The models never ship with the Workshop. A build lists only their names,
sizes, SHA-256 digests and avatars' settings, and writes the files to `dist-content/models/<sha256>.glb` for a
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

## Materials

Every model renders with its own glTF PBR materials: base colour, metalness, roughness,
normal, occlusion and emissive maps, under the theme's lights. Author the look in the
models; the engine adds no alternative shading.

## Profile format

Profiles use **schema version 19**. Every profile has `waistLean`, the most a 3D character's upper body leans toward
the hammer in degrees (0-45; see [waist lean](sprites.md#waist-lean)), and `grips`: the placement, each
hand's distance from the butt (0-3 m) where it starts, the slide point `slideAt`, a share of each
arm's length in the course plane that a sliding hand may ride from its shoulder, either way along the
handle, before the handle slides through it (0-1), `slideRange`, the stretch sliding hands keep to, `from`
and `to` as shares of the handle a hand can hold (0 the butt, 1 the nearest a hand may come to the head;
`from` no greater than `to`), and `rotation`, each 3D hand's turn on its grip about `x`, `y`
and `z` in degrees (-180 to 180; see [hand grips](../README.md#hand-grips)). It also has
`arms`, `null` for each type's own arm lengths or each side's `upper` and `forearm`
(0.1-2 m). The model fields below are present only while used.

```json
{
  "schemaVersion": 19,
  "characterRiggingType": "avatar-3d",
  "armForwardDistance": 0.25,
  "waistLean": 20,
  "grips": {
    "placement": "sliding", "left": 0.04, "right": 0.22, "slideAt": 0.85, "slideRange": { "from": 0, "to": 1 },
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
    "hair": { "chains": [], "colliders": [] },
    "motion": []
  },
  "hammer": { "model": "hammer" },
  "pot": { "model": "pot" }
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
  config; a game's strategies are named `<plugin>/<name>`. A profile whose driver no kinds
  facet registered fails to load with `unknown-strategy` rather than falling back to another
  rig.
- `avatar.hair` is the avatar's [hair](#hair), bound to its model's joints like the bone map.
- `avatar.motion` lists the game's [motion kinds](#secondary-motion) the avatar runs, each
  `{ "id", "config" }`, also bound to its model.
- Models have their own budget, so they do not count against the 24 MiB sprite
  budget. Each model can be up to 20 MiB, and a profile file up to about 104 MiB.

Profiles in any other schema version are rejected, not converted.

## Rig strategies

An imported avatar says how it is fitted and posed through its `driver`. The built-in
`standard` strategy sizes the arms from the model's own shoulders and bind-pose arm lengths
(or the profile's arm lengths) and places the hands on the physical grips, exactly as
described above. A game adds strategies of its own, named `<plugin>/<name>`, and the kinds of
its avatars' [secondary motion](#secondary-motion), in a plugin's kinds facet; see
[kinds plugins](kinds-plugins.md). A strategy that poses the arms as the standard one does, a
starting point for a game's own, kept in the game's repository as `games/my-game/my-rig.ts`:

```ts
import { AvatarRigError, composeArmJoints, STANDARD_AVATAR_FRAME_PLANNER } from '../../src/plugins/kinds-sdk';
import type { AvatarRigStrategy } from '../../src/plugins/kinds-sdk';

const SIDES = ['left', 'right'] as const;

export const myRig: AvatarRigStrategy = {
  id: 'my-game/my-rig',
  prepare(config, binds) {
    // Validate the configuration once, here, and refuse bad data with AvatarRigError.
    if (config !== null) throw new AvatarRigError('invalid-config', 'This rig takes no configuration; use null.');
    return {
      // Phase 1: where each hand rides on the tool.
      writeFramePlan(context, out) {
        STANDARD_AVATAR_FRAME_PLANNER.writeFramePlan(context, out);
      },
      // Phase 2: the arm joints, from the solved arms and the plan they followed.
      writePose(context, out) {
        for (const side of SIDES) {
          const arm = context.arms[side];
          composeArmJoints(binds.arms[side], arm.shoulder, arm.elbow, arm.wrist, arm.normal,
            context.plan[side].shaft, context.plan[side].forward, out[side]);
        }
      },
    };
  },
};
```

A strategy is trusted host code, not content: it is pure numeric code that never sees a scene,
material or renderer, and frame plans are passed explicitly between phases; scratch belongs to
one avatar, never a global. `prepare` checks the configuration once, before the avatar changes,
and returns the avatar's rig synchronously. When the profile rotates a hand, the engine turns a
copy of that side's frame plan about the hand's grip after phase 1: its `offset`, `shaft` and
`forward` all turn, so the arms reach the turned wrist and phase 2 receives the turned plan. The
plan phase 1 wrote is never rewritten.

`AvatarRigFrameContext` is live-only: body and inverse body, tool, shaft axis,
forward direction, shaft length and frame duration. `AvatarRigPoseContext` includes
`attachment: 'gripped' | 'released'`. Death bypasses `writeFramePlan`,
grip placement and wrist offsets. Its explicit shoulder/elbow/wrist solutions and hand
directions follow the corpse, not the dropped shaft. The standard strategy composes those
solutions as supplied. Live play runs both phases with gripped attachment; death
runs only the pose phase with released attachment. Neither context carries a
presentation-source flag.

### The character figure and death

The runtime [`death-pose` point](runtime-plugins.md#death-pose) presents one shared physical
pose for Mesh parts, the built-in skinned avatar, imported avatars and 2D sprites. The
simulation builds six passive bodies from its own live rig and a validated
`CharacterFigure` (`src/character-figure.ts`), never from the view: torso, head, two
upper arms and two forearms/hands. Shared torso/head collider dimensions, mass
shares and joint limits stay engine defaults. The figure is immutable numeric data:

```ts
interface FigureArm {
  readonly shoulder: Readonly<Point>; // torso-local course-plane metres
  readonly upper: number;            // positive finite metres
  readonly forearm: number;
  readonly pole: Readonly<Point>;    // torso-local elbow bend preference
}
interface CharacterFigure {
  readonly waistLean: number;        // degrees; 0 for 2D
  readonly neck: Readonly<Point>;     // torso-local neck pivot
  readonly arms: Readonly<Record<'left' | 'right', FigureArm>>;
  readonly grips: Readonly<Record<'left' | 'right', number>>; // metres from the butt
}
```

The profile and selected library avatar resolve the fitted or default shoulder/neck
layout, waist lean, arm lengths and authored grips once on a presentation change.
When the profile supplies no arm lengths, a sprite grip chain supplies its natural
lengths; otherwise its type's default or fitted chains do. The project's arm-IK hints
provide the XY poles. `CharacterView`'s `onCharacterFigure` callback pushes changes to
`Simulation.setCharacterFigure`. Construction takes `(settings, level, figure, moments)`:
a headless host supplies a `MomentWriter` and `DEFAULT_CHARACTER_FIGURE` or another
validated figure. `CharacterFigureError` has code `'invalid-figure'`;
coordinates must be finite, lengths positive and finite, lean within 0–45° and grips
within `GRIP_LIMITS`. There is no minimum projected arm length.

At entry, physics uses the physical tool line's target waist lean (not the view's
eased lean), authored grips (not the live slide offset) and planar two-bone IK,
bending each elbow toward its pole. Each segment retains the figure's exact length;
only a capsule polygon's half-span is at least 0.02 m to keep it well formed. Collider
visuals are centred on the obstacle line, and 3D arms retain `ARM_LAYER`, sharing depth with
the released hammer.

Sprite profiles stay at schema 19. Existing torso/head anchors and grip-target IK chains
carry the physical pose; no ragdoll data is authored. Facing, flipbook frames, animation
and hair base pose freeze at entry, but the skeleton continues evaluating physical hand
targets with pooled buffers. Artwork bound to a dedicated head subtree follows that
anchor independently; weighted artwork spanning body and head follows its existing
ownership, rather than guessed bone names. The default death writer smoothsteps from
the last drawn live pose into the interpolated corpse and dims 2D materials to 45%,
restored at placement. With no live frame drawn in this placement, capture uses the
physical entry pose; reduced motion skips the blend. Sprites ignore facial yaw/pitch
and keep their head on the obstacle line.

All corpse and tool fixtures collide only with terrain and platforms, never enemies
or each other. Enemies and traps read the frozen entry point, and the dying jar cannot
trigger illusions; the released head still blocks projectile rays. The figure and
corpse do not shape persistent world state after a bonfire return.
Player-body tuning edits while dying take effect at the next placement, never by retuning the corpse; rig
geometry edits and switches between rigid and compliant handles still restart the run.
Character selections, Workshop edits, previews, appearance changes and completed
profile/model loads apply at once while dying. Sprites re-hold the base pose from the
new state, evaluating a new skeleton or preview once first; held IK always uses
released targets. Physics stores a changed figure for the next death without rebuilding
the current corpse. A library hammer chosen mid-death draws immediately, while the
released collider keeps its entry outline until placement. A rig's wrist-chain offset
still drops away at entry; the presentation-only blend cannot change that physical rule.

The same registry is used by every check: importing or opening a project, the project server's
writes, packaging a release and the running release, so a driver or motion is accepted or rejected
identically everywhere. Node builds it once, when the dev server, build or project server starts,
so changing a kinds facet needs a restart; see [kinds plugins](kinds-plugins.md#node-and-the-browser).
A driver fails with an `AvatarRigError` and a `code`: `unknown-strategy` when no strategy is
registered under its ID, `invalid-config` when the strategy refuses its `config`, and
`invalid-strategy` when the strategy prepares no frame planner and pose writer. A motion fails
with an `AvatarMotionError` (`src/avatar-motion.ts`): `unknown-kind`
for an unregistered kind, `invalid-motion` for a motion that is not an object with an `update()` and
distinct skin-joint indices as its claims, or the kind's own code for a configuration it refuses, with
the kind's ID in `motion`. Like `AvatarRigError`, it keeps a portable tag across Vite's module runner.
The Workshop shows both as it shows model errors. Callers branch on `code`, never on the message.
Registering a malformed strategy or kind fails with a `PluginError` instead; see
[kinds plugins](kinds-plugins.md#errors).

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
attached and visible: nothing reloads, and live physics, the timer and the level
continue. Its figure is stored for the next death; swapping during death retargets
the existing corpse immediately. An inactive profile is detached from the scene and does no per-frame
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
map later. An avatar entry carries its rig `driver`, its [hair](#hair), its [motions](#secondary-motion) and what
depends on its proportions: its bone map, grips, arm lengths and arm forward distance. A new avatar starts
without hair or motions and takes the grips, arm lengths and arm forward distance of the open character,
and **Use character settings** takes them again, so tune them in Workshop / Character first. **Preview** shows a library model in the Workshop's game
exactly as a release shows it; previews are not saved. The project server stores the
library as `models/<part>/<id>.glb` with its entries in `project.json`, with
[API routes](projects.md#api-for-scripts-and-language-models) for each model.

**What shows.** A library avatar replaces the avatar of an Avatar (3D) character and
brings its own settings; the profile keeps everything else, such as its waist lean.
Library hammers and pots show in every character type, fitted like the profile's own. The selection belongs to the player, so switching characters keeps it.

**Hammer heads.** Each library hammer carries its own head: a collision outline that
replaces the game's default head while the hammer is shown, so a pick-shaped hammer can
hook what a sledge cannot. A new hammer starts with the game's default head; shape it in
Workshop / Physics / **Hammer head**. Swapping hammers, in a release or a Workshop
preview, swaps the head in place without restarting the run. Phantom recordings do not
record which hammer was held, so recordings made with any hammer share the course.

**Content.** Each library GLB is its own content group, `library/<part>/<id>`, which
the release's shell does not list; see [content delivery](content-delivery.md). The
release fetches a library model only after the backend selects it, through a grant
for that group, so the backend and its CDN can refuse models the player does not own.
Only a game built with a [release facet](release-plugins.md#library-models) has a backend that
selects, so a build without one, and every studio preview, packages no library models.

**The backend's contract.** A plugin's release facet adds `select(request, signal)` to the
content access it supplies. With `null` it returns the stored selection, `{ avatar, hammer, pot }`
of library IDs or `null` for the profile's own model; with `{ role, id }` it asks the
backend to change one part, and returns the selection the backend then stores. The
backend may refuse by throwing a `ContentError`, or answer with any selection.
[Library models](release-plugins.md#library-models) shows the facet, which relays the player's
choices through `api.modelLibrary`, where `api` is the `ReleaseApi` its `READY` callbacks
receive.

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
  swap that asked for it, or reaches the `MODEL_FAILED` callbacks when no swap asked; at
  boot it starts with the profile's own model.
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

`CharacterView`, exposed as `game.view.character`, is the character host and receives
the same `characterModels` loader. Its `createAlternateCharacter()`
returns the second profile's `SpriteRig`, and `selectCharacter(index)` switches
profiles. `SpriteRig` stays independent of Three.js model loading: its
`characterAssets.prepare(document, signal)` option loads and validates a
document's models before the rig commits it. Without a host, documents with models are rejected.

### Presenter architecture

`GameView` owns the scene passes, camera and effects; `CharacterView` owns character
selection, the resolved figure, previews and death presentation. `CharacterProfiles`
keeps profile models, library overrides and their prepare-then-commit transactions.
The mesh-parts, built-in avatar, imported-avatar and sprite `CharacterPresenter`s share
`FigureRig`'s scene, lean and head aim, plus `GripArms`' grip placement and IK. An imported
presenter's frame plan runs before grips and its pose phase after IK; only the active
sprite presenter feeds `SpriteRig.update`, using pooled targets and pose buffers.
Games customize through profile content and the rig, motion and runtime plugin points.

## Performance

Imported avatars are built once when their profile loads. Each frame writes the
seven driven bone matrices, with no allocation. Unmapped joints keep static local
matrices; hair chains add their joints' matrices and at most 15 solver steps, bounded by
their joints and colliders, and each motion adds its claimed joints' rest frames and matrices
and its own update, which allocates nothing. A change to an avatar's hair or motions alone
replaces its motions without rebuilding the avatar. The hammer and pot models copy one matrix each; a new handle length
rewrites the hammer model's vertices once. This cost does not depend on the level.
In the editor, `window.gettingOver.level().rendering` reports `importedAvatar`
(joints, unmapped joints, chains, cumulative `boneWrites`, and each motion's `claims` and cumulative
claimed-joint `writes`, hair first), `hammerModel` and
`potModel` (transform, drawn material types and cumulative `matrixWrites`; the
hammer's `fit` gives its handle length and fitted bounds), `characters`
and `renders`.
