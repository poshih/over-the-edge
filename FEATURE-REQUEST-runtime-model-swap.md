# Feature request: swap a character's avatar, hammer and pot models at runtime

**Date:** 2026-09-28 · **Baseline:** `95b9551` · **Status:** requested, not started. Builds on
[authenticated content delivery](FEATURE-REQUEST-authenticated-content-delivery.md).

Games want to change what the player's character looks like while playing: a different body, hammer or pot, each
chosen on its own, without rebuilding the release or reloading the level. Some models are sold separately, so a
library model loads only when the game asks for it, and only through access the game's backend grants for that model.

## What exists today (source-audited at `95b9551`)

- A release carries one or two whole character profiles (primary and optional alternate). `Game.selectCharacter()`
  and the CHARACTER control switch between them mid-level.
- No build carries a model to swap to: a profile may list only the models its avatar, hammer and pot use, and project
  media are video and audio only.
- Changing one model means loading a whole new primary profile with `Game.loadSprites()`, which rebuilds the
  character's sprite state; a second load while one is in progress throws instead of replacing it. The alternate
  profile cannot be reloaded at all.

## Scope boundary (owner direction, 2026-09-28)

**The engine handles game and editor work only. It swaps assets.** It has no concept of any of the following:
- cosmetics, skins or loadouts;
- unlocks, ownership or entitlements;
- purchases, prices, currencies or stores;
- which model a player prefers.

All of that is the downstream game's own code and backend. They decide who may load which model and when to swap, and
call the API below. The engine loads a library model only when that API is called, only through the game's content
access, and never otherwise.

## Requested capability

### 1. A model library in the project

A project may list extra avatar, hammer and pot models that a release can swap to. Only `GAME_PROJECT` releases have a
library; the per-file inputs are unchanged.

**Entries:**
- Each has a stable id with the project ID rules (lowercase letters, digits and inner hyphens).
- **An avatar entry** carries everything that depends on the avatar model:
  - its bone map;
  - the presentation settings sized by its proportions (grips, arm lengths, arm forward distance);
  - once avatar hair chains ship ([FEATURE-REQUEST-avatar-hair-chains.md](FEATURE-REQUEST-avatar-hair-chains.md)),
    its hair chains and colliders.
- **Hammer and pot entries** are models only. The physical rig never changes.

**Validation:** library models pass the same checks as character models on project validation, Workshop import and
build: `MODEL_LIMITS` and the typed character-model checks, a skin and a bone map for avatars, and the documented
hammer and pot conventions. An invalid entry fails with its role and id named.

**Storage:** as with `appearance/<part>.glb`, each GLB sits at a fixed path named by its role and id
(`models/<role>/<id>.glb`), so the manifest only lists entries. Project files, bundles and the project server's section
API and guide (`GET /api`) carry the library like the other sections.

