# The game's module

A game adds its own code to its release with **`GAME_MODULE`**: one `.ts` or `.js` file inside
this repository, which the build bundles into the shell. Where the module supplies something,
the release uses it instead of the engine's default; everything else stays the engine's. It is
how a game draws the HUD's readouts and the level's objects its own way, signs players in and
grants access to its content, talks to its own phantom backend and selects library models.

```sh
GAME_PROJECT=projects/my-game GAME_MODULE=games/my-game/module.ts npm run build:game
```

The module runs only in releases built with it. The Workshop and the project server's studio
previews run without it, so they show the engine's own readouts and looks, as they show course
artwork's placeholders, use public access to their content and package no library models.

## start(host)

The module exports `start(host)`. The release calls it once, before it fetches anything, and
awaits it, so the module can sign the player in first. Its types, and the engine's defaults a
module may wrap, are in `src/release-module.ts`.

```ts
import type { ReleaseHost, ReleaseModule } from '../../src/release-module';
import { healthBar } from './health-bar';
import { orbs } from './orbs';

export async function start(host: ReleaseHost): Promise<ReleaseModule> {
  return {
    hud: { health: healthBar },
    looks: { projectile: orbs },
    ready: (api) => { /* the game runs; api.setPause(true) while the module's own UI is open */ },
  };
}
```

