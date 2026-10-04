# Feature request: Workshop plugins — a game's own editor tools

**Date:** 2026-10-04 · **Baseline:** `1b6a2ce` · **Status:** requested; nothing is implemented. A downstream game waits
for this instead of patching the Workshop.

A game built on GettingOver wants editor tools of its own in the Workshop and wants to keep their code in its own
repository. Examples:

- richer tuning for the motion kinds it registers, such as joint pickers, collider handles drawn on the avatar, and
  previews of a fall or a landing;
- tools for its own level content;
- previews of its own models.

Today the Workshop cannot load such code:

- It builds a fixed set of editors (`src/editor/main.ts`), and its tabs are a closed list (`WorkshopTab`,
  `src/editor/ui-types.ts`).
- From the game, it loads only the avatar rig module's registry and the motion kinds' data-only `controls`
  (`virtual:avatar-rigs`, `virtual:avatar-motion-controls`). It runs none of the game's UI code.
- The game module (`GAME_MODULE`, `src/release-module.ts`) runs only in releases.
- A project holds fixed sections (`PROJECT_SECTIONS`, `src/editor/project-session.ts`) validated as exact records, so
  a game cannot keep editor data of its own in it.
- Scene overlays (`ViewLayer`, `src/view.ts`) and the editors' operations are internal.

So a game must either edit engine modules, which conflict on every sync, or build a separate tool that cannot see the
open project or the running game. The avatar-rig SDK and the motion hook solved this for runtime code: a game names a
trusted module, and a public SDK defines what it may do. This request asks for the same in the Workshop. With it, a
game adds, changes or removes its editor tools without editing any engine file.

## Stage A: plugins in the Workshop

- **Registration:**
  - A project names one editor-only module, `WORKSHOP_MODULE`, with the containment rules of `AVATAR_RIG_MODULE`.
    It is a separate module because the rig module ships in releases, and plugin code imports editor code.
  - Only the Workshop loads it. It is an editor module: the release build fails if game code imports it, and releases
    contain none of its code or data.
  - It default-exports its API version and its plugins. Each plugin has an id (lowercase letters, digits and hyphens,
    starting with a letter) and a `start(host)` function.
  - A wrong API version, a duplicate or invalid id, or a malformed plugin stops the Workshop's start with a typed error,
    as an invalid rig module does. Without the module, the Workshop is exactly as today.
  - Plugins are the game's own trusted code, like its rig module, not content.
- **Public editor SDK:** one public module defines the plugin contract, the host's interface and a small UI kit under
  the API version. Plugins import nothing else from `src/editor`; anything a plugin needs is in the SDK. A plugin may
  also import the engine's public runtime SDKs, such as `src/avatar-rig.ts`, and the game's own code.
- **Places in the Workshop:**
  - A plugin can add its own tabs, after the built-in ones, and its own sections inside built-in tabs: at least
    Character, Level, Physics and Project. Each gets a mount element and is told when it is shown or hidden.
  - The UI kit gives the Workshop's own controls and styles, so plugin UI looks and behaves like built-in UI: at least
    range controls, buttons, selects, toggles, tuning groups and notices.
- **Reading the project:** read-only snapshots of the open project, with change subscriptions: the manifest's
  sections, the game settings, the level, the character profiles and the model library.
- **Editing through the engine's operations:**
  - A plugin changes engine-owned data only through the operations the built-in editors use. Every edit a built-in tab
    can make is available to plugins.
  - Each edit gets the same validation, draft, dirty marking, Save, Revert, export and conflict handling as in the
    built-in tab.
  - A refused edit returns the engine's typed error, and the Workshop shows it as it shows its own.
  - A plugin cannot change engine-owned data any other way.
- **A plugin's own data:**
  - Each plugin may keep one bounded JSON document in the open project, in its own section (`plugins/<id>`). The engine
    stores, fingerprints, saves, reverts, exports and conflict-checks it like any other section, but never interprets
    it.
  - The engine checks its stated limits on size, depth and value count. The plugin may validate it, refusing with its
    own typed error code; the Workshop runs that validation whenever the section loads or changes.
  - It is editor-only: releases never include it.
  - A project holding data for a plugin the Workshop lacks opens with a notice naming the plugin, and that section
    stays unchanged.
- **Lifecycle:**
  - The Workshop starts plugins once the project is open.
  - A change to the plugin module stops the plugins and starts them again, without losing the open project's unsaved
    changes.
  - Stopping aborts the plugin's `AbortSignal` and removes its UI, overlays, listeners and previews.
  - An error a plugin throws after it starts is reported with its id, and that plugin stops. The Workshop and other
    plugins keep running.
- **Diagnostics:** `window.gettingOver` lists the plugins, whether each is running, and each one's last error.

## Stage B: plugins and the running game

