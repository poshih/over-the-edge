# Feature request: one look for releases and the Workshop

**Date:** 2026-10-09 · **Baseline:** `15c03ee` · **Status:** requested; nothing is implemented.

Releases and the Workshop share their drawing code, but each hands the project's look to it on its own: a release in
`src/release.ts` and `src/release-art.ts`, the Workshop in `src/editor/main.ts` and `ProjectSession`'s `onLook`. The
theme, the HUD, enemy art and the course's GLBs are each handed over twice, and decoration artwork only once:

- A release draws every decoration whose model the course artwork maps (`art.decorations`) as that GLB
  (`loadCourseArt` calls `DecorationView.useArtwork`). The Workshop never does. There a mapped model shows its built-in
  stand-in, or nothing at all when the library lacks the model, such as `stone-idol`; its selection box is a guess,
  half as wide as tall (`decorationSize`, `src/editor/level-editor.ts`), and nothing warns. The decoration library's help
  and `docs/decorations.md` call this intended: "the Workshop keeps showing the placeholder".
- The course look's shape mode (Project / Course artwork / Course look) is a second way to draw the whole course, and a
  second way for a decoration to show nothing: shape releases refuse models the library lacks.
- Level JSON imports check only the level, so the Workshop can hold a decoration whose model nothing draws; saves,
  the project server and release builds refuse it later (`unknownDecorationModels`, `src/decoration-models.ts`).

This request makes the look one value that one function applies in releases and the Workshop alike, removes shape mode,
keeps every decoration in the Workshop drawable, and lets the Level tab place the project's own models.

## Rules every stage keeps

- **One source.** Releases and the Workshop differ only in where GLB bytes come from (release content, project files)
  and when they load (before play, on demand). Neither wires a renderer of its own.
- **Same pixels.** A level in the Workshop draws as the release made from it does: the same models at the same size,
  depth, tilt, turn, mirror and tint.
- **Incremental and instanced.** A look change redraws only what changed. Decorations stay batched by chunk, model and
  side. Each GLB loads once per page and is shared by terrain and decorations. Nothing costs per frame while idle.
- **Release boundary.** The course-art renderer stays injected, so releases without GLBs carry no GLTF loader, and
  runtime code imports nothing from the editor.
- **No compatibility.** Format changes bump their schema versions; bundled projects and packages are rewritten, and
  nothing reads the old shape.

## Stage A: remove shape mode

- Removed: `ArtMode`; `art.mode` in projects, release content and course packages; `CourseArtView.setMode`;
  Project / Course artwork / Course look; the Workshop SDK's `edits.artMode`; `GAME_ART_MODE` in builds, `dev:game`
  and publishing; `pack:course --mode`.
- The course draws one way. Terrain with a GLB draws its GLB, or its collision extruded while the GLB loads or if it
  cannot; other terrain draws its collision extruded, as now. A decoration draws its GLB when the course artwork maps
  its model, and its built-in model otherwise.
- A build from plain level JSON whose terrain places GLBs is refused and points to course packages and
  `GAME_PROJECT`, which carry the GLBs; today it builds in shape mode.
- Which GLBs a level uses (its terrain's, and those of the decoration models it places) is worked out in
  `src/decoration-art.ts`, shared by the release build (`drawnArt`, `build/release-input.ts`) and release content
  validation (`src/content.ts`), which repeat it today.
- Project schema 21, content schema 20, course package schema 3. The bundled projects, the default course, the
  level-streaming benchmark (its slices case, which measures collision memory, drew in shape mode), the docs and the
  API manual follow.

## Stage B: one look

- `GameLook` (`src/game-look.ts`): the theme, the HUD, enemy art and the course artwork (its GLBs and the decoration
  models they draw). A release builds it from its manifest; the Workshop from the open project as edited, saved or not.
- `Game` takes the look when created and `setLook(look)` after; `game.look` is the look applied. It restyles the scene,
  swaps enemy art, sets the HUD and draws the course artwork, each only when its part changed. The `theme`, `enemyArt`
  and `hud` options go.
- The game view makes the course-art renderer from an injected factory, null in releases without GLBs, and an injected
  GLB source. `src/release-art.ts` goes and `virtual:game-art` exports the factory. A release awaits
  `game.loadArtwork(signal)`, which loads every GLB its look lists before play, as now. The Workshop's own
  `CourseArtView` and its mode wiring go.
- The HUD bars of the game page and the Workshop, and the game menu, read the HUD settings from the game's look and
  follow it. `ProjectSession` re-applies the look after every change to the theme, HUD, enemy art or course artwork.
- Audio settings, which releases scale by the player's own volume, stay as they are.

## Stage C: decorations draw the project's models in the Workshop

- The course-art renderer owns every GLB, for terrain and decorations alike. A GLB loads when the first terrain object
  or decoration needs it and is let go a frame after the last stops, unless a release loaded it up front. One budget
  covers both.
- `DecorationView` draws a mapped model as its GLB as soon as the GLB arrives. A change to the mapping redraws only the
  models whose GLB changed. The placement preview holds its GLB too.
- A GLB that cannot load is reported by name, as terrain's are; its decorations draw the built-in model if there is one.
- Editing uses the model as drawn: selection, outlines, the turn dial and the placement preview, redrawn when a GLB
  arrives. The half-as-wide box remains only while a GLB is loading.

## Stage D: every decoration drawable; the project's models in the Level tab

- One rule says whether a model can be drawn: the decoration library has it, or the course artwork maps it. Saves,
  the project server and release builds already refuse levels that break it. The Workshop's level (`LevelState`) now
  refuses every change that would: Level JSON imports, server levels and plugin edits, with the message saves give.
  The project's artwork is adopted before its level, as course package imports already do. Workshop changes to the
  course artwork that would strand a decoration are refused already.
- Level / Decoration library gains a **Project** group listing every model the course artwork maps, by model ID with
  its GLB's name. Placing one uses the library's defaults when the library has the model, and otherwise the GLB's own
  height and a depth 3 m behind the course. Object properties' Model list includes them; its "no placeholder" entry
  goes.
- The decoration library's help, the Project / Course artwork status, `docs/decorations.md`, `docs/course-artwork.md`,
  `docs/projects.md` and the README say what the Workshop draws.

## Acceptance

- A project whose course artwork maps `stone-idol`, which the library lacks, and a built-in model draws both as their
  GLBs in the Workshop, where and as its release does.
- Importing a course package that maps a model to another GLB redraws that model's decorations at once, unsaved.
- A `stone-idol` decoration is selected by its drawn outline, and its selection box matches the mesh.
- Importing Level JSON with an unmapped `stone-idol` is refused with the message a save gives.
- The project's models are listed under Level / Decoration library / Project and can be placed.
- A built-in model the artwork does not map still draws its built-in model.
- A release without GLBs contains no GLTF loader; decoration drawing costs nothing per frame while idle.

Not in this request: audio settings in the look, and thumbnails of the project's models in the library.

## Context

A downstream game builds its levels by hand in the Workshop, with its own decoration models drawn by course artwork.
Its game drew them, but the Workshop showed almost none, so its scenery could be judged only by playing a release.
