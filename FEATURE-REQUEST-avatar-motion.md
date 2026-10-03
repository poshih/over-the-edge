# Feature request: game-registered secondary motion for imported skinned avatars

**Date:** 2026-10-03 · **Baseline:** `3b9d05c` · **Status:** requested; nothing is implemented.

Follow-up to [imported skinned characters](FEATURE-REQUEST-skinned-character.md),
[spring-bone hair chains](FEATURE-REQUEST-avatar-hair-chains.md) and the avatar-rig SDK (`src/avatar-rig.ts`,
`build/avatar-rig-module.ts`). A game wants its own secondary motion on its imported avatars, such as soft parts,
tails, ears, flaps or dangling accessories, and wants to keep that code in its own repository. Today it can only do
that by editing engine modules, and every engine sync then conflicts with those edits:

- The profile, avatar-settings and model-library validators accept exactly `model`, `boneMap`, `driver` and `hair`
  (`src/character-profile.ts`, `src/model-library.ts`), so a profile cannot carry another motion's data.
- `SkinnedAvatarView` runs only the built-in hair after it poses the mapped joints (`src/skinned-avatar-view.ts`).
- The Workshop, releases and offline tools know only hair.

The avatar-rig SDK already solved this for rig drivers. A game names one render-only module (`AVATAR_RIG_MODULE`),
which the game shell, the Workshop, the Node validators and offline tools all load the same way. A profile names a
strategy by id, with an opaque `config` that the strategy validates. This request asks for the same contract for
secondary motion.

## Requested capability

- **Registration:** the game's render-only module (`AVATAR_RIG_MODULE`, served as `virtual:avatar-rigs`) also exports
  motion kinds beside its rig strategies, under a bumped API version. A kind has an id and prepares itself for one
  avatar from its config. Loading works as it does for rig strategies: the same trusted-module rules, the same
  startup snapshot, and the same typed refusals for a duplicate or unknown id, a wrong API version, an invalid kind
  or an invalid config. Without a module, only built-in kinds exist.
- **Profile data:** `avatar.motion` lists motion entries, each `{ "id": "<kind>", "config": { … } }`, at most one per
  kind, run in the listed order.
  - The engine never interprets `config`. It hands the config to the kind, which validates it against the model.
  - The engine carries `config` unchanged wherever hair goes today: profiles and server avatar settings files,
    model-library entries and runtime swaps, Save, Revert and JSON export, and releases, validated at build time.
  - An entry naming a kind the registry lacks is a typed refusal; it is never skipped.
  - `[]` costs nothing.
- **Binding to the model:** when an avatar loads, each kind gets read-only facts about the model:
  - the skin joints' names and parents;
  - each joint's bind frame in the fitted avatar space;
  - the bone map's joints;
  - the joints that hair simulates.

  The kind claims the unmapped skin joints it will move. The engine refuses each of these with a
  `CharacterModelError` code:
  - a claimed joint that the bone map drives;
  - a joint that two motions claim, or that a motion and hair both use;
  - a claimed joint that carries a mapped joint, a hair joint or another motion's joint.
- **Each frame**, after the mapped joints are posed (driver, head gaze, waist lean) and in the profile's order, the
  engine calls each motion with:
  - the clock: either *reset* (start from rest) or a number of fixed 1/60 s steps to advance. The engine decides
    which by hair's rules: frozen while time stands still, at most 15 catch-up steps, a reset on a rewind, a restart,
    a long gap or a new avatar. No game code measures time.
  - where avatar space sits in the world (`body`) and the pot's frame (`pot`), as hair gets them;
  - the mapped joints' frames at bind and now, in avatar space;
  - each claimed joint's rest frame for this frame: where the joint would be if it followed its mapped ancestor
    rigidly, as unmapped joints do today.

  The motion writes each claimed joint's frame, in avatar space, into storage the engine provides. The engine turns
  those frames into local bone matrices, and joints below a claimed joint follow it rigidly. A motion cannot write
  any other joint.
- **Presentation only:** a motion never drives IK, gameplay or physics and never changes authored level or profile
  data.
- **One path:** the built-in hair chains are the first built-in kind and run through the same interface, behaving
  exactly as today. Whether `avatar.hair` stays its own field or becomes a `motion` entry is upstream's choice.
- **Errors:** a kind's refusal is typed. An error the kind throws for its config surfaces with the kind's id and the
  kind's own code, never as a message to match. It survives Vite's module runner the way rig-strategy refusals do.
- **Offline tools:** tools that pose an avatar through the engine's skinned-avatar view pass the motion registry the
  way they pass the rig registry, and get the same motion.
- **Editor (a later stage):** a kind may describe its tunable numbers as data in an editor-only part of the module:
  label, unit, range, step and path in its config. Workshop → Character renders those controls, re-validates
  through the kind and previews live. The Workshop runs no game DOM code, and releases contain no editor code.
- **Diagnostics:** the rendering report counts each motion's claimed joints and writes, as it counts hair chains.

## Acceptance

- A sample kind kept outside `src/` is registered through the module and moves one extra joint on the
  verification's humanoid each frame. It survives every data path listed under Profile data, and its release
  contains no editor code.
- A game adds, changes or removes a kind without editing any engine file.
- Without the module, a profile naming the kind fails to load with a typed error.
- The character verification covers every refusal under Binding to the model.
- Hair behaves exactly as before through the shared interface. Profiles without `motion` cost nothing extra.
- Per-frame engine overhead is bounded by the motions' claimed joints and does not depend on the level. The engine
  allocates nothing per frame on a motion's behalf.

## Out of scope

- Any particular motion besides hair.
- Access for a motion to physics, gameplay or the scene graph.
- Sprite skeletons.

## Constraints (from `AGENTS.md`)

- Performance is a feature requirement.
- Runtime modules never import editor modules.
- Presentation state never mutates authored level or profile data.
- No backward-compatibility shims; schema and API-version bumps are fine.
