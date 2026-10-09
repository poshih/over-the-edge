# Feature request: level names

**Date:** 2026-10-09 · **Baseline:** `eb15c1d` · **Status:** requested; nothing is implemented. A downstream game waits
for this instead of patching the Workshop.

A level has no name. `LevelDefinition` (`src/level.ts`) holds `schemaVersion`, `labels` and `objects`, and
`validateLevel` refuses any other key; the only metadata edited beside the objects is the course labels
(`validateLevelMetadata`). A project names its level only by its file, `level.json`, and the Workshop lists server
levels by file name (`build/workshop-levels.ts`).

Where a name would go, the Workshop shows fixed engine text: the eyebrow above the game title in its game header is the
literal "PHYSICS PLAYGROUND / 01" (`src/editor/game-ui.ts`), with every project and every level. Releases show no name
at all: the game-only HUD has height, health and timer readouts (`HUD_READOUTS`, `src/hud-readouts.ts`), and no
readout, HUD setting or `HudFrame` field knows the level.

This request gives a level a name of its own, edited in the Workshop, shown in its header and available to releases.

## Rules every stage keeps

- **A name changes no play.** Like labels and message text, it stays out of the phantom course (`src/phantom-course.ts`
  reads only objects) and out of the course checks, so renaming a level keeps its recordings.
- **It travels with the level.** The name is part of the level document, so it goes wherever a level goes: the
  project's `level.json`, server levels, Export and Import level JSON, project bundles, course packages, the level
  history's versions, the project API's level answers and release content. No path rebuilds
  `{ schemaVersion, labels, objects }` by hand and drops it.
- **Plain text on one line.** It is drawn with `textContent`, never parsed as markup, so `<b>Ledge</b>` shows as typed.
- **Event-driven.** The header and the readouts write the page only when the level or its name changes.

## Stage A: the name in the level format and the Workshop

### Format: level schema 11

- `LevelDefinition` gains `name: string | null`, a required key; `null` is an unnamed level. Validated levels keep the
  key order `{ schemaVersion, name, labels, objects }`.
- A name follows the game title's rule (`build/game-title.ts`): one line without control characters (C0, C1, U+2028
  and U+2029) and 1–80 characters. Move the rule into one shared module that build code and Node scripts can import,
  used for both, so titles and level names cannot drift apart.
- A stored name is canonical: the validator refuses surrounding spaces instead of trimming them, so a file round-trips
  unchanged. The Workshop trims what is typed before it validates.
- A refusal names the field and states the rule, for example "Level name must be 1-80 characters on one line, without
  control characters." A level file with an invalid name fails to load with that error.
- `validateLevelMetadata` covers `{ name, labels }`, and `LevelState` (`src/editor/level-state.ts`) takes the name in
  `metadata` and in batch edits, as it takes labels. Set pieces (`src/editor/set-pieces.ts`) validate their labels
  alone, so they keep a labels-only check.
- `LEVEL_SCHEMA_VERSION` becomes 11 with no reader for 10: the engine updates its bundled levels below, and downstream
  games remake theirs.

### The Workshop

- **Level tab.** A **Name** field at the top of the Level tab (`level-top`, above Playtest), always in view. It commits
  on change, by Enter or by leaving the field: the trimmed text, or `null` when it is empty. A refused name shows the
  rule as a notice and restores the field. A rename is a level edit, so it marks the level unsaved, saves with the
  project or to a server level, becomes a new version in the level history and goes out with Export level JSON. Import,
  Server levels and opening a project bring the file's name; New level starts unnamed.
- **Header.** The eyebrow shows the open level's name, and the fixed "PHYSICS PLAYGROUND / 01" goes. `createGameUI`
  gains `setLevelName(name)`, which the Workshop calls from its level subscription (`src/editor/main.ts`) when a level
  loads and whenever an edit changes the name, never per frame. An unnamed level shows a muted "Untitled level"
  placeholder, whose tooltip says to name it in the Level tab. A name stays on one line; where all of it would crowd
  the game's buttons, at the narrow and Wide panel widths or on a small screen, it ends in an ellipsis, and the
  heading's tooltip shows it in full.

