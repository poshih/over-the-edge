# Feature request: swap a character's avatar, hammer and pot individually, as the game's backend decides

**Date:** 2026-09-28 · **Baseline:** `95b9551` · **Status:** requested, not started. Builds on
[authenticated content delivery](FEATURE-REQUEST-authenticated-content-delivery.md).

Games want to change what the player's character looks like while playing: a different body, hammer or pot, each
swapped on its own, without rebuilding the release or reloading the level. Some models are sold separately, and a
player can modify anything that runs in their browser, so the game's backend decides which model each part uses. The
release asks the backend, shows its answer and loads only the models that answer selects. Nothing in the browser
decides or remembers a selection.

## What exists today (source-audited at `95b9551`)

- A release carries one or two whole character profiles (primary and optional alternate). `Game.selectCharacter()`
  and the CHARACTER control switch between them mid-level, and the control remembers the choice in `localStorage`.
- No build carries a model to swap to: a profile may list only the models its avatar, hammer and pot use, and project
  media are video and audio only.
- Changing one model means loading a whole new primary profile with `Game.loadSprites()`, which rebuilds the
  character's sprite state; a second load while one is in progress throws instead of replacing it. The alternate
  profile cannot be reloaded at all.
- Models never affect play: colliders, masses, reach and contacts are the same with every model
  ([imported 3D characters](docs/characters.md)).

## Scope boundary (owner direction, 2026-09-28)

**The engine handles game and editor work only. It swaps assets.** It has no concept of any of the following:
- cosmetics, skins or loadouts;
- unlocks, ownership or entitlements;
- purchases, prices, currencies or stores;
- which model a player prefers.

All of that belongs to the downstream game's backend, which decides which library model each part uses. The release
only asks the backend and carries out its answers. The CHARACTER switch between the release's own two profiles is
unchanged: both profiles are game content that every player of the release receives.

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

**Delivery:** a game build puts each library model in its own content group, for example `library/<role>/<id>`, so
the game's backend grants each one apart from the rest of the game. The release's manifest lists each entry's role,
id, avatar settings and file.

