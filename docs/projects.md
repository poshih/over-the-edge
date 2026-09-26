# Game projects

A **project** holds every authored input of one complete game: title, level,
physics, characters, appearance models, arm IK, theme, HUD, audio, enemy art,
media and course artwork. The engine is the same for every project, so you can
make different total conversions and switch between them by switching projects.

- In the Workshop, **Project** opens, saves, exports and publishes projects.
- `GAME_PROJECT=<project> npm run build:game` builds any project into a
  standalone, editor-free release.
- A self-hosted **project server** stores projects on disk and offers a JSON API,
  so scripts and language models can read and change every setting.

[`examples/projects/lantern-cavern`](../examples/projects/lantern-cavern) is a small
total conversion made only of data: a dark cave theme, recoloured character, custom
enemy pixel art, HUD in feet, music, sound cues, a play-sound event and its own course.

```sh
GAME_PROJECT=examples/projects/lantern-cavern npm run dev:game
GAME_PROJECT=examples/projects/lantern-cavern npm run build:game
```

## What a project contains

| Section | Stored in | Contents |
| --- | --- | --- |
| `title` | `project.json` | Game name: browser tab and release title (1-80 characters) |
| `level` | `level.json` | Level JSON, schema 2, as exported from Workshop / Level |
| `settings` | `project.json` | Game-settings profile v2: physics and cursor target |
| `characters/primary` | `characters/primary.json` | Character profile, or `null` for the procedural character |
| `characters/alternate` | `characters/alternate.json` | Optional second character players can switch to |
| `arm-ik` | `project.json` | Body-relative elbow hints |
| `appearance` | `project.json` + `appearance/<part>.glb` | Per-part GLB replacements and their alignment |
| `theme` | `project.json` | Sky, fog, exposure, lights, sun disc, backdrop, aim marker, procedural character colours |
| `hud` | `project.json` | Release readout labels, unit, scale, decimals and visibility |
| `audio` | `project.json` | Master volume, looping music and sound cues |
| `enemies` | `project.json` | Replacement pixel art per enemy species |
| `art` | `project.json` + `art/<assetId>.glb` | Course artwork: release look and terrain GLBs |
| `media` | `project.json` + `media/<file>` | Videos and sounds, used as `/media/<file>` |

Nothing else reaches a release: a project release does not copy `public/`, so it
ships only its own media plus the site icon.

## Project directory

```text
my-game/
  project.json                  manifest: small sections inline, file references
  level.json
  characters/primary.json       only when the project has a character profile
  characters/alternate.json
  appearance/torso.glb          one GLB per replaced part
  art/asset-<sha256>.glb        terrain meshes, named by their content hash
  media/intro.webm
  media/clink.wav
```

The paths are fixed, so a manifest only says which files exist:

```json
{
  "format": "over-the-edge-project",
  "schemaVersion": 1,
  "title": "Lantern Cavern",
  "level": "level.json",
  "art": { "mode": "shapes", "assets": [] },
  "settings": { "schemaVersion": 2, "physics": { "...": "..." }, "cursor": { "maxRadius": 2.65 } },
  "characters": { "primary": null, "alternate": null },
  "armIk": { "leftHintX": -0.55, "leftHintY": 0.15, "leftHintZ": -0.35, "rightHintX": 0.55, "rightHintY": 0.15, "rightHintZ": 0.45 },
  "appearance": [],
  "theme": { "sky": "#0e1418", "fog": { "color": "#0e1418", "near": 18, "far": 55 }, "...": "..." },
  "hud": { "height": { "visible": true, "label": "DEPTH CLIMBED", "unit": "ft", "scale": 3.28084, "decimals": 0 },
           "timer": { "visible": true, "label": "LANTERN TIME" } },
  "audio": { "volume": 0.9, "music": { "source": "/media/cavern-loop.wav", "volume": 0.35 }, "cues": { "...": "..." } },
  "enemies": { "bird": { "frames": [["..."], ["..."]], "palette": { "#": "#0b0d10" } }, "hollow-soldier": null },
  "media": [{ "path": "/media/cavern-loop.wav" }]
}
```

