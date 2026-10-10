# Feature request: Workshop commands with one undo history

**Date:** 2026-10-10 · **Baseline:** `281ab1b` · **Status:** Requested; not implemented.

A designer who makes a change they do not like can take it back in only two places: an unfinished outline drops its
last stroke, and the Level tab removes the last placed set piece. Every other edit, in every tab, stays unless the
designer remembers the old value and sets it again. Authored state also has half a dozen owners, each changing it its
own way: the level in `LevelState`, game settings in a copy kept by Physics and another kept by the game, the rest of
the project in `ProjectSession`, and the character and appearance in stores of their own. An undo added to each owner
would make six histories that disagree about what came last.

**In short:** make the open project one document, a frozen value per project section, changed only by commands that
one linear history applies. A step records, for each section it changed, the exact value before and after, and for the
level also the objects it upserted and removed, so Undo and Redo put back values that existed and reach the game as
incremental `LevelChange`s, as any edit does. A drag or a slider scrub is one step, typing commits once, and
multi-object edits are atomic. Edits that wait for a bake or a file are *pending edits*: Undo cancels them, and each
becomes one step when its data is ready. One history serves every tab and every Workshop plugin. Saving does not touch
it, so undoing back to what was saved makes the project clean again; opening another project clears it, and a server
update cuts it. Stage A builds the history for the level, Stage B moves the project content and game settings into the
document, Stage C lets Workshop plugins take part, and Stage D brings in the character and appearance.

## Where the engine stands

| Area | Today |
| --- | --- |
| Level | `LevelState` (`src/editor/level-state.ts:72`) holds the level with its indexes. `upsert`, `remove`, `edit`, `metadata`, `replace` and `merge` (120-259) check a change, replace the frozen root and emit a `LevelChange` (`src/level.ts:258`): the objects upserted and the IDs removed. `main.ts:155` hands it to `Game.applyLevel` (`src/game.ts:563`), whose worlds and views apply only those objects (`src/terrain-world.ts:66`); a `replace` restarts the run. The Level tab calls the mutators from some twenty places: a drag's release (`level-editor.ts:3252`), placements, `commitOrPreview` for every inspector field (1048), set pieces (2157), deletes (2688), name and labels (2740-2749), New level, Import and Server levels (2750-2830), trigger events (920) and the turn bake (1597). Plugins reach them through `host.project.edit.level` (`workshop-plugin-host.ts:728-733`), the project through `ProjectWorkspace.level` (`project-session.ts:114`). |
| Game settings | Two copies. Physics keeps one (`ui.ts:48`) and changes it on every slider `input` (245-257). `main.ts:245` passes each value to `Game.setSettings` (`src/game.ts:415`), which keeps the other and restarts the run when the rig changes, and to the character, hammer head and jar editors, the plugins and the level checks. Character's handle length and Physics' hammer head and jar edit the settings through `applySettings` in `main.ts`. |
| Project content | Private fields of `ProjectSession` (`project-session.ts:337-358`): title, theme, HUD, audio, enemy art, course artwork, media, model library, alternate character and plugins' data. Each `set…`, `add…` or `remove…` replaces its field, then `applyLook` (2026) gives `Game.setLook` (`src/game.ts:451`) the parts, which it compares by identity. Theme and HUD sliders and colour inputs commit on every `input` (`project-editor.ts:201-251`, `range-control.ts:66`). |
| Character | `SpriteEditorState` (`sprite-state.ts:234-245`): a draft, a saved copy in IndexedDB with Save and Revert, a revision counter and a busy flag. A whole profile loads into the rig before it commits (`replaceRig`, 1106); a layer edit updates one layer. |
| Appearance | `Appearance` (`appearance.ts:21-28`): imported parts, alignment drafts and arm IK, kept in IndexedDB outside a project's Workshop and in localStorage profiles (`arm-ik-store.ts`). Part models load asynchronously. |
| Plugins | `host.data.set` (`workshop-plugin-host.ts:504`) calls `ProjectSession.setPluginData` (`project-session.ts:499`), which checks the data's limits and the plugin's `validate`. `host.project.edit` (712) maps every operation onto the built-in tabs' own. |
| Saving | Dirtiness is per section: each section's fingerprint against the one last saved or loaded (`fingerprints`, 1961; `dirtySections`, 480), by identity for the level, theme, HUD, audio, enemy art and characters. Autosave writes sections that held still for a second (1199), and each save of the level or settings numbers a level version unless it equals the latest (`docs/projects.md:268`). A poll loads the server's changes into sections the page has not changed and flags the rest as conflicts (1625); the level takes them through `merge`, so a playtest goes on. `playedVersion` (1055) holds while the level is the same object. Named profiles (`named-snapshots.ts`), server copies, the browser copy and the character and appearance stores are saves of their own. |