Suggested entries (upstream's design call):

```jsonc
"models": {
  "avatar": [{ "id": "hero-hooded", "name": "Hooded hero", "boneMap": { "body": "Hips", "...": "..." },
               "armForwardDistance": 0.25, "grips": { "...": "..." }, "arms": null }],
  "hammer": [{ "id": "mallet", "name": "Mallet" }],
  "pot":    [{ "id": "urn", "name": "Urn" }]
}
```

### 2. Loading only on request

- **One content group per entry.** A game build puts each library model in its own content group, for example
  `library/<role>/<id>`, so the game's backend grants it apart from the rest of the game. The release's manifest lists
  each entry's role, id, avatar settings and file.
- **Only on the API call.** The release asks for an entry's group and fetches its file only for a swap (§3) or the
  starting selection (§4), once per load. It never prefetches, and never retries or fetches another way on its own.
- **Refusals are typed.** A refusal from the game's content access, a failed fetch or a failed check rejects the load
  with a typed error.
- **Memory only.** A library model stays in memory while in use, or in the bounded cache (§3); like all content, it is
  never written to browser storage.

### 3. Runtime swap, per role and independent

Swap the active character's avatar, hammer or pot model by library id, or return a role to the profile's own model.
With the starting selection (§4), this call is the only way a library model loads.

- **No reload, mid-level.** Physics, the timer, the level, and the pot and hammer frames continue. Only that model is
  detached and the new one attached, as the CHARACTER switch does today.
- **An avatar swap applies at once.** Its bone map and settings take effect immediately: IK, grips and head gaze drive
  the new model.
- **Bounded memory.** A replaced model is disposed, or kept in a bounded in-memory cache (upstream's choice), so
  memory is bounded by what is in use.
- **Shading follows.** The active character's shading (PBR, or cel with outline) applies to the new model at once, as
  it does to the profile's own models.
- **Asynchronous and typed:**
  - the swap resolves when the new model is visible;
  - refused access, a failed fetch or a failed check rejects with a typed error and leaves the previous model in
    place;
  - a newer swap of the same role cancels an older one still loading.
- **Per-frame cost is unchanged:** bone and matrix updates for the active models only.
- **Character types:** the avatar role is for `avatar-3d` characters; hammer and pot swaps apply to every character
  type, as hammer and pot models do today.
- **Two profiles:** whether a selection belongs to each profile or to the release, and so survives the CHARACTER
  switch, is upstream's call. Either way the switch stays instant and never waits for a fetch.

Suggested API (upstream's design call; named apart from the existing `characterModels` loader option). The game's
module receives it with the game API ([content delivery §4](FEATURE-REQUEST-authenticated-content-delivery.md)):

```ts
api.modelLibrary.available(role);                   // library ids for 'avatar' | 'hammer' | 'pot'
api.modelLibrary.active(role);                      // the id in use, or null for the profile's own model
await api.modelLibrary.swap(role, id, { signal });  // null returns the role to the profile's own model
```

### 4. Start with a selection

The game's module names the starting avatar, hammer and pot before content loads, so a restored choice never shows the
default first and a profile model it replaces is never fetched. Its library models load through the game's content
access, like a swap, before play starts. If access is refused or a load fails, that role starts with the profile's own
model, the module receives the typed error, and play still starts.

### 5. Workshop

- The Project and Character tabs list, import, validate and remove library models for each role, and edit an avatar
  entry's bone map and settings.
- They preview any combination live on the loaded character, with the same checks as releases, reading library models
  from the open project.
- Editor modules stay out of releases.

## Acceptance

- **No library, no change:** a project with an empty model library builds and plays exactly as today.
- **Independent swaps:** with two avatars, two hammers and two pots in the library, a test module whose adapter grants
  each entry's group separately swaps each role mid-level.
  - Only that model changes; physics, the timer and the level continue, and nothing reloads.
  - The grips follow the new avatar's settings.
  - Returning a role to the profile's own model restores that model and, for the avatar, the profile's settings.
- **Only on the API call:**
  - playing without a swap or starting selection asks for no library group and fetches no library file;
  - a swap to a model not already in memory asks for its group once and fetches its file once;
  - after swapping back and forth, memory returns to its steady state.
- **Separate access:** a module that grants the game but refuses one entry plays normally; swapping to that entry
  rejects with the typed refusal and keeps the previous model.
- **Starting selection:** it appears on the first frame; a refused starting entry starts that role with the profile's
  own model and reports the error to the module.
- **Two profiles:** after a swap, the CHARACTER switch follows the chosen rule, stays instant and fetches nothing.
- **Invalid models:**
  - an invalid library model fails project validation, the build and the Workshop import, with the entry named;
  - a failing runtime load keeps the previous model and rejects with a typed error.
- **Shading and cost:** cel shading and outlines follow swapped models, and per-frame cost depends only on the active
  models, including on a representative large level.
- **Boundary:** no engine module has a cosmetic, unlock, ownership, purchase or store concept, and the engine stores no
  model selection.

## Constraints (from `AGENTS.md`)

- **Performance** is a feature requirement.
- **Separation:** runtime modules never import editor modules.
- **Authored data:** presentation state never mutates authored level or profile data.
- **Design:** the cleanest design, with no backward-compatibility shims.

## Context

A downstream game sells avatars, hammers and pots as separate choices through its platform. Its backend grants each
player the models they own, and its module shows its own UI in the release's interface element, remembers the
player's choice and calls `swap`. A player who has not bought a model must not be able to download it. None of the
selling, ownership or UI belongs in the engine. Its models follow the engine's documented conventions. Stricter
content rules it sets itself, such as pot models that match the collision outline, are its own authoring policy, not
engine checks.
