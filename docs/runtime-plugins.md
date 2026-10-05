# Runtime plugins

A plugin's **runtime facet** changes what play shows and sounds: HUD readouts, camera following,
backdrop, aim marks, object, enemy and phantom looks, scene layers, audio and event messages.
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

`out` holds the current aim on entry. Write the next coordinates and a finite, positive
`worldHeight` in place; allocate nothing in either method. `aim` runs each drawn frame, and
`snap` on a resize, a recenter or a player placed anew. `DEFAULT_CAMERA_DIRECTOR` preserves the
engine's full/compact framing, exponential follow and compact keep-the-rig-visible clamp.
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
  update(tip: Readonly<Point>, cursor: Readonly<Point>): void;
  dispose(): void;
}
```

The root draws in **marks**, over the characters and their arms, under the tool.
**All its materials must ignore depth (`depthTest: false`), leaving the arms/tool depth
alone**, as the [pass rules](#pass-rules-for-presentation-points) require. This point changes
drawing only, never aiming or input. `DEFAULT_AIM_MARKS` is the original ring and centre dot
and dashed line from the hammer tip to the cursor, recoloured from `theme.aim`. It reuses both
position and line-distance attributes. `update` receives borrowed, read-only points each drawn
frame, including a character presentation preview's movement. Reuse geometry, materials and
scratch; allocate nothing per frame. The engine detaches the root before `dispose`.

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
    update(_tip, cursor) { mesh.position.set(cursor.x, cursor.y, 1); },
    dispose() { mesh.geometry.dispose(); mesh.material.dispose(); },
  };
};

export default defineRuntime({ start: () => [replace(AIM_MARKS, dot)] });
```

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
  Gameplay cues arrive in source order through lifecycle-guarded microtasks, outside `Simulation.step`
  and physics callbacks; closing or stopping the Game drops pending deliveries.
  **Game limits impacts at the source to one per 70 ms**, before any output or wrapper sees
  them, checking delivery time so a long frame cannot bunch deferred impacts. The Workshop's
  cue preview shares that limit but remains available after gameplay stops; previews are guarded
  by the audio output's disposal, not the Game's lifecycle.
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
or a wrap works without authored audio. The unchanged silent base enables neither impact tracking nor a Web
Audio context; a replacement or wrapper enables the shared device and cue delivery.

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

## Messages

The three independent slots are `MESSAGES.toasts` (`messages.toasts`), `MESSAGES.popup`
(`messages.popup`) and `MESSAGES.video` (`messages.video`). The project's message style still
chooses toasts or popups. The Workshop still skips trigger videos; releases and studio previews
play them. All three points resolve once per session, even when that policy skips videos.

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
- `setHeld(true)` holds the toast while a popup or video owns the player's attention; `false`
  resumes it. The engine owns this hold regardless of which modal presenter is chosen.
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
`DEFAULT_LOOKS`, `DEFAULT_CAMERA_DIRECTOR`, `DEFAULT_BACKDROP` and
`DEFAULT_AIM_MARKS` are the engine's own factories, the points' bases, for a plugin that replaces
a point but draws the engine's part inside its own. Forward every contract method explicitly when wrapping an
instance; its methods may live on a prototype, so spreading it does not copy them.
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
- Points reject non-function factories. Creating a readout, director, backdrop, marks, look,
  layer, audio output or toast presenter checks the returned object's required and optional
  methods, roots and passes. A
  factory, or a wrap, that throws fails with `plugin-failed`; a malformed return fails with
  `invalid-contribution`. Each names the plugin and point, including the contributor of a list
  layer. A director that writes a non-finite aim or a non-positive height also fails explicitly.
- Audio and toasts require their lifecycle methods, and an optional `inspect` must be a
  function. Popup/video results must be promises of a valid `EventOutcome`, and a toast's
  `show` must return a boolean; malformed results fail with `invalid-contribution`, naming
  the plugin and point.
- As the Workshop or a release starts, any of these stops it with a fatal error naming the
  plugin. The engine never falls back to its own presentation silently.
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
