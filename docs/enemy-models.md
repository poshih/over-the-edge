# Enemy models

A project can draw any enemy species as an animated 3D model instead of pixel art. The model is a skinned GLB of the
project's [course artwork](course-artwork.md), and it plays one animation clip for each of the species' roles. Each
clip's root motion, how far the clip's character travels, is worked out once when the model is chosen and kept with
the project, so the game never reads an animation back from the screen.

## Requirements

- A self-contained, uncompressed binary glTF 2.0 file with at least one skinned mesh, +Y up and facing +Z, glTF's
  convention, within the character model limits (`MODEL_LIMITS` in `src/model-data.ts`) and the course artwork's
  budgets (`ART_LIMITS` in `src/art-types.ts`), which it shares with the course's own GLBs.
- One skeleton: every skin shares one top joint, the joint with no other joint above it, such as `Hips` in a
  Mixamo-style rig or a `Root` bone at the feet. Only that joint may travel: the nodes above it must not be animated.
- Between 1 and 32 animation clips, each named, the names all different, each up to 10 seconds long.
- It is fitted to the species' height, its bind pose as tall as the species' collider, its feet on the collider's
  bottom and its middle on the obstacle line.
- It may not also be a terrain mesh or a decoration model, which must be static.

## Roles

Each species plays one clip for each phase it has, and for its patrol one standing and one moving:

| Role | Plays while | Species |
| --- | --- | --- |
| `idle` | patrolling, standing | all |
| `walk` | patrolling, moving (a bird flying) | all |
| `windup` | drawing a bow, or hovering before a dive | archer, bird |
| `dive` | diving at the player | bird |
| `recover` | pausing after a bump, reloading, or flying home | all |
| `hurt` | reeling from a strike | all |
| `death` | falling when defeated | all |

`idle` and `walk` loop; the others play once.

## Choosing a model

**Workshop / Project / Enemy art / Import 3D model** reads a GLB off the page's thread, adds it to the course artwork
and draws the species with it. Each role takes the first clip whose name suggests it (idle or stand; walk, run or
fly; draw, aim or attack; dive or swoop; recover, reload or stagger; hit or hurt; death or die), or else the idle clip.
Change any role's clip under the model; each shows how fast its clip travels. **Use built-in art**, or applying pixel
art, draws the species as pixel art again, and its GLB leaves the course artwork unless another species draws with it.
**Project / Course artwork** refuses to remove a GLB a model uses, importing a course package keeps the models' GLBs,
and **Level** never offers them as terrain meshes.

## Root motion

The motion of a clip is the travel of the model's top joint along its facing, +Z, sampled 60 times a second through
the transforms above the joint, and kept as whole ten-thousandths of the model's bind-pose height, so it scales with
the height the model is fitted to. Travel to the side, and up and down, is not root motion: the bob of a walk stays in
its pose. The Workshop, the project server and builds work it out with the same function, `src/enemy-motion.ts`;
releases never do. The project server, writing a new or changed model entry or importing a bundle, and every build
bake the model's clips again and refuse motion that does not match them. Workshop plugins give a species a model only
through `enemyModel` and `enemyClips`, which bake it; `enemies` keeps a model entry only as it is.

## Play

A species drawn by a model moves as its clips travel; one drawn as pixel art moves as before.

- **Ground enemies**, soldiers and archers, move by root motion. Each step, the clip their phase plays sets the
  velocity their body is driven toward along its facing, within the species' acceleration; gravity keeps the vertical.
  - A patrol walks with its walk clip at the rate that travels at the enemy's Patrol speed, so its steps land where its
    feet do, and idles while it stands. A walk clip travelling forward less than `ENEMY_MOTION.inPlaceStride` (5% of
    the model's height) each cycle walks in place: it plays at its own pace while the enemy walks at its Patrol speed,
    as pixel art does, so give walks root motion for steps that land.
  - A hammer strike turns the enemy to face it. Its hurt clip then carries it, so a stagger backward moves it away from
    the hammer, and a killing blow's death clip falls away from it.
  - A soldier's pause after a bump, an archer's draw and its reload move as their clips do.
  - Phases keep the game's timings: a clip longer than its phase is cut by the next, and a shorter one holds its last
    frame and stops travelling.
  - The corpse has no collider. It travels as its death clip does and stays until that clip ends.
- **Birds** are steered as they fly, as ever: their clips play in place at their own pace, and a dead bird stays until
  its death clip ends.
- Every enemy pose carries the role it plays and its clip time (`clip`, `clipTime`; see
  [runtime plugins](runtime-plugins.md)), so a look plays exactly what play moved.
- A ground enemy's motion joins the level's [course](phantoms.md#courses): changing a clip it moves by starts a new
  course, with new recordings.

## Format

In `project.json`, each species in `enemies` is `null` for the built-in pixel art, a sprite, or a model:

```json
{
  "hollow-soldier": {
    "type": "model",
    "asset": "asset-<sha256 hex of the GLB>",
    "clips": { "idle": "Idle", "walk": "Walk", "recover": "Idle", "hurt": "HitReact", "death": "Death" },
    "motion": { "walk": { "duration": 1.0667, "travel": [0, 197, 391, "..."] }, "...": "..." }
  },
  "hollow-archer": { "type": "sprite", "frames": ["..."], "palette": { "...": "..." } },
  "bird": null
}
```

Over the [project API](projects.md#api-for-scripts-and-language-models), upload the GLB with
`POST /api/projects/{id}/art/assets`; `GET /api/projects/{id}/art/assets/{assetId}/enemy` then answers with its clips
and every clip's motion, to put in the entry with the clips its roles play.

## Bringing your own animations

The engine plays the clips a GLB carries and adds no retargeting of its own. Build each enemy's GLB in your own pipeline:

- **Retargeting.** Blender, or the Apache-2.0 [`retargeting-threejs`](https://github.com/upf-gti/retargeting-threejs),
  brings clips made for another rig, such as Mixamo's, onto your character's skeleton.
- **Compression.** [glTF-Transform](https://gltf-transform.dev) (`resample`, `prune`, `dedup`) shrinks clips without
  changing them.
- **Sources.** Quaternius, Kenney and KayKit publish CC0 humanoid characters and animations. Mixamo's terms allow its
  characters and clips in your own game's files, but not redistributing them, so they never belong in this engine's
  repository.
