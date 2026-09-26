# Feature request: imported skinned character, one-model hammer, shading modes and a 2D/3D toggle

**Date:** 2026-09-26 · **Baseline:** `da9bf3e` · **Status:** requested, not started.

Downstream games want to ship their **own** GPU-skinned 3D character (generated or hand-made, e.g.
rigged with Mixamo-style bone names), render it either **PBR** or **cel-shaded**, and offer players
a **toggle** between that character and their 2D sprite character. Everything below is generic:
the engine owns the machinery, a game supplies only data (GLBs, bone maps, profiles).

## What exists today (source-audited at `da9bf3e`)

- `CHARACTER_RIGGING_TYPES = ['sprite-2d', 'model-3d', 'avatar-3d']` (`src/sprite-data.ts`); the
  type lives in the character/sprite profile and is changed only in the Workshop.
- `avatar-3d` (`src/avatar-view.ts`, `src/avatar-geometry.ts`) renders **one built-in procedural
  `SkinnedMesh`** with 8 joints (`AVATAR_JOINTS`: body, head, and upper arm / forearm / hand per
  side), driven by the arm IK to the physical `left-grip` / `right-grip`, with neck-pivoted head
  gaze (`head-aim.ts`). It is constructed once and reused; per frame it only updates bones. Pot and
  hammer stay visible as separate mesh parts (`view.ts`: `separateProp`).
- The Workshop states "Whole-avatar GLB import and animation retargeting are not supported";
  Appearance imports **rigid** per-part GLBs only, stored browser-locally, not in releases.
- The hammer is **two** visuals: a shaft stretched between the physical endpoints plus a head.
- Materials are `MeshStandardMaterial` (PBR). No toon/cel material or outline pass exists.
- A game-only release bundles **one** character profile (`GAME_SPRITES`, `vite.game.config.ts`
  `spriteBundle`). Static GLBs reach releases only through course packages (`pack:course`).

## Requested capabilities

### S1 — Import a skinned character GLB into `avatar-3d`

- A character profile may reference a skinned GLB in place of the built-in avatar mesh, with an
  explicit **bone map** from GLB joint names to the 8 avatar joints. Unmapped joints (spine, neck,
  fingers, legs) are allowed and follow their nearest mapped ancestor; list them in diagnostics.
- The existing arm IK, grip targets, head gaze, arm-forward distance and pot/hammer separation
  drive the mapped joints exactly as they drive the built-in avatar. Chain lengths come from the
  GLB bind pose; IK behaviour at unreachable targets matches the built-in avatar.
- Load-time validation with typed errors (no string matching): no skin; missing, duplicate or
  unknown mapped joints; mapped joints that are not an ancestor chain (body → upper → forearm →
  hand); more than 4 influences per vertex; unnormalised weights; `MODEL_LIMITS` overruns.
- Versioned profile data: a schema bump written only when the new fields are present, so existing
  profiles stay byte-identical (as the flipbook change did).
- **Acceptance:** a Mixamo-named humanoid GLB (`Hips`…`Head`, `Left/RightArm`, `Left/RightForeArm`,
  `Left/RightHand`) plus a bone map replaces the built-in avatar; IK bends its shoulders, elbows and
  wrists toward the grips; an incomplete map fails with a typed error; per-frame cost is bone
  updates only (no per-frame allocation), independent of level size.

### S2 — One-model hammer bound to the physical tool frame

- A hammer GLB with a documented convention — **origin at the butt of the handle, handle along
  +X, metres** — may replace the shaft-plus-head pair and follows the physical hammer frame
  rigidly (no stretching). Available in every character type, in the existing foreground pass.
- **Acceptance:** the model follows grips and the collision overlay without distortion; physical
  length, reach, grips and contacts are unchanged; the two-part hammer remains the default.

### S3 — Character shading modes, switchable live for comparison

- A per-profile shading choice for the skinned character and the separate props: **PBR** (today)
  and **cel** — stepped/ramp lighting (configurable band count or ramp texture) with an optional
  outline (inverted hull or screen-space; colour and width configurable) that follows skinned
  deformation. Materials are built once at load and reused.
- The Workshop can flip the mode live on the same model, so an owner can compare the two looks
  side by side without reloading.
- **Acceptance:** one GLB renders correctly in both modes; switching allocates nothing per frame
  and creates no new materials after the first switch; the outline stays attached during IK.

### S4 — Two character profiles in one release, with a player toggle

- A game-only release can bundle a sprite-2d profile **and** a skinned-avatar profile (its GLBs
  validated at build time against `MODEL_LIMITS`, as `GAME_SPRITES` validates sprites today), and
  players switch between them in game settings. The choice persists locally.
- Toggling swaps presentation only: physics, reach, grips, saves and level state are identical,
  and the level is not reloaded. A release with one profile behaves exactly as today.
- **Acceptance:** one build ships both characters; the toggle works mid-level; the playable
  release contains no editor modules (existing verification); both profiles' assets are loaded
  once and reused.

## Constraints (from `AGENTS.md`)

- Performance is a feature requirement: reuse geometry/materials, update incrementally, keep
  per-frame work proportional to active effects; exercise a representative large level.
- Runtime modules must not import editor modules; editor-only UI (bone-map editing, the live
  shading flip) stays in the editor entry point.
- Temporary presentation state never mutates authored level or profile data.

## Suggested order

S1 (skinned import) → S3 (shading comparison) → S2 (one-model hammer) → S4 (release toggle).
