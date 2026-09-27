# Feature request: terrain and pot friction in game settings

**Date:** 2026-09-26 · **Baseline:** `e186181` · **Status:** requested, not started.

Game projects (`docs/projects.md`) made every other gameplay tuning value project data, but two
material frictions are still engine constants: `PHYSICS.terrainFriction` (3, applied to terrain
fixtures in `src/terrain-world.ts`) and `PHYSICS.potFriction` (0.45, the pot fixture in
`src/player.ts`). Hammer friction is already a setting (`settings.physics.gripFriction`, Workshop
Settings → Materials). A game whose ground should feel different (e.g. slicker stone at 0.8) must
edit `src/config.ts`, so its project cannot describe the whole game and the same engine release
cannot serve both games.

## Requested capability

- **Settings:** add `terrainFriction` and `potFriction` to the physics tuning, in the *Materials*
  group next to hammer friction, with validated ranges (for example 0.05-10, step 0.05) and the
  current constants as defaults. A game-settings schema bump that loads v2 profiles and projects
  with those defaults, so existing games play exactly as before.
- **Runtime:** terrain and pot fixtures use the active settings. Changing either in the Workshop
  applies to the existing fixtures without rebuilding the level (as hammer friction does today via
  `fixture.setFriction`), and a release uses the value its project or `GAME_SETTINGS` carries.
- **Everywhere settings go:** Workshop Settings controls, saved settings profiles, project
  `settings`, the project API guide (`GET /api/`), and `GAME_SETTINGS` / `GAME_PROJECT` builds.

## Acceptance

- A project with `physics.terrainFriction: 0.8` builds a release whose terrain fixtures have
  friction 0.8; the default game, v2 profiles and existing projects are unchanged.
- Out-of-range or missing values fail validation with the section named, like other tuning fields.
- No engine module needs editing to give a game different material frictions.

## Context

A downstream game (now an `e186181` project) keeps terrain friction 0.8 in a local edit of
`src/config.ts`; with this capability that value moves into its project and the edit goes away.
