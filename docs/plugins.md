# Plugins

A downstream game adds its own code to the engine with **plugins**. A plugin is one feature of
the game, such as its HUD, its store or its custom avatars, with an ID of its own. It has up to
four **facets**, one module for each place its code runs: `kinds`, `runtime`, `release` and
`workshop`. A facet contributes to the engine's **points**: typed extension points, each declared
by the engine module whose contract it is, with the engine's own implementation as its default.
A plugin replaces, wraps or adds to them piece by piece, so a game swaps the health readout
without redrawing the rest of the HUD.

A game lists its plugins in one JSON **manifest**, which `GAME_PLUGINS` names. Plugins are build
inputs, the game's own trusted code, never project data.

## The manifest

```json
{
  "apiVersion": 2,
  "plugins": [
    { "id": "my-game", "kinds": "./kinds.ts", "runtime": "./runtime.ts", "release": "./release.ts", "workshop": "./workshop.ts" }
  ]
}
```

Set `GAME_PLUGINS` to the manifest's path, from the repository's root, for every command that
should use the plugins:

```sh
GAME_PLUGINS=games/my-game/plugins.json npm run dev                                       # the Workshop and project server
GAME_PLUGINS=games/my-game/plugins.json GAME_PROJECT=projects/my-game npm run dev:game    # a release, in development
GAME_PLUGINS=games/my-game/plugins.json GAME_PROJECT=projects/my-game npm run build:game  # a release
GAME_PLUGINS=games/my-game/plugins.json GAME_PROJECT=projects/my-game npm run build       # a Workshop for the game
```

