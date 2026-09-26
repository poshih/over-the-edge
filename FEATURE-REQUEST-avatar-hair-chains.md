# Feature request: spring-bone hair chains on imported skinned avatars

**Date:** 2026-09-26 · **Baseline:** `a831e8a` · **Status:** requested, not started.

Follow-up to [imported skinned characters](FEATURE-REQUEST-skinned-character.md). Sprite
skeletons already have cosmetic spring-bone hair (`HairChain` + `SkeletonCollider` in
`src/skeleton-data.ts`, solved in `src/skeleton-pose.ts`; docs `sprites.md` → Spring-bone hair).
An imported skinned avatar (`avatar-3d`, `docs/characters.md`) has no secondary motion: every
unmapped joint "follows its nearest mapped ancestor rigidly in its bind-pose offset", so a long
braid modelled on the avatar is a stiff rod. Games want the same chain physics on their 3D
character, e.g. a long braid hanging from the head.

## Requested capability

- **Profile data:** the avatar profile may list hair chains over its own skin joints, with the
  sprite hair parameters, plus body colliders on mapped joints:

  ```jsonc
  "avatar": {
    "model": "avatar", "boneMap": { ... },
    "hair": [{ "id": "braid", "joints": ["Braid1", "Braid2", "...", "Braid12"],
               "stiffness": 0.04, "damping": 0.18, "gravity": 9.81, "radius": 0.035 }],
    "colliders": [{ "id": "torso", "joint": "body", "x": 0, "y": 0.2, "radius": 0.26 }]
  }
  ```

  A chain is one continuous parent→child run of unmapped skin joints whose root's parent is a
  mapped joint or an unmapped joint that follows one (typically under `head`); the root is pinned to
  it. Collider `joint` names an avatar joint id (`body`, `head`, arms); offsets are in that joint's
  frame, in metres after the avatar fit. Schema bump written only while present.
- **Solver:** reuse the existing sprite hair solver (one implementation, not a 3D copy): chains
  keep segment lengths and world-space inertia, bounded fixed substeps, freeze on unchanged
  simulation time, reset on rewind/restart, pinned roots and lengths win over colliders. Motion is in
  the game's side-view plane (X-Y); each joint keeps its bind-pose depth offset. The chain's joints
  drive the skin, so the braid mesh bends along them.
- **Order:** mapped joints (IK, head gaze) update first, then hair, as for sprites; hair never
  drives IK, gameplay or physics.
- **Validation (typed `CharacterModelError` codes):** unknown or mapped joints in a chain, broken
  (non-continuous) chains, chains sharing joints, chains nested under simulated joints, colliders
  on unknown avatar joints, out-of-range parameters (same limits as sprite hair).
- **Editor:** the Character tab lists chains and colliders with the sprite hair controls, previews
  them live on the loaded model, and shows collider circles in the collision overlay.
- **Shading:** cel outlines keep following the skinned braid.

## Acceptance

- A Mixamo humanoid with a 12-joint braid under `Head` and one torso collider: the braid hangs
  under gravity, swings and settles as the character moves and aims, and stays outside the torso
  circle; the rest of the avatar behaves exactly as today.
- A profile without `hair` is byte-identical to today's schema and costs nothing extra.
- Per-frame cost is bounded by the chain joint count (no allocation), independent of level size;
  a representative large level stays in today's cost class.
- The same document round-trips through Save/Revert/JSON export and `GAME_SPRITES` /
  `GAME_ALTERNATE_SPRITES` releases, validated at build time.

## Constraints (from `AGENTS.md`)

Performance is a feature requirement; runtime modules never import editor modules; presentation
state never mutates authored level or profile data.
