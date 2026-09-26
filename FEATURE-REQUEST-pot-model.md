# Feature request: pot model in the character profile and releases

**Date:** 2026-09-26 · **Baseline:** `088e9c9` · **Status:** requested, not started.

Follow-up to [imported skinned characters](FEATURE-REQUEST-skinned-character.md). A game's 3D
character is typically three pieces: a skinned body, the pot and the hammer. Schema 8 carries the
skinned avatar and a one-model hammer in the profile and ships them in releases, but the **pot**
can only be replaced through Appearance, which is browser-local and never reaches a release.

## What exists today (source-audited at `088e9c9`)

- Profile `models` lists 1-2 GLBs, each used by `avatar` or `hammer` (`docs/characters.md`,
  `src/character-profile.ts`). There is no pot role.
- Avatar mode keeps the pot as a separate prop (`view.ts`: `PROP_PARTS`), rendered from the
  mesh-part `pot` slot at `PLAYER_DEPTH.pot`, optionally replaced by an Appearance GLB
  (`src/visual-model.ts`), which is stored in the browser only.
- Cel shading already styles "Appearance's pot and hammer imports" in Avatar mode.

## Requested capability

- A **pot model** role in the profile (`"pot": { "model": "<id>" }`), alongside `avatar` and
  `hammer`, with `models` allowing up to 3 GLBs (one per role, no sharing).
- A documented convention, in metres: **+Y up, origin at the bottom-centre of the physical pot**,
  front facing +Z. The model follows the physical pot body rigidly (no stretching) in every
  character type, at the pot's existing depth, so a skinned body inside it is hidden by the pot's
  own walls through the depth buffer. State the physical pot's rim height and radius in the docs
  (as the hammer section states the head block) so artists can fit it.
- Static mesh only: a skinned pot fails with `unexpected-skin`; convention violations fail with
  `invalid-model`; the same DOM-free inspector runs at import, load and build.
- The Shading setting (PBR / cel, outline) applies to the pot model like the hammer model.
- `GAME_SPRITES` / `GAME_ALTERNATE_SPRITES` releases bundle it as one hashed asset, validated at
  build time. Schema bump written only while a pot model is present; older documents stay
  byte-identical.
- Appearance's pot import is hidden while a profile pot model is present (as for the hammer).

## Acceptance

- A profile with avatar, hammer and pot models renders all three in a release with no editor
  modules; the pot tracks the physical pot body exactly; colliders, contacts and physics are
  unchanged.
- The collision overlay shows the model's base on the pot's physical bottom.
- Switching PBR/cel restyles the pot with no new materials after the first switch.
- Per-frame cost for the pot model is one matrix copy, independent of level size.

## Constraints (from `AGENTS.md`)

Performance is a feature requirement; runtime modules never import editor modules; presentation
state never mutates authored level or profile data.
