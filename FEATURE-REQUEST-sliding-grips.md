# Feature request: hands that slide along the handle, and a configurable handle length

**Date:** 2026-09-27 · **Baseline:** `56377bc` · **Status:** implemented; see [hand grips](README.md#hand-grips)
and the [hammer rig](README.md#game-settings). The handle length and maximum extension are the settings' `rig`
section; the three handle segments share the handle length instead of exposing a layout. Level starts store the
head's `reach` instead of the slider extension, so a start keeps its pose on any handle, and profiles carry
`grips`. Settings (schema 3), levels (schema 3) and profiles (schema 10) changed without backward compatibility.

A game wants a **longer hammer so its character can have shorter arms** (the same reach, with more
of it in the handle). Today that cannot work: the hands are pinned to the butt of the sliding
handle, so they travel the whole slide range and every character needs arms that reach about as far
as the handle is long. A longer handle makes the arms longer, not shorter.

## What exists today (source-audited at `56377bc`)

- **The hands are pinned to the butt.** `view.ts` `updateArms` targets each hand at
  `ARM_GEOMETRY[side].gripX` (0.04 m and 0.22 m) along the grip frame, and the grip frame sits on
  the `slider` body, which is the handle's butt (`player.ts`: segment 0 starts at the slider).
- **The butt travels the whole slide.** The slider moves along the aim axis through the shoulder
  pivot from `RIG.minExtension` (−handle length, −1.5 m) to `RIG.maxExtension` (1.15 m).
  `drivePlayer` targets `projected reach − handle length`, so pulling the head in to the body puts
  the butt, and both hands, up to 1.5 m behind the shoulder.
- **So the arms must span the slide.** From the avatar shoulders (`ARM_GEOMETRY`) to the grips at
  the tool depth (`getToolDepth(0.25)` = 0.75 m, against a torso at 0.27 m), the worst cases are
  **1.74 m** (left hand, head pulled in, aim ≈ 158°) and **1.60 m** (right hand, full extension). The
  built-in avatar therefore has 0.82 m + 0.82 m arms (`ARM_LENGTH`). An imported skinned avatar with
  human-proportioned arms gets its forearm stretched (`SkinnedAvatarView.limbFrame` scales the
  segment by distance ÷ rest length). A sprite character's IK clamps at its chain length, so its
  hands leave the handle.
- **The rig is fixed.** Handle segments, segment length and maximum extension are constants in
  `src/config.ts` (`RIG`). A game can only change them by editing an engine module.

Longer handles under pinned grips, same 2.65 m reach (worst grip distance from a shoulder):

| Handle / max extension | Pinned grips (today) | Sliding grips (requested) |
| --- | --- | --- |
| 1.5 m / 1.15 m (today) | 1.74 m | 1.60 m |
| 2.1 m / 0.55 m | 2.32 m | **1.03 m** |
| 2.2 m / 0.45 m | 2.41 m | **0.94 m** |

The figures come from the source geometry above and the sliding rule below, not from a run.

## Requested capability

1. **Grip placement as a per-character strategy** (profile data; default `fixed`):
   - `fixed`: today's behaviour, the hands at `gripX` from the butt.
   - `sliding`: the hands hold the handle where it passes the body, and the handle slides through
     them as the head extends and retracts, as in Getting Over It. For example: the grips centre on
     the projection of the shoulders' midpoint onto the handle axis, keep today's order and spacing
     (left 0.18 m nearer the butt), and are clamped to the holdable span, from today's grips at the
     butt to a margin short of the head. When the butt is ahead of the body (positive extension),
     the hands hold the butt, so the arm length a game needs is set by its maximum extension, not
     its handle length.
   - Grips are presentation: physics, colliders, input and motors do not change. Avatar IK (built-in
     and skinned) and sprite IK (`left-grip`, `right-grip` targets) consume the same grip positions.
     Hammer models and the two-part hammer still follow the physical tool frame.
   - Grip positions are continuous in aim and extension (no jump when the butt passes the body);
     the hands stay oriented along the shaft; the cost is constant per hand per frame.
2. **Handle length and extension range as game-project physics**, like the other tuning values:
   the handle length (with its segment layout) and the maximum extension; the minimum extension
   stays −handle length and the reach is handle + extension. Everything derived from them follows:
   rig construction (`createPlayer`), the two-part hammer, the one-model hammer convention and its
   documented numbers, the collision overlay, spawn-extension and cursor-radius validation, touch
   pixels per reach and camera framing. Changing them rebuilds the player through an explicit reset,
   never half a rig.

## Acceptance

- With `sliding`, a 2.1 m handle and 0.55 m maximum extension keep every grip within about 1.03 m
  of its shoulder for all aims and extensions, and the hands never leave the handle or enter the
  head block.
- `fixed` reproduces today's grip positions exactly; existing profiles and the default game play
  and look as before.
- A project with a 2.1 m handle and 0.55 m extension builds a release whose physics rig, collision
  overlay, cursor radius and hammer convention agree, with no engine module edited.
- Each character applies its own strategy; switching a project's characters takes effect without a
  reload.

## Context

A downstream game's 3D character has 0.82 m + 0.82 m arms only so its hands can follow the pinned
butt, and the owner wants human proportions with a longer hammer. Its hammer model is built from the
physical rig (handle length and width, head collision polygon), so it follows any handle length.
Once grips slide, the game sets a longer handle in its project and models the arms at about 0.5 m
per segment. Its 2D painted arms (0.58 m + 0.56 m) would reach the grips too, without the sprite-IK
stretch they would otherwise need.
