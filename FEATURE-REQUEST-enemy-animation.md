# Feature request: animated 3D enemies with root motion

**Date:** 2026-10-10 · **Baseline:** `790e922` · **Status:** requested; nothing is implemented.

Enemies draw only as two-frame pixel sprites (`src/enemy-view.ts`), from the project's enemy art (`src/enemy-art-data.ts`).
Their species and behaviours are engine code: `ENEMY_SPECS` (`src/enemy-types.ts`) and `EnemyWorld`
(`src/enemy-world.ts`), which moves each enemy's dynamic body toward a velocity (`drive`) within its species'
acceleration, through fixed phase timings. The engine imports skinned GLBs only for the player avatar, which it drives
procedurally, ignoring animation clips (`docs/characters.md`). A game cannot give its humanoid enemies animated models
that move as their animations do.

three.js already provides what playing clips needs: `AnimationMixer` and `AnimationAction` (clips, cross-fades, time
scale) and `SkeletonUtils.clone` (many skinned copies of one loaded model). Nothing in three.js handles root motion,
where an animation's own travel moves the character, and the simulation must not read the renderer anyway: play is a
deterministic planck simulation that phantoms and saved runs replay. So this request bakes root motion once, when a model
is imported, into project data the simulation reads, as collision is baked from course meshes.

## Rules every stage keeps

- **One source.** An enemy's GLB is the source of both how it looks and how far its moves travel. Its root motion is
  baked from it at import, stored with the project, and read by the simulation; the renderer plays the same clips in
  place. Builds bake again and refuse motion that no longer matches its GLB.
- **The simulation never reads the renderer.** Motion is plain numbers, read the same in the Workshop, the project
  server, the course kit, builds and releases. Releases never bake, as they never slice meshes.
- **Collider and drawing stay together.** A model stands where its body is, and its clip plays at the time the
  simulation says, so what it travels and what it shows never drift apart.
- **Recordings follow the motion.** An enemy's baked motion joins the course fingerprint, so a changed clip makes a new
  course, as a moved enemy does.
- **One look.** Enemy models reach the game through `GameLook`, so the Workshop draws them as releases do.
- **Cost follows awake enemies.** Copies share geometry, materials and textures; each awake enemy has one mixer, and
  dormant ones cost nothing. A release carries the model renderer and its GLTF loader only when it has enemy models.
- **No new runtime dependency.** three.js does the playing. Retargeting and compression tools stay in a game's own
  pipeline, and the docs name open ones.
- **No compatibility.** Format changes bump their schema versions; bundled projects are rewritten.

## Stage A: enemy models in the project