- **Undo today.** An unfinished outline remembers where each stroke began (`polygon-draft.ts:44`, `undo` at 74), which
  Backspace, Ctrl/Cmd+Z (`level-editor.ts:3347`) and **Undo point / stroke** pop. **Remove last placed set piece**
  (`setPieceHistory`, 978; `removeLastSetPiece`, 2173) removes what remains of the latest of up to 64 remembered drops
  (`SET_PIECE_HISTORY`, 119), and any replace forgets them (3411). Nothing else can be taken back.
- **Previews.** Level drags draw a ghost and commit once on release, as do the jar and hammer-head outline drags
  (`outline-editor.ts:405-411`). Sliders, colour inputs and the directional diagram's handles
  (`directional-editor.ts:418-485`) commit continuously. Trigger events stay in a form until **Apply events**
  (`trigger-inspector.ts:1-5`). Placements, the camera, the tool and view toggles are the editors' own state.
- **Waiting edits.** Turning GLB terrain bakes its collision off the page's thread (`mesh-baker.ts`), once per turn
  (`courseMeshTerrain`, `project-session.ts:616`). The course shows the turn meanwhile (`turning`,
  `level-editor.ts:945`), and the commit is dropped if the object changed (1597-1641). The committed object carries the
  baked collision, so nothing ever bakes to put it back. Media, course meshes, library models, course packages
  (`project-session.ts:560-886`) and level files (`level-editor.ts:2769-2830`) are read and checked before they apply.
  New course artwork, character models and appearance parts then load in the game as it draws them.
- **Keys.** Only the Level tab claims Ctrl/Cmd+Z, and only for an outline. Game input ignores Ctrl, Meta and Alt
  (`src/input.ts:150`), text entry keeps its keys (`TEXT_ENTRY`, `ui.ts:28`), and `/` opens the Workshop's search (495).

## Rules every stage keeps

- **One source.** Each project section has one value, in the document. The editors, the game, `ProjectSession` and
  the plugins read it there; none keeps a copy to edit.
- **One way in.** Every change to a section is a command applied by the history. A section's owner builds commands; it
  has no setters.
- **One history.** One linear history for the open project. No editor keeps an undo stack of its own.
- **Exact values.** Undo and Redo set each section to the exact value a step recorded, never to one rebuilt from it,
  so identity checks keep working: dirty sections, the played version and `Game.setLook`.
- **Incremental.** Undo and Redo reach the game as edits do: the level as a `LevelChange` of the changed objects, other
  sections by identity. Nothing serialises a section to record, measure or apply a step.
- **Bounded, never per frame.** The history works only when the document changes, within limits on steps and bytes.
- **Editor-only.** The document and the history live in `src/editor`; runtime modules never import them, and releases
  contain none of them.
- **Typed refusals.** A command refuses with its section's typed error (`LevelError`, `GameSettingsError`,
  `ProjectError`, `SpriteError`, `AppearanceError`, a plugin's `PluginError`) before anything changes, and records
  nothing.
- **No compatibility.** Mutators, copies and ad hoc histories that the document replaces are deleted, not wrapped, and
  the docs change with each stage.