Every key is required and unknown keys are rejected, like the other file formats.
Directories are friendly to version control and to tools that edit files directly.

A **project file** (bundle) is the same file tree in one JSON document, for moving
a game between machines and browsers. JSON files are embedded as values and binary
files as base64 data URLs:

```json
{
  "format": "over-the-edge-project-bundle",
  "schemaVersion": 1,
  "files": {
    "project.json": { "format": "over-the-edge-project", "...": "..." },
    "level.json": { "schemaVersion": 2, "labels": [], "objects": [] },
    "media/clink.wav": "data:audio/wav;base64,UklGR..."
  }
}
```

A bundle may not contain files its manifest does not reference.

## Validation and references

Projects are validated as a whole, with the same validators the Workshop and the
release build already use. Additionally:

- Every site-relative source in a level video or sound event, and every audio
  source, must be a `/media/` file in the project's media library. External
  HTTP(S) sources remain allowed.
- Every terrain `art.assetId` must be a course artwork asset, and each asset's ID
  must match the SHA-256 of its GLB.
- Character GLBs, appearance GLBs and course GLBs pass the same structure,
  rig and budget checks as their existing import paths.
- Media files must start with the signature of their extension, so a `.wav` path
  can never serve HTML or script.

A project that fails any check neither builds nor saves; the error names the section.

## Building a standalone game

```sh
GAME_PROJECT=projects/my-game npm run build:game              # a project directory
GAME_PROJECT=projects/my-game/project.json npm run build:game # its manifest
GAME_PROJECT=exports/my-game.project.json npm run build:game  # a project file
```

The path must be inside this repository. The release in `dist-game/` embeds the
project's validated level, settings and presentation; character, appearance and
course GLBs and media become hashed assets. Model and audio loaders are bundled
only when the project uses them, and the build still fails if an editor module
reaches the release. `npm run dev:game` restarts when a project file changes.

`GAME_PROJECT` is the whole game, so combining it with `GAME_LEVEL`,
`GAME_SETTINGS`, `GAME_SPRITES` or `GAME_ALTERNATE_SPRITES` fails. The project
title replaces `GAME_TITLE`: a `GAME_TITLE` from `.env` files is ignored, and one
passed on the command line fails. `GAME_ART_MODE` still overrides the project's
course artwork look.

Deploy `dist-game/` like any other release, for example with
`npx wrangler deploy --config wrangler.game.toml`.

## Working in the Workshop

**Workshop / Project** shows the game title and whether the page holds a local
project or one from the project server, plus which sections have unsaved changes.

- **Open project** loads a server project into every editor at once: the level,
  physics, character profile, appearance models, arm IK and all project sections.
  The page remembers it and reopens it after a reload.
- **Save project** writes only the changed sections. **Save as project ID** stores
  the whole game as a new project (or replaces the project with that ID).
- **New project** starts from the built-in course and defaults.
- **Export project file** downloads the whole game as one bundle; **Import project
  file** replaces the Workshop's game with one. Both work without a server.
- **Publish standalone game** saves unsaved changes, builds the release on the
  server and links to it at `/play/<id>/`.

The remaining sections edit what only a project has, with a live preview:
**Theme**, **HUD**, **Audio** (music and cue sounds from the media library, with
test buttons), **Enemy art** (JSON pixel art, starting from the built-in art),
**Media library**, **Alternate character** (use, swap, import or remove a second
profile) and **Course artwork** (release look, or import a `pack:course` package).

Everything else keeps its usual tab. Opening or importing a project replaces the
page's current game, its sprite draft and its browser-saved appearance models; the
Workshop asks first when there are unsaved changes.

While a server project is open, the page checks the server every two seconds.
Sections changed on the server, for example by a script or a language model, load
automatically when you have not changed them; level changes arrive as incremental
edits, so a playtest keeps going. A section changed on both sides is reported as a
conflict and kept as you edited it: **Save project** then overwrites the server's
version, and **Open project** takes it instead.

The editor HUD previews the project's HUD labels and units. Opening a project runs
its level like any imported level, including intro events.

## The project server

The project server is part of the Workshop's Vite server, so there is nothing
else to install or host:

