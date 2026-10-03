# Feature request: game-registered secondary motion for imported skinned avatars

**Date:** 2026-10-03 · **Baseline:** `d87ee73` · **Status:** requested; nothing is implemented. A downstream game waits
for this instead of patching the engine.

Follow-up to [imported skinned characters](FEATURE-REQUEST-skinned-character.md),
[spring-bone hair chains](FEATURE-REQUEST-avatar-hair-chains.md) and the avatar-rig SDK (`src/avatar-rig.ts`,
`build/avatar-rig-module.ts`). A game wants its own secondary motion on its imported avatars, such as soft parts,
tails, ears, flaps or dangling accessories, and wants to keep that code in its own repository. Today it can only do
that by editing engine modules, and every engine sync then conflicts with those edits:

- The profile, avatar-settings and model-library validators accept exactly `model`, `boneMap`, `driver` and `hair`
  (`src/character-profile.ts`, `src/model-library.ts`), so a profile cannot carry another motion's data.
- `SkinnedAvatarView` runs only the built-in hair after it poses the mapped joints (`src/skinned-avatar-view.ts`).
- The Workshop, releases and offline tools know only hair.

The avatar-rig SDK already solved this for rig drivers. A game names one render-only module (`AVATAR_RIG_MODULE`).
The editor's and the release build's Vite configs load it in Node for their validators and serve it to the browser
as `virtual:avatar-rigs`; offline tools import it directly. A profile names a strategy by id, with an opaque `config`
that the strategy validates. This request asks for the same contract for secondary motion. With it, a game adds,
changes or removes a motion without editing any engine file.

## Stage A: runtime, data and checks

- **SDK:** a public module beside `src/avatar-rig.ts` defines the motion-kind interface, its API version and a typed
  refusal error. Like `AvatarRigError`, the error keeps a portable tag across Vite's module runner. Frames use the
  engine's matrix type, as the rig SDK's poses do.
- **Registration:** the game's render-only module exports motion kinds beside its rig strategies, under a bumped API
  version. The registry it produces carries both. Loading works as it does for rig strategies:
  - the same trusted-module rules and the same startup snapshot;
  - the same typed refusals for a duplicate or unknown id, a wrong API version, an invalid kind or an invalid config.

  Without a module, only built-in kinds exist.
- **Profile data:** `avatar.motion` lists motion entries, each `{ "id": "<kind>", "config": { … } }`, at most one per
  kind. The engine states its limits as it does for hair, allowing at least 16 claimed joints per avatar, and bounds
  the config's size as it bounds a driver's.
  - The engine never interprets `config`. It hands the config to the kind, which validates it against the model.
  - An entry naming a kind the registry lacks is a typed refusal; it is never skipped.
  - `[]` costs nothing.
- **Data paths:** `motion` travels unchanged wherever hair travels today:
  - profiles (`parseSpriteDocument`) and server avatar settings files (`validateAvatarModelSettings`);
  - model-library entries (`libraryAvatarSettings`, `validateModelLibrary`) and runtime swaps;
  - Save, Revert and JSON export;
  - releases with one or two characters, validated at build time.
- **Checks:** every public check that takes the rig registry today also checks motion entries with it:
  `checkCharacterModels`, `checkModelLibrary`, `checkLibraryModel`, the Workshop's project session, and the editor's
  and the release build's validators. Offline tools that already pass the registry then need no new wiring.
- **Binding to the model:** when an avatar loads, each kind gets read-only facts about the model:
  - every skin joint's name and parent;
  - each joint's bind frame in the fitted avatar space, in metres;
  - which joints the bone map drives;
  - which joints hair simulates.

  The kind claims the unmapped skin joints it will move. The engine refuses each of these with a
  `CharacterModelError` code:
  - a claimed joint that the bone map drives;
  - a joint that two motions claim, or that a motion and hair both use;
  - a claimed joint that carries, or hangs below, a mapped joint, a hair joint or another motion's joint.

  Claims are therefore disjoint and never nest, so the order in which motions run cannot change a result.
- **Each frame**, after the mapped joints are posed (driver, head gaze, waist lean), the engine gives each motion:
  - **The clock:** *reset* (start from rest, no steps) or a number of fixed 1/60 s steps to advance. It resets and
    steps exactly when hair does: frozen while time stands still, at most 15 catch-up steps, and a reset on a rewind,
    a restart, a new avatar, a gap longer than the catch-up limit, or a view that was not simulated for a while. No
    game code measures time.
  - **Placement:** where avatar space sits in the world (`body`, including the waist lean) and the pot's frame
    (`pot`), as hair gets them.
  - **The skeleton:** the mapped joints' frames at bind and now, in avatar space.
  - **Rest frames:** each claimed joint's frame for this frame if it followed its mapped ancestor rigidly, as unmapped
    joints do today.

  The motion writes each claimed joint's frame, in avatar space, into storage the engine provides. The engine turns
  those frames into local bone matrices, and joints below a claimed joint follow it rigidly. A motion cannot write
  any other joint.