- **Validation** is code review, the owner's rule: each stage's acceptance is checked against the code, never by
  running tests, builds or type-checks. `window.gettingOver.history()` reports the steps, bytes and pending edits for
  anyone inspecting a session, and the review weighs the cost claims against the levels a stage must serve:
  `examples/projects/ashen-ascent` (687 objects) and a level at `LEVEL_OBJECT_LIMIT` (`src/level.ts:74`, 2,481 objects).

## The design

### The document

`ProjectDocument` (`src/editor/document/project-document.ts`) holds one frozen value per section, named as projects
name them (`PROJECT_SECTIONS`, `project-session.ts:64`, and `plugins/<id>`): the unit that autosave, dirtiness,
conflicts and server revisions already use. Binary sections hold *file handles*, one immutable handle per distinct
file, whose bytes a `FileStore` finds in the page, the bound server project or the published project. An upload moves
a file's location in the store, never the document, so saving never changes a section. Derived things, such as object
URLs, loaded models and collision baked for each turn, are caches outside the document.

The document has no setters: the history is its only writer. Listeners subscribe per section and hear each change
with its cause (`edit`, `undo`, `redo`, `open` or `server`) and its step's label and place, once every section of the
step is set. A listener never applies a command while it is told of one; plugins hear changes a microtask later, as now
(`workshop-plugin-host.ts:396`).

### Commands, changes and steps

A **command** is a label, a place and a function from the document to the **changes** it makes; it throws its
section's refusal and changes nothing. A change names a section with its exact value before and after. The level's
change also carries a delta: the objects upserted and the IDs removed, which become the game's `LevelChange`, and the
objects they replaced, so it inverts in O(changed) without reading the level. Other sections need no delta, because
their listeners compare values by identity. A **step** is one or more changes. Undo applies their inverses in reverse
order, after checking that each section still holds the step's `after` value; a mismatch is a programmer error.

**Decision: section snapshots with keyed deltas.** Frozen values share structure, so a step costs only what it
allocated: a moved object and the new `objects` array (8 bytes an object, under 20 KB at `LEVEL_OBJECT_LIMIT`), or one
theme object. Restoring the exact value makes saved and dirty, the played version and the look right with no saved
marker. Steps are recorded only once their data is ready, so the history never waits. Rejected:

- *Command objects with do and undo.* Every operation would need a hand-written inverse kept in step with it (a remove
  also strips trigger targets; an upsert moves counts and geometry use), inverses of loads would be asynchronous,
  plugins would have to write inverses, and drift would show only as a corrupted project.
- *Whole-document snapshots.* Correct too, but they hide what changed, so every projection would diff the project
  after each undo.
- *JSON patches.* They address level objects by array index, which every remove shifts, need an inverse generated per
  operation, and buy nothing over frozen values.

`LevelState` keeps its checks and indexes (counts, geometry use, objects by ID) but stops holding the level. It follows
the document's level, in O(changed) per change and in full only when a project opens, and its `upsert`, `remove`,
`edit`, `metadata`, `replace` and `merge` return the change they would make. The next `objects` array is built from the
current one, replacing, dropping and appending by ID, so object order never depends on the index.

### Grouping

- **Drags** keep previewing as editor state and apply one command on release. Drags that edit live, such as the
  directional diagram's handles and a plugin's own tools, open a **transaction**: what it applies shows at once and
  folds into one step on commit, and cancel restores it all.
- **Scrubs and typing.** A command with a coalescing key merges into the newest step when that step has the same key
  and is still open or was sealed less than a second ago. `RangeControl` runs `onInput` with its ID as the key and seals
  on `change`, as colour inputs do, so a scrub, a held arrow key or a burst of Q, E, [ and ] is one step. Text fields
  commit on `change`, so a rename is one step; while typing, the field's own undo works.