`npm run studio` takes it too, and the project server's **Publish** then builds
[studio previews](#studio-previews) with it.

| Field | Rule |
| --- | --- |
| `apiVersion` | `2` (`PLUGIN_API_VERSION`) |
| `plugins` | 1-32 plugins (`PLUGIN_LIMITS.plugins`), in composition order: see [order and conflicts](#order-and-conflicts) |
| `id` | 1-64 lowercase letters, digits and hyphens, starting with a letter. IDs are unique, and `engine` is reserved |
| `kinds`, `runtime`, `release`, `workshop` | The plugin's facets, at least one: each a path relative to the manifest, naming a `.ts`, `.mts`, `.js` or `.mjs` file inside the repository |

- The manifest is a `.json` file inside the repository. Neither it nor a facet may lie outside
  it: paths are checked as real paths, so a symbolic link cannot reach out.
- Nothing else may appear, at either level, and no file may be named twice, by one plugin or two.
- A manifest that breaks a rule stops the command with a [`PluginError`](#errors) naming the
  manifest and the plugin: `invalid-manifest`, `api-version`, `invalid-plugin`, `duplicate-plugin`
  or `reserved-plugin`.
- Editing the manifest restarts the dev server.
- Without `GAME_PLUGINS` a game has no plugins: the engine's defaults everywhere, the built-in
  kinds alone and no library models packaged.

Breaking public contract changes bump `PLUGIN_API_VERSION`; manifests must name the current
version, without legacy readers or aliases. Version 2 breaks version-1 contracts:

- Renames `game.events` to filtered `game.observers`: `EVENTS` → `OBSERVERS`,
  `GameEvent` → `Moment`, and `GameObserver.event()` → `moment()`, through the stamped
  gameplay-moment journal.
- Removes `scene.hurt-effects` for `effects.strikes` / `effects.lava` / `effects.extras`;
  `HURT_EFFECTS` / `DEFAULT_HURT_EFFECTS` → `EFFECTS` / `DEFAULT_EFFECTS`, and
  `HurtEffects` / `HurtEffectsFactory` → `MomentEffect` / `MomentEffectFactory`.
- Renames `scene.death-animation` to `scene.death-pose`:
  `DEATH_ANIMATION` / `DEFAULT_DEATH_ANIMATION` → `DEATH_POSE` / `DEFAULT_DEATH_POSE`;
  `DeathAnimationInput` / `DeathAnimationPose` / `DeathAnimationWriter` →
  `DeathPoseInput` / `DeathAppearance` / `DeathPoseWriter`. Input drops `direction` and carries
  captured live pose, interpolated physical corpse and entry `headFacing`; the writer fills
  full `DeathAppearance` (`torso`, `head`, `arms`, `headFacing`, `spriteBrightness`), not
  `torsoLean` / `headPitch` offsets.
- `DeathFrame.duration` now uses the game settings' `death.wait`; `HudSettings['death'].hold`
  is removed, affecting `DeathScreen.show(info, settings)` and Workshop `hud()` edits.
- Enforces synchronous runtime contracts; platform looks receive only changed-pose deltas.
  Projectile/enemy look arrays and poses are now pooled and borrowed. `SceneFrame` replaces
  `parts` / `rig` with as-drawn `character` / `hammer`, without physics internals.
  Runtime and Workshop SDKs drop `PartPose` / `RigGeometry`; Workshop `game.state()` is an
  explicit typed plain-data contract.
- Removes `GameCue` and `GameAudio.handle(cue)`; audio now uses `moment()` / `preview()`,
  and `AUDIO_CUES` / `AudioCue` gains `block`.
- `AvatarRigFrameContext` and `AvatarRigPoseContext` drop `deathWeight`: frame context is
  live-only; pose context has `attachment: 'gripped' | 'released'`. `AvatarMotionFrame.reset`
  no longer fires because time steps backward; Workshop presentation previews now end early
  on placement rather than rewind.
- `BlockMoment.trap` is now `id`, the trap or hollow archer that fired the blocked projectile,
  and `ProjectilePose` gains `kind`, `'bolt'` or `'arrow'`.
- The course has one look, so the Workshop SDK drops `ArtMode` and `edits.artMode()`, and
  `ProjectArt` drops `mode`.

A plugin's identity comes from the manifest alone, and facet modules never repeat it. Each host
tells its facet the ID, as `host.plugin`. The ID names the plugin in errors, keys its Workshop
data in the project and is the namespace of the items it adds, so renaming a plugin changes them.

## Facets and environments

| Facet | Runs in | SDK | For | Virtual module |
| --- | --- | --- | --- | --- |
| `kinds` | Node, as the dev server, the project server and builds start; and every page: the Workshop, studio previews and releases | [`src/plugins/kinds-sdk.ts`](../src/plugins/kinds-sdk.ts) | Code that content selects by ID: avatar rig strategies and motion kinds. See [kinds plugins](kinds-plugins.md) | `virtual:game-plugins/kinds` |
| `runtime` | Workshop play-tests, studio previews and releases | [`src/plugins/runtime-sdk.ts`](../src/plugins/runtime-sdk.ts) | What play shows, sounds and does: HUD readouts and extras, camera following, backdrop, aim marks, strike, impact, lava, enemy health, rest and extra effects, death pose and screen, object, enemy and phantom looks, scene layers, audio, messages, gameplay observers, key bindings and additional input devices; character choice in releases and studio previews. See [runtime plugins](runtime-plugins.md) | `virtual:game-plugins/runtime` |
| `release` | Releases alone, never the Workshop or a studio preview | [`src/plugins/release-sdk.ts`](../src/plugins/release-sdk.ts) | Release-only services and shell chrome: sign-in and content access, notices and fatal errors, the main menu with the player's saved run and settings, the phantom backend, library models and the load's callbacks. See [release plugins](release-plugins.md) | `virtual:game-plugins/release` |
| `workshop` | The Workshop alone | [`src/editor/workshop-sdk.ts`](../src/editor/workshop-sdk.ts) | Authoring tools: tabs, sections, the plugin's data, overlays, previews, motion controls and level checks. See [Workshop plugins](workshop-plugins.md) | `virtual:game-plugins/workshop` |

- A facet imports the engine only through an SDK: its own environment's, or that of an
  environment that runs wherever it does, as a workshop facet may use the kinds and runtime SDKs.
  It may also import packages, such as `three`, and the game's own code.
- The engine reads each environment's facets, in manifest order, from its virtual module. Only
  the engine imports them. The Workshop serves `kinds`, `runtime` and `workshop`. Game builds serve
  `kinds`, `runtime` and `release`, and in studio previews `release` lists no plugins. A build
  asked for another environment's module fails with `invalid-facet`.

## A first plugin

A manifest, `games/my-game/plugins.json`, with one plugin, `my-game`, and a runtime facet:

```json
{
  "apiVersion": 2,
  "plugins": [
    { "id": "my-game", "runtime": "./runtime.ts" }
  ]
}
```

The facet replaces the height readout with the best height of the run, in the project's units:

```ts
// games/my-game/runtime.ts
import { defineRuntime, formatHeight, HUD, replace } from '../../src/plugins/runtime-sdk';

export default defineRuntime({
  start() {
    return [replace(HUD.height, (mount, settings) => {
      const text = document.createElement('p');
      mount.append(text);
      let shown = -1;
      return {
        update(frame) {
          if (frame.bestHeight === shown) return;
          shown = frame.bestHeight;
          text.textContent = `BEST ${formatHeight(settings, shown)} ${settings.height.unit}`;
        },
      };
    })];
  },
});
```

```sh
GAME_PLUGINS=games/my-game/plugins.json npm run dev
```

The Workshop's play-test shows the new readout, and so do studio previews and releases built
with the manifest. The health and timer readouts stay the engine's. [Runtime plugins](runtime-plugins.md)
describes the readouts, looks, audio and messages, with complete examples.

## Points and contributions

A point is a typed descriptor, identified by a string such as `hud.health`. The engine module
that owns a contract declares its point, and its environment's SDK exports it, such as `HUD.health`
from the runtime SDK. A facet returns **contributions**, each made with a verb, and the engine
composes them into one **session** for each place it runs: a page's or a process's kinds, one
game's runtime, one release's services, the Workshop's tools. Every [point](#point-catalogue) is
one of three types:

| Type | Holds | Default |
| --- | --- | --- |
| Slot | One value, such as a readout's factory | The base, the engine's own value |
| Keyed | Items with an `id`, up to a limit | The built-ins, if any |
| List | Values, each kept with the plugin that added it, up to a limit | None |

| Verb | Points | Contribution |
| --- | --- | --- |
| `replace(point, value)` | Slot | `value` in place of the base |
| `wrap(point, decorate)` | Slot | `decorate(previous)`: the value built on what the slot holds so far, the base or an earlier plugin's |
| `add(point, ...items)` | Keyed, list | The items |

- A plugin contributes to a point at most once: an `add` lists all its items for that point.
- A session checks every contribution as it composes, before anything uses one, and refuses
  them all if one is invalid: a point its environment does not have (`unknown-point`), a verb the
  point does not take, or a value the point refuses (`invalid-contribution`).
- The engine resolves each point once per session and keeps the result: nothing is looked up
  per frame. A wrap runs, and its result is checked, when its point is first resolved.

To extend the engine's audio, use `wrap(AUDIO, previous => ...)`, as the
[audio example](runtime-plugins.md#synthesizing-one-sound) does: `previous` supplies the engine's
selected base or an earlier plugin's factory.
Feature-gated defaults, such as the audio director and the phantom look, are reached through
`wrap`, not imported from the runtime SDK.

### Order and conflicts

Contributions compose in manifest order.

- **Slots.** A slot starts from its base. A replace takes the base's place, and each wrap
  receives what the slot holds so far: the base, the replacement or an earlier wrap. A slot
  therefore takes at most one replace, before any wrap. A plugin that replaces a slot an earlier
  plugin already replaced or wrapped fails with `slot-conflict`, naming both plugins: reorder the
  manifest, or wrap instead.
- **Keyed points.** The built-ins come first, then each plugin's items in manifest order. IDs are
  unique (`duplicate-id`), and the total, built-ins included, stays within the point's limit
  (`too-many`).
- **Lists.** Values keep manifest order, each with its plugin, so errors and per-plugin effects
  name it. The total stays within the point's limit (`too-many`).

### Namespaced IDs

A plugin's keyed items are named `<plugin>/<name>`, such as `my-game/charm`: its own ID, a slash
and a name following the same rule as plugin IDs. An item under another plugin's name fails with
`foreign-namespace`, so plugins never take each other's IDs or the built-ins', which have no
namespace, such as `standard`. Content selects a plugin's item by its whole ID.
`isNamespacedId(value)` tells whether a value is such an ID, and `namespaceOf(id)` returns its
plugin, or `null`.

## Defining a facet

Each facet module default-exports one facet, made with its SDK's define helper. The helper
returns its argument unchanged: it gives the facet its type, so TypeScript checks it and types
`host`.

| Helper | SDK | Facet |
| --- | --- | --- |
| `defineKinds` | Kinds | `{ contributes }`: pure, evaluated in Node and in the browser |
| `defineRuntime` | Runtime | `{ start(host) }`, returning the contributions |
| `defineRelease` | Release | `{ start(host) }`, returning the contributions or a promise of them |
| `defineWorkshop` | Workshop | `{ start(host), contributes?, validate?(data) }` |

Each environment's host checks the facets' shapes as they load: a default export of the wrong
shape fails with `invalid-facet`, naming the plugin.

Every SDK also exports the kernel's verbs and types: `add`, `replace`, `wrap`, `isNamespacedId`,
`namespaceOf`, `PLUGIN_API_VERSION`, `PLUGIN_ERROR_CODES`, `PLUGIN_LIMITS`, `PluginError` and
`pluginRefusal`, and the types `Contribution`, `SlotPoint`, `KeyedPoint`, `ListPoint` and
`PluginEnvironment`. The kernel itself is [`src/plugins/kernel.ts`](../src/plugins/kernel.ts).

## Errors

Every plugin failure the engine detects is a **`PluginError`**:

| Field | Meaning |
| --- | --- |
| `kind` | `'plugin-error'`, a portable tag |
| `code` | What failed: one of the codes below, or a plugin's own |
| `plugin` | The plugin's ID, or `null` |
| `point` | The point's ID, or `null` |
| `cause` | The error it wraps, when there is one |

| Code | Cause |
| --- | --- |
| `invalid-manifest` | The manifest is not a JSON file inside the repository, holds something other than `apiVersion` and `plugins`, lists no plugin or more than 32, or names a file twice |
| `api-version` | `apiVersion` is not 2 |
| `invalid-plugin` | A plugin is not an object, or has an invalid ID, an unknown field, no facet, or a facet that is not a relative path to a module file inside the repository |
| `duplicate-plugin` | Two plugins share an ID |
| `reserved-plugin` | A plugin is named `engine` |
| `invalid-facet` | A facet's default export has the wrong shape; a build refused a facet file its boundary forbids; a build was asked for a virtual module it does not serve |
| `unknown-point` | A contribution names a point its environment does not have |
| `invalid-contribution` | A contribution is malformed, uses a verb its point does not take, or holds a value its point or build refuses; an instance lacks its contract's required methods, optional methods, roots or passes; a synchronous contract returns a promise-like value; or a call violates its point's input or output rules, including a presenter that returns a non-promise or invalid outcome |
| `duplicate-contribution` | A plugin contributes to one point twice |
| `slot-conflict` | A plugin replaces a slot an earlier plugin already replaced or wrapped |
| `duplicate-id` | Two items of a keyed point share an ID |
| `foreign-namespace` | A keyed item is not named `<plugin>/<name>` under its own plugin |
| `too-many` | A point holds more items than its limit, or a session more than 32 plugins |
| `plugin-failed` | Plugin code throws or an asynchronous plugin call rejects, including startup, wrapping, creation, instance methods and callbacks. The error names the executing plugin, point and action and retains the original error as its cause. A `PluginError` already attributed to that same plugin and point passes through; an error from another plugin, point or the engine is attributed to the executing plugin instead. Documented content, phantom, event and Workshop-validation refusals keep their own semantics |
| `plugin-stopped` | A stopped Workshop plugin's host, or a closed release session, refused a call |

A plugin may refuse with codes of its own, as a Workshop plugin's `validate` does for its data:
`new PluginError('invalid-joint', message)`. Codes are 1-64 lowercase letters, digits and
hyphens, starting with a letter; any other code throws a `TypeError`. Branch on `code`, never on
the message. `pluginRefusal(error, plugin)` rebuilds a `PluginError` that crossed Vite's module
runner as another copy of the class, by its `kind` tag, or returns `null`.

Death-return placement failures are engine invariants, not plugin refusals. The runtime SDK
exports `DeathSequenceError`; branch on its `code`:

| Code | Cause |
| --- | --- |
| `placement-failed` | `Game`'s `onAction('reset')` returned without placing the player synchronously |
| `placement-changed` | Placement changed without cancelling the active death sequence |

See the [death sequence's host contract](runtime-plugins.md#death-sequence).

Physical entry and frame validation additionally use the typed `PlayerDeathError`
(`src/player-ragdoll.ts`); branch on its `code`:

| Code | Cause |
| --- | --- |
| `locked-world` | Death entry inside a physics step |
| `repeated-entry` | The placement is already dying |
| `construction-failed` | The corpse cannot be constructed or the live root removed |
| `phase-mismatch` | A player snapshot or interpolation has inconsistent live/death phases |

These stop the transition or frame rather than substituting a pose, teleporting the
character or retaining a partial corpse.

`CharacterFigureError` (`src/character-figure.ts`) has code `'invalid-figure'`.
Simulation construction and figure updates validate immutable numeric proportions:
finite coordinates, positive finite arm lengths, bounded waist lean and grips.
A figure refusal never changes an existing corpse.

## Lifecycle and hot reload

| Facet | Starts | When it changes | Stops |
| --- | --- | --- | --- |
| `kinds` | Composed in Node when the dev server, the project server or a build starts, and in each page as it loads | Restart the dev server or the project server, or rebuild: Node keeps the kinds it composed at startup | With its process or page |
| `runtime` | `start(host)` once per runtime session, in manifest order: each run of the Workshop's page, each load attempt of a release | The Workshop's page code runs again, with a new session; `npm run dev:game` restarts the release | The session's signals abort in reverse order, after the game it served is disposed |
| `release` | `start(host)` once per release, awaited in manifest order before anything is fetched | `npm run dev:game` restarts the release | The signals abort in reverse order when the release closes |
| `workshop` | `start(host)` once the Workshop's project is open | Every Workshop plugin stops and starts again; the page and the project, with its unsaved changes, stay | On its own error, on a change, or when the Workshop's page code runs again |

- **Kinds** are a startup snapshot in Node, because the project server and builds validate
  content against them: change a kinds facet, then restart.
- **A runtime or release `start`** that throws fails with `plugin-failed`, naming the plugin,
  and the plugins that started before it have their signals aborted, in reverse order. A runtime
  facet whose start throws, or whose contributions are invalid, stops the Workshop or the release
  with a fatal error naming the plugin: the engine never falls back to its defaults silently.
- **Release sessions** live until the release closes, even after a fatal load error, so a
  plugin's own interface, such as a sign-in or a buy link, stays.
- **Workshop facets** that are invalid, when the page loads or after a change, run no Workshop
  plugins: the Workshop shows the error as a notice, `window.gettingOver.plugins()` reports it,
  and the page and the project stay. A Workshop plugin that throws stops alone; see
  [Workshop plugins](workshop-plugins.md#lifecycle).

Keep per-session state in the closures of `start` and of factories, never at module level: one
page may run several sessions over its life.

## The import-time rule

A facet module must not run code when it is imported. It defines functions, classes, constants
and its facet; everything else, such as touching the page, starting a timer, fetching or reading
storage, happens in `start`, a factory or a callback, where the engine reports its errors. An
error thrown while a facet module is imported stops the page before the engine can show it, so
check the browser console.

Kinds facets load in Node too, with no DOM and without the app's Vite configuration. They, and
everything they import, use relative paths and package names, never the app's aliases or
`virtual:` modules.

## Trust and boundaries

- **Build inputs only.** Code comes only from `GAME_PLUGINS`. Project data never names code, so
  nothing sent to a project server can add code to a game.
- **Trusted and unsandboxed.** Plugins are the game's own code and run with the page's full
  access, without a sandbox. Review them as you would the engine.
- **Boundaries.** Each build refuses code that does not belong in it, by real path, both as
  files load and in the chunks a build writes:
  - game builds refuse `src/editor/**` and every workshop facet, and studio previews every
    release facet too;
  - the Workshop refuses every release facet, so a runtime facet that imports one fails it;
  - Node's kinds loader refuses `src/editor/**` and every facet but kinds facets.
- **No globals.** The engine never imports anything a plugin brings, such as an identity
  provider's SDK, and puts neither a plugin's API nor anything else on a global.
- **Public shells.** A release built without `GAME_PLUGINS` contains no downstream code. A
  release's shell is public, so plugins hold no secrets.

### Studio previews

The project server's **Publish** builds a studio preview of the open project, with the studio's
own `GAME_PLUGINS` and `GAME_STUDIO_PREVIEW=1`. It runs the game's kinds and runtime facets, so it
shows the game's own HUD readouts and looks, and drops every release facet:
`virtual:game-plugins/release` lists none. A preview therefore uses public access to its own
content, has no phantom backend, replaying only the project's bundled recordings, packages no
library models and has no main menu, so play starts at once.

## Performance

Plugin code runs in the engine's frame and shares its budget. The engine keeps per-frame work
proportional to what is active, including allocation-free checks around active plugin calls.

- **Set up once.** Points resolve once per session. Build geometry, materials and elements in
  `start`, in factories and when objects change, never per frame. Attribution and instance
  contracts are checked and cached at creation; frame calls use fixed-arity adapters without
  rest arrays, closures, freezing or point resolution.
- **Allocate nothing per frame.** `update` runs 60 or more times a second. Reuse vectors,
  matrices, arrays and objects, and write only what changed: a readout compares the frame with
  what it last drew, and a look uploads only the instances it moved.
- **Never keep borrowed data.** HUD and scene frames, pooled enemy arrays/poses, camera inputs/aims,
  phantom figure frames, gameplay moments and nested causes, and input-device output are reused: read what you need during the
  call and treat nested references as borrowed. Synchronous contracts must finish in that call;
  returning a promise-like value is `invalid-contribution`, even from a `void` method.
- **Pay only while active.** A look's `update` runs only while the level has objects of its
  kind, so an unused look costs nothing per frame. The front pass draws only while some look's
  front is visible, so hide yours while it shows nothing. Enemy looks update only with enemies
  in the level, and phantom looks draw only while a figure shows. Scene layers and Workshop
  overlays without `update` have no per-frame callback; others run only while added. Effects
  update only after a routed moment until returning false; observers run only on routed
  moments, and absent input devices have no polling call. Routes are built once, and the
  double-buffered journal grows only at a new high-water mark.
- **Keep callbacks light.** `PROGRESS` runs as each piece of the boot downloads arrives.
  Audio handles moments, explicit previews and pause/settings changes, not frames. Toasts request frames only while
  showing; notices and modal presenters need no idle animation loop.
- **Stay out of physics.** No plugin code runs inside the physics step or its callbacks.
  Devices poll before stepping; look updates flush after the step loop, then each moment
  goes to effects, audio and observers before rendering. Terrain stays synchronous and
  engine-only. A motion kind's
  `update` and a [rig strategy's](characters.md#rig-strategies) frame phases run every frame:
  allocate nothing there either.

## Type-checking plugin code

Vite strips TypeScript without checking it, and the engine's own check, which `npm run build`
runs, covers the engine and the examples in [`examples/plugins`](../examples/plugins) and
[`examples/main-menu`](../examples/main-menu) alone. Check a game's
plugin code with a `tsconfig.json` of its own, beside the manifest, which extends the engine's and
includes the game's folder:

```json
{
  "extends": "../../tsconfig.json",
  "include": ["."]
}
```

```sh
npx tsc -p games/my-game/tsconfig.json
```

It applies the engine's strict settings, such as `noUnusedLocals` and `erasableSyntaxOnly`, to
the game's code and to the SDKs it imports.

## The examples

[`examples/plugins`](../examples/plugins) holds one plugin, `example`, with a runtime facet that
draws the health readout as a bar and projectiles as glowing orbs:

```sh
GAME_PLUGINS=examples/plugins/plugins.json npm run dev
```

Place a **Projectile trap** in Workshop / Level and play: the level now has health, shown as the
example's bar, and the trap's shots fly as its orbs. A release shows the bar too, in a game whose
enemies can hurt the player:

```sh
GAME_PLUGINS=examples/plugins/plugins.json GAME_PROJECT=examples/projects/ashen-ascent npm run dev:game
```

[Runtime plugins](runtime-plugins.md#complete-example) walks through its code.

[`examples/main-menu`](../examples/main-menu) holds a second plugin, `main-menu`, with a release
facet that puts a main menu in front of play: a title screen that starts a new game or continues the
player's saved climb, a pause menu, and settings for the volume, the control sensitivity and the
character. Release facets run only in releases, so try it with `npm run dev:game`:

```sh
GAME_PLUGINS=examples/main-menu/plugins.json npm run dev:game
```

[Release plugins](release-plugins.md#main-menu) describes the menu's API.

## Point catalogue

| Point | Constant | Facet | Type | Base or built-ins |
| --- | --- | --- | --- | --- |
| [`avatar.rigs`](kinds-plugins.md#rig-strategies) | `AVATAR_RIGS` | `kinds` | Keyed, 64 `AvatarRigStrategy` | The `standard` strategy |
| [`avatar.motions`](kinds-plugins.md#motion-kinds) | `AVATAR_MOTIONS` | `kinds` | Keyed, 64 `AvatarMotionKind` | None; hair is built in, outside the point |
| [`hud.level`](runtime-plugins.md#hud-readouts) | `HUD.level` | `runtime` | Slot, `HudReadoutFactory` | `DEFAULT_HUD_READOUTS.level` |
| [`hud.height`](runtime-plugins.md#hud-readouts) | `HUD.height` | `runtime` | Slot, `HudReadoutFactory` | `DEFAULT_HUD_READOUTS.height` |
| [`hud.health`](runtime-plugins.md#hud-readouts) | `HUD.health` | `runtime` | Slot, `HudReadoutFactory` | `DEFAULT_HUD_READOUTS.health` |
| [`hud.timer`](runtime-plugins.md#hud-readouts) | `HUD.timer` | `runtime` | Slot, `HudReadoutFactory` | `DEFAULT_HUD_READOUTS.timer` |
| [`hud.extras`](runtime-plugins.md#extra-readouts) | `HUD.extras` | `runtime` | List, 32 `HudReadoutFactory` | None |
| [`ui.character-choice`](runtime-plugins.md#character-choice) | `CHARACTER_CHOICE` | `runtime` | Slot, `CharacterChoiceFactory` | `DEFAULT_CHARACTER_CHOICE`; releases and studio previews with two profiles only |
| [`looks.flag`](runtime-plugins.md#object-looks) | `LOOKS.flag` | `runtime` | Slot, `() => ObjectLook<TriggerObject>` | `DEFAULT_LOOKS.flag` |
| [`looks.updraft`](runtime-plugins.md#object-looks) | `LOOKS.updraft` | `runtime` | Slot, `() => ObjectLook<TriggerObject>` | `DEFAULT_LOOKS.updraft` |
| [`looks.switch`](runtime-plugins.md#object-looks) | `LOOKS.switch` | `runtime` | Slot, `() => SwitchLook` | `DEFAULT_LOOKS.switch` |
| [`looks.bonfire`](runtime-plugins.md#object-looks) | `LOOKS.bonfire` | `runtime` | Slot, `() => BonfireLook` | `DEFAULT_LOOKS.bonfire` |
| [`looks.platform`](runtime-plugins.md#object-looks) | `LOOKS.platform` | `runtime` | Slot, `() => PlatformLook` | `DEFAULT_LOOKS.platform`: slabs, with moving deck plates when `ride` is true |
| [`looks.shooter`](runtime-plugins.md#object-looks) | `LOOKS.shooter` | `runtime` | Slot, `() => ObjectLook<ShooterObject>` | `DEFAULT_LOOKS.shooter` |
| [`looks.projectile`](runtime-plugins.md#object-looks) | `LOOKS.projectile` | `runtime` | Slot, `() => ProjectileLook` | `DEFAULT_LOOKS.projectile` |
| [`looks.axe`](runtime-plugins.md#object-looks) | `LOOKS.axe` | `runtime` | Slot, `() => ObjectLook<AxeObject>` | `DEFAULT_LOOKS.axe` |
| [`looks.lava`](runtime-plugins.md#object-looks) | `LOOKS.lava` | `runtime` | Slot, `() => ObjectLook<PoolObject>` | `DEFAULT_LOOKS.lava` |
| [`looks.swamp`](runtime-plugins.md#object-looks) | `LOOKS.swamp` | `runtime` | Slot, `() => ObjectLook<PoolObject>` | `DEFAULT_LOOKS.swamp` |
| [`camera.director`](runtime-plugins.md#camera-director) | `CAMERA` | `runtime` | Slot, `CameraDirectorFactory` | `DEFAULT_CAMERA_DIRECTOR` |
| [`scene.backdrop`](runtime-plugins.md#backdrop) | `BACKDROP` | `runtime` | Slot, `BackdropFactory` | `DEFAULT_BACKDROP` |
| [`scene.aim-marks`](runtime-plugins.md#aim-marks) | `AIM_MARKS` | `runtime` | Slot, `AimMarksFactory` | `DEFAULT_AIM_MARKS`; hidden while dying |
| [`effects.strikes`](runtime-plugins.md#effects) | `EFFECTS.strikes` | `runtime` | Slot, `MomentEffectFactory` | `DEFAULT_EFFECTS.strikes`: one shared pool for character strikes, hammer blocks and hammer strikes on enemies |
| [`effects.impacts`](runtime-plugins.md#effects) | `EFFECTS.impacts` | `runtime` | Slot, `MomentEffectFactory` | `DEFAULT_EFFECTS.impacts`: debris, dust and sparks where the hammer head strikes terrain or a platform, each surface its own way |
| [`effects.lava`](runtime-plugins.md#effects) | `EFFECTS.lava` | `runtime` | Slot, `MomentEffectFactory` | `DEFAULT_EFFECTS.lava` |
| [`effects.enemy-health`](runtime-plugins.md#effects) | `EFFECTS.enemyHealth` | `runtime` | Slot, `MomentEffectFactory` | `DEFAULT_EFFECTS.enemyHealth`: a health bar over each hurt enemy |
| [`effects.rest`](runtime-plugins.md#effects) | `EFFECTS.rest` | `runtime` | Slot, `MomentEffectFactory` | `DEFAULT_EFFECTS.rest`: a wave of firelight across the whole screen as the player lights a bonfire |
| [`effects.extras`](runtime-plugins.md#effects) | `EFFECTS.extras` | `runtime` | List, 32 `MomentEffectFactory` | None |
| [`scene.death-pose`](runtime-plugins.md#death-pose) | `DEATH_POSE` | `runtime` | Slot, `DeathPoseWriter` | `DEFAULT_DEATH_POSE` |
| [`looks.enemies`](runtime-plugins.md#enemy-looks) | `LOOKS.enemies` | `runtime` | Slot, `EnemyLookFactory` | `DEFAULT_LOOKS.enemies` |
| [`looks.phantoms`](runtime-plugins.md#phantom-looks) | `LOOKS.phantoms` | `runtime` | Slot, `PhantomLookFactory` | `DEFAULT_PHANTOM_LOOK` |
| [`scene.layers`](runtime-plugins.md#scene-layers) | `SCENE_LAYERS` | `runtime` | List, 32 `SceneLayerFactory` | None |
| [`audio.output`](runtime-plugins.md#audio) | `AUDIO` | `runtime` | Slot, `GameAudioFactory` | `DEFAULT_AUDIO_OUTPUT`; `SILENT_AUDIO_OUTPUT` in releases without content audio |
| [`messages.toasts`](runtime-plugins.md#messages) | `MESSAGES.toasts` | `runtime` | Slot, `ToastsFactory` | `DEFAULT_MESSAGE_TOASTS` |
| [`messages.popup`](runtime-plugins.md#messages) | `MESSAGES.popup` | `runtime` | Slot, `PopupPresenter` | `DEFAULT_MESSAGE_POPUP` |
| [`messages.video`](runtime-plugins.md#messages) | `MESSAGES.video` | `runtime` | Slot, `VideoPresenter` | `DEFAULT_MESSAGE_VIDEO` |
| [`messages.death`](runtime-plugins.md#death-screen) | `DEATH_SCREEN` | `runtime` | Slot, `DeathScreenFactory` | `DEFAULT_DEATH_SCREEN` |
| [`game.observers`](runtime-plugins.md#gameplay-moments) | `OBSERVERS` | `runtime` | List, 32 `GameObserverFactory` | None |
| [`input.bindings`](runtime-plugins.md#input) | `INPUT_BINDINGS` | `runtime` | Slot, frozen `InputBindings` | `DEFAULT_INPUT_BINDINGS`: r / p / Space / c |
| [`input.devices`](runtime-plugins.md#input) | `INPUT_DEVICES` | `runtime` | List, 32 `InputDeviceFactory` | None; pointer input remains built in |
| [`release.notices`](release-plugins.md#notices) | `NOTICES` | `release` | Slot, `NoticesFactory` | `DEFAULT_NOTICES`; studio previews keep the engine default |
| [`release.fatal`](release-plugins.md#fatal-display) | `FATAL` | `release` | Slot, `FatalDisplayFactory` | `DEFAULT_FATAL`; studio previews and the Workshop keep the engine default |
| [`release.access`](release-plugins.md#access-and-sign-in) | `ACCESS` | `release` | Slot, `ContentAccess` | `publicAccess(contentUrl)` |
| [`release.phantoms`](release-plugins.md#phantom-backend) | `PHANTOMS` | `release` | Slot, `PhantomService \| null` | `httpPhantoms(phantomsUrl)` in a build with a phantom URL, otherwise `null` |
| [`release.failed`](release-plugins.md#load-failures-and-progress) | `FAILED` | `release` | Slot, `(error: ContentError) => Promise<void>` | Rejects with the error, which stops the load |
| [`release.progress`](release-plugins.md#load-failures-and-progress) | `PROGRESS` | `release` | List, 32 `(progress: ContentProgress) => void` | None |
| [`release.model-failed`](release-plugins.md#library-models) | `MODEL_FAILED` | `release` | List, 32 `(error: Error) => void` | None |
| [`release.ready`](release-plugins.md#ready-and-the-release-api) | `READY` | `release` | List, 32 `(api: ReleaseApi) => void` | None |
| [`release.menu`](release-plugins.md#main-menu) | `MENU` | `release` | Slot, `MenuFactory \| null` | `null`: play starts at once and no run is saved |
| [`avatar.motion-controls`](workshop-plugins.md#motion-controls) | `AVATAR_MOTION_CONTROLS` | `workshop` | Keyed, 64 `AvatarMotionControlSet` | None |
| [`level.checks`](workshop-plugins.md#level-checks) | `LEVEL_CHECKS` | `workshop` | Keyed, 32 `LevelCheck` | None |
| [`level.reach`](workshop-plugins.md#level-checks) | `LEVEL_REACH` | `workshop` | Slot, `LevelReachSource` | `reachForSettings(settings)`, with the highest bonfire as goal |

The limit of a keyed or list point counts every item, built-ins included.