Suggested entries (upstream's design call):

```jsonc
"models": {
  "avatar": [{ "id": "hero-hooded", "name": "Hooded hero", "boneMap": { "body": "Hips", "...": "..." },
               "armForwardDistance": 0.25, "grips": { "...": "..." }, "arms": null }],
  "hammer": [{ "id": "mallet", "name": "Mallet" }],
  "pot":    [{ "id": "urn", "name": "Urn" }]
}
```

### 2. The backend decides

- **The selection is backend state.** For each part (the avatar, the hammer and the pot), the backend stores which
  library entry the player uses, or none for the profile's own model. It applies its own rules, such as entitlements,
  whenever it changes the selection. The release keeps only the backend's latest answer, in memory.
- **One seam.** The content access adapter (content delivery §2) gains `select`, which returns the backend's
  selection: as stored, or after asking the backend to change one part. The engine applies only selections that
  `select` returns, and the module's API cannot apply one itself.
- **Requests, not decisions.** A swap asks the backend to use an entry, or the profile's own model, for one part. The
  backend may refuse, with `unauthenticated`, `denied` or `unavailable`, or answer with a different selection; the
  release shows the answer.
- **In order.** The engine makes one `select` call at a time and applies each answer in order, so the backend
  receives requests in the order they were made.
- **Files for the selection only.** The engine asks for a library entry's group only while the backend's latest
  answer selects it, and fetches its file once per load, never in advance. The adapter can answer that grant from the
  backend's `select` response, so a swap costs one backend round trip.
- **Nothing kept in the browser.** The release reads no selection from browser storage and writes none to it, and
  library models stay in memory only. A reload shows the backend's stored selection.
- **Without a backend.** A release whose adapter has no `select`, including one using public access, has no model
  selection: every part uses the profile's own model, swaps reject with `unavailable`, and no library model loads.

Suggested adapter extension (upstream's design call):

```ts
interface ContentAccess {
  // grant() as in content delivery. select() returns the backend's answer unchanged.
  select(request: { role: 'avatar' | 'hammer' | 'pot'; id: string | null } | null, signal: AbortSignal):
    Promise<{ avatar: string | null; hammer: string | null; pot: string | null }>;  // null request: read only
}
```

### 3. Runtime swap, each part on its own

The avatar, the hammer and the pot are separate parts, each a `role` in the API. Each swaps on its own, and any
combination of library entries and the profile's own models is valid.

- **One part at a time.** Swapping one part never refetches, reloads or changes the other two.
- **No reload, mid-level.** Physics, the timer, the level, and the pot and hammer frames continue. Only that part's
  model is detached and the new one attached, as the CHARACTER switch does today.
- **An avatar swap applies at once.** Its bone map and settings take effect immediately: IK, grips and head gaze drive
  the new model.
- **Bounded memory.** A replaced model is disposed, or kept in a bounded in-memory cache (upstream's choice), so
  memory is bounded by what is in use. A cached model shows again only when a backend answer selects it.
- **Shading follows.** The active character's shading (PBR, or cel with outline) applies to the new model at once, as
  it does to the profile's own models.
- **Asynchronous and typed:**
  - a swap resolves with the selection in use once the backend's answer is visible;
  - a refusal, a failed fetch or a failed check rejects with a typed error and leaves that part's model in place;
  - a newer swap of the same part supersedes an older one not yet sent, which rejects as superseded; one already
    sent still completes, since the backend may have stored it.
- **Per-frame cost is unchanged:** bone and matrix updates for the active models only.
- **Character types:** the avatar part applies to whichever `avatar-3d` profile is active; the hammer and pot parts
  apply to every character type, as hammer and pot models do today.
- **Across characters:** the selection is the player's, not a profile's. Switching characters keeps it, stays instant
  and fetches nothing.

Suggested API (upstream's design call; named apart from the existing `characterModels` loader option). The game's
module receives it with the game API ([content delivery §4](FEATURE-REQUEST-authenticated-content-delivery.md)):

```ts
api.modelLibrary.available(role);       // library ids this release lists for 'avatar' | 'hammer' | 'pot'
api.modelLibrary.active(role);          // the id in use, or null for the profile's own model
await api.modelLibrary.swap(role, id);  // asks the backend; a null id asks for the profile's own model
await api.modelLibrary.refresh();       // re-reads the backend's selection, for example after it changed there
```

### 4. Start with the backend's selection

Before content loads, the engine reads the backend's selection alongside the `game` group's grant, so it adds no
round trip. The selected library models load with the game content and a profile model they replace is never fetched,
so the first frame shows the backend's selection. If the backend refuses or a model fails, that part starts with the
profile's own model, the module receives the typed error, and play still starts.

### 5. Workshop

- The Project and Character tabs list, import, validate and remove library models for each part, and edit an avatar
  entry's bone map and settings.
- They preview any combination live on the loaded character, with the same checks as releases, reading library models
  from the open project. The Workshop is an authoring tool without a backend, and its preview never reaches a release.
- Editor modules stay out of releases.

## Threat model

- **The backend is the authority.** The release, the engine and the game's module all run on the player's machine,
  where the player can change them. So the backend makes and stores every decision, and enforces it where the player
  cannot reach: it grants an entry's file only while the player's stored selection names that entry, and the CDN
  serves only granted files.
- **A modified client cannot** download a library model the backend has not granted it, change the stored selection
  except through requests the backend accepts, or gain anything in play, since models never affect physics.
- **A modified client can** change what its own screen shows, but only with model files it already holds. A file an
  entitled player extracts and shares is beyond what any browser game can stop; the engine does no DRM.
- **What others see comes from the backend.** Anything other players or services show of a player's selection is read
  from the backend's stored selection, never reported by the client.
- **The adapter must relay.** The engine cannot tell whether `select` returned the backend's answer; a game whose
  adapter decides in the browser gives up these guarantees.

## Acceptance

- **No library, no change:** a project with an empty model library builds and plays exactly as today.
- **Each part on its own:** with two avatars, two hammers and two pots in the library, a test backend that stores
  selections and signs URLs for a local CDN stand-in, and a test module that relays the player's swaps:
  - each part swaps mid-level on its own, and every combination of entries and profile models shows each part's
    selected model;
  - swapping one part fetches and reloads nothing for the other two;
  - physics, the timer and the level continue, and nothing reloads;
  - the grips follow the new avatar's settings;
  - returning a part to the profile's own model restores that model and, for the avatar, the profile's settings.
- **The backend decides:**
  - when the backend refuses a swap or answers with another selection, the release shows its answer, and a refusal
    reaches the caller as a typed error;
  - the module's API has no way to apply a selection that `select` did not return;
  - the release asks for no library group the backend's latest answer does not select;
  - with a slow test backend, swaps made in quick succession reach it one at a time and in order, and the release ends
    showing the backend's stored selection;
  - after swaps, browser storage holds no selection and no library model, and a reload shows the backend's stored
    selection;
  - with an adapter that has no `select`, no library model loads and swaps reject with `unavailable`.
- **Loading and memory:**
  - playing without a swap asks for no library group beyond the backend's starting selection;
  - a swap to a model not in memory fetches its file once, and a swap to a cached model fetches nothing;
  - after swapping back and forth, memory returns to its steady state.
- **Starting selection:** the backend's selection appears on the first frame; a refused or failed starting part uses
  the profile's own model and reports the error to the module.
- **Across characters:** after a swap, the CHARACTER switch keeps the selection, stays instant and fetches nothing.
- **Invalid models and answers:**
  - an invalid library model fails project validation, the build and the Workshop import, with the entry named;
  - a failing runtime load keeps the previous model and rejects with a typed error;
  - an answer selecting an id this release does not list for that part leaves the part unchanged and reports a typed
    error.
- **Shading and cost:** cel shading and outlines follow swapped models, and per-frame cost depends only on the active
  models, including on a representative large level.
- **Boundary:** no engine module has a cosmetic, unlock, ownership, purchase or store concept, and the engine decides
  and stores no model selection.

## Constraints (from `AGENTS.md`)

- **Performance** is a feature requirement.
- **Separation:** runtime modules never import editor modules.
- **Authored data:** presentation state never mutates authored level or profile data.
- **Design:** the cleanest design, with no backward-compatibility shims.

## Context

A downstream game sells avatars, hammers and pots separately through its platform. Its backend knows what each player
owns, stores which model each part uses and grants files only for those. Its module shows the game's own UI in the
release's interface element and relays the player's requests to that backend. Even with a modified client, a player
must not be able to download a model they have not bought or change what the backend stores. None of the selling,
ownership or UI belongs in the engine. Its models follow the engine's documented conventions. Stricter content rules it
sets itself, such as pot models that match the collision outline, are its own authoring policy, not engine checks.