- **Atomic edits.** One command may change several objects or sections: a set piece's parts and labels, a delete with
  the trigger events it strips, a course package's artwork and level, an enemy model's course artwork and enemy art,
  and any later paste or multiple delete.
- **Pending edits.** An edit that waits for a bake or a file is a pending edit: the newest action, shown at once, but
  not yet a step. Undo cancels it. When its data is ready it re-reads the document and becomes one step on top, or is
  dropped if its target changed meanwhile, as the turn bake checks today. A GLB turn, file imports, level files and
  server levels, model reads and enemy bakes are pending edits.
- **The outline.** Drawing is a pending edit with steps of its own: each stroke records the outline before and after.
  While the Level tab shows it, Undo and Redo walk its strokes; **Finish shape** applies one step, "Draw shape", and its
  strokes go; Escape cancels it. `PolygonDraft` keeps no history.

### What is not in the history

The camera, selection, tool, placement ghost, Course and Scenery modes, **Show scenery**, the board and links, open
sections, panel width, search, replays, Record, the overlay, practice positions, the placed player, previews (Sway,
Jolt, skeleton and directional), trigger event forms, saves, exports, sign-in and publishing. Undo ends a drag on
objects, as any edit does today (`level-editor.ts:3411-3433`), and drops unapplied event edits of triggers it changes.

A step records where it was made: its tab, its section, and the selection before and after. Undo restores the before
selection and Redo the after, where the current mode can select it. If the step's tab is shown, its section opens
(`showSection`, `workshop-section.ts:71`), and a restored Level selection wholly out of view is centred, as picking a
check finding does (`level-editor.ts:2917`).

### One history for every tab

**Decision: one global history.** Steps span tabs and sections: a course package changes the artwork and the level,
Character's handle length and Physics' hammer head change the settings, and a plugin's group can change its data and
the level. Per-tab histories could undo out of order into combinations the project never had, such as a trigger that
plays a sound whose media file was undone in Project. A linear history visits only states the project had.

Ctrl/Cmd+Z therefore undoes the newest change wherever it was made. The Workshop does not switch tabs: the button
names the step and its tab, and a notice says what was undone when its tab is not shown.

### Saving, opening and syncing

- **Saving is not a step**, automatic or through **Save to project** (`project-save.ts`). Dirtiness stays per section
  against what was last saved, so undoing back to it makes the section clean, autosave writes nothing and the played
  version returns. Undoing past a save makes the section dirty, and autosave writes the older value, a new level
  version unless it equals the latest.
