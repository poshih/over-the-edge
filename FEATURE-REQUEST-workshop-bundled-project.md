# Feature request: a deployed Workshop opens its game's project

**Date:** 2026-09-26 · **Baseline:** `e186181` · **Status:** implemented; see [publishing a Workshop with its
project](docs/projects.md#publishing-a-workshop-with-its-project). The project's files ship as separate hashed
assets instead of one bundle, so unchanged files stay cached and each fits static hosts' per-file limits.

Game projects (`docs/projects.md`) hold a whole game, and `GAME_PROJECT` builds one into a release.
The Workshop build cannot carry a project, so a deployed (static) Workshop never shows the game it
belongs to:

- `vite.config.ts` has no project input; `GAME_PROJECT` only affects `vite.game.config.ts`.
- `ProjectSession.start()` (`src/editor/project-session.ts`) only reopens a remembered **server**
  project. A static deployment has no server, so the page boots from browser-local editor state:
  `DEFAULT_LEVEL`, the Sprites tab's last *save* (`SpriteEditorState.restore`), saved appearance
  models and IK profiles.
- **Import project file** loads every section, but nothing persists it: `loadDocument` replaces only
  the sprite draft, and no local project is remembered. A reload returns to the older browser state.
- That older state can be a broken character. A schema-4 Hybrid save from an earlier release now
  restores as pure 2D without its 3D body (`spriteMigrationNotice`).

Example: a team deploys its Workshop for authoring a skinned `avatar-3d` character. Opening the
editor shows a leftover 2D save with no body. Every visit needs a manual file import, and a reload
loses the imported project again.

## Requested capability

- **Build input:** `GAME_PROJECT=<directory|bundle> npm run build` bundles that project into the
  Workshop build.
  - Validate it at build time with the same checks and errors as release builds.
  - Emit it as a hashed static asset fetched at boot, not inlined into the JavaScript. A project
    with two embedded character profiles is about 16 MB.
  - Take the page title from the project, as release builds do.
  - Builds without `GAME_PROJECT` stay exactly as today.
- **Boot:** a page with no project of its own opens the bundled project as **Import project file**
  does.
  - That covers level, settings, arm IK, appearance, theme, HUD, audio, enemy art, media and course
    art.
  - The primary character opens in its own rigging type: an `avatar-3d` primary boots in avatar
    mode with its model. The alternate appears under *Alternate character*.
  - Show loading progress, and report failures through the normal notice path.
- **Local persistence (static deployments):** keep the open project, with unsaved edits, in browser
  storage and reopen it after a reload, as a remembered server project is reopened today.
  - **Export project file** remains the way to take work out.
  - Add a **Reopen published project** action that discards the page's copy.
- **Precedence and updates:**
  - Browser saves from before the project (Sprites save, appearance models, IK and settings
    profiles) must not override the bundled project at boot. They stay in storage unchanged.
  - When a new deployment bundles a changed project:
    - A page with no unsaved changes opens the new version.
    - A page with unsaved changes keeps them and offers the new version, as the existing
      "asks first when there are unsaved changes" flow does.
  - With a project server (`npm run dev` / `studio`), a remembered server project keeps
    precedence.

## Acceptance

- After `GAME_PROJECT=projects/my-game npm run build` and a static deploy, a fresh browser opens
  the Workshop showing my-game with no import:
  - title, level, settings, arm IK, appearance and look
  - its primary character in its rigging type
  - its alternate under *Alternate character*
- A browser holding older saves boots into the bundled project; the older saves remain unchanged.
  This includes a Hybrid save migrated to 2D.
- Edit, then reload: the edits and the unsaved-changes state are still there until
  **Reopen published project**.
- Redeploy with a changed project: a clean page shows the new version, and a page with unsaved
  changes keeps them and offers the new one.
- An invalid bundled project fails the build with the section named.

## Context

A downstream game deploys its Workshop as a static Worker for authoring its skinned 3D character,
and its game project (`e186181` format) has that avatar as the primary character. The owner opens
the editor expecting the project in avatar mode. They see a leftover Hybrid-era 2D save with no body
instead, and importing the project file must be repeated after every reload.
