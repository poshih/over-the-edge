# Runtime plugins

A plugin's **runtime facet** changes what play shows: the HUD's readouts and the looks of the
level's objects. It runs wherever the game plays: in the Workshop's play-test, in studio previews
and in releases, so a game sees its own HUD and looks while it is authored. Its SDK is
[`src/plugins/runtime-sdk.ts`](../src/plugins/runtime-sdk.ts). [Plugins](plugins.md) describes the
manifest, points and verbs.

## The runtime facet

The facet module default-exports a `RuntimeFacet`, made with `defineRuntime`: `start(host)`,
which returns the plugin's contributions.

```ts
import { defineRuntime, HUD, replace } from '../../src/plugins/runtime-sdk';
import { healthBar } from './readouts';

export default defineRuntime({
  start() {
    return [replace(HUD.health, healthBar)];
  },
});
```

`healthBar` is a [readout](#hud-readouts) in the game's own code, such as the
[complete example's](#complete-example).

- The engine calls `start` synchronously, once per runtime session, in manifest order, and
  composes what it returns. A session serves one game: the Workshop starts one each time its page
  code runs, and a release one for each load attempt, so a retry after a failed load starts the
  facets again.
- `start` returns its contributions at once; it cannot wait for anything. Keep the session's
  state in its closures and in the factories' own.
- The engine resolves each point once per session and calls the factories it holds as it builds
  the HUD and the game's view.

**`RuntimeHost`** (what `start` receives):

| Member | Meaning |
| --- | --- |
| `plugin` | The plugin's ID, from the manifest |
| `signal` | Aborts when the session is disposed, after the game it served |
| `notice(message, kind?)` | The Workshop's or the release's notice, `info` or `error`; the Workshop shows notices from `start` once its interface is ready |

## HUD readouts

The HUD shows three readouts, from left to right: `height`, `health` and `timer`, the points
`HUD.height`, `HUD.health` and `HUD.timer`. The Workshop's play-test and releases, studio previews
included, build them from the same readout slots, so a game's readouts show in all of them;
beside them the Workshop keeps its own chrome: PEAK, the input state and its buttons. A plugin
draws any readout its own way, and the others stay the engine's. Each is a factory,
`(mount, settings) => readout` (`HudReadoutFactory`):

- `mount` is the readout's own slot in the HUD, empty and unstyled; the readout draws everything
  inside it. Slots have the classes `hud-slot` and `hud-<name>`. The engine's own readouts draw
  elements with the `play-readout` and `play-readout-<name>` classes in theirs.
- `settings` are the project's [HUD settings](projects.md#section-reference): the labels, the
  height's unit and its format. `formatHeight(settings, metres)` formats a height as the engine
  does, and `formatElapsedTime(seconds)` a time.
- `readout.update(frame)` runs every frame with the game's `HudFrame`. It runs 60 or more times
  a second, so draw only what changed.
- `readout.dispose()`, optional, runs when the HUD is rebuilt or its game closes. The slot goes
  with the HUD, so dispose only what the readout keeps elsewhere, such as listeners on the window.

| `HudFrame` field | Meaning |
| --- | --- |
| `height`, `bestHeight` | The player's height now, and the best this run, in metres |
| `elapsed` | The run's timer, in seconds |
| `timerRunning` | Whether the timer still runs; a Stop timer event stops it |
| `health` | The player's health, `{ current, max }` (`HealthReading`), or `null` in levels where nothing can hurt the player |
| `paused` | Whether the game is paused |
| `pointerLocked` | Whether the mouse is captured for play |
| `inputMode` | `mouse` or `touch` |

The frame and its health reading are one object, reused every frame: read what you need during
`update`, and never keep either to compare later.

- The project's HUD settings still say which readouts show: a hidden height or timer readout is
  never created, whoever draws it. The health slot is hidden while `frame.health` is `null`; its
  readout still updates.
- A change to the HUD settings, such as the Workshop previewing a project's labels, rebuilds the
  readouts: each is disposed and created again with the new settings. Nothing else rebuilds them.
- The engine's timer shows **TIME STOPPED** in place of its label once the timer stops.
- A facet may import its own stylesheet; the build bundles it.
- To add to one of the engine's readouts rather than draw it anew, [wrap](#wrapping-a-default)
  its point.

The [complete example](#complete-example) draws the health readout as a bar.

## Object looks

A plugin draws any kind of level object its own way: `LOOKS.flag` and `LOOKS.updraft`, the
triggers marked with them, `LOOKS.bonfire`, `LOOKS.shooter` (projectile traps),
`LOOKS.projectile`, `LOOKS.axe`, and the pools of `LOOKS.lava` and `LOOKS.swamp`. The others stay
the engine's. Each is a factory, `() => look`, which the game calls once as it starts, and the
look draws every object of its kind:

- `passes` are the three.js objects it adds to the view's passes, each drawn over the last:
  `course`, with the course and behind the actors; `actors`, with the characters and enemies;
  and `front`, over the actors, for what stands in front of the obstacle line, such as an axe
  swung toward the camera or the liquid in front of whatever is in a pool. They are the look's
  for its whole life. The front pass runs only while some look's `front` is visible, so hide it
  while it shows nothing.
- `set(objects)` receives every object of its kind when the level loads, none at all included,
  and again whenever any of them changes. The projectile look has none.
- `update(time)` runs every frame with the run's time, in seconds, but only while the level has
  objects of the look's kind: a kind the level lacks costs nothing per frame. It runs 60 or more
  times a second, so move only what moves.
- The projectile look's `update(projectiles, time)` also receives the projectiles in flight,
  each `{ x, y, angle }` (`ProjectilePose`) with its tip at its position. It runs while the level
  has projectile traps or shots fly, then once more with none, so the look can clear its last
  shots.
- `setLit(ids)`, the bonfire look's alone, receives the bonfires the player has reached this
  run, which burn, whenever they change.
- `dispose()` runs when the game closes, once the view has let go of the look's passes: free its
  geometries and materials. `inspect()`, optional, reports to the Workshop's diagnostics, in
  `window.gettingOver.level().rendering.looks`.

A look only draws: collision, hits and buoyancy stay the engine's, from the objects' own
fields, so draw what the play does. Objects stand on the obstacle line, z = 0, where they are
placed. An axe's blade, `AXE.bladeWidth` by `AXE.bladeHeight`, hangs `axe.length` below its
pivot and turns about the x axis by `axeAngle(axe, time)` radians, positive away from the
camera. `BONFIRE`, `SHOOTER` and `triggerBounds(trigger)` give the engine's sizes and a
trigger's region. The view enables three.js local clipping, so a look can split itself at the
obstacle line with clipping planes, as the engine's axes do; its pools are built as two half
boxes instead. Import three.js from the `three` package, which is the engine's own copy. To add
to one of the engine's looks rather than draw it anew, [wrap](#wrapping-a-default) its point.

The [complete example](#complete-example) draws projectiles as glowing orbs.

## Wrapping a default

`wrap(point, decorate)` builds on what a point holds so far: `decorate` receives the previous
factory, the engine's own or an earlier plugin's, and returns the factory the game uses. The
previous factory still draws, and the wrapper adds to it. `DEFAULT_HUD_READOUTS` and
`DEFAULT_LOOKS` are the engine's own factories, the points' bases, for a plugin that replaces a
point but draws the engine's part inside its own.

The engine's health readout, flashing whenever the player is hurt:

```ts
import { defineRuntime, HUD, wrap } from '../../src/plugins/runtime-sdk';
import type { HudReadoutFactory } from '../../src/plugins/runtime-sdk';

const flashing = (previous: HudReadoutFactory): HudReadoutFactory => (mount, settings) => {
  const readout = previous(mount, settings);
  let shown = -1;
  return {
    update(frame) {
      readout.update(frame);
      if (frame.health === null || frame.health.current === shown) return;
      if (frame.health.current < shown) mount.animate([{ opacity: 0.2 }, { opacity: 1 }], 400);
      shown = frame.health.current;
    },
    dispose() {
      readout.dispose?.();
    },
  };
};

export default defineRuntime({
  start() {
    return [wrap(HUD.health, flashing)];
  },
});
```

A wrap composes on whatever comes before it in the manifest, so two plugins may wrap one readout;
see [order and conflicts](plugins.md#order-and-conflicts).

## Errors

- A default export that is not an object with `start(host)` fails with `invalid-facet`, naming
  the plugin.
- A `start` that throws fails with `plugin-failed`, naming the plugin, and the plugins that
  started before it have their signals aborted, in reverse order. Contributions that break the
  rules fail with their [codes](plugins.md#errors), naming the plugin and the point.
- Creating a readout or a look checks it. A factory, or a wrap, that throws fails with
  `plugin-failed`. A readout without `update(frame)`, or with a `dispose` that is not a function,
  and a look without passes of three.js objects or a method its kind needs, fail with
  `invalid-contribution`. Each names the plugin and the point.
- As the Workshop or a release starts, any of these stops it with a fatal error naming the
  plugin. The engine never falls back to its own readouts or looks silently.
- An error a readout or look throws while the game runs stops the game and shows the error, as
  any error in the game does.

## Complete example

[`examples/plugins`](../examples/plugins) holds one plugin, `example`, with a runtime facet. It
draws the health readout as a bar, styled by its own [`health-bar.css`](../examples/plugins/health-bar.css),
and projectiles as glowing orbs. Its manifest, `examples/plugins/plugins.json`:

```json
{
  "apiVersion": 1,
  "plugins": [
    { "id": "example", "runtime": "./runtime.ts" }
  ]
}
```

Its runtime facet, `examples/plugins/runtime.ts`:

```ts
import { DynamicDrawUsage, InstancedMesh, Matrix4, MeshBasicMaterial, SphereGeometry } from 'three';
import { defineRuntime, HUD, LOOKS, replace, SHOOTER } from '../../src/plugins/runtime-sdk';
import type { HudReadoutFactory, ProjectileLook, ProjectilePose } from '../../src/plugins/runtime-sdk';
import './health-bar.css';

// One readout's state belongs to its factory invocation, not the module or a shared HUD frame.
const healthBar: HudReadoutFactory = (mount) => {
  const root = document.createElement('div');
  root.className = 'example-health';
  const label = document.createElement('span');
  label.textContent = 'HEALTH';
  const meter = document.createElement('div');
  meter.className = 'example-health-meter';
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', 'Health');
  meter.setAttribute('aria-valuemin', '0');
  const fill = document.createElement('span');
  fill.className = 'example-health-fill';
  meter.append(fill);
  root.append(label, meter);
  mount.append(root);
  let current = -1;
  let max = -1;
  return {
    update(frame) {
      const health = frame.health;
      if (health === null || health.current === current && health.max === max) return;
      current = health.current;
      max = health.max;
      fill.style.transform = `scaleX(${current / max})`;
      meter.setAttribute('aria-valuenow', String(current));
      meter.setAttribute('aria-valuemax', String(max));
    },
    dispose() { root.remove(); },
  };
};

function orbs(): ProjectileLook {
  const radius = 0.11;
  const mesh = new InstancedMesh(new SphereGeometry(radius, 12, 8),
    new MeshBasicMaterial({ color: 0x7be5f2, toneMapped: false }), SHOOTER.projectiles);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const matrix = new Matrix4();
  // Reuse the update range too: addUpdateRange() would allocate a new object each frame.
  const range = { start: 0, count: 0 };
  return {
    passes: { actors: mesh },
    update(projectiles: readonly ProjectilePose[]) {
      const count = projectiles.length;
      if (count === 0 && mesh.count === 0) return;
      for (let index = 0; index < count; index++) {
        const pose = projectiles[index]!;
        // The sphere's leading edge, not its centre, matches the projectile's physical tip.
        matrix.makeTranslation(pose.x - Math.cos(pose.angle) * radius, pose.y - Math.sin(pose.angle) * radius, 0);
        mesh.setMatrixAt(index, matrix);
      }
      mesh.count = count;
      if (count === 0) return;
      range.count = count * mesh.instanceMatrix.itemSize;
      mesh.instanceMatrix.updateRanges.length = 0;
      mesh.instanceMatrix.updateRanges.push(range);
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}

export default defineRuntime({
  start() {
    return [replace(HUD.health, healthBar), replace(LOOKS.projectile, orbs)];
  },
});
```

- The bar draws only when the health changes, and keeps its meter's values for screen readers.
- The orbs are one `InstancedMesh` for up to `SHOOTER.projectiles` shots. Its update writes only
  the shots in flight and reuses its matrix and its update range, so it allocates nothing per
  frame, and it does nothing once the last shots are cleared.
- Each readout and look keeps its state in its own factory call, so a HUD rebuilt for new
  settings, or a new session, starts afresh.

Try it as [the example](plugins.md#the-example) describes:
`GAME_PLUGINS=examples/plugins/plugins.json npm run dev`.