- **Opening another project** (from the server, a project file, a new project, the published project or this
  browser's copy) clears the history and cancels pending edits: the binding changes, and undoing would write one
  project's sections into another. Its confirmations stay.
- **Server updates** of a section, and choosing the project's version in a conflict, are changes from outside: the
  history drops the newest step that touched the section and every older one, and all redo steps, so Undo never writes
  over someone else's change.
- **Replacing within the project is an edit.** New level, a level file, a server level, a course package, a named
  profile, a server copy, a settings file, Reset to defaults, the character's Revert and restoring this browser's kept
  changes are steps, so their replace confirmations go.
- **Other saves** (named profiles, server copies, the character and appearance stores, the browser copy) store
  document values and keep their own fingerprint of what they stored. Restoring one at start sets the document; it is
  not a step.

### Plugins

A plugin's edits are commands with nothing for the plugin to write: the host applies `project.edit` and `data.set`
through the history, and steps restore values, so no plugin code inverts anything. The Workshop SDK grows by three
small parts, checked where the plugin calls them, as the host checks its other calls, with `PluginError`
(`invalid-contribution` for a bad label or selection, `plugin-stopped` after a stop):

- `data.set(value, { label?, select? })`. `label`, 1-80 characters, names the step "<plugin>: <label>", and sets with
  the same label within a second merge, so a tool that sets its data on every pointer move still makes one step.
  `select` lists the IDs selected before and after: at most 16, each 1-64 characters.
- `host.history.begin(label)`, a group: everything the plugin applies until `commit({ select? })` is one step, shown at
  once, and `cancel()` restores it. A plugin has at most one group open; Undo, Redo or an edit made outside the group
  commits it first, and the plugin's stop cancels it. Edits that wait, such as `project.edit.media.add`, finish as
  steps of their own.
- `data.subscribe(listener)`: the listener gets `(data, { cause, select })`, so it hears undo and redo with the
  selection to restore.

`ui.range` coalesces its scrubs by itself, labelled with its own label. Calls of `project.edit` outside a group are a
step each, "<plugin>: <operation>", merging within a second as keyed commands do. Undo never runs `validate`, since the
data was checked when recorded; when the workshop facets change, steps that touch plugin sections are cut as server
updates cut them. No contribution point is needed: the history is a host service, like `host.data`.

### Limits and cost

`HISTORY_LIMITS` is 200 steps and 64 MiB. Each section's adapter estimates a change's bytes without serialising: the
level's from object counts and point and text lengths, plugin data's from the size its validation already measures,
files' from the page-held bytes that only the history keeps. The oldest steps go first; the newest always stays,
however large. Two hundred moves on a level at `LEVEL_OBJECT_LIMIT` hold about 4 MB. Applying a step costs what the
edit cost: O(changed) in the history and `LevelState`, and one `LevelChange` for the game.

### Undo and redo in the Workshop

- **Buttons.** Undo and Redo sit in the Workshop header's tool group, which search already indexes (`ui.ts`), in every
  tab and layout. Each names its step, "Undo Move Block at D7 (Level)", or "Cancel Turn Cliff at C2" while a pending
  edit is newest, and is disabled with "Nothing to undo". A live region announces each undo and redo; on touch, where
  tips do not show, a notice shows it too.
- **Keys.** Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl+Y redo. One listener handles them while the Workshop is open
  and the mouse is not captured for play. In text entry the browser's own undo edits the text. Backspace in Draw shape
  undoes a stroke.
- **Labels** say what and where: a verb, the object's name as the Level tab gives it and its board square, such as
  "Place set piece Rising steps at D7", "Set Sky colour" or "my-game: Resize marker".
- **Waiting.** Undo and Redo wait while a project opens, imports or updates from the server.

### Five edits, end to end

1. **Moving terrain.** A press on Block at D7 starts a drag; the overlay draws the ghost and nothing else changes. On
   release the Level tab applies `upsert(moved)` as "Move Block at D7", selecting the block, and the game hears one
   `LevelChange` with one object. Ctrl/Cmd+Z puts back the level root from before the move: `LevelState` updates one
   entry, the game hears the original object, the Level tab selects the block, and if the move was the only change
   since the last save the level is clean again. Redo puts back the moved root.
2. **Dropping a set piece.** One command adds its parts and labels as "Place set piece Rising steps at D7". Undo removes
   every part in one `LevelChange` and restores the labels array; Redo brings back the same IDs.
3. **Scrubbing a theme colour.** Each `input` applies the new theme with the control's ID as its key: the first makes a
   step, the rest merge into it, and the game takes each value through `setLook` as now. `change` seals the step. Undo
   puts back the theme object from before the scrub, and the game redraws once.
4. **Turning GLB terrain.** Releasing the dial at 30° prepares the pending edit "Turn Cliff at C2", and the course shows
   the turn while it bakes. Undo now cancels it: the preview goes and nothing is recorded. Otherwise the bake lands and
   the Level tab re-reads the object: if it was removed or turned meanwhile, the edit is dropped; if not, one step
   upserts it with the baked mesh, turn and box. Undo and Redo swap the two objects without baking.
5. **A plugin's data.** A plugin's `ui.range` edits the settings through `project.edit.settings`: one step,
   "my-game: Hammer head mass". Its canvas tool sets its data on release with `{ label: 'Resize marker' }`: another.
   Undo restores the section, and the plugin's listener hears `{ cause: 'undo' }` and redraws.

### Interfaces

```ts
// src/editor/document/project-document.ts: the open project, one frozen value per section, written only by History.
export type SectionName = ProjectSectionName;                     // PROJECT_SECTIONS and plugins/<id>
// SectionValue<S> is section S's frozen value (LevelDefinition, GameTheme, PluginData | null, …); SectionValues all.
export type ChangeCause = 'edit' | 'undo' | 'redo' | 'open' | 'server';

export interface SectionChange<S extends SectionName = SectionName> {
  readonly section: S;
  readonly before: SectionValue<S>;                               // the exact value it replaces
  readonly after: SectionValue<S>;
  readonly delta: S extends 'level' ? LevelDelta : null;
}

// What the game's LevelChange carries, and what it replaced, so it inverts without reading the level.
export interface LevelDelta {
  readonly kind: 'edit' | 'replace';
  readonly upsert: readonly LevelObject[];
  readonly remove: readonly string[];
  // Each upserted or removed object as it was; absent for an object the change added.
  readonly previous: ReadonlyMap<string, LevelObject>;
}

export interface ProjectDocument {
  get<S extends SectionName>(section: S): SectionValue<S>;
  subscribe<S extends SectionName>(section: S,
    listener: (change: SectionChange<S>, cause: ChangeCause, step: StepInfo | null) => void): () => void;
}

// src/editor/document/history.ts
export const HISTORY_LIMITS = Object.freeze({ steps: 200, bytes: 64 * 1024 * 1024, label: 80, coalesceMs: 1000 });

export interface Selection { readonly before: readonly string[]; readonly after: readonly string[] }

export interface StepInfo {
  readonly label: string;                                         // 'Move Block at D7'
  // Where it was made: the tab (null for a plugin's step), the section to open and the selection to restore.
  readonly place: StepPlace;
}

export interface StepPlace {
  readonly tab: WorkshopTab | null;
  readonly section: string | null;
  readonly select: Selection | null;
}

export interface Command extends StepInfo {
  readonly coalesce: string | null;
  // The changes, worked out from the document as it is; throws the section's typed refusal, changing nothing.
  run(document: ProjectDocument): readonly SectionChange[];
}

// One step built over time: a live drag, a plugin's group.
export interface Transaction {
  apply(run: Command['run']): Error | null;                       // shown at once
  commit(select?: Selection): void;
  cancel(): void;                                                 // restores what it applied and records nothing
}

export interface PendingEdit<T = never> {                         // a bake, a file being read, an outline being drawn
  readonly done: boolean;
  step(label: string, before: T, after: T): void;                 // a step of its own, such as a stroke
  finish(command: Command): Error | null;                         // one step on top of the history
  cancel(): void;
}

export interface History {
  apply(command: Command): Error | null;
  coalescing<R>(key: string, label: string, run: () => R): R;     // commands run inside take the key, as a scrub's do
  seal(key: string): void;
  begin(info: StepInfo): Transaction;
  prepare<T = never>(info: StepInfo & { restore?(value: T): void; cancelled(): void }): PendingEdit<T>;
  undo(): void;
  redo(): void;
  load(values: SectionValues): void;                              // another project: clears steps and pending edits
  external(changes: readonly SectionChange[]): void;              // the server's: cuts the history at those sections
  state(): HistoryState;                                          // labels, counts, bytes and pending edits
  subscribe(listener: () => void): () => void;
}

// src/editor/document/sections.ts: one adapter for the level, one for plugin data, one for whole values.
export interface SectionAdapter<S extends SectionName> {
  invert(change: SectionChange<S>): SectionChange<S>;
  compose(first: SectionChange<S>, next: SectionChange<S>): SectionChange<S> | null;  // null when nothing is left
  bytes(change: SectionChange<S>): number;                        // estimated, never by serialising the section
}

// src/editor/workshop-sdk.ts, Stage C.
export type WorkshopChangeCause = 'edit' | 'undo' | 'redo' | 'open' | 'server';
export interface WorkshopSelection { readonly before: readonly string[]; readonly after: readonly string[] }
export interface WorkshopHistory {
  // One undo step, named `label` (1-80 characters), for everything the plugin applies until commit or cancel.
  begin(label: string): { commit(options?: { readonly select?: WorkshopSelection }): void; cancel(): void };
}
export interface WorkshopPluginData {
  get(): PluginData | null;
  set(value: PluginData | null, options?: { readonly label?: string; readonly select?: WorkshopSelection }):
    WorkshopRefusal | null;
  subscribe(listener: (data: PluginData | null,
    change: { readonly cause: WorkshopChangeCause; readonly select: readonly string[] }) => void): () => void;
}
// WorkshopHost gains `readonly history: WorkshopHistory`.
```

## Stage A: the history and the level

- `src/editor/document/` with `project-document.ts`, `history.ts` and `sections.ts` (the level's adapter and the
  whole-value one); `src/editor/history-controls.ts` for the buttons, keys and announcements; and
  `window.gettingOver.history()`: steps, redo steps, bytes, both labels, pending edits and any open transaction.
- The level is the document's first section, and every level edit is a command: the Level tab's, trigger events'
  **Apply events** and the plugin host's `project.edit.level`, whose `replace` becomes a step of the objects that
  differ. New level, Import and Server levels are steps, with reading the file or the download as their pending edit;
  the turn bake and the outline are pending edits.
- The game, the Level tab, the level checks, the header's level name and the plugin host follow the document's level,
  as they followed `LevelState`.
- `ProjectWorkspace.level` loads through `history.load` and syncs through `history.external`. Until Stage B, a change
  to the course artwork or media, which the level refers to, cuts the history as a server update of the level does,
  and a course package clears it, as opening a project does.
- **Deleted:** `LevelState`'s mutating methods and listeners; `PolygonDraft`'s history and `undo`; `undoDrawing`;
  **Undo point / stroke**; the Level tab's Ctrl/Cmd+Z handling; `setPieceHistory`, `SET_PIECE_HISTORY`,
  `removeLastSetPiece`, **Remove last placed set piece** and its diagnostics; the replace confirmations of New level,
  Import and Server levels. The README gains *Undo and redo* and rewrites *Drawing terrain* (856) and the set pieces'
  removal (1319).
- **Acceptance:**
  - On both validation levels, moving an object, Undo and Redo each give the game one `LevelChange` with one object,
    within a frame; 200 moves hold under 5 MB; idle frames cost what they cost before.
  - A set piece drop, a delete of a trap that a trigger fires (with the trigger's event), a rename, Clear labels and
    New level are one step each, and Undo restores them exactly, IDs and object order included.
  - Undo while a turn bakes cancels it; a finished turn undoes and redoes without a bake.
  - Strokes undo and redo while drawing; Finish shape leaves one step; Escape leaves none.
  - Undoing to the saved level shows it saved, autosave writes nothing and the played version returns.
  - Opening a project clears the history; a server update of the level cuts it.
  - In text fields Ctrl/Cmd+Z edits the text; elsewhere in the open Workshop it undoes, in every tab.

## Stage B: project content and game settings

- Title, settings, theme, HUD, audio, enemy art, course artwork, media, model library and the alternate character join
  the document, the binary ones as file handles in a `FileStore` (`src/editor/document/files.ts`).
- `ProjectSession` becomes saving, syncing and opening over the document. Its section fields go; its `set…`, `add…`
  and `remove…` become commands (`src/editor/document/project-commands.ts`); `applySections` loads through
  `history.load` or `history.external`; its fingerprints read the document.
- Physics, the hammer head and jar editors and Character's handle length read and edit the document's settings, and
  the game follows them. `ui.ts`'s copy, `GameUi.applySettings` and `settings`, and `ProjectWorkspace.settings` go.
- `RangeControl` and colour inputs coalesce; imports are pending edits; profiles, server copies, settings files, Reset
  to defaults and course packages are steps; Stage A's rule for artwork and media goes. `docs/projects.md` says how
  undo meets saving and server updates.
- **Acceptance:** a physics slider scrub is one step, and undoing it rebuilds the rig once; a theme colour scrub is one
  step, and the game redraws once on undo; removing a media file and undoing brings back the same file, uploading
  nothing when the server held it; a course package undoes to the previous artwork and level in one step; a section
  undone to its saved value is clean; a poll's update cuts the history at its section; code review finds no editor
  holding a section value of its own.

## Stage C: Workshop plugins

- The SDK additions above in `src/editor/workshop-sdk.ts`, routed by `WorkshopPluginHost`; `ui.range` coalesces; a
  facet change cuts the steps that touch plugin sections. `docs/workshop-plugins.md` gains an *Undo* section, and its
  example labels its drag.
- **Acceptance:** a plugin's range scrub, a `data.set` on release and a group that changes the level and the plugin's
  data are one step each, undone and redone whole; a cancelled group leaves the document as it was; a label of 81
  characters stops the plugin with `invalid-contribution` and cancels its open group; a stopped plugin's calls refuse
  with `plugin-stopped`; listeners hear `undo` and `redo` with the selection.

## Stage D: character and appearance

- The primary character, arm IK and appearance join the document. `SpriteEditorState` and `Appearance` become commands
  and projections: the character rig and the appearance rig follow the document, loading whole profiles and models
  asynchronously, the newest value winning. The IndexedDB stores and arm IK profiles become saves of the document.
- Layer, grip, arm, arm IK and alignment sliders coalesce; skeleton and motion edits are steps; the directional
  diagram's drags are transactions; image, avatar, prop and part imports are pending edits; Revert, New, imported
  profiles and loaded arm IK profiles are steps.
- **Deleted:** `SpriteEditorState`'s draft and revision counter, `Appearance`'s records, drafts and arm IK copies, and
  `ProjectWorkspace`.
- **Acceptance:** undoing an avatar import removes it from the document at once while the rig lets it go, and Redo
  loads it again; rapid Undo and Redo end showing the document's value, never a stale load; edits that need a model's
  joints wait for it, as now; a diagram drag is one step.

## Not planned

- Keeping the history across reloads, branching histories, and merging other people's server changes into it.
- Undoing saves, exports, publishing, sign-in or saved named profiles.

## Risks

- **A large refactor.** Each stage leaves each section with one source; sections not yet in the document stay outside
  the history, and Stage A's interim rule keeps the level consistent with them.
- **Identity discipline.** Code that rebuilds an equal value instead of keeping the old one leaves an undone section
  dirty. Commands that change nothing record nothing, values are frozen, and the history checks identities.
- **Asynchronous projections.** After an undo, the character rig and models lag the document; they must show loading
  and never apply a stale load.
- **Memory.** Files kept only for undo count against the budget: removing a 64 MiB media file pushes out older steps.
- **Collaboration.** A busy shared server project cuts histories often.

## Open questions

- Should Undo switch to the step's tab instead of naming it?
- Should there be a history list, to go back several steps at once?
- Which budgets, measured on the benchmark levels, fit low-end devices?
- Should server updates rebase the steps that do not conflict with them instead of cutting the history?
- Should trigger events commit field by field, as other fields do, instead of through **Apply events**?
- Undo cannot remove a set piece once later edits follow. Does the Level tab need a way to select a whole placed piece?
- Should a two-finger tap undo on the Level canvas, as touch editors often do?

## Context

The owner asked for a design, not an implementation, of a command system that gives the Workshop one source of truth
and one undo history for changes a designer does not like. The baseline has two ad hoc undos and half a dozen owners
of authored state, each changing it its own way. This design makes the project one document, every change a command
and the history the document's only writer, then moves the editors onto it a section at a time, Workshop plugins
included.
