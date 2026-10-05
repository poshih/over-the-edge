# Workshop plugins

A game can add its own tools to the Workshop without editing the engine: tabs and sections
built from the Workshop's own controls, edits made through the engine's own operations,
data of its own kept in the project, and overlays, canvas drags and previews in the running
game. It names one editor-only module with **`WORKSHOP_MODULE`**:

```sh
WORKSHOP_MODULE=games/my-game/workshop.ts npm run dev
WORKSHOP_MODULE=games/my-game/workshop.ts GAME_PROJECT=projects/my-game npm run build
```

Without the module the Workshop is exactly as before.

## The module

The module is a `.ts` or `.js` file inside the repository, with the containment rules of
[`AVATAR_RIG_MODULE`](characters.md#rig-strategies). Its default export is a `WorkshopModule`:
the API version (`1`, `WORKSHOP_API_VERSION`) and at most 32 plugins. Each plugin has an `id`
of 1-64 lowercase letters, digits and hyphens, starting with a letter, a `start(host)`, and an
optional `validate(data)` for its own data.

- **One SDK.** A plugin imports nothing from `src/editor` except
  [`src/editor/workshop-sdk.ts`](../src/editor/workshop-sdk.ts), which defines the plugin
  contract, the host and the UI kit and re-exports every type they use. It may also import the
  engine's public runtime SDKs, such as `src/avatar-rig.ts`, and the game's own code.
- **Checked at start.** When the Workshop's dev server or build starts, Node imports the module
  through its own resolver and checks it, as it checks the rig module, so the module must be
  free of side effects when imported: it may define DOM code but not run it. Use relative paths
  and bare package imports, not the app's aliases or `virtual:` modules. A wrong API version, an
  invalid or duplicate ID or a malformed plugin stops the start with a `WorkshopPluginError`
  coded `api-version`, `invalid-plugin` or `duplicate-plugin`.
- **Trusted code.** Plugins are the game's own code, like its rig module, never content, and
  run without a sandbox.
- **Editor-only.** The game-only build fails if game code imports the module or any editor
  module, and releases contain none of a plugin's code or data.

## Lifecycle

- The Workshop starts each plugin once the project is open, with a host of its own.
  `host.signal` aborts when the plugin stops.
- An error a plugin throws, or a promise it rejects, in `start`, `validate`, a listener, a UI
  kit callback, an overlay or a preview, stops that plugin alone. The Workshop shows the error
  with the plugin's ID; the Workshop and the other plugins go on. A failed plugin stays stopped
  until the module changes. Callbacks the plugin registers elsewhere, such as its own timers,
  get the same treatment through `host.guard(callback)` and `host.listen(target, type, listener)`.
- Stopping removes everything the plugin added: its tabs and sections, overlays, listeners,
  preview, pause and drag. A stopped plugin's host then refuses anything that would add or
  change something, with `plugin-stopped`.
- Changing the module, or anything it imports, stops the plugins and starts them again; the
  project, with its unsaved changes, stays. A module that becomes invalid runs no plugins until
  it is fixed.
- `window.gettingOver.plugins()` lists the plugins, whether each is running and each one's
  last error.

## Places in the Workshop

- `host.addTab({ id, label, title? })` adds a tab after the built-in ones.
- `host.addSection(tab, { id, title, hint?, open? })` adds a collapsible section at the end of
  `character`, `level`, `physics` or `project`. The Workshop remembers whether it is open, as it
  does for its own sections.
- Each returns a mount: its `element`, whether it is `shown` (its tab is selected in the open
  Workshop, and a section is expanded), `onVisibility(listener)` and `remove()`. IDs are unique
  among a plugin's tabs and sections.
- `host.ui` builds the Workshop's own controls: `range` (a slider with step buttons, as in
  Physics), `button`, `select`, `toggle`, `group` (a titled group of controls), `note` and
  `notice`. Their callbacks are guarded like the plugin's other callbacks.

## The project

`host.project.snapshot()` is the open project as the Workshop holds it, unsaved changes
included: the title, game settings, level, both character profiles, model library, theme, HUD,
audio, enemy art, course artwork, media, arm IK and appearance parts. It is read-only and the
same object until the project changes, and `host.project.subscribe(listener)` tells of each
batch of changes.

`host.project.edit` holds every edit the built-in tabs make, through the same operations: the
title, game settings, the level (`upsert`, `remove`, `edit`, `labels` and `replace`, which
changes only the objects that differ, so a playtest goes on), the primary character (the whole
profile, or its rigging type, arm forward distance, waist lean, grips, arms, avatar motion and
presentation), the alternate character, arm IK and appearance parts, theme, HUD,
audio, enemy art, course artwork mode and packages, media and the model library. Each edit is
validated, changes the draft, marks it unsaved and goes through Save, Revert, export and
conflict handling as in its tab. Each returns the engine's typed error when it refuses, which
the Workshop has shown as it shows its own, or `null`. A plugin changes the project no other
way.