```sh
npm run dev      # Workshop and project server at http://localhost:5181
npm run studio   # builds the Workshop, then serves it with the project server at http://localhost:4174
```

It stores projects in `projects/<id>/` and published releases in `releases/<id>/`,
both ignored by Git. Settings, from the environment or `.env.local`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STUDIO_PROJECTS` | `projects` | Folder holding the project directories |
| `STUDIO_RELEASES` | `releases` | Folder for published releases; must be inside this repository |
| `STUDIO_TOKEN` | unset | Access token, at least 16 characters, for use from other machines |
| `STUDIO_API` | on | `off` removes the project server |

Without `STUDIO_TOKEN`, the API only answers requests from this computer that use
`localhost`, `127.0.0.1` or `[::1]`; other hosts are refused, which also blocks DNS
rebinding. With a token, every request needs `Authorization: Bearer <token>`; the
Workshop asks for it once and keeps an HttpOnly session cookie. Every change must
also send `X-Studio-Request: 1`, which browsers cannot add to cross-site requests,
and requests with a foreign `Origin` are refused. The dev server never serves the
project and release folders as plain files, so they are only reachable through these
checks. Serve it over HTTPS if you expose it beyond a trusted network.

A static Workshop deployment has no project server; its Project tab still opens,
edits and exports project files.

## API for scripts and language models

`GET /api` returns a machine-readable guide generated from the validators: every
endpoint, every section with its fields, ranges and examples, level object and
trigger event shapes, the enemy art format with the built-in art, media types and
limits. Point a tool or model at it before it edits a project.

Conventions:

- Changes need `X-Studio-Request: 1`; JSON bodies need
  `Content-Type: application/json`; uploads send raw bytes with their media type or
  `application/octet-stream`.
- `PATCH` applies a JSON merge patch; unlike RFC 7386, `null` sets a field to
  `null`. Patching a character profile recomputes its schema version.
- Every change is validated before anything is written and fails with
  `{ "error": { "code", "message", "section" } }`, leaving the project unchanged.
- Sections have revisions: `GET` returns `ETag: "<revision>"`, and a change with
  `If-Match` fails with `412` if the section changed meanwhile.
  `GET /api/projects/{id}/revision` is a cheap poll.
- Upload files before referencing them. Deleting a file that is still used fails
  with `409`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create `{ "title", "id"? }` from the built-in course |
| GET, DELETE | `/api/projects/{id}` | Manifest, revisions and file sizes; delete |
| GET, PUT | `/api/projects/{id}/bundle` | Export or import the whole project |
| GET, PUT, PATCH | `/api/projects/{id}/{section}` | Any section in the table above |
| DELETE | `/api/projects/{id}/characters/{primary\|alternate}` | Remove a profile |
| GET, POST | `/api/projects/{id}/level/objects` | List or add level objects |
| GET, PUT, PATCH, DELETE | `/api/projects/{id}/level/objects/{objectId}` | One object |
| GET, PUT | `/api/projects/{id}/level/labels` | Course labels |
| POST | `/api/projects/{id}/art/assets?name=` | Upload a course GLB; returns its asset ID |
| GET, PUT, DELETE | `/api/projects/{id}/appearance/{part}/model?name=` | A part's GLB |
| GET, PATCH, DELETE | `/api/projects/{id}/appearance/{part}` | A part's name and alignment |
| GET, PUT, DELETE | `/api/projects/{id}/media/{file}` | Media library files |
| POST | `/api/projects/{id}/validate` | Every release check, reported as problems |
| POST, GET | `/api/projects/{id}/publish` | Build the release; latest publish record |
| GET | `/play/{id}/` | The published release |

For example, starting a new game and shaping it from a shell:

```sh
H='-H X-Studio-Request:1 -H Content-Type:application/json'
curl -s -X POST localhost:5181/api/projects $H -d '{"title":"Night Climb","id":"night-climb"}'
curl -s -X PATCH localhost:5181/api/projects/night-climb/theme $H \
  -d '{"sky":"#0b1020","fog":{"color":"#0b1020","near":20,"far":70},"sunDisc":{"visible":false}}'