[Content delivery](content-delivery.md#protected-games-the-games-module) shows a module that
signs players in and grants access to protected content.

**`ReleaseHost`** (what `start` receives):

| Member | Meaning |
| --- | --- |
| `mount` | The element the release mounts its interface in; the module may add its own UI there |
| `contentUrl` | The build's content URL, absolute |
| `phantomsUrl` | The build's [phantom](phantoms.md) URL (`GAME_PHANTOMS_URL`), absolute; `null` without a phantom backend |
| `notice(message, kind?)` | The release's notice, `info` or `error` |

**`ReleaseModule`** (what `start` returns; every member is optional):

| Member | Meaning |
| --- | --- |
| `hud` | The [HUD readouts](#hud-readouts) the game draws its own way; the others keep the engine's |
| `looks` | The [looks](#object-looks) of the kinds of level objects the game draws its own way; the others keep the engine's |
| `access` | The [content access](content-delivery.md#grants). Without it, content is public under the content URL |
| `phantoms` | The [phantom](phantoms.md#the-games-own-backend) service. Without it, a build with phantoms uses the reference protocol at the phantom URL; a build without them refuses it |
| `progress({ loaded, total })` | Bytes loaded before play |
| `failed(error)` | A `ContentError`; resolve to retry the whole load, reject to stop with the rejection shown |
| `modelFailed(error)` | A part that could not follow the backend's model selection outside a swap; it keeps its model, or starts with the profile's own |
| `ready(api)` | Called once the game runs |
| `dispose()` | Called when the release is disposed, for example on a development reload |

**`ReleaseApi`** (what `ready` receives): `setPause(paused)` and `setInputBlock(blocked)`,
under the module's own reason so they never undo the game's, `halted`, and `modelLibrary`,
which swaps parts to [library models](characters.md#model-library-and-runtime-swaps) as the
backend answers `access.select(request, signal)`.

## HUD readouts

The release's HUD shows three readouts across the top of the screen, from left to right:
`height`, `health` and `timer`. A module's `hud` draws any of them its own way, and the
others stay the engine's. Each is a factory, `(mount, settings) => readout`:

- `mount` is the readout's own slot in the HUD, empty and unstyled; the readout draws
  everything inside it. Slots have the classes `play-hud-slot` and `play-hud-<name>`.
- `settings` are the project's [HUD settings](projects.md#section-reference), with the
  labels, the height's unit and its format. `formatHeight(settings, metres)` formats a height
  as the engine does, and `formatElapsedTime(seconds)` a time.
- `readout.update(frame)` runs every frame with the game's `HudFrame`: `height` and
  `bestHeight` in metres, `elapsed` in seconds and whether the timer is still `timerRunning`,
  `health` (`{ current, max }`, or `null` in levels where nothing can hurt the player) and
  `paused`. It runs 60 or more times a second, so draw only what changed.
- `readout.dispose()`, optional, runs when the release closes.

The project's HUD settings still say which readouts show: a hidden height or timer readout is
never created, whoever draws it. The health slot is hidden while `frame.health` is `null`. To
add to one of the engine's readouts rather than replace it, wrap `DEFAULT_HUD_READOUTS[name]`.
A module may import its own stylesheet; the build bundles it into the shell.

A health bar that empties as the player is hurt:

```ts
import type { HudReadoutFactory } from '../../src/release-module';
import './health-bar.css';

export const healthBar: HudReadoutFactory = (mount) => {
  const bar = document.createElement('div');
  bar.className = 'health-bar';
  const fill = document.createElement('div');
  bar.append(fill);
  mount.append(bar);
  let shown = -1;
  return {
    update(frame) {
      if (frame.health === null || frame.health.current === shown) return;
      shown = frame.health.current;
      fill.style.width = `${(100 * shown) / frame.health.max}%`;
    },
  };
};
```

A readout left `undefined` keeps the engine's. A `hud` that names a readout the HUD does not
have, or supplies something else that is not a function, stops the release from loading with
an error naming it, as does a factory that returns no `update`. A factory may be a method of
the object, its own or inherited, as in a class; it is called on that object. An error a readout throws stops the game and shows the error, as any
error in the game does.

## Object looks

A module's `looks` draws any kind of level object its own way: `flag` and `updraft`, the
triggers marked with them, `bonfire`, `shooter` (projectile traps), `projectile`, `axe`, and
`lava` and `swamp` pools. The others stay the engine's. Each is a factory, `() => look`, which
the game calls once as it starts, and the look draws every object of its kind:

- `passes` are the three.js objects it adds to the view's passes, each drawn over the last:
  `course`, with the course and behind the actors; `actors`, with the characters and enemies;
  and `front`, over the actors, for what stands in front of the obstacle line, such as an axe
  swung toward the camera or the liquid in front of whatever is in a pool. They are the look's
  for its whole life. The front pass runs only while some look's `front` is visible, so hide it
  while it shows nothing.
- `set(objects)` receives every object of its kind when the level loads, none at all included,
  and again whenever any of them changes. The projectile look has none.
- `update(time)` runs every frame with the run's time, in seconds; the projectile look's
  `update(projectiles, time)` also receives the projectiles in flight, each `{ x, y, angle }`
  with its tip at its position. It runs 60 or more times a second, so move only what moves.
- `setLit(ids)`, the bonfire look's alone, receives the bonfires the player has reached this
  run, which burn, whenever they change.
- `dispose()` runs when the game closes: free the look's geometries and materials. `inspect()`,
  optional, reports to the game's diagnostics.

A look only draws: collision, hits and buoyancy stay the engine's, from the objects' own
fields, so draw what the play does. Objects stand on the obstacle line, z = 0, where they are
placed. An axe's blade, `AXE.bladeWidth` by `AXE.bladeHeight`, hangs `axe.length` below its
pivot and turns about the x axis by `axeAngle(axe, time)` radians, positive away from the
camera. `BONFIRE`, `SHOOTER` and `triggerBounds(trigger)` give the engine's sizes and a
trigger's region. The view enables three.js local clipping, so a look can split itself at the
obstacle line with clipping planes, as the engine's axes do; its pools are built as two half
boxes instead. To add to one of the engine's looks rather than replace it, wrap
`DEFAULT_LOOKS[name]`. Import three.js from the `three` package, which is the engine's own copy.

Projectiles as glowing orbs:

```ts
import { InstancedMesh, Matrix4, MeshBasicMaterial, SphereGeometry } from 'three';
import { SHOOTER } from '../../src/release-module';
import type { ProjectileLook } from '../../src/release-module';

export function orbs(): ProjectileLook {
  const mesh = new InstancedMesh(new SphereGeometry(0.15, 12, 8), new MeshBasicMaterial({ color: 0x66ccff }), SHOOTER.projectiles);
  mesh.count = 0;
  mesh.frustumCulled = false;
  const matrix = new Matrix4();
  return {
    passes: { actors: mesh },
    update(projectiles) {
      if (projectiles.length === 0 && mesh.count === 0) return;
      projectiles.forEach((shot, index) => mesh.setMatrixAt(index, matrix.makeTranslation(shot.x, shot.y, 0)));
      mesh.count = projectiles.length;
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}
```

A look left `undefined` keeps the engine's. `looks` that names a look the engine does not
have, or supplies something else that is not a function, stops the release from loading with
an error naming it, as does a factory that returns no passes of three.js objects or lacks a
method its kind needs. Factories may be methods, called on their object. An error a look throws
stops the game and shows the error.

## Trust and the release boundary

A release built without `GAME_MODULE` contains no downstream code. The module is a build input,
never project data, so nothing sent to the project server can add code to a release. The
release boundary covers it: a module that imports an editor module fails the build. The engine
never imports anything the module brings, such as an identity provider's SDK, and puts neither
the module's API nor anything else on a global. The shell is public, so the module must hold no
secrets.
