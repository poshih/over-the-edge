# Kinds plugins

A plugin's **kinds facet** registers code that content selects by ID: the rig strategies that fit
and pose imported avatars, which an avatar names in its `driver`, and the kinds of their
secondary motion, which it lists in its `motion`. Content stays data: a profile names a kind, and
the kind's code comes only from the game's manifest. Kinds run wherever content is checked or
played: in Node, when the dev server, the project server or a build starts, and in every page,
the Workshop, studio previews and releases. Its SDK is
[`src/plugins/kinds-sdk.ts`](../src/plugins/kinds-sdk.ts). [Plugins](plugins.md) describes the
manifest, points and verbs.

## The kinds facet

The facet module default-exports a `KindsFacet`, made with `defineKinds`: `{ contributes }`,
the plugin's contributions, with no `start` and no host.

```ts
// games/my-game/kinds.ts
import { add, AVATAR_MOTIONS, AVATAR_RIGS, defineKinds } from '../../src/plugins/kinds-sdk';
import { charm } from './charm';
import { myRig } from './my-rig';

export default defineKinds({
  contributes: [add(AVATAR_RIGS, myRig), add(AVATAR_MOTIONS, charm)],
});
```

- The facet is pure: its contributions are built as the module loads, in Node and in the
  browser. Strategies and kinds are plain objects; they touch no page, timer or network.
- A plugin adds all its items for one point in one `add`, such as `add(AVATAR_RIGS, myRig, otherRig)`.
- In Node the facet, and everything it imports, loads without a DOM and without the app's Vite
  configuration: it imports by relative path or package name, never through the app's aliases
  or `virtual:` modules. Node's loader refuses `src/editor/**` and every facet but kinds facets.

## Rig strategies

`add(AVATAR_RIGS, ...strategies)` registers rig strategies, each an `AvatarRigStrategy`:
`{ id, prepare(config, binds) }`. [Rig strategies](characters.md#rig-strategies) describes the
contract and shows a complete strategy, `my-game/my-rig`. The point holds 64 strategies, the
built-in `standard` among them. An avatar selects a plugin's strategy by its namespaced ID:

```json
"driver": { "id": "my-game/my-rig", "config": null }
```

## Motion kinds

`add(AVATAR_MOTIONS, ...kinds)` registers motion kinds, each an `AvatarMotionKind`:
`{ id, prepare(config, model) }`. [Secondary motion](characters.md#secondary-motion) describes
the contract and shows a complete kind, `my-game/charm`. The point holds 64 kinds and has no
built-ins: the built-in hair is configured in `avatar.hair`, outside it. An avatar lists a
plugin's kinds by their namespaced IDs:

```json
"motion": [{ "id": "my-game/charm", "config": { "joint": "Charm", "stiffness": 30, "damping": 4 } }]
```

A kind's sliders in Workshop / Character / Secondary motion come from a workshop facet of the
same plugin: see [motion controls](workshop-plugins.md#motion-controls).

## IDs in content

- A driver or motion ID names a built-in, such as `standard`, or a plugin's item,
  `<plugin>/<name>`, whose two parts are each 1-64 lowercase letters, digits and hyphens,
  starting with a letter: at most 129 characters.
- A plugin registers items only under its own namespace (`foreign-namespace` otherwise), so no
  plugin takes another's IDs or a built-in's. `hair` names the built-in hair and never appears
  in `motion`.
- The plugin's ID is part of every ID content stores: renaming a plugin in the manifest means
  updating the profiles, server avatars' settings and library entries that name its kinds.
- Content that names an ID nothing registers fails wherever it is checked or loaded, with
  `unknown-strategy` or `unknown-kind`. It never falls back to the standard rig or skips a
  motion.

## Node and the browser

The dev servers, the project server and every build compose the kinds facets in Node as they
start, through Vite's module runner, with the same function, `composeKinds`, that each page uses.
A profile, a server avatar's settings or a library avatar is therefore accepted or refused
identically when it is imported or opened, stored by the project server, packaged into a release
or loaded by one, and a custom driver never works in one path while failing in another. Studio
previews keep the game's kinds facets, so a published game shows the avatars the project server
checked.

Node keeps the kinds it composed at startup. After changing a kinds facet, or anything it
imports, restart `npm run dev`, `npm run dev:game` or `npm run studio`, or rebuild. Editing the
manifest restarts the dev server by itself.

## Errors

Registration fails with a `PluginError` naming the plugin, and the point it concerns, in Node as
the command starts, so the dev server, the project server or the build does not start:

| Code | Cause |
| --- | --- |
| `invalid-facet` | The default export is not an object whose `contributes` is a list |
| `unknown-point` | A contribution names a point kinds facets do not have, such as a runtime point |
| `invalid-contribution` | A verb other than `add`, or an item that is not an object with an ID and a `prepare()` function |
| `duplicate-contribution` | Two `add`s for one point |
| `foreign-namespace` | An item not named `<plugin>/<name>` under its own plugin |
| `duplicate-id` | Two items with one ID |
| `too-many` | More than 64 strategies, `standard` included, or more than 64 motion kinds |

Content fails with the domain's own errors, wherever it is checked or loaded:

- an `AvatarRigError`, `unknown-strategy`, `invalid-config` or `invalid-strategy`, for a driver;
  see [rig strategies](characters.md#rig-strategies);
- an `AvatarMotionError`, `unknown-kind`, `invalid-motion` or the kind's own code, for a motion,
  and a `CharacterModelError` for its claims; see [secondary motion](characters.md#secondary-motion).