- **Format.** Each species in the `enemies` section is `null` (the built-in sprite), a sprite
  (`{ "type": "sprite", "frames", "palette" }`, today's art), or a model:
  `{ "type": "model", "name", "clips": { role: clip name }, "motion": { role: baked motion } }`, its GLB at
  `enemies/<species>.glb`.
- **Clip roles.** One role per phase: `idle` and `walk` for patrol (standing or moving), `windup`, `dive`, `recover`,
  `hurt` and `death`. Each species needs the roles of the phases it has: a soldier `idle`, `walk`, `recover`, `hurt`
  and `death`; an archer those and `windup`; a bird those and `windup` and `dive`.
- **Model rules.** A skinned glTF 2.0 binary, +Y up and facing +Z, with named clips, within the character model
  limits (`MODEL_LIMITS`) and at most 32 clips of at most 10 s each. It is fitted to its species' height, its feet on the
  bottom of the collider and its middle on the obstacle line.
- **The bake** (`src/enemy-motion.ts`, DOM-free). It reads the GLB with the reader the collision baker uses, moved out of
  `src/mesh-collision.ts` into its own module so both share it. For each mapped clip it samples the skin's top joint at
  60 Hz in model space, through its ancestors' transforms. It keeps the travel along the model's facing as a fraction of
  the model's bind-pose height, so it scales with the fitted height, quantized so its JSON and its fingerprint are
  canonical. Sideways travel is dropped; up and down stays in the pose. `idle` and `walk` loop and the rest play once.
  The Workshop bakes off the page's thread, as it bakes collision; the project server, the course kit and builds run
  the same function.
- **Workshop.** Project / Enemy art offers each species a sprite or a 3D model: import a GLB, then choose a clip for each
  role, pre-filled by name (idle, walk or run, attack, draw or shoot, hit or hurt, death or die), each showing its
  travel, such as "walk: 1.3 m/s". Refusals name what to change. The Workshop SDK's `edits.enemies()` takes the new
  shape, and plugins can add and remove models as Project does.
- **Server and releases.** The project API stores, serves and removes each species' GLB and bakes on upload. A release
  packages the GLBs of the species its level places that have models.
- Project schema 23 and release content schema 22. The example projects and the generator of the bundled
  souls-like project write the sprite shape; the docs and the API manual follow.

## Stage B: root motion in the simulation

- `EnemyWorld` takes each species' baked motion from the project, or none for a sprite, which behaves as today.
- **Ground enemies with a model move as their clips travel.** In every phase, the clip's travel at the phase's clip
  time, in the enemy's facing, sets the velocity its body is driven toward each step, within its species' acceleration
  as today; gravity keeps the vertical.
  - **Patrol.** A walking enemy plays its walk clip at the rate that travels at its Patrol speed, so the level's speed
    keeps its meaning and every step lands where the feet do. A standing one idles.
  - **Hurt.** A struck enemy turns to face where the strike came from, then its hurt clip's travel moves it, so a
    stagger carries it away from the hammer.
  - **Recover and windup.** A soldier's pause after a bump, an archer's draw and its reload travel as their clips do.
  - **Phase lengths stay the game's timings** (hurt, bump pause, draw, reload): a clip longer than its phase is cut by
    the next, and a shorter one holds its last frame and stops travelling.
  - **Death.** The corpse has no collider. It travels as its death clip does and stays until the clip ends, in place of
    the fixed dissolve time.
- **Birds** are steered at targets as they fly (a dive at the player, the way home), so their clips play in place at the
  speed they fly, with no root motion.
- `EnemyPose` gains the playing role and its clip time, so every look plays exactly what the simulation moved.
- The course fingerprint takes the baked motion of every species the level places with a model (phantom course
  format 12).

## Stage C: drawing animated enemies

- `GameLook.enemies` carries each species' sprite or model. The game gets the enemy-model renderer from an injected,
  code-split factory and the GLBs from an injected source, as it gets course artwork; releases include it only when they
  have enemy models.
- **The engine's own look** draws sprites as now and, for each species with a model, loads its GLB once. Each awake
  enemy gets a `SkeletonUtils.clone` sharing geometry, materials and textures, and its own `AnimationMixer`:
  - Clips play in place: the top joint's travel along the facing is removed, its bob kept.
  - Each frame the action's time is set from the pose's clip time, so a model never runs ahead of or behind its body.
    A change of role cross-fades over 0.15 s.
  - Facing turns the model a quarter turn about its vertical axis, toward the side it walks to.
  - A windup tints it with the sprites' warning colour and a hurt flashes it, on a material copy made only while that
    enemy is awake.
  - Dormant enemies are hidden, with their mixers stopped; a dead one goes when the simulation removes it.
- The `looks.enemies` slot stays the way a game draws enemies its own way; its looks get the new pose fields.
- `docs/enemy-models.md`: the format, clip roles, root motion, limits and costs, and a content pipeline using open tools
  (glTF-Transform to resample and compress clips; Blender, or `retargeting-threejs`, to bring clips onto a game's own
  rig) and CC0 sources (Quaternius, Kenney, KayKit). It notes that Mixamo's terms allow a game's own files but not
  redistribution, so clips from it never belong in the engine's repository.

## Acceptance

- A project gives the hollow soldier a CC0 humanoid GLB with idle, walk, recover, hurt and death clips. In the Workshop
  and in its release, soldiers walk their patrols without their feet sliding, stand idle, stagger away when struck and
  fall when defeated, alike.
- A soldier with Patrol speed 0.8 m/s plays its walk clip at the rate that travels 0.8 m/s, and travels exactly that.
- Changing the walk clip changes the course fingerprint.
- Projects without enemy models look and play as before, and their releases carry no enemy-model renderer.
- With 64 model enemies placed, frames cost only the awake ones.

Not in this request: new enemy species or behaviours, retargeting inside the engine, blend trees beyond cross-fades,
foot placement on slopes and turning clips.

## Context

A downstream game wants humanoid enemies drawn as its own animated characters that move as their animations do, in the
Workshop and in its releases alike.