## A plugin's own data

Each plugin may keep one JSON document in the open project: `host.data.get()`,
`host.data.set(value)` (`null` removes it) and `host.data.subscribe(listener)`, which hears of
every change, by the plugin, a project opening or the server.

- It is stored in `project.json` under `plugins.<id>`, and is the project section
  `plugins/<id>`. The engine saves, reverts, exports and conflict-checks it like any other
  section, but never interprets it.
- It is limited to 64 KiB, nesting depth 16 and 8,192 values (`PLUGIN_DATA_LIMITS`); a project
  holds data for at most 16 plugins.
- The plugin's `validate(data)` runs whenever the section loads or changes. It refuses with a
  `WorkshopPluginError` of its own code (lowercase letters, digits and hyphens), which
  `data.set` returns. Anything else it throws is a failure: the plugin stops, and its data is
  accepted unchecked until the module changes, so a faulty plugin never holds the project back.
- A project holding data for a plugin the Workshop lacks opens with a notice naming the plugin,
  and that section stays unchanged.
- Scripts reach it at `/api/projects/{id}/plugins/{plugin}`; see [projects](projects.md#api-for-scripts-and-language-models).

## The running game

Everything here is presentation in the Workshop only: physics, gameplay, play recordings and
the authored level and profiles never see it. Without plugins nothing runs per frame; a
plugin's per-frame work runs only while its overlays or previews are active, and the engine
allocates nothing per frame on its behalf.

- **Overlays.** `game.addOverlay({ root, pass, update?, dispose? })` adds a scene layer of three.js
  objects: `course` draws with the terrain, `actors` over it with the characters, and `marks`
  over the characters and their arms, under the tool. Like the engine's own marks, a `marks`
  overlay's materials ignore depth (`depthTest: false`). `update(frame)` runs every drawn
  frame with a read-only view of the simulation's frame (time, parts, cursor, enemies and rig)
  and must not allocate; `dispose()` runs when the overlay is removed. It returns the removal.
- **Canvas input.** `game.onPointer(listener)` hears pointer events on the game canvas, unless
  the mouse is captured for play, with client pixels and the point under them on the course
  plane in metres. A listener of a `down` may `capture()` it to take the drag: the game sees
  none of the drag, and game input stays blocked under the plugin's reason only until the drag
  ends. `game.project(point)` and `game.unproject(client)` convert as the Level tab does.
- **Game control.** `game.pause(paused)` under the plugin's own reason, `game.restart()`,
  `game.placePlayer(position)` as the Level tab places the player, and `game.state()`, what
  `window.gettingOver.snapshot()` reports.
- **Avatar facts.** `game.avatar()` is the loaded imported avatar, or `null`: the model facts its
  motion kinds get (`AvatarMotionModel`), each motion's claimed joints, and
  `jointWorld(index, out)`, a skin joint's current world frame.
- **Previews.** `game.preview('sway')` and `game.preview('jolt')` run Character's Sway and
  Jolt. `game.preview({ duration, offset })` runs one of the plugin's own: for up to 10 seconds
  of game time, `offset(elapsed, out)` moves the character's whole presentation (body, pot and
  tool together) by `out.x` and `out.y` metres in the view's plane, at most 20 m, and turns it by
  `out.turn` radians about the player's root. The avatar's motions see it through `body` and
  `pot` exactly as they see real movement, so a drop, a bounce or a shake swings hair and
  [secondary motion](characters.md#secondary-motion). The camera and overlays keep the
  simulation's frame. A preview ends early on a rewind, a restart or another preview, and
  `game.preview(null)` ends the plugin's own.

## Example

A tuner kept in the game's own repository. Its tab edits a game setting, picks a joint of the
loaded avatar, marks it with a circle and runs a 1 m drop; its Character section edits a motion's
configuration; dragging from the circle resizes it, kept in the plugin's own data.

```ts
import { CircleGeometry, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { WORKSHOP_API_VERSION, WorkshopPluginError } from '../../src/editor/workshop-sdk';
import type { JsonValue, WorkshopModule, WorkshopPlugin } from '../../src/editor/workshop-sdk';

type JsonObject = { readonly [key: string]: JsonValue };
// The plugin's data: the skin joint it marks and the marker's radius in metres.
type Marker = { readonly joint: number; readonly radius: number };

const tuner: WorkshopPlugin = {
  id: 'tuner',
  validate(data) {
    const field = (key: string): unknown => typeof data === 'object' && data !== null ? Reflect.get(data, key) : undefined;
    const joint = field('joint'), radius = field('radius');
    if (typeof joint !== 'number' || !Number.isInteger(joint) || joint < 0) {
      throw new WorkshopPluginError('invalid-joint', 'The marker names a skin joint by its index, from 0.');
    }
    if (typeof radius !== 'number' || !(radius >= 0.02 && radius <= 1)) {
      throw new WorkshopPluginError('invalid-radius', 'The marker is 0.02-1 m in radius.');
    }
  },
  start(host) {
    const { ui, project, data, game } = host;
    const marker = (): Marker => (data.get() as Marker | null) ?? { joint: 0, radius: 0.1 };

    // Tuner tab: a game setting through Physics' edit, the marked joint, and previews.
    const tab = host.addTab({ id: 'main', label: 'Tuner' });
    const mass = ui.range({
      label: 'Hammer head mass', min: 0.5, max: 4, step: 0.1, unit: 'kg', value: project.snapshot().settings.physics.hammerMass,
      onInput: (value) => {
        const settings = project.snapshot().settings;
        project.edit.settings({ ...settings, physics: { ...settings.physics, hammerMass: value } });
      },
    });
    const joints = ui.select({
      label: 'Marked joint', options: [], value: '',
      onChange: (value) => { data.set({ ...marker(), joint: Number(value) }); },
    });
    // The character drops 1 m and comes back over a second; motions swing with it.
    const drop = ui.button({
      label: 'Drop 1 m',
      onClick: () => game.preview({
        duration: 1,
        offset: (elapsed, out) => {
          out.x = 0;
          out.y = -Math.sin(Math.PI * elapsed);
          out.turn = 0;
        },
      }),
    });
    const tools = ui.group('Tuner');
    tools.append(mass.element, joints.element, drop, ui.button({ label: 'Sway', onClick: () => game.preview('sway') }),
      ui.note('Drag from the circle on the canvas to resize it.'));
    tab.element.append(tools);

    // Character section: the charm motion's stiffness, through Character's edit of the profile.
    const section = host.addSection('character', { id: 'charm', title: 'Charm tuner' });
    const stiffness = ui.range({
      label: 'Charm stiffness', min: 1, max: 200, step: 1, unit: '/s²', value: 30,
      onInput: (value) => {
        const avatar = project.snapshot().characters.primary.avatar;
        if (avatar === undefined) return;
        // A value the motion kind refuses comes back as its AvatarMotionError, already shown.
        project.edit.character.avatarMotion(avatar.motion.map((entry) =>
          entry.id === 'charm' ? { id: entry.id, config: { ...(entry.config as JsonObject), stiffness: value } } : entry));
      },
    });
    section.element.append(stiffness.element);
    const refresh = (): void => {
      const snapshot = project.snapshot();
      mass.set(snapshot.settings.physics.hammerMass);
      const charm = snapshot.characters.primary.avatar?.motion.find((entry) => entry.id === 'charm');
      const value = charm === undefined ? undefined : (charm.config as JsonObject).stiffness;
      stiffness.set(typeof value === 'number' ? value : 30, { disabled: charm === undefined });
    };
    project.subscribe(refresh);
    refresh();

    // A circle at the marked joint while the tab shows; dragging from it resizes it.
    const circle = new Mesh(new CircleGeometry(1, 32),
      new MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.6, depthTest: false }));
    const frame = new Matrix4();
    const center = new Vector3();
    let dragRadius: number | null = null;
    let removeCircle: (() => void) | null = null;
    const showCircle = (shown: boolean): void => {
      removeCircle?.();
      removeCircle = null;
      if (!shown) return;
      const avatar = game.avatar();
      joints.set(String(marker().joint), {
        disabled: avatar === null,
        options: avatar?.model.joints.map((joint, index) => ({ value: String(index), label: joint.name })) ?? [],
      });
      removeCircle = game.addOverlay({
        root: circle,
        pass: 'marks',
        update: () => {
          const facts = game.avatar();
          const { joint, radius } = marker();
          circle.visible = facts !== null && joint < facts.model.joints.length;
          if (facts === null || !circle.visible) return;
          circle.position.copy(center.setFromMatrixPosition(facts.jointWorld(joint, frame)));
          circle.scale.setScalar(dragRadius ?? radius);
        },
      });
    };
    tab.onVisibility(showCircle);
    showCircle(tab.shown);
    data.subscribe(() => joints.set(String(marker().joint)));
    game.onPointer((event) => {
      if (removeCircle === null || !circle.visible) return;
      const distance = Math.hypot(event.world.x - center.x, event.world.y - center.y);
      if (event.type === 'down' && event.button === 0 && distance <= marker().radius) {
        event.capture();
        dragRadius = marker().radius;
      } else if (dragRadius !== null && event.type === 'move') {
        dragRadius = Math.min(1, Math.max(0.02, distance));
      } else if (dragRadius !== null && (event.type === 'up' || event.type === 'cancel')) {
        if (event.type === 'up') data.set({ ...marker(), radius: dragRadius });
        dragRadius = null;
      }
    });
    host.signal.addEventListener('abort', () => {
      circle.geometry.dispose();
      circle.material.dispose();
    });
  },
};

export default { apiVersion: WORKSHOP_API_VERSION, plugins: [tuner] } satisfies WorkshopModule;
```
