# Workshop plugins

A game can add its own tools to the Workshop without editing the engine: tabs and sections
built from the Workshop's own controls, edits made through the engine's own operations,
data of its own kept in the project, controls for its motion kinds, and overlays, canvas drags
and previews in the running game. A plugin's **workshop facet** holds them, named in the game's
[plugin manifest](plugins.md#the-manifest):

```json
{
  "apiVersion": 1,
  "plugins": [
    { "id": "my-game", "workshop": "./workshop.ts" }
  ]
}
```

```sh
GAME_PLUGINS=games/my-game/plugins.json npm run dev
GAME_PLUGINS=games/my-game/plugins.json GAME_PROJECT=projects/my-game npm run build
```

Without workshop facets the Workshop has only its own tools.

## The workshop facet

The facet module default-exports a `WorkshopFacet`, made with `defineWorkshop`: `start(host)`,
which starts the plugin's tools, an optional `validate(data)` for its own data, and an optional
`contributes`, its [motion controls](#motion-controls). The plugin's ID comes from the manifest,
as `host.plugin`.

- **One SDK.** A plugin imports nothing from `src/editor` except
  [`src/editor/workshop-sdk.ts`](../src/editor/workshop-sdk.ts), which defines the facet, the
  host and the UI kit, re-exports every type they use, and exports the kernel's verbs and
  `PluginError`. It may also import the kinds and runtime SDKs and the game's own code, but no
  release facet: the Workshop refuses release facet files.
- **Checked in the page.** The Workshop checks its facets in the browser, when the page loads
  and after every change; Node never runs them. Facets that are invalid, such as a default
  export without `start` or controls for a motion kind no kinds facet registers, run no Workshop
  plugins until fixed: the Workshop shows the error as a notice, `window.gettingOver.plugins()`
  reports it, and the page and the project stay.
- **Nothing runs on import.** A facet module defines its facet and runs nothing when imported:
  an error thrown while it is imported stops the page before the Workshop can show it, so check
  the browser console. See [the import-time rule](plugins.md#the-import-time-rule).
- **Trusted code.** Plugins are the game's own code, never content, and run without a sandbox.
- **Editor-only.** Game builds refuse workshop facet files and every editor module, and
  releases contain none of a plugin's Workshop code or data.

## Lifecycle

- The Workshop starts each plugin once the project is open, with a host of its own.
  `host.signal` aborts when the plugin stops.
- An error a plugin throws, or a promise it rejects, in `start`, `validate`, a listener, a UI
  kit callback, an overlay or a preview, stops that plugin alone, with `plugin-failed`. The
  Workshop shows the error with the plugin's ID; the Workshop and the other plugins go on. A
  failed plugin stays stopped until the workshop facets change. Callbacks the plugin registers
  elsewhere, such as its own timers, get the same treatment through `host.guard(callback)` and
  `host.listen(target, type, listener)`.
- Stopping removes everything the plugin added: its tabs and sections, overlays, listeners,
  preview, pause and drag. A stopped plugin's host then refuses anything that would add or
  change something, with `plugin-stopped`.
- Changing a workshop facet, or anything one imports, stops the plugins and starts them again;
  the project, with its unsaved changes, stays. Facets that become invalid run no plugins until
  they are fixed.
- `window.gettingOver.plugins()` lists the manifest's plugins, each with its facets, whether its
  workshop facet runs and its last error, and says why no workshop facets run while they are
  invalid.

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

- It is stored in `project.json` under `plugins.<id>`, the plugin's ID from the manifest, and is
  the project section `plugins/<id>`. The engine saves, reverts, exports and conflict-checks it
  like any other section, but never interprets it.
- It is limited to 64 KiB, nesting depth 16 and 8,192 values (`PLUGIN_DATA_LIMITS`); a project
  holds data for at most 16 plugins.
- The plugin's `validate(data)` runs whenever the section loads or changes. It refuses with a
  `PluginError` of its own code (lowercase letters, digits and hyphens, starting with a letter),
  which `data.set` returns. Anything else it throws is a failure: the plugin stops, and its data
  is accepted unchecked until the workshop facets change, so a faulty plugin never holds the
  project back.
- A project holding data for a plugin the Workshop lacks opens with a notice naming the plugin,
  and that section stays unchanged.
- Scripts reach it at `/api/projects/{id}/plugins/{plugin}`; see [projects](projects.md#api-for-scripts-and-language-models).

## Motion controls

Workshop / Character / **Secondary motion** shows sliders for the tunable numbers of an avatar's
[motion kinds](characters.md#secondary-motion). A workshop facet describes them, as data, at
`AVATAR_MOTION_CONTROLS`: one set for each kind, whose `id` is the kind's. The kinds are the
plugin's own, registered by its [kinds facet](kinds-plugins.md#motion-kinds), so the IDs are
`<plugin>/<name>` and a plugin describes only its own kinds.

```ts
import { add, AVATAR_MOTION_CONTROLS, defineWorkshop } from '../../src/editor/workshop-sdk';

export default defineWorkshop({
  contributes: [add(AVATAR_MOTION_CONTROLS, {
    id: 'my-game/charm',
    controls: [
      { label: 'Stiffness', unit: '/s²', min: 1, max: 200, step: 1, default: 30, path: ['stiffness'] },
      { label: 'Damping', unit: '/s', min: 0, max: 20, step: 0.1, default: 4, path: ['damping'] },
    ],
  })],
  start() {},
});
```

- A control describes one number in the kind's configuration: its `label` (1-80 characters), a
  `unit` shown after the value (at most 16 characters, empty for none), its range from `min` to
  `max`, a `step` no larger than the range, the `default` a reset restores, and a `path` into
  the configuration of 1-8 object keys, each 1-64 characters, and array indices.
- A control list, `{ list, title, controls }`, repeats 1-64 controls over a list in the
  configuration: `list` is the list's path, there is one group per item, titled by the item's
  field that `title` names, and each control's path leads into the item.
- A set holds at most 64 controls, counting each list's (`AVATAR_MOTION_CONTROL_LIMITS`), and the
  point at most 64 sets. A control has exactly its own fields.
- The Workshop checks every set against the registered motion kinds: controls for a kind no
  kinds facet registers fail with `invalid-contribution`, and the facets then run no Workshop
  plugins until fixed.
- Each motion shows its controls and a reset to their defaults. A change goes to the draft
  profile, where the kind checks it again, and through Save and Revert. Releases contain none
  of it.

## The running game

Everything here is presentation in the Workshop only: physics, gameplay, play recordings and
the authored level and profiles never see it. Without plugins nothing runs per frame; a
plugin's per-frame work runs only while its overlays or previews are active, and the engine
allocates nothing per frame on its behalf.

- **Overlays.** `game.addOverlay(layer: SceneLayer)` adds a scene layer of three.js objects:
  `{ root, pass, update?, dispose? }`. It uses the same `SceneLayer` and `SceneFrame` contract
  as [runtime scene layers](runtime-plugins.md#scene-layers), re-exported by the Workshop SDK,
  not a Workshop-specific type. `course` draws with the terrain, `actors` over it with the
  characters, and `marks` over the characters and their arms, under the tool. Collider
  visuals stay centred on the obstacle line, z = 0, in actors; a marks overlay's materials
  ignore depth (`depthTest: false`), leaving the arms/tool depth alone. Only overlays with
  `update(frame: SceneFrame)` run each drawn frame. That frame is reused and read-only (time,
  parts, cursor, enemies and rig), so never retain it as a snapshot and allocate nothing.
  Static overlays have no frame callback. The host checks the root, pass and methods when
  added, naming the plugin in a refusal. It returns the removal; removal or plugin stop
  detaches the root and calls the optional `dispose()` once to free owned resources.
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

The workshop facet of a plugin, `my-game`, kept in the game's own repository. Its Tuner tab edits
a game setting, picks a joint of the loaded avatar, marks it with a circle and runs a 1 m drop;
its Character section edits the configuration of the plugin's `my-game/charm` motion; dragging
from the circle resizes it, kept in the plugin's own data.

```ts
import { CircleGeometry, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { defineWorkshop, PluginError } from '../../src/editor/workshop-sdk';
import type { JsonValue } from '../../src/editor/workshop-sdk';

type JsonObject = { readonly [key: string]: JsonValue };
// The plugin's data: the skin joint it marks and the marker's radius in metres.
type Marker = { readonly joint: number; readonly radius: number };

export default defineWorkshop({
  validate(data) {
    const field = (key: string): unknown => typeof data === 'object' && data !== null ? Reflect.get(data, key) : undefined;
    const joint = field('joint'), radius = field('radius');
    if (typeof joint !== 'number' || !Number.isInteger(joint) || joint < 0) {
      throw new PluginError('invalid-joint', 'The marker names a skin joint by its index, from 0.');
    }
    if (typeof radius !== 'number' || !(radius >= 0.02 && radius <= 1)) {
      throw new PluginError('invalid-radius', 'The marker is 0.02-1 m in radius.');
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
          entry.id === 'my-game/charm' ? { id: entry.id, config: { ...(entry.config as JsonObject), stiffness: value } } : entry));
      },
    });
    section.element.append(stiffness.element);
    const refresh = (): void => {
      const snapshot = project.snapshot();
      mass.set(snapshot.settings.physics.hammerMass);
      const charm = snapshot.characters.primary.avatar?.motion.find((entry) => entry.id === 'my-game/charm');
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
});
```
