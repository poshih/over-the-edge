# Runtime plugins

A plugin's **runtime facet** changes what play shows, sounds and does: HUD readouts and extras,
camera following, backdrop, aim marks, hurt and block effects, death pose and screen, object,
enemy and phantom looks, scene layers, audio, event messages, gameplay observers, key bindings
and additional input devices; character choice in releases and studio previews.
It runs wherever the game plays: in the Workshop's play-test, in studio previews and in releases,
so a game sees and hears its own presentation while it is authored. Its SDK is
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
- The engine resolves each point once per session and keeps direct references to its factories
  and presenters; it never resolves a point on a frame or a cue.

**`RuntimeHost`** (what `start` receives):

| Member | Meaning |
| --- | --- |
| `plugin` | The plugin's ID, from the manifest |
| `signal` | Aborts when the session is disposed, after the game it served |
| `notice(message, kind?)` | The Workshop's or the release's notice, `info` or `error`; the Workshop shows notices from `start` once its interface is ready |

## HUD readouts

The HUD's first three readouts, from left to right, are `height`, `health` and `timer`, the points
`HUD.height`, `HUD.health` and `HUD.timer`. Plugins can add their own [extra readouts](#extra-readouts)
after them. The Workshop's play-test and releases, studio previews included, build them from
the same readout slots, so a game's readouts show in all of them;
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
| `health` | The player's health, `{ current, max }` (`HealthReading`), or `null` when the authored level has no hurt sources; shots already in flight can still hurt after their shooter is removed |
| `death` | `'health'` or `'fall'` during the death sequence, otherwise `null`; a fall can leave positive health |
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

### Extra readouts

`HUD.extras`, the runtime list point `hud.extras`, adds a game's own readouts, such as coins or
deaths. It holds up to 32 `HudReadoutFactory` entries in total; the engine's default is an empty
list. Use `add`, not `replace` or `wrap`:

```ts
import { add, defineRuntime, HUD } from '../../src/plugins/runtime-sdk';
import { coins, deaths } from './readouts';

export default defineRuntime({
  start() {
    return [add(HUD.extras, coins, deaths)];
  },
});
```

Each factory receives its own empty slot, with classes `hud-slot` and `hud-extra`, and the
project's `HudSettings`. Slots follow height, health and timer in manifest order, and in the
order of factories within each plugin's `add`. Extras use the same `update(frame)` and optional
`dispose()` contract as the other readouts: their returned objects are checked where created,
and a refusal names the contributing plugin and `hud.extras`.

Extras decide their own visibility, for example by setting `mount.hidden`; the engine never
hides them using the height/timer settings or `frame.health`. They still update every frame, including
when hidden, and are disposed and rebuilt with the bar when HUD settings change. Keep a game's
own counters in its session or factory closures; `HudFrame` remains the engine's read-only,
reused frame, not a container for extra game state. No point resolution or factory invocation
runs on the frame path.

## Character choice

`CHARACTER_CHOICE`, the runtime slot `ui.character-choice`, holds a `CharacterChoiceFactory`,
`(mount: HTMLElement, choice: CharacterChoiceModel) => CharacterChoiceView`. A runtime facet
uses `replace(CHARACTER_CHOICE, factory)` or `wrap(CHARACTER_CHOICE, decorate)`. The contract
and default are exported from the runtime SDK; the creation checks live in
[`src/character-choice.ts`](../src/character-choice.ts):

```ts
interface CharacterChoiceModel {
  readonly labels: readonly string[];
  readonly selected: number;
  readonly select: (index: number) => void;
}
interface CharacterChoiceView {
  setEnabled(enabled: boolean): void;
  dispose(): void;
}
```

The factory receives an empty mount and a read-only model. Its `labels` are the two profiles'
display labels; `selected` reads the current index. Request a selection through `select(index)`,
never by writing to the model. The play UI owns the index and its existing local-storage
persistence, restores the player's last valid choice, and selects that profile once loading
finishes. `select` requires an integer index within `labels`; an invalid index fails with
`invalid-contribution`, naming the plugin and point.

The play UI resolves the factory once per runtime session with `DEFAULT_CHARACTER_CHOICE` as
its base. It creates a view only in releases and studio previews with **two profiles**; a
single-profile game has no choice UI, and the Workshop keeps its own character controls.
The Workshop never resolves `ui.character-choice`, so try its wraps and views with
`npm run dev:game` or a studio preview.
The engine calls `setEnabled(false)` when the view is created and `setEnabled(true)` once every
profile has loaded. Keep controls disabled until then. `dispose()` releases listeners and
anything the view keeps elsewhere; the engine removes the mount when the play UI is cleared
or disposed. There is no per-frame method.

`DEFAULT_CHARACTER_CHOICE` draws the engine's existing **CHARACTER** radio group, with the
same 2D/3D labels, numbered when they repeat, and the restored selection. Creating a view
checks both required methods; a malformed result fails with `invalid-contribution`, and a
throwing factory fails with `plugin-failed`, each naming the plugin and `ui.character-choice`.

## Object looks

A plugin draws any kind of level object its own way: `LOOKS.flag` and `LOOKS.updraft`, the
triggers marked with them, `LOOKS.switch` (pressure switches), `LOOKS.bonfire`,
`LOOKS.platform`, `LOOKS.shooter` (projectile traps), `LOOKS.projectile`, `LOOKS.axe`,
and the pools of `LOOKS.lava` and `LOOKS.swamp`. The others stay the engine's. Each is a
factory, `() => look`, which the game calls once as it starts, and the look draws every object
of its kind:

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
  shots. The array and its mutable pose slots are pooled, bounded by `SHOOTER.projectiles`,
  and borrowed read-only until the next frame sample. Never retain or mutate either; copy
  scalar values into your own state if you need history. Do not use array or pose identity
  to detect changes, and a slot does not identify a particular shot.
- `setLit(ids)`, the bonfire look's alone, receives the bonfires the player has reached this
  run, which burn, whenever they change. Changes during physics are staged: after the step loop,
  it runs at most once per notification flush, with the latest lit set.
- `setPressed(ids)`, the switch look's alone, receives the switch triggers the player's foot is
  inside. Reset, restart and respawn release switches through the same staged looks phase.
- The platform look's `set(objects)` receives the authored platforms, and its
  `update(changes, time)` receives **only changed drawn poses**, `{ id, x, y }`
  (`PlatformPose`), each frame while the level has platforms. This is a position delta,
  not a membership list: an empty update leaves every platform where it was. In `set`,
  place new IDs at their authored `x`/`y`, retain existing IDs' drawn positions, and remove
  missing IDs. `travelX`/`travelY` are offsets in metres from the authored start to the other
  end; draw the runtime poses without changing those definitions. The delta array and its
  mutable pose slots are borrowed read-only until the next frame sample: do not retain or
  mutate them, and copy coordinates you keep into your own drawing records. Changes stay
  pending until the look has drawn them; sampling a frame for the camera, death presentation
  or Workshop diagnostics does not consume them. Reset and level replacement send changed
  positions through the same path. The required `ride` boolean starts a resting platform when
  the pot boards its top. The default look draws a darker metal deck plate on `ride`
  platforms, moving it with the slab through the same pose updates; platforms with
  `ride: false` have plain decks. A replacement `PlatformLook` receives `ride` in `set(objects)`
  and can draw that plate its own way without changing the look contract.
- `dispose()` runs when the game closes, once the view has let go of the look's passes: free its
  geometries and materials. `inspect()`, optional, reports to the Workshop's diagnostics, in
  `window.gettingOver.level().rendering.looks`.

At the simulation/view boundary, `PhysicsFrame.platforms` is a reused `PlatformFrame`,
with `changes`, `revision` and `acknowledge(revision)`. `LevelLooks` owns acknowledgement,
after a successful platform-look update; non-rendering frame samples never acknowledge.
An acknowledgement from an older sample cannot consume a newer sample's pending changes.
The platform look itself receives only the delta array, not the acknowledgement function.

A look only draws: collision, hits and buoyancy stay the engine's, from the objects' own
fields, so draw what the play does. Objects stand on the obstacle line, z = 0, where they are
placed. An axe's blade lies in the plane of its swing, edge-on to the camera with its curved
edge below: `AXE.bladeWidth` across the obstacle line, toward the camera and away,
`AXE.bladeHeight` along the haft and `AXE.bladeThickness` along the line. It hangs `axe.length`
below its pivot and turns about the x axis by `axeAngle(axe, time)` radians, positive away from
the camera. `BONFIRE`, `SHOOTER` and `triggerBounds(trigger)` give the engine's sizes and a
trigger's region. Platforms collide, so draw their slabs centred at z = 0. A switch plate is
drawn on its trigger's floor and never collides; a rideable platform's deck plate is scenery
centred on the obstacle line, on its deck top, and stays within the slab's depth. The default
platform look shares one box geometry across two dense instance meshes, slabs and ride plates,
and visits only the pose deltas, writing matrices only for changed poses, authored objects or
instance slots. Its travel bounds are cached on content edits, not rebuilt over every
platform each frame. The view
enables three.js local clipping, so
a look can split itself at the obstacle line with clipping planes, as the engine's axes do;
its pools are built as two half boxes instead. Import three.js from the `three` package, which
is the engine's own copy. To add to one of the engine's looks rather than draw it anew,
[wrap](#wrapping-a-default) its point.

The [complete example](#complete-example) draws projectiles as glowing orbs.

### Pass rules for presentation points

The engine keeps the renderer and the pass sequence. Each pass draws over the last:

1. **Course:** backdrop first, then terrain, its artwork, decorations behind the obstacle line
   and looks' course roots.
2. **Actors**, with depth cleared: characters, enemies and phantoms, never hidden by colliders.
3. **Front**, with depth cleared, only while something shows there: decorations on or in front
   of the obstacle line, axes swung toward the camera and the front of liquid pools.
4. A 3D player's **arms** (`ARM_LAYER`), with depth cleared, over its body, jar and head.
5. **Marks**, ignoring depth, over the arms.
6. The **tool**, sharing the arms' depth, over the marks so the hands hold it.

Everything that collides is centred on `OBSTACLE_LINE`, z = 0: terrain reaches half its depth
each side, and the pot and enemies stand there. Do not move collider visuals away from it.
Decorations never collide; a prop standing on a collider stays within that collider's depth.
New 3D player-arm visuals use `ARM_LAYER`. Every marks material must use `depthTest: false`,
leaving the depth shared by arms and tool alone; `depthWrite: false` may make that intent
explicit too. The SDK exports `OBSTACLE_LINE` and `ARM_LAYER`.

## Camera director

`CAMERA`, the slot `camera.director`, holds a `CameraDirectorFactory`, `() => CameraDirector`:

```ts
interface CameraDirector {
  aim(view: CameraView, out: CameraAim): void;
  snap(view: CameraView, out: CameraAim): void;
  inspect?(): unknown;
}
interface CameraAim { x: number; y: number; worldHeight: number }
```

`CameraView` is reused and read-only:

| Field | Meaning |
| --- | --- |
| `focus` | The pot root, `{ x, y }`, in metres on the obstacle line |
| `reach` | The hammer head's centre on that same plane |
| `reachRadius` | The head's collision radius in metres |
| `maxReach` | The rig's maximum reach in metres |
| `width`, `height` | Canvas size in CSS pixels |
| `dt` | The drawn frame's elapsed real seconds |
| `death` | `'health'` or `'fall'` during the death sequence, otherwise `null` |

`out` holds the current aim on entry. Write the next coordinates and a finite, positive
`worldHeight` in place; allocate nothing in either method. `aim` runs each drawn frame, and
`snap` on a resize, a recenter or a player placed anew. `DEFAULT_CAMERA_DIRECTOR` preserves the
engine's full/compact framing, exponential follow and compact keep-the-rig-visible clamp.
During death it holds the current framing, rather than following the corpse out of view;
placement clears `death` and snaps to the new player. A replacement director receives that
state in both methods and chooses its own death framing.
The engine still owns the theme's perspective/FOV or orthographic projection, near/far, fog,
matrices and the [pass sequence](#pass-rules-for-presentation-points).

The Workshop's `setFraming` override bypasses both director methods; returning to play snaps
through the director again. Diagnostics report the current aim and `director.inspect()`, which
reports `{ compact }` for the default. The input is the simulation, not a temporary character
presentation preview.

**Input coupling:** mouse `pointerDelta` uses the resulting `worldHeight / height` to turn
pixels into metres. A wider framing also increases mouse gain. Touch gain remains based on
`maxReach`, independent of zoom.

For example, wrap the current director to show ten percent more height:

```ts
import { CAMERA, defineRuntime, wrap } from '../../src/plugins/runtime-sdk';
import type { CameraAim, CameraView } from '../../src/plugins/runtime-sdk';

export default defineRuntime({
  start() {
    return [wrap(CAMERA, previous => () => {
      const director = previous();
      return {
        aim(view: CameraView, out: CameraAim) {
          director.aim(view, out);
          out.worldHeight *= 1.1;
        },
        snap(view: CameraView, out: CameraAim) {
          director.snap(view, out);
          out.worldHeight *= 1.1;
        },
        inspect: () => director.inspect?.(),
      };
    })];
  },
});
```

## Backdrop

`BACKDROP`, the slot `scene.backdrop`, holds a `BackdropFactory`, `(theme: GameTheme) => Backdrop`:

```ts
interface Backdrop {
  readonly root: Object3D;
  setTheme(theme: GameTheme): void;
  follow(camera: Readonly<Point>): void;
  dispose(): void;
}
```

The game creates one backdrop, draws its root first in the **course** pass and detaches it before
`dispose`. It renders before the rest of the course without clearing depth between them, so
three.js's opaque/transparent sorting cannot put it later. `DEFAULT_BACKDROP` is the engine's
mountains and sun disc, at their original depths and colours. `setTheme` restyles them in place.
`follow` runs each drawn frame with the reused,
read-only camera aim; the default parallax is `(camera.x * 0.6, camera.y * 0.25)`.
Hide `root.visible` when the backdrop shows nothing, so the engine skips its render. The default
does this when both the mountains and sun disc are hidden, in its constructor and on theme changes.
Build geometry and materials once, never retain the camera as a snapshot and allocate nothing
in `follow`. A backdrop is scenery, never a collider, and stays behind the actors; the engine
keeps the sky clear colour, lighting, fog and [pass rules](#pass-rules-for-presentation-points).

This wrapper slows horizontal parallax while keeping the current backdrop and its theming:

```ts
import { BACKDROP, defineRuntime, wrap } from '../../src/plugins/runtime-sdk';
import type { Backdrop } from '../../src/plugins/runtime-sdk';

export default defineRuntime({
  start() {
    return [wrap(BACKDROP, previous => (theme): Backdrop => {
      const backdrop = previous(theme);
      return {
        root: backdrop.root,
        setTheme: theme => backdrop.setTheme(theme),
        follow(camera) {
          backdrop.follow(camera);
          backdrop.root.position.x = camera.x * 0.4;
        },
        dispose: () => backdrop.dispose(),
      };
    })];
  },
});
```

## Aim marks

`AIM_MARKS`, the slot `scene.aim-marks`, holds an `AimMarksFactory`,
`(theme: GameTheme) => AimMarks`:

```ts
interface AimMarks {
  readonly root: Object3D;
  setTheme(theme: GameTheme): void;
  update(tip: Readonly<Point>, cursor: Readonly<Point>, death: DeathKind | null): void;
  dispose(): void;
}
```

The root draws in **marks**, over the characters and their arms, under the tool.
**All its materials must ignore depth (`depthTest: false`), leaving the arms/tool depth
alone**, as the [pass rules](#pass-rules-for-presentation-points) require. This point changes
drawing only, never aiming or input. `DEFAULT_AIM_MARKS` is the original ring and centre dot
and dashed line from the hammer tip to the cursor, recoloured from `theme.aim`. It hides all
three while dying and shows them again on the next live update, reusing both position and
line-distance attributes. `update` receives borrowed, read-only points each drawn frame,
including a character presentation preview's movement, and the [death kind](#death-sequence):
`'health'`, `'fall'` or `null` while alive. A replacement chooses its own death presentation
through that input. Reuse geometry, materials and scratch; allocate nothing per frame.
The engine detaches the root before `dispose`.

For a dot without the line:

```ts
import { CircleGeometry, Mesh, MeshBasicMaterial } from 'three';
import { AIM_MARKS, defineRuntime, replace } from '../../src/plugins/runtime-sdk';
import type { AimMarksFactory } from '../../src/plugins/runtime-sdk';

const dot: AimMarksFactory = theme => {
  const mesh = new Mesh(new CircleGeometry(0.09, 24),
    new MeshBasicMaterial({ color: theme.aim.cursor, depthTest: false, depthWrite: false }));
  return {
    root: mesh,
    setTheme(theme) { mesh.material.color.set(theme.aim.cursor); },
    update(_tip, cursor, death) {
      mesh.visible = death === null;
      if (death === null) mesh.position.set(cursor.x, cursor.y, 1);
    },
    dispose() { mesh.geometry.dispose(); mesh.material.dispose(); },
  };
};

export default defineRuntime({ start: () => [replace(AIM_MARKS, dot)] });
```

## Hurt effects

`HURT_EFFECTS`, the slot `scene.hurt-effects`, holds a `HurtEffectsFactory`,
`() => HurtEffects`: what shows when something hurts the character, by what did, where and how hard.

```ts
interface HurtEffects {
  readonly root: Object3D;
  hurt(cause: Readonly<HurtCause>, fatal: boolean): void;
  clear(): void;
  update(frame: SceneFrame): boolean;
  dispose(): void;
}

interface HurtCause {
  readonly source: HurtSource; // 'enemy' | 'projectile' | 'axe' | 'lava'
  readonly id: string;
  readonly x: number;      // where it struck, in world metres
  readonly y: number;
  readonly pushX: number;  // the velocity it knocked the player with, in m/s
  readonly pushY: number;
}
```

- `hurt` takes each hit that cost health, `fatal` for the killing one. `cause.source` says what
  dealt it, an enemy's bump, a trap's projectile, an axe's blade or lava (swamp never hurts), and
  `cause.id` names the level object that did: the enemy, the trap that fired the projectile, the
  axe or the pool. `x` and `y` are where it struck: midway between the enemy and the pot, where
  the projectile's path entered the character, the middle of where the blade met the character,
  or the character's centre in lava. `pushX` and `pushY` are the velocity the hit added to the
  player, along the shot, away from the blade or the enemy and upward; lava pushes nothing. A hit
  lands at most once a second, as the character is then unharmed for a while, so lava burns once
  a second while the pot stays in it.
- `clear` follows every placement of the player anew, a restart or a return to a bonfire: end what
  follows the character. The killing hit arrives at death entry; the return and `clear` follow
  after the [death sequence](#death-sequence). What shows where a blow landed, at the cause's
  `x` and `y`, can play on.
- `update` runs on each drawn frame from a `hurt` or a `clear` until it returns `false`, and then
  not again until the next one, so an idle point costs nothing. It receives the borrowed
  [`SceneFrame`](#scene-layers): the drawn time, which a restart rewinds, and the character's
  physical `parts` and typed `player` phase. Use `player.centre` in either phase, or
  `player.presented.torso` while dying to follow the corpse as drawn. There is no `root`
  part during a ragdoll death. Return `true` while anything still shows;
  anything else than a boolean is an error.

`hurt` and `clear` arrive with the [gameplay events](#gameplay-events), after the frame's physics
steps and before the frame is drawn, in the order they happened; never inside a physics step. The
cause is borrowed: copy its fields to keep them. The root draws in **marks**, over the characters
and their arms, under the tool, so **all its materials must ignore depth (`depthTest: false`)**,
as the [pass rules](#pass-rules-for-presentation-points) require. Reuse geometry, materials and
scratch, and allocate nothing on a frame. The engine detaches the root before `dispose`.

`DEFAULT_HURT_EFFECTS` shows:

- **Lava:** the character alight while it burns: tongues of flame shaded from turbulence rising
  through them and warped by itself, deep red to a white-hot core, that lick up the character,
  bend away from its motion and flare at each burn, with embers rising from it, smoke above it and
  a flickering glow about it. Each burn keeps the fire going a little over a second; then the
  flames die down and the last embers and smoke finish rising. Embers and smoke each live their
  own life from where they were born, so a later burn grows the flames again from where they are
  and starts new embers and smoke at the character, without anything appearing mid-flight.
  A fatal lava burn keeps the corpse alight until placement clears it, without further damage.
- **An axe:** where the blade struck, a cold steel flash with a glint, a ring rushing outward, a
  bright slash across the character bowed the way the blow knocks it, and a spray of sparks
  thrown that way, cooling from white through orange to red as they slow and fall.
- **A projectile:** where it struck, a hot flash and ring, sparks sprayed back from the impact and
  on along its flight, and the burning bolt broken into glowing chips that tumble away.

Blows play out where they landed, also when a death returns the player to a bonfire. Enemy bumps
show nothing more. It all needs no textures, draws only while something shows and allocates
nothing on a frame.

To keep the engine's effects and add one of your own, wrap the point and forward every hit to the
base. This adds a flash where an enemy bumps the character:

```ts
import { CircleGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { defineRuntime, HURT_EFFECTS, wrap } from '../../src/plugins/runtime-sdk';
import type { HurtEffectsFactory } from '../../src/plugins/runtime-sdk';

const withBumpFlash = (previous: HurtEffectsFactory): HurtEffectsFactory => () => {
  const base = previous();
  const flash = new Mesh(new CircleGeometry(0.5, 24),
    new MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false, depthWrite: false }));
  flash.visible = false;
  const root = new Group().add(base.root, flash);
  // When the flash started; a new one starts on the next drawn frame.
  let start: number | null = null;
  let pending = false;
  return {
    root,
    hurt(cause, fatal) {
      base.hurt(cause, fatal);
      if (cause.source !== 'enemy') return;
      // Copy what is kept: the cause is borrowed.
      flash.position.set(cause.x, cause.y, 1);
      pending = true;
    },
    clear() {
      base.clear();
    },
    update(frame) {
      const showing = base.update(frame);
      if (pending) { pending = false; start = frame.time; }
      if (start === null) return showing;
      const age = frame.time - start;
      flash.material.opacity = Math.max(0, 0.6 - age * 2);
      flash.visible = age >= 0 && age < 0.3;
      if (!flash.visible) start = null;
      return showing || flash.visible;
    },
    dispose() {
      base.dispose();
      flash.geometry.dispose();
      flash.material.dispose();
    },
  };
};

export default defineRuntime({ start: () => [wrap(HURT_EFFECTS, withBumpFlash)] });
```

To draw one source your own way and keep the others, wrap the point the same way but leave that
source's hits out of what you forward to the base. Replace the point instead to draw every cause
your own way. The same causes reach [gameplay observers](#gameplay-events) on `hurt` and `death`,
for sounds or scores of a game's own.

## Block effects

`BLOCK_EFFECTS`, the slot `scene.block-effects`, holds a `BlockEffectsFactory`,
`() => BlockEffects`: what shows where a projectile strikes the hammer head, independently
of the character's [hurt effects](#hurt-effects).

```ts
interface BlockEffects {
  readonly root: Object3D;
  block(hit: Readonly<ProjectileBlock>): void;
  update(frame: SceneFrame): boolean;
  dispose(): void;
}

interface ProjectileBlock {
  readonly trap: string;        // the ID of the trap that fired the projectile
  readonly x: number;           // where the bolt struck the head, in world metres
  readonly y: number;
  readonly directionX: number;  // the projectile's unit flight direction
  readonly directionY: number;
  readonly normalX: number;     // the head's outward unit surface normal there
  readonly normalY: number;
}
```

- `block` receives each projectile stopped by the hammer head, whether held or released.
  It runs after the frame's physics steps and before drawing, once per block, including
  during death and while the character is unharmed. A projectile that hurt the character
  first is not also a block. Terrain and platform stops do not call this point.
  `hit` is borrowed: copy the scalar fields you keep. Pending blocks from a superseded
  player placement, restart or replacement level are dropped before delivery.
- `update` runs on each drawn frame from a `block` until it returns `false`, then not again
  until the next block, so an idle point costs nothing. It receives the borrowed
  [`SceneFrame`](#scene-layers), reused by the engine; return `true` while anything still
  shows. Anything else than a boolean is an error.
- There is no `clear`: blocks stay where they struck, not on the character or hammer,
  and can finish when the player returns to a bonfire. A restart rewinds `frame.time`;
  end the bursts when time moves backward.

The root draws in **marks**, over the characters and their arms, **under the tool**, held
or released. **All its materials must use `depthTest: false`**; `depthWrite: false` leaves
the depth shared by arms and tool alone, as the [pass rules](#pass-rules-for-presentation-points)
require. Reuse geometry, materials and scratch; allocate nothing on a block or drawn frame.
The engine detaches the root before `dispose`. This is presentation only: it changes
neither health nor the hammer's motion, and adds no gameplay event or audio cue.

`DEFAULT_BLOCK_EFFECTS` shows a projectile-sized **cold white-steel flash**, a glint and
a small ring, six centimetres off the contact point along the outward normal, on the
obstacle line. Sparks glance off the head along the reflected flight
`r = d - 2 * (d · n) * n`, fanned toward the outward normal, cooling to dim blue-grey as
they slow and fall. The burning bolt breaks into glowing chips that drop from the strike.
It reads differently from the hot orange flash and back-spray of a character hit.

The default shares the instanced burst implementation and shader sources with the hurt
effects, but owns a separate root and four-burst pool. The oldest is replaced when full,
so a three-shot burst shows each block. It needs no textures, reuses its geometry,
materials and scratch, allocates nothing per block or frame, and hides its root while idle.
A rewound drawn time ends the old bursts before newly delivered blocks start.

To keep the engine's effect and add one of your own, wrap the point and forward every
method. This adds a short blue ring at the strike:

```ts
import { Group, Mesh, MeshBasicMaterial, RingGeometry } from 'three';
import { BLOCK_EFFECTS, defineRuntime, wrap } from '../../src/plugins/runtime-sdk';
import type { BlockEffectsFactory } from '../../src/plugins/runtime-sdk';

const withRing = (previous: BlockEffectsFactory): BlockEffectsFactory => () => {
  const base = previous();
  const ring = new Mesh(new RingGeometry(0.12, 0.16, 32),
    new MeshBasicMaterial({ color: 0xa8d9ff, transparent: true, depthTest: false, depthWrite: false }));
  ring.visible = false;
  const root = new Group().add(base.root, ring);
  let start: number | null = null;
  let pending = false;
  let lastTime = 0;
  return {
    root,
    block(hit) {
      base.block(hit);
      // Copy what is kept: the hit is borrowed.
      ring.position.set(hit.x + hit.normalX * 0.06, hit.y + hit.normalY * 0.06, 0);
      pending = true;
    },
    update(frame) {
      const showing = base.update(frame);
      if (frame.time < lastTime) { start = null; pending = false; }
      lastTime = frame.time;
      if (pending) { pending = false; start = frame.time; }
      if (start === null) { ring.visible = false; return showing; }
      const age = frame.time - start;
      ring.scale.setScalar(1 + age * 4);
      ring.material.opacity = Math.max(0, 1 - age / 0.25);
      ring.visible = age >= 0 && age < 0.25;
      if (!ring.visible) start = null;
      return showing || ring.visible;
    },
    dispose() {
      base.dispose();
      ring.geometry.dispose();
      ring.material.dispose();
    },
  };
};

export default defineRuntime({ start: () => [wrap(BLOCK_EFFECTS, withRing)] });
```

Replace the point instead to draw every block your own way. Replacing it does not
change the character's hurt effects or how projectiles are stopped.

## Death sequence

Health running out and falling out of the level both start the sequence. Death wins that
physics step before triggers or recording observers run. The world keeps simulating:
terrain, platforms, liquids, traps and enemies carry on, and dying costs run time unless a
Stop timer event already stopped it. In the default `ragdoll` mode the player becomes
six passive physical bodies, releases its hands and drops the hammer. The drive joint
and live root are removed between steps; no dying step drives that rig. The jar and
tool retain their transforms and velocities, and the old root's mass is redistributed
across the torso, head, two upper arms and two forearms/hands. In `hold` mode the original
fixed-rotation root, motors, last hinge-relative aim and grips stay unchanged.
Neither mode can take damage, deal a hammer hit or scripted enemy bump, light a
bonfire or improve best height. Ordinary physical contacts still push bodies; no corpse
impacts are staged.
Running and queued trigger runs are cancelled, their signals close popups and videos, and
pressed switches release; once-triggers keep their consumption and history.

The game settings (schema **14**) own `death: { mode, wait, angularDamping, friction }`.
Workshop / Physics / Death exposes the same fields:

| Field | Values | Default |
| --- | --- | --- |
| `mode` | `'ragdoll'` or `'hold'` | `'ragdoll'` |
| `wait` | 0.5–15 s, step 0.1 | 4 |
| `angularDamping` | 0–10 /s, step 0.1 | 2 |
| `friction` | 0.05–2, step 0.05 | 0.45 |

Ragdoll fixtures and the released shaft use corpse friction; the pot and head retain their
own materials. Corpse parts do not self-collide, and the tool collides with terrain,
platforms and active enemies, never the corpse. The detached head still blocks projectile
rays, without new damage or impulses. Corpse and tool query liquids separately with their
own masses; only the pot supplies buoyancy, while limbs and tool take drag. Enemy activity
remains centred on the corpse: a stray hammer can pass through sleeping enemies far away.
Wait and construction settings are captured at entry. Player-body tuning stays live in `hold`;
in `ragdoll` it takes effect at the next placement, not by retuning the corpse.
Runtime character selections and accepted model/head changes wait for placement;
synchronous character-authoring edits are refused with a transient Workshop notice,
leaving its draft unchanged. In-flight profile/model loads keep waiting for placement.
No corpse is rebuilt mid-death.

The engine's `PlacementHold` accepts only prepared applications that cannot fail for
caller input: validate and prepare everything refusable before deferring. It detaches
the batch before applying, so re-entry cannot replay it or resolve waiters early.
A thrown application is an engine invariant violation: cancel the remaining work and
reject placement waiters. `AppearanceRig` checks alignment and fitting at call time,
against the last accepted model for that same slot (including a pending replacement).
Thus an `align()` after an accepted, deferred `setModel()` is valid; after `reset()` it
refuses until another model is accepted. Application installs the prepared fit without
revalidating caller input.

Game settings' `death.wait` owns the gameplay delay, not a runtime timing slot. The
engine waits its snapshotted **4 s** default before returning to the last bonfire, or
requesting the ordinary Reset when none was reached. The project's HUD owns only
`death: { text, fadeIn }`: **“You are dead...”** and a **1.5 s** visual fade by default.
Each death snapshots its wait, text and fade; edits affect the next death.
A fade longer than the wait ends unfinished without an error, never extending the wait.
Death settings and timing do not count toward the phantom course because recordings
never include dying. The clock advances by `PHYSICS.dt` with each dying physics step and presentation
interpolates it with the frame's alpha. Pause and a hidden tab hold it, with no catch-up.
Reset and other control actions remain available; only movement is discarded.

`Game` hosts must handle `onAction('reset')` by placing the player synchronously through
`Game` before returning, for example with `game.perform('reset')`. A death's return
without a bonfire relies on that placement. If Reset returns without a new placement, or
placement changes without cancelling the active death, return fails with a typed
[`DeathSequenceError`](plugins.md#errors) rather than silently leaving the sequence active.
`Game.dying` reports whether a sequence is active; `Game.deathKind` is `'health'`, `'fall'`
or `null`.

The [phantom recorders](phantoms.md) are interrupted at entry, before the terminal sample.
Neither dying steps nor the teleport or placement pose is sampled; capture resumes on a
subsequent live step. Incremental level edits apply without ending the sequence. Reset,
level replacement, Workshop placement/play-from-here, entering Level editing and disposal
cancel it, with no automatic `respawn` from cancellation. A rig rebuild is an ordinary
restart. There is no wall-clock timeout or deferred completion callback to survive a
cancellation.

Two independent runtime slots replace the presentation without taking over its clock:
[`DEATH_SCREEN`](#death-screen) and [`DEATH_POSE`](#death-pose).
Both consume reused, borrowed frames:

```ts
type DeathKind = 'health' | 'fall';
type DeathInfo =
  | { readonly kind: 'health'; readonly cause: Readonly<HurtCause> }
  | { readonly kind: 'fall' };
interface DeathFrame {
  readonly elapsed: number;       // interpolated seconds since entry
  readonly duration: number;      // game settings' death.wait, snapshotted at entry
  readonly poseProgress: number;  // linear 0–1 over 0.65 s
  readonly reducedMotion: boolean;
}
```

`cause` is the killing hit, as for [hurt effects](#hurt-effects). Copy its fields to keep
them, and never retain a frame. Reduced motion is captured at entry: the defaults show the
static dead appearance and text immediately, but keep the same total wait.

### Death screen

`DEATH_SCREEN`, the slot `messages.death`, holds a `DeathScreenFactory`,
`(mount: HTMLElement) => DeathScreen`:

```ts
interface DeathScreen {
  show(info: DeathInfo, settings: HudSettings['death']): void;
  update(frame: DeathFrame): void;
  clear(): void;
  dispose(): void;
}
```

`mount` is the game view's interface layer, over its canvas and below the Workshop.
Cover that layer with absolute positioning (`position: absolute; inset: 0; z-index: 1`),
under modal presentations, not the browser viewport with a fixed overlay.

- Create only your own nodes in `mount`, and remove only those nodes.
- `show` runs once at entry, with the HUD's validated text and visual fade only.
- `update` runs on visible frames while dying. Animate with the engine's `elapsed`,
  not a timer or another animation loop. Clamp presentation elapsed time to `duration`;
  a fade may be longer than that duration and end unfinished. Pausing cannot consume the wait.
- `clear` runs at placement or cancellation: hide the screen and clear pending
  announcements immediately. `dispose` releases it when the game closes or stops.
- Keep it passive: no focus steal, focus trap, pointer interception or input blocking.
  Reset and Pause must remain reachable.

`DEFAULT_DEATH_SCREEN` centres the project's text over a restrained dark scrim. One paused
Web Animation follows the engine's clock; it requests no frames of its own. A persistent
polite, atomic live region announces once on a subsequent visible frame, and cancellation
clears pending speech. Fade progress uses the HUD fade and elapsed time clamped to the
gameplay duration; it never moves placement. Reduced motion reveals the text at once.

### Death pose

`DEATH_POSE`, the slot `scene.death-pose`, holds a pure numeric
`DeathPoseWriter`, `(frame, out) => void`:

```ts
interface Transform2 { x: number; y: number; angle: number }
interface Rotation3 { x: number; y: number; z: number; w: number }
interface DeathArmPose {
  shoulder: Point;
  elbow: Point;
  hand: Transform2;
}
interface DeathPose {
  torso: Transform2;
  head: Transform2;
  arms: Record<'left' | 'right', DeathArmPose>;
}
interface DeathPoseInput extends DeathFrame {
  readonly character: CharacterRiggingType;
  readonly body: 'ragdoll' | 'rigid';
  readonly attachment: 'released' | 'gripped';
  readonly physical: ReadonlyDeathPose; // deeply readonly DeathPose
  readonly headFacing: Readonly<Rotation3>;
  readonly layout: ReadonlyDeathLayout; // torso-local waist and neck
  readonly direction: -1 | 1; // tool side at entry; +1 when centred
  readonly grippedArms: Readonly<Record<'left' | 'right', ReadonlyDeathArmPose>> | null;
}
interface DeathAppearance extends DeathPose {
  headFacing: Rotation3;
  spriteBrightness: number; // 0–1 colour multiplier, not opacity
}
```

Coordinates are world metres in the course plane, angles counterclockwise radians.
`torso` is the artwork's torso frame and `head` the physical head centre; facial
yaw/pitch remain in `headFacing`. Ragdoll input is the interpolated physical pose.
Rigid input is the captured terminal pose carried with its live root. `grippedArms`
is the hold mode's numeric grip-driven baseline, evaluated with the default slump,
or `null` for released hands. A held pose writer that changes the torso can write
its own matching arms too.

Write every point, angle, quaternion component and brightness each call. The engine
initialises them to invalid sentinels, then requires complete finite transforms, a unit
facial quaternion (squared norm within 0.0001 of 1) and brightness within 0–1.
Input, output and pose buffers are reused and borrowed. Allocate nothing, keep no frame
history and never mutate the input. The writer sees no scene, body, material or renderer
and runs only while dying. It changes presentation, not collision; an authored nonphysical
collapse should select `hold`.

`DEFAULT_DEATH_POSE` copies the physical ragdoll directly. `hold` keeps the former 20°
torso lean and 35° head nod, eased by smoothstep over 0.65 s, and retains grip-driven arms.
Both dim 2D runtime materials to 45%; saved art never changes. Reduced motion completes
the slump/dimming immediately, but never stops physical integration or changes the wait.
Released hands use their forearm directions, with no grip placement or wrist offsets.
Mesh parts, built-in and imported skinned avatars and 2D anchors consume the shared pose.
Sprites freeze facing, flipbook and animation/hair base poses but continue evaluating
physical hand targets each frame with pooled skeleton and target buffers.
Collider visuals remain on `OBSTACLE_LINE`; 3D arms keep `ARM_LAYER` and share depth with
the dropped tool. Placement clears the tint and pose.

The seed is evaluated once against the terminal frame at alpha 1, without rendering,
moving the camera or staging effects. The same complete state, settings and seed give
the same fixed-step integration; a seed is not promised identical across render cadences.
Locked-world entry, stale placement/time, repeated entry, invalid seeds, construction
failures and inconsistent snapshot/interpolation phases raise
[`PlayerDeathError`](plugins.md#errors), not a fallback or an incomplete corpse.

For example, retain the default physical pose but choose a dimmer sprite, and report
the death kind without replacing the screen's drawing:

```ts
import {
  DEFAULT_DEATH_POSE, DEATH_POSE, DEATH_SCREEN, defineRuntime, replace, wrap,
} from '../../src/plugins/runtime-sdk';

export default defineRuntime({
  start(host) {
    return [
      replace(DEATH_POSE, (frame, out) => {
        DEFAULT_DEATH_POSE(frame, out);
        out.spriteBrightness *= 0.8;
      }),
      wrap(DEATH_SCREEN, previous => mount => {
        const screen = previous(mount);
        return {
          show(info, settings) {
            screen.show(info, settings);
            host.notice(info.kind === 'fall' ? 'Fell out of the level.' : 'Health ran out.');
          },
          update: frame => screen.update(frame),
          clear: () => screen.clear(),
          dispose: () => screen.dispose(),
        };
      }),
    ];
  },
});
```

Both points require functions, and the screen's result requires all four methods.
Every method and writer finishes synchronously: promise-like results are
`PluginError('invalid-contribution')`. Missing, non-finite or out-of-range pose outputs
are the same refusal, never clamped or replaced with defaults. Throws are `plugin-failed`
with their cause; matching typed errors retain their code. All failures name the owner
and point, including wrappers.

## Enemy looks

`LOOKS.enemies`, the slot `looks.enemies`, holds an `EnemyLookFactory`,
`(art: EnemyArtSettings) => EnemyLook`:

```ts
interface EnemyLook {
  readonly passes: LookPasses;
  apply(event: EnemyEvent): void;
  update(poses: readonly EnemyPose[], time: number): void;
  setArt(art: EnemyArtSettings): void;
  dispose(): void;
  inspect?(): unknown;
}
```

`DEFAULT_LOOKS.enemies` creates `EnemyView`, the engine's shared atlas and instanced sprites,
including animation, windup, hurt and death effects. The game forwards simulation membership
events to `apply`: `reset` with every pose, `upsert` with one pose and `remove` with an ID.
A surviving hammer hit publishes one `upsert` when the enemy enters hurt, so the look, the
`enemy-hit` cue and gameplay observers all receive the hit. Hit cooldown and contact
deduplication still apply; notifications are raised only for accepted hits.
These notifications are staged and applied in order after the frame's step loop, before audio,
gameplay observers and rendering; the look never runs inside physics. Event envelopes are reused
and read-only: consume them during `apply`, never retain them.
`update` receives only the active poses and simulation seconds, **only while the level has
enemies**; sleeping sprites remain from `apply`. `setArt` receives the project's pixel-art
settings when they change. `inspect`, optional, appears in the rendering diagnostics' `enemies`.

Collider visuals stand on `OBSTACLE_LINE` and draw in **actors**, never hidden by terrain.
`passes.course` and `passes.front` may add scenery behind or in front of them, following
`LookPasses` and the [pass rules](#pass-rules-for-presentation-points); hide an empty front.
Keep membership changes incremental, batch/shared geometry and materials, reuse scratch and
allocate nothing in `update`. The look draws only: species, collision, hits and decisions stay
the engine's. The SDK exports `EnemyEvent`, `EnemyPose`, `EnemyArtSettings`, `ENEMY_SPECS`,
`ENEMY_LIMITS`, `ENEMY_DIRECTION` and `ENEMY_BEHAVIOR`. Pass roots are detached before disposal.

A game's own aggregate sprite renderer can replace it without replacing any object look:

```ts
import { defineRuntime, LOOKS, replace } from '../../src/plugins/runtime-sdk';
import type { EnemyLookFactory } from '../../src/plugins/runtime-sdk';
import { enemySprites } from './enemy-sprites';

const enemies: EnemyLookFactory = art => enemySprites(art);
export default defineRuntime({ start: () => [replace(LOOKS.enemies, enemies)] });
```

## Phantom looks

`LOOKS.phantoms`, the slot `looks.phantoms`, holds a `PhantomLookFactory`,
`(options: { readonly figures: number }) => PhantomLook`:

```ts
interface PhantomLook {
  readonly root: Object3D;
  draw(figures: readonly PhantomFigureFrame[], head: HammerHead): void;
  dispose(): void;
}
```

The factory is resolved once per runtime session when a phantom consumer starts. Only those
consumers import playback and the default drawing: a release with neither a phantom backend
nor bundled recordings includes neither. The runtime catalogue still lists `LOOKS.phantoms`,
without importing its implementation. A look is created with a fixed slot count: up to three
playing figures plus a held slot in releases, or just a held slot for the Workshop's replay
viewer. `PhantomPlayback` owns which recordings play, sampling, timing, fades, `hold` and
`clear`; the look only draws. The Workshop resolves the look from its runtime session too.

Every `draw` receives **all slots**, in stable order, as reused, read-only `PhantomFigureFrame`
values:

| Field | Meaning |
| --- | --- |
| `visible` | Whether this slot shows; hide the drawing of a hidden slot |
| `pose` | A reused `PhantomPose`: `x`, `y`, `pot`, `angle`, `along`, `across` |
| `tool` | A reused `PhantomTool`: `tipX`, `tipY`, `buttX`, `buttY` |
| `handleLength` | The recording's handle length, in metres |
| `opacity` | The engine's fade factor, 0..1; multiply by the look's own base opacity |
| `fresh` | A new recording or discontinuous seek: reset the slot's drawing history |
| `dt` | Playback seconds for drawing history, 0 when fresh; a pause also has 0 but is not fresh |

`head` is the current rig settings' `HammerHead` (`SceneFrame.rig.head`), as in the engine's
original phantoms: not the recorded player's or a selected library hammer's own outline.
Playback calls `draw` **only while at least one slot shows** and controls the root's visibility, hiding it when the
last slot ends without a final empty draw. It may also draw when `play` or `hold` changes a
slot between game frames; other slots then get `dt = 0`, never a second advance.

`DEFAULT_PHANTOM_LOOK` creates the pooled `PhantomView`: the original translucent white
silhouettes, opacity 0.38 times the fade, with default sliding grips and arm IK. Geometry is
shared and target vectors, solver scratch, poses and quaternions are reused: no per-frame
allocation. Keep your own figures pooled too; never retain the input as a snapshot.
The root draws in **actors**, over the course; phantoms never collide and the input preserves
the recorded course-plane positions. The default translucent parts retain their nearer-part-first
depth ordering; the [front, arms, marks and tool passes](#pass-rules-for-presentation-points) are
unchanged. The engine detaches the root before `dispose`. Recording and network services stay
outside this point; see [phantoms](phantoms.md).

To raise the default ghosts slightly, without changing playback:

```ts
import { defineRuntime, LOOKS, wrap } from '../../src/plugins/runtime-sdk';

export default defineRuntime({
  start() {
    return [wrap(LOOKS.phantoms, previous => options => {
      const look = previous(options);
      look.root.position.y = 0.1;
      return look;
    })];
  },
});
```

The phantom default is engine-only, not exported by the SDK. Wrap the previous factory to
extend it without importing a feature that a release may omit.

## Scene layers

`SCENE_LAYERS`, the list `scene.layers`, holds up to 32 `SceneLayerFactory` values
(`SCENE_LAYER_LIMITS.layers`), `() => SceneLayer`. The engine default is an empty list.

```ts
interface SceneLayer {
  readonly root: Object3D;
  readonly pass: 'course' | 'actors' | 'marks';
  update?(frame: SceneFrame): void;
  dispose?(): void;
}
interface SceneFrame {
  readonly time: number;
  readonly parts: readonly Readonly<PartPose>[];
  readonly player: ScenePlayerFrame;
  readonly cursor: Readonly<Point>;
  readonly enemies: readonly EnemyPose[];
  readonly rig: RigGeometry;
}
```

Factories run once per Game, and their roots are added in manifest order to the selected pass.
The returned root, pass and methods stay the same for the layer's lifetime.
Only layers with `update` receive a per-frame callback; static layers are still drawn.
`SceneFrame` is one reused, read-only view of the simulation at the drawn time, unaffected by
a temporary character presentation preview. `time` is simulation seconds and rewinds on a
restart; all member references are borrowed. Read during the call, never keep the frame as a
previous snapshot, allocate nothing and update changed objects only.

`player.phase` is `'alive'`, `'dying-rigid'` or `'dying-ragdoll'`. All expose `centre`;
live frames expose `shoulder`, and death frames expose the interpolated physical `pose`,
captured `layout` and `headFacing`, and the death writer's `presented` appearance, including
its facial quaternion and sprite brightness. Use these
typed phases rather than searching for a `root` part: ragdolls have no live root.
`parts` still describe physics and collision, not authored death-pose changes. Hurt effects
use this same frame; fatal lava follows `player.presented.torso` until placement.

Layers obey the [obstacle-line and pass rules](#pass-rules-for-presentation-points): collider
visuals stay on the obstacle line in actors, and all marks materials ignore depth. Layers
never change physics or authored data, and cannot introduce a new pass. Roots detach before
the optional `dispose`, when removed or when the Game closes; free owned geometry/materials
there. [Workshop overlays](workshop-plugins.md#the-running-game) use exactly the same
`SceneLayer` and `SceneFrame` contract, re-exported by the Workshop SDK.

An extra cursor guide, built once and moved without allocating:

```ts
import { Mesh, MeshBasicMaterial, RingGeometry } from 'three';
import { add, defineRuntime, OBSTACLE_LINE, SCENE_LAYERS } from '../../src/plugins/runtime-sdk';
import type { SceneLayerFactory } from '../../src/plugins/runtime-sdk';

const guide: SceneLayerFactory = () => {
  const mesh = new Mesh(new RingGeometry(0.2, 0.22, 32),
    new MeshBasicMaterial({ color: 0x35ffbe, depthTest: false, depthWrite: false }));
  return {
    root: mesh, pass: 'marks',
    update(frame) { mesh.position.set(frame.cursor.x, frame.cursor.y, OBSTACLE_LINE); },
    dispose() { mesh.geometry.dispose(); mesh.material.dispose(); },
  };
};
export default defineRuntime({ start: () => [add(SCENE_LAYERS, guide)] });
```

## Audio

`AUDIO` is the slot `audio.output`, holding a `GameAudioFactory`. A plugin replaces the audio
output or wraps it to change just one cue, while music and the other cues keep working.
The point, contracts, silent base and creation checks live in
[`src/game-audio.ts`](../src/game-audio.ts), independently of the optional
[`src/audio.ts`](../src/audio.ts) implementation.

```ts
type GameAudioFactory = (setup: GameAudioSetup) => GameAudio;

interface GameAudioSetup {
  readonly settings: AudioSettings;
  readonly media: MediaHost;
  readonly sounds: readonly string[];
  readonly device: AudioDevice;
  notice(message: string): void;
}

interface GameAudio {
  handle(cue: GameCue): void;
  setPaused(paused: boolean): void;
  setSettings(settings: AudioSettings): void;
  setMedia(media: MediaHost): void;
  dispose(): void;
  inspect?(): unknown;
}
```

- `settings` are the project's [audio settings](projects.md#section-reference): master volume,
  looping music and a clip or `null` for each cue. `sounds` lists the initial level's authored
  play-sound sources to preload. `media` loads authored sound bytes and streams music; a release
  resolves these sources through its packaged content and access grants. `notice(message)`
  reports an audio failure without stopping play.
- `handle` receives a `GameCue`: `{ type: 'cue', cue: AudioCue, strength: number }` for a gameplay
  moment, or `{ type: 'sound', source: string, volume: number }` for a play-sound event. The
  closed cue list is `AUDIO_CUES`: `impact`, `enemy-hit`, `enemy-defeat`, `launch`, `finish`,
  `hurt`, `death`, `fall` and `bonfire`. Impact strength is 0-1; other cues have strength 1.
  Gameplay cues arrive in source order after the frame's step loop and look notifications, before
  gameplay observers and rendering, outside `Simulation.step` and physics callbacks. Closing or
  stopping the Game drops staged deliveries. Cue objects are reused and read-only: consume during
  `handle`, never retain them.
  **Game limits impacts at the source to one per 70 ms**, before any output or wrapper sees
  them, when staging the impact event, not in the output. The Workshop's cue preview shares
  that limit but goes directly to the output, independently of gameplay staging and observers,
  and remains available after gameplay stops; previews are guarded by the audio output's
  disposal, not the Game's lifecycle.
- `setPaused` receives the initial state when play starts, then only pause-state changes.
  `setSettings` previews new project audio settings in the Workshop, and `setMedia` tells the
  output to drop media cached for files that changed. Forward all three in a wrap so the
  previous output's music, settings and caches stay correct.
- `dispose` releases the output's sources, media elements and subscriptions. The host disposes
  the shared device after the output, and the runtime session after its consumers.
  `inspect`, optional, supplies `window.gettingOver.gameProject().playback` in the Workshop.

The engine provides **one `AudioDevice` per Game**:

| Member | Meaning |
| --- | --- |
| `context` | The shared `AudioContext`, or `null` until the first gesture or when Web Audio is unavailable |
| `output` | The master `GainNode`, or `null` with the context; connect effect nodes here, never straight to `context.destination` |
| `onUnlock(listener)` | Calls the listener after the first pointer, key or touch gesture, including when Web Audio is unavailable; a late subscriber runs immediately. Returns an unsubscribe function |
| `setVolume(volume)`, `dispose()` | Host-owned: the engine keeps project volume in sync independently of the chosen output, then closes the device. Plugins must not call these |

Never create another `AudioContext`, close the shared one or bypass its output. Allocate and
connect effect nodes only when a cue plays, preload and decode sources once, and keep no
animation loop for audio. The SDK exports `AudioDevice` only as a type; use `setup.device`,
never construct a device. Abort your loads and stop/disconnect your nodes on disposal.

**Defaults.** `DEFAULT_AUDIO_OUTPUT` builds the engine's `AudioDirector`: sounds fetched ahead
of time and decoded on unlock, streamed looping music that pauses with play, and the authored
cue clips, with impact volume scaled by strength. This implementation factory stays in
`src/audio.ts` for `virtual:game-audio` and the Workshop; the runtime SDK does not export it.
The Workshop always uses this base. A release
whose content has no audio or sound events gets `null` from `virtual:game-audio` and uses
`SILENT_AUDIO_OUTPUT` as its base instead. The lightweight `game-audio.ts` module has no
dependency on `AudioDirector`. The release still resolves and creates `AUDIO`, so a replacement
or a wrap works without authored audio. Without gameplay observers, the unchanged silent base
enables neither impact tracking nor a Web Audio context; a replacement or wrapper enables the
shared device and cue delivery. Gameplay observers enable impact tracking even with silent
audio, but do not enable a Web Audio context.

To extend the engine's audio, use `wrap(AUDIO, previous => ...)`: `previous` is the engine's
selected base or an earlier plugin's factory, so the wrap preserves music and every cue it
passes on without importing the director.
Feature-gated defaults, such as the audio director and the phantom look, are reached through
`wrap`, not imported from the runtime SDK.

### Synthesizing one cue

This complete runtime facet extends the engine's audio through `wrap(AUDIO, ...)`, composing
with whichever output precedes it, even the silent release base.
Hammer impacts thud with a synthesized tone; music, authored sounds and every other cue stay
with the previous output. Add it as the `runtime` facet of a plugin in your manifest.

```ts
// games/my-game/runtime.ts
import { AUDIO, defineRuntime, wrap } from '../../src/plugins/runtime-sdk';
import type { GameAudio } from '../../src/plugins/runtime-sdk';

export default defineRuntime({
  start() {
    return [wrap(AUDIO, (previous) => (setup) => {
      const inner = previous(setup);
      const tones = new Map<OscillatorNode, GainNode>();
      return {
        handle(cue) {
          if (cue.type !== 'cue' || cue.cue !== 'impact') {
            inner.handle(cue);
            return;
          }
          const { context, output } = setup.device; // null until the player's first gesture
          if (context === null || output === null) return;
          const tone = context.createOscillator();
          const gain = context.createGain();
          const now = context.currentTime;
          tone.frequency.value = 70;
          // An exponential envelope stays positive, including for the weakest impact.
          gain.gain.setValueAtTime(Math.max(0.001, 0.6 * cue.strength), now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
          tone.connect(gain).connect(output);
          tones.set(tone, gain);
          tone.onended = () => {
            tone.disconnect();
            gain.disconnect();
            tones.delete(tone);
          };
          tone.start();
          tone.stop(now + 0.25);
        },
        setPaused: (paused) => inner.setPaused(paused),
        setSettings: (settings) => inner.setSettings(settings),
        setMedia: (media) => inner.setMedia(media),
        inspect: () => inner.inspect?.(),
        dispose() {
          for (const [tone, gain] of tones) {
            tone.onended = null;
            tone.stop();
            tone.disconnect();
            gain.disconnect();
          }
          tones.clear();
          inner.dispose();
        },
      } satisfies GameAudio;
    })];
  },
});
```

The shared master gain applies project volume to the synthesized tone too. Its short-lived
nodes exist only while sounding, and disposal stops any still in flight.

## Gameplay events

`EVENTS`, the list `game.events`, adds up to 32 `GameObserverFactory` values. The engine's base
is an empty list. Each factory runs once per Game, in manifest order, with no engine objects:

```ts
type GameObserverFactory = () => GameObserver;
interface GameObserver {
  event(event: GameEvent): void;
  dispose?(): void;
}
```

`GameEvent` is a small discriminated union exported by the runtime SDK:

| `type` | Additional fields and meaning |
| --- | --- |
| `hurt` | `health`, `max`: the simulation's remaining health and maximum after a nonlethal hurt in the step batch, independent of whether the HUD shows health; `cause`: what dealt the hit, a [`HurtCause`](#hurt-effects) with its `source` (`enemy`, `projectile`, `axe` or `lava`), the `id` of the level object that dealt it, where it struck (`x`, `y`) and the velocity it knocked the player with (`pushX`, `pushY`) |
| `death` | The health death sequence started; `cause`: what dealt the killing hit, as for `hurt` |
| `fall` | The fall death sequence started; takes precedence over death if both occur in the same step |
| `respawn` | `bonfire`: the checkpoint's ID, or `null` when the automatic reset path returns to the attempt's start |
| `restart` | A new attempt: Reset, a rebuilt rig or a replacement level, not a checkpoint return |
| `bonfire` | `id`: a newly reached checkpoint, including a previously lit bonfire other than the current checkpoint |
| `enemy-hit` | `id`: an enemy transitioned to hurt after a surviving hit |
| `enemy-defeat` | `id`: an enemy transitioned to defeated |
| `impact` | `strength`: normalized 0–1 hammer-impact strength, limited at the source to one per 70 ms |
| `launch` | An authored Launch player action executed |
| `finish` | An authored Stop timer action executed |
| `sound` | `source`, `volume`: an authored play-sound action executed |

There is no boot `restart` event. An automatic return without a checkpoint uses the ordinary
reset action, so it emits `death` or `fall`, then `restart`, then `respawn` with `bonfire: null`
once the player has been placed. A checkpoint return emits `death` or `fall`, then `respawn`
with its bonfire ID; its timer and attempt continue. Messages and videos keep their
[presentation contracts](#messages); they are not additional `GameEvent` variants. Cue previews
do not notify observers.

`death`/`fall` arrive at sequence entry, not placement. `restart`/`respawn` arrive only
after its snapshotted `death.wait` and placement. An explicit cancellation such as Reset emits
the ordinary `restart`, never an automatic `respawn`. A simultaneous killing hit and fall
still stages fatal hurt effects, but only the `fall` gameplay event and cue.

**Schedule and ownership.** The Game stages notifications in reusable storage while its
physics-step loop runs. After the loop, and before rendering, it flushes:

1. Enemy look changes in order, the bonfire look's latest lit set at most once, then hits and
   placements for the [hurt effects](#hurt-effects) in order, followed by
   [projectile blocks](#block-effects), whether or not anything else consumes events.
2. Audio, mapping those gameplay events to the existing cues and authored sounds in source order.
   `restart` and `respawn` have no cues.
3. Gameplay observers: each event in source order, with observers called in manifest order.

Terrain changes stay synchronous and engine-only. No look, audio output, gameplay observer or
input device runs inside `Simulation.step` or a physics callback. Notifications from asynchronous
trigger continuations or a reset between frames join the next flush, even while paused.
Notifications raised by delivery callbacks join the following flush, not the batch being
delivered. Hurt and block notices carry their placement: superseded notices cannot ignite
a newly placed character or show an old block, and its hurt clear is applied before drawing
even when a delivery callback resets again. Started world-anchored bursts can still finish.
Pools grow only when a burst exceeds their previous high-water capacity.

Events are **read-only borrowed objects, reused by the engine**. Read them only during
`event`; never retain one or compare it with an event from an earlier call. Save scalar fields
into your own state instead. `event` must finish synchronously; promise-like returns are errors.
Observers run only when events occur, never on idle frames. The engine checks factories and
returned observers with `PluginError`, naming the plugin and point; a throwing observer stops
the game with the same attribution, never silently removing it. `dispose`, when supplied,
runs with Game cleanup; every part is attempted before the first cleanup error is rethrown.

For example, report reached checkpoints without changing the gameplay rules:

```ts
import { add, defineRuntime, EVENTS } from '../../src/plugins/runtime-sdk';
import type { GameObserverFactory } from '../../src/plugins/runtime-sdk';

export default defineRuntime({
  start(host) {
    const checkpoints: GameObserverFactory = () => ({
      event(event) {
        if (event.type === 'bonfire') host.notice(`Reached checkpoint ${event.id}.`);
      },
    });
    return [add(EVENTS, checkpoints)];
  },
});
```

For a game's own sound moments, keep the shared `setup.device` from an [audio factory](#audio)
in the facet's closure and use it from an observer. Do not create another audio context or add
an audio animation loop.

## Input

The engine's pointer input remains responsible for mouse capture, canvas drag and touch.
Runtime plugins can change its keyboard bindings or add devices without replacing those controls.

### Key bindings

`INPUT_BINDINGS`, the slot `input.bindings`, resolves once per session with
`DEFAULT_INPUT_BINDINGS` as its base:

```ts
type BindableAction = 'reset' | 'pause' | 'recenter';
type InputBindings = Readonly<Record<string, BindableAction>>;

// DEFAULT_INPUT_BINDINGS is frozen.
const bindings: InputBindings = Object.freeze({ r: 'reset', p: 'pause', ' ': 'pause', c: 'recenter' });
```

Keys are nonempty, lowercase **`KeyboardEvent.key`** values, not physical `code` values;
Space is `' '`, and named keys use forms such as `'arrowleft'`. The resolved record is
validated and copied into a frozen snapshot: uppercase keys, symbols, non-record values and
actions other than exactly `reset`, `pause` and `recenter` are errors naming the contributor.
A replacement supplies the whole map, so omitted keys are unbound; a wrap can preserve
previous bindings:

```ts
import { defineRuntime, INPUT_BINDINGS, wrap } from '../../src/plugins/runtime-sdk';

export default defineRuntime({
  start: () => [
    wrap(INPUT_BINDINGS, previous => Object.freeze({ ...previous, q: 'reset' })),
  ],
});
```

The existing guards still apply: interaction blocks disable shortcuts; repeats, composing text
and Meta/Ctrl/Alt shortcuts are ignored; text inputs and editable content keep their keys.
Space still activates a focused button or summary rather than pausing. Escape releases a
captured mouse before consulting the map. Unbound keys can still reach the Workshop's own
shortcut handler, so the default D and practice-number shortcuts remain unchanged.
The Workshop's pause/reset key hints use this same cached binding snapshot, listing its bound
keys and hiding the keyboard hint when an action has none; the buttons remain available.

### Additional input devices

`INPUT_DEVICES`, the list `input.devices`, adds up to 32 `InputDeviceFactory` values to an
empty engine base. Each is created once per Game, in manifest order:

```ts
type InputDeviceFactory = (host: InputDeviceHost) => InputDevice;

interface InputDeviceHost {
  action(action: BindableAction): void;
  readonly signal: AbortSignal;
}

interface InputDevice {
  poll(dt: number, out: { x: number; y: number }): void;
  dispose?(): void;
}
```

- `poll` runs once per visible frame before physics, including paused and input-blocked
  frames, and only while devices exist. Paused polling lets `host.action('pause')` toggle
  the user's pause reason and resume, just as the keyboard does. All devices are polled in
  manifest order unless the Game stops. `dt` is frame seconds, clamped to the engine's
  maximum physics-step budget.
- **Add** course-plane hammer movement in **metres**, +x right and +y up, into `out`.
  It starts at zero each frame and contains earlier devices' movement; never zero it or replace
  another device's contribution. The Game adds the sum to the pointer's converted movement and divides it
  across the physics steps. Mouse conversion follows camera world height, while touch
  conversion remains reach-based; neither scale is applied to device movement.
- Device movement is consumed only when that frame runs physics steps with input enabled.
  Paused, hidden, input-blocked and zero-step frames discard it; it never carries into a
  later frame. Player placements clear movement, and a reset during polling also discards
  that polling frame's movement.
- `out` is borrowed, reusable scratch: never retain it. Finish synchronously, never return a
  promise, and add only finite movement. Invalid outputs and throwing polls stop the game with
  a `PluginError` naming the plugin and `input.devices`.
- Use `host.action` from polling or input listeners for the same reset, pause and recenter
  actions as the keyboard, not while constructing the device. It is ignored while interaction
  is blocked or the Game has stopped. `signal` aborts when the Game stops or is disposed; use
  it to remove listeners and cancel work. Optional `dispose` runs with Game cleanup.
- Factories and returned devices are checked where created. No device gets a Simulation,
  view, canvas or engine internals; no device callback runs inside physics.

### Gamepad example

The left stick moves each hammer axis at up to 3 metres per second with a small dead zone;
button 0 resets on its rising edge. The browser supplies the gamepad snapshot; the device
creates no movement objects per poll:

```ts
import { add, defineRuntime, INPUT_DEVICES } from '../../src/plugins/runtime-sdk';
import type { InputDeviceFactory } from '../../src/plugins/runtime-sdk';

const gamepad: InputDeviceFactory = host => {
  let resetDown = false;
  return {
    poll(dt, out) {
      const pad = navigator.getGamepads()[0];
      const reset = pad?.buttons[0]?.pressed === true;
      const pressed = reset && !resetDown;
      resetDown = reset;
      if (pressed) {
        host.action('reset');
        return;
      }
      if (!pad) return;
      const x = pad.axes[0] ?? 0;
      const y = pad.axes[1] ?? 0;
      if (Math.abs(x) > 0.15) out.x += x * 3 * dt;
      if (Math.abs(y) > 0.15) out.y -= y * 3 * dt;
    },
  };
};

export default defineRuntime({ start: () => [add(INPUT_DEVICES, gamepad)] });
```

## Messages

The three independent slots are `MESSAGES.toasts` (`messages.toasts`), `MESSAGES.popup`
(`messages.popup`) and `MESSAGES.video` (`messages.video`). The project's message style still
chooses toasts or popups. The Workshop still skips trigger videos; releases and studio previews
play them. All three points resolve once per session, even when that policy skips videos.
The separate [`DEATH_SCREEN`](#death-screen) slot, `messages.death`, presents the engine's
death sequence without modal ownership.

### Toasts

`ToastsFactory` is `(mount: HTMLElement) => Toasts`:

```ts
interface Toasts {
  show(message: MessageAction): boolean;
  clear(): void;
  setHeld(held: boolean): void;
  dispose(): void;
  inspect?(): unknown;
}
```

`MessageAction` is `{ type: 'message', title: string, message: string }`.

- `show` accepts or queues a message and returns `true`; return `false` when no more can wait.
  The engine reports that as an event failure; any non-boolean result is `invalid-contribution`,
  naming the plugin. A toast never pauses play, takes input or holds up a trigger's next event.
- `clear` starts a new run: drop waiting messages and dismiss the one showing.
- `setHeld(true)` holds the toast while a popup, video or death owns the player's attention;
  `false` resumes it only after every hold releases. The engine owns this hold regardless
  of which presenters are chosen.
- `dispose` cancels animation, removes owned nodes and releases listeners when the Game closes.
  `inspect`, optional, supplies the `toasts` field of the Workshop's presentation diagnostics.

`DEFAULT_MESSAGE_TOASTS` creates the engine's `MessageToasts`: one procedural toast at a time,
duplicate messages coalesced, at most three waiting, and a fade for reduced motion. It requests
frames only while a toast shows and is not held; it costs no animation frames when idle.
Keep that active-only rule in replacements, bound the queue and reuse drawing resources.

### Popups and videos

`PopupPresenter` is `(action: MessageAction, context: PresentationContext) => Promise<EventOutcome>`.
`VideoPresenter` has the same contract with `VideoAction`, `{ type: 'play-video', source: string }`.

```ts
interface PresentationContext {
  readonly mount: HTMLElement;
  readonly signal: AbortSignal;
  readonly media: MediaHost;
  readonly previouslyFocused: HTMLElement | null;
  setState(state: PresentationState): void;
  onClose(): void;
}
```

- `EventPresenter` keeps the modal state machine: exactly one presentation at a time, pausing
  gameplay, blocking game input and holding toasts until it closes. An active video covers the
  game view, so rendering that view stops until the video closes. Replacing a presenter does
  not change these rules.
- Append only your own nodes to `mount`, and remove only those nodes. Stream authored videos
  with `media.stream(source, signal)`; it returns `Promise<MediaStream>`, with
  `{ readonly url: string; readonly crossOrigin: 'anonymous' | 'use-credentials' | null }`.
- `setState` reports diagnostic progression: `popup`, `loading`, `awaiting-input` or `playing`
  (`PresentationState`). The host starts a popup in `popup`, a video in `loading`; a custom
  presenter need not report further states unless its UI has them.
- Settle with `completed`, `skipped` or `cancelled` (`EventOutcome`). After synchronous cleanup,
  `onClose()` releases the modal before you restore focus, just before settling the promise.
  `previouslyFocused` is captured before modal input blocking; restore it if it is still in the
  document and is not the body. A presenter that does not call `onClose` is closed when its
  promise settles.
- `signal` cancels the presentation when its event aborts or the presenter is disposed, even if
  a plugin's promise has not settled; remove UI and listeners and stop media synchronously on
  abort. The host also aborts it to clean up a failed presentation. Successful closing does not
  abort the signal: release resources on normal settlement too, as the defaults do with their
  own listener controller. Late results cannot close a newer modal.
- Use `EventExecutionError` for an expected media/presentation refusal: the trigger reports it
  and play continues. Unexpected throws or rejections are `PluginError` with the plugin and
  point; a non-promise result or invalid outcome is `invalid-contribution`, never a silent
  fallback to the default.

`DEFAULT_MESSAGE_POPUP` and `DEFAULT_MESSAGE_VIDEO` use the engine's `Presentation`: the same
ARIA dialogs, focus trap and restoration, Tab cycling and Escape behavior, Continue/Skip
controls, and streamed HTML video with gesture-required playback and fullscreen controls.
Video loading, playback refusals and media errors retain their event failure paths.
Defaults and replacements do work only while presenting; do not add an idle animation loop.

## Wrapping a default

`wrap(point, decorate)` builds on what a point holds so far: `decorate` receives the previous
factory, the engine's own or an earlier plugin's, and returns the factory the game uses. The
previous factory still draws, and the wrapper adds to it. `DEFAULT_HUD_READOUTS`,
`DEFAULT_LOOKS`, `DEFAULT_CAMERA_DIRECTOR`, `DEFAULT_BACKDROP`, `DEFAULT_AIM_MARKS`,
`DEFAULT_HURT_EFFECTS`, `DEFAULT_BLOCK_EFFECTS`, `DEFAULT_DEATH_SCREEN` and `DEFAULT_CHARACTER_CHOICE` are the engine's
own factories, the points' bases, for a plugin that replaces a point but draws the engine's
part inside its own. Forward every contract method explicitly when wrapping an instance;
its methods may live on a prototype, so spreading it does not copy them.
Feature-gated defaults, such as audio and phantom drawing, are not SDK exports: extend them with `wrap`.

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
- Points reject non-function factories or writers. Creating a readout, director, backdrop, marks,
  hurt or block effects, death screen, look, layer, audio output, toast presenter, character choice,
  gameplay observer or input device
  checks the returned object's required and optional methods and, where applicable, roots
  and passes. A factory, or a wrap, that throws fails with `plugin-failed`; a malformed return
  fails with `invalid-contribution`. Each names the plugin and point, including the contributor
  of an extra readout or other list item. A director that writes a non-finite aim or a
  non-positive height also fails explicitly.
- A death screen's methods and a death-pose writer must finish synchronously.
  Malformed poses and promise-like results fail with `invalid-contribution`; throws
  are `plugin-failed`, with the owner and point. No invalid output is clamped or masked.
- Key bindings must be a lowercase-key record of the three bindable actions. An observer's
  `event` and a device's `poll` must complete synchronously, without a promise-like return;
  a device must add finite movement. Violations fail with `invalid-contribution`, naming
  the plugin and point; a thrown callback is `plugin-failed` with its cause.
- Audio and toasts require their lifecycle methods, and an optional `inspect` must be a
  function. Popup/video results must be promises of a valid `EventOutcome`, and a toast's
  `show` must return a boolean, as hurt and block effects' `update` must; malformed results fail with
  `invalid-contribution`, naming the plugin and point.
- At facet startup, contribution validation, point resolution or consumer creation, a refusal
  stops the environment that encounters it with a fatal error naming the plugin. The engine
  never falls back to its own presentation silently.
- An error a runtime presentation object throws while the game runs stops the game and shows
  the error, as any error in the game does. Workshop overlays retain their
  [isolated plugin lifecycle](workshop-plugins.md#lifecycle).
- An expected `EventExecutionError`, such as a video that cannot load or a full toast queue,
  instead fails that trigger event and reports a notice, without stopping play.

## Complete example

[`examples/plugins`](../examples/plugins) holds one plugin, `example`, with a runtime facet. It
draws the health readout as a bar, styled by its own [`health-bar.css`](../examples/plugins/health-bar.css),
and projectiles as glowing orbs. Its manifest, `examples/plugins/plugins.json`:

```json
{
  "apiVersion": 2,
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