curl -s -X PATCH localhost:5181/api/projects/night-climb/settings $H -d '{"physics":{"hammerMass":1.2}}'
curl -s -X PUT localhost:5181/api/projects/night-climb/media/bell.wav \
  -H X-Studio-Request:1 -H Content-Type:audio/wav --data-binary @bell.wav
curl -s -X POST localhost:5181/api/projects/night-climb/level/objects $H -d '{
  "kind":"trigger","id":"bell","name":"Bell","x":3,"y":2,"region":{"type":"circle","radius":1.5},
  "activation":"once","marker":"none","events":[{"type":"play-sound","source":"/media/bell.wav","volume":1}]}'
curl -s -X POST localhost:5181/api/projects/night-climb/publish -H X-Studio-Request:1
```

An open Workshop page shows each change within two seconds.

## Section reference

**Theme.** Colours are lowercase `#rrggbb`. `fog.near` and `fog.far` are metres
from the camera (`far` must exceed `near`); `exposure` is 0.2-3; light intensities
are 0-10. `sunDisc` and `backdrop` can be hidden. `character` recolours the
procedural Mesh parts character (pot, trim, dark details, suit, skin, handle);
imported models keep their own materials. Theme changes restyle existing lights
and materials in place.

**HUD.** `height.label`, `height.unit` (may be empty), `height.scale` (metres are
multiplied by it; `3.28084` shows feet), `height.decimals` (0-3) and
`timer.label`; either readout can be hidden. The default HUD is exactly the
original one.

**Audio.** `volume` (master) and each clip's `volume` are 0-1. `music` loops while
the game runs and pauses with it. Cues: `impact` (hammer strikes, louder when
faster), `enemy-hit`, `enemy-defeat`, `launch` (Launch player events), `finish`
(Stop timer events) and `fall` (falling out of the level). Browsers start audio only
after the player first clicks, taps or presses a key; sounds are fetched ahead of
time and decoded then. Releases without audio or sound events include no audio code.

**Play sound event.** Triggers can play a sound without pausing:
`{ "type": "play-sound", "source": "/media/bell.wav", "volume": 1 }`. The next event
starts immediately. Levels using it need an updated runtime.

**Enemy art.** Per species (`bird`, `hollow-soldier`): `null` for the built-in art,
or `{ "frames": [rows, rows], "palette": { "<char>": "#rrggbb" } }` with exactly two
frames of equal size, at most 64 x 64 pixels and 32 palette colours. Rows read top
to bottom and face right; `.` is transparent. Art is cosmetic: colliders, health,
behaviour and display size stay the same, and all enemies still share one draw batch.

**Media.** Files are addressed as `/media/<name>` with a lowercase name ending in
`.webm`, `.mp4`, `.mp3`, `.ogg`, `.wav` or `.m4a`; at most 64 files, 64 MiB each and
160 MiB in total. Releases bundle them as hashed assets and resolve the authored
paths to those assets, so media keep working when a release is published below a
sub-path such as `/play/<id>/`.

**Appearance, arm IK and characters.** Appearance parts are the Workshop's
per-part GLB replacements (20 MiB each, 64 MiB in total), fitted with the same
alignment as in Workshop / Appearance, and now included in releases. Arm IK is the
Appearance tab's body-relative elbow hints. Character profiles are the files
Workshop / Character exports; see [imported 3D characters](characters.md) and
[sprites](sprites.md).

**Course artwork.** `mode` is `shapes` or `meshes`; assets come from
`npm run pack:course` packages or the API upload. See [course artwork](course-artwork.md).

## Limits

A project directory has no overall size limit beyond its sections. A project file
is limited to 384 MiB; export very large games as directories instead. `project.json`
is limited to 2 MiB, and each section keeps its existing limit.

## Verification

```sh
npm run verify:project
```

This builds the example project as a directory and as a project file, checks that
invalid projects and conflicting inputs fail, builds and plays a project with two
character profiles, an appearance model and arm IK, exercises the API (validation,
revisions, token and host checks, cross-site protection, file signatures,
references, bundles, publishing), drives the Project tab end to end (open, save,
live sync, conflicts, enemy art, media, alternate character, export, import, save
as, publish, reopen) and measures a 1,000-object project. It writes
`artifacts/project-report.json`.