All of this is presentation in the Workshop only. Physics, gameplay, play recordings and the authored level and
profiles never see it.

- **Overlays:** a plugin adds and removes scene layers through a public form of the engine's `ViewLayer` (the course,
  actors or marks pass). They are updated each frame with a public, read-only view of the frame, for example to draw
  colliders, joints or guides.
- **Canvas input:** the plugin gets pointer events on the game canvas in world coordinates and the camera's project
  and unproject, as the Level tab has them. While it handles a drag, it can block game input under its own reason.
- **Game control:** pause and resume under the plugin's own reason, restart, place the player as the Level tab does,
  and read the current state that `window.gettingOver.snapshot()` reports.
- **Avatar facts:** read-only, for the loaded imported avatar:
  - the model facts that motion kinds get (`AvatarMotionModel`);
  - each motion's claimed joints;
  - each joint's current world frame.

  With these, a plugin can offer joint pickers and draw joints and colliders.
- **Previews:**
  - A plugin can run the engine's Sway and Jolt.
  - It can also run a preview of its own: a function of time, over a bounded duration, that offsets the whole
    character's presentation (body, pot and tool together) by a translation in the view's plane and a turn.
  - Motions see the offset through `body` and `pot`, exactly as they see real movement. A game can therefore build a
    drop, a bounce or a shake.
  - The preview ends early on a rewind, a restart or another preview.

Illustrative shapes. The names are upstream's choice, but each part is a need:

```ts
// WORKSHOP_MODULE
export default { apiVersion: 1, plugins: [tuner] } satisfies WorkshopModule;

interface WorkshopPlugin {
  readonly id: string;
  // Checks the plugin's own section whenever it loads or changes; throws the SDK's typed refusal.
  validate?(data: RigJson): void;
  start(host: WorkshopHost): void;
}
interface WorkshopHost {
  readonly signal: AbortSignal; // aborted when the plugin stops
  addTab(options: { id: string; label: string }): WorkshopMount;
  addSection(tab: 'character' | 'level' | 'physics' | 'project', options: { id: string; title: string }): WorkshopMount;
  readonly ui: WorkshopUiKit;
  readonly project: WorkshopProject; // snapshots, subscriptions and the engine's edit operations
  readonly data: WorkshopPluginData; // the plugin's own section
  readonly game: WorkshopGame;       // Stage B: overlays, input, control, avatar facts and previews
  notice(message: string, kind?: 'info' | 'error'): void;
}
interface WorkshopMount {
  readonly element: HTMLElement;
  onVisibility(listener: (shown: boolean) => void): () => void;
}
interface WorkshopPreview {
  readonly duration: number; // seconds, bounded
  // The character's presentation offset `elapsed` seconds in: metres in the view's plane, radians counterclockwise.
  offset(elapsed: number, out: { x: number; y: number; turn: number }): void;
}
```

## Acceptance

Stage A:

- A sample plugin kept outside `src/` registers through `WORKSHOP_MODULE`. It:
  - adds a tab and a Character section built from the UI kit;
  - edits an avatar motion's configuration and a game setting through the engine's operations. The edits survive Save,
    Revert and export, and a refused value shows the engine's typed error;
  - keeps its own data in `plugins/<id>`. The data saves, reverts and conflict-checks with the project, the plugin's
    validation refuses bad data, and a release built from the project contains none of it.
- The sample is added, changed and removed without editing any engine file. Without `WORKSHOP_MODULE`, the Workshop
  behaves and looks exactly as today.
- A release built from the project contains none of the plugin's code, and game code that imports the module fails the
  build.
- A plugin that throws is reported with its id and stopped, while the Workshop and other plugins keep running. A change
  to the module restarts the plugin and keeps the unsaved changes.

Stage B:

- The sample draws a circle at a joint of the loaded avatar, placed from the avatar facts. It changes a value by
  dragging on the canvas, and game input is blocked only during the drag.
- Its own preview drops the character 1 m and back over a second. The avatar's motions react, while the physics
  state, the authored level and profiles, and the play recording are identical with and without it.
- Without plugins, the per-frame cost is unchanged. A plugin's per-frame work runs only while its overlays or previews
  are active, and the engine allocates nothing per frame on its behalf.

## Out of scope

- Node-side extensions of the Workshop's project server, such as running a game's offline content tools from a panel.
  That would be a separate request.
- Plugins in releases: the game module covers the shipped game.
- Untrusted or third-party plugins, and sandboxing.
- Hiding, replacing or restyling built-in editors.

## Constraints (from `AGENTS.md`)

- Performance is a feature requirement.
- Runtime modules never import editor modules, and the playable release contains no editor modules or assets.
- Presentation state never mutates authored level or profile data.
- No backward-compatibility shims; schema and API-version bumps are fine.