### Bundled levels

Each bundled level gets a name, written by its generator where it has one, so regenerating keeps it:

| Level | Name | Written by |
| --- | --- | --- |
| `src/default-course/course.json` | Over the Edge | `scripts/default-course/generate.ts` |
| `levels/showcase.json` | Showcase | `scripts/showcase/generate.ts` |
| `levels/skyward-ruins.json` | Skyward Ruins | the file |
| `examples/projects/ashen-ascent/level.json` | Ashen Ascent | `scripts/ashen-ascent/generate.ts`, through the course kit |
| `examples/projects/lantern-cavern/level.json` | Lantern Cavern | the file |

The course kit's `level()` builder (`scripts/course-kit/course.ts`) takes the name, and the level-streaming benchmarks
are named after their case. `STARTER_LEVEL` (`src/default-course.ts`), which New level opens, is unnamed. The dev server
validates `levels/*.json` as it loads, so those files change in the same commit as the version.

### Docs

`docs/projects.md` (the level format and schema 11), the README (the Workshop's Level tab and header, and level JSON's
schema) and `server/api-manual.ts` (the level's shape and the name's rule).

### Done when

- Naming the open level in the Level tab shows the name in the header at once, and the fixed text never shows.
- The name survives saving to the project and reloading the Workshop, Export then Import level JSON, opening a server
  level, a project bundle and a course package; a rename adds a level version, and the level's phantom course, and so
  its recordings, stay the same.
- A name of 80 characters fits the header at both panel widths and on a small screen without covering the buttons.

## Stage B: releases show the name

- `HudFrame` gains `level: string | null`, the open level's name, which `Game` keeps from its level as it starts and
  from `applyLevel`. The frame is reused and carries the same string until a rename, so a readout compares by value and
  draws only on change. Plugin readouts, in `hud.extras` or wrapping a built-in, can present the name their own way.
- The HUD settings gain `level: { visible, label }`, by default `{ visible: false, label: 'LEVEL' }`, edited in
  Workshop / Project / HUD as **Show the level name** and **Level label** (1–32 characters).
- `HUD_READOUTS` gains `'level'`, first in the bar, with the slot point `HUD.level` (`hud.level`) and
  `DEFAULT_HUD_READOUTS.level`, the label over the name. The bar builds it only while `level.visible` is on, and it
  hides its slot for an unnamed level, as the health readout hides in a level where nothing hurts. A project that
  leaves it off shows players no name. The Workshop's readout bar previews it the same way.
- Release content embeds the level whole (`src/content.ts`), so the name is already there. The HUD's shape changes, so
  `PROJECT_SCHEMA_VERSION` and `CONTENT_SCHEMA_VERSION` move on together, with both example `project.json` files and
  `scripts/ashen-ascent/project.ts`.
- Docs: `docs/runtime-plugins.md` (the `hud.level` readout and `HudFrame.level`), `docs/plugins.md` (the point
  catalogue), `docs/projects.md` (the HUD fields), the README's `GAME_TITLE` paragraph, which says the game-only HUD
  shows no title, and its Game-only release section, and `server/api-manual.ts`.

### Done when

A release built from a project with a named level shows the name when its HUD settings ask for it and none when they do
not, and a runtime plugin's readout can show the name instead.

## Not planned

- Level selection menus, numbering or ordering levels, title cards or animations, and localization.
- The Workshop's other fixed text: the footer's "TWO MOTORS. ONE MOUNTAIN. YOUR WAY UP." and the page's title suffix and
  description in `index.html`. A separate request if a project needs to set or hide them.
- The name in gameplay moments: it is not a gameplay event, and readouts are where a game presents it.

## Open questions

- Should **Level / Server levels** list a named level by its name, with its file name beside it?

## Context

A downstream game makes its levels by hand in the Workshop, each level's JSON its single source of truth, and names
them in its plans, but the format has nowhere to keep a name. While editing it sees "PHYSICS PLAYGROUND / 01" above its
own title, and its players meet a level's name only as the title of an in-level message. It patches no engine file and
keeps no table of names beside its levels, so it waits for the level itself to carry its name.