- **The view:** `SkinnedAvatarView` is the one place motions run. Its public constructor, which offline tools call
  directly today with resolved hair, also takes the avatar's prepared motions. Its `apply` runs them with the time it
  gives hair, so offline tools that render stills get the same motion as the game.
- **One path:** the built-in hair chains are the first built-in kind and run through the same interface, behaving
  exactly as today. Whether `avatar.hair` stays its own field or becomes a `motion` entry is upstream's choice.
- **Presentation only:** a motion never drives IK, gameplay or physics, never touches the scene graph, and never
  changes authored level or profile data.
- **Errors:** an error a kind throws for its config surfaces with the kind's id and the kind's own code, never as a
  message to match. The Workshop shows it as it shows model errors.
- **Diagnostics:** the rendering report counts each motion's claimed joints and writes, as it counts hair chains.

Illustrative shapes. The names are upstream's choice, but each field is a need:

```ts
interface AvatarMotionKind {
  readonly id: string;
  // Validates config against the model and claims joints; throws the SDK's typed refusal.
  prepare(config: RigJson, model: AvatarMotionModel): AvatarMotion;
}
interface AvatarMotionModel {
  readonly joints: readonly { readonly name: string; readonly parent: number | null; readonly bind: Readonly<Matrix4> }[];
  readonly mapped: Readonly<Record<AvatarJointId, number>>;
  readonly hair: ReadonlySet<number>;
}
interface AvatarMotion {
  readonly claims: readonly number[];
  update(frame: AvatarMotionFrame): void; // allocation-free
}
interface AvatarMotionFrame {
  readonly reset: boolean;
  readonly steps: number;       // 0 when reset; at most 15
  readonly stepSeconds: number; // 1/60
  readonly body: Readonly<Matrix4>;
  readonly pot: Readonly<Matrix4>;
  readonly mapped: { readonly bind: Readonly<Record<AvatarJointId, Matrix4>>; readonly current: Readonly<Record<AvatarJointId, Matrix4>> };
  readonly rest: readonly Readonly<Matrix4>[]; // one per claim, this frame
  readonly out: readonly Matrix4[];            // one per claim, written by the motion
}
```

## Stage B: Workshop controls

- **Descriptors:** a kind may describe its tunable numbers as data in an editor-only part of the game module. Each
  number has a label, a unit, a range, a step and a path in the config. A descriptor may repeat over a list in the
  config: one group per item, titled by a field of the item.
- **Character tab:** Workshop → Character lists the avatar's motions and renders their controls with a reset. A change
  re-validates through the kind and goes through Save and Revert.
- **Preview:** the live preview runs every motion and can sway and jolt the avatar, so a setting can be judged without
  playing.
- **Separation:** the Workshop runs no game DOM code, and releases contain no editor code.

## Acceptance

Stage A:

- A sample kind kept outside `src/` is registered through the game module and moves one extra joint on the
  verification's humanoid. It survives every data path above, and a release built with it contains no editor code.
- The sample is added, changed and removed without editing any engine file.
- Without the module, a profile naming the kind fails to load with a typed error. The character verification covers
  every refusal under Binding to the model.
- With the sample:
  - no steps arrive while time stands still;
  - a rewind, a restart, a new avatar and a long gap each reset it;
  - a slow frame brings at most 15 steps;
  - its joint ends exactly at the frame it wrote, and the joints below it follow.
- An offline tool constructs `SkinnedAvatarView` with the sample and gets the same frames as the game for the same
  inputs.
- Hair behaves exactly as before through the shared interface. Profiles without `motion` cost nothing extra.
- Per-frame engine overhead is bounded by the motions' claimed joints and does not depend on the level. The engine
  allocates nothing per frame on a motion's behalf.

Stage B:

- The sample's descriptors, including one that repeats over a list, render as controls.
- The controls survive Save and Revert, and the preview's sway and jolt move the sample's joint.

## Out of scope

- Any particular motion besides hair.
- Access for a motion to physics, gameplay or the scene graph.
- Sprite skeletons.

## Constraints (from `AGENTS.md`)

- Performance is a feature requirement.
- Runtime modules never import editor modules.
- Presentation state never mutates authored level or profile data.
- No backward-compatibility shims; schema and API-version bumps are fine.
