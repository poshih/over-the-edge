# Game projects

A **project** holds every authored input of one complete game: title, level,
physics, characters, appearance models, arm IK, a model library, theme, HUD, audio,
enemy art, media and course artwork. The engine is the same for every project, so you can
make different total conversions and switch between them by switching projects.

- In the Workshop, **Project** opens, saves, exports and publishes projects.
- `GAME_PROJECT=<project> npm run build:game` builds any project into a
  standalone, editor-free release.
- `GAME_PROJECT=<project> npm run build` builds a Workshop that opens that game,
  to deploy as a static site for the people who author it.
- A self-hosted **project server** stores projects on disk and offers a JSON API,
  so scripts and language models can read and change every setting.

[`examples/projects/lantern-cavern`](../examples/projects/lantern-cavern) is a small
total conversion made only of data: a dark cave theme, recoloured character, custom
enemy pixel art, HUD in feet, music, sound cues, a play-sound event and its own course.

```sh
GAME_PROJECT=examples/projects/lantern-cavern npm run dev:game
GAME_PROJECT=examples/projects/lantern-cavern npm run build:game
```

[`examples/projects/ashen-ascent`](../examples/projects/ashen-ascent) is a full-length
souls-like game that places all 67 set pieces from the library along one climb to a
castle in the sky. It is generated; see [Ashen Ascent](ashen-ascent.md).

## What a project contains

| Section | Stored in | Contents |
| --- | --- | --- |
| `title` | `project.json` | Game name: browser tab and release title (1-80 characters) |
| `level` | `level.json` | Level JSON, schema 4, as exported from Workshop / Level |
| `settings` | `project.json` | Game-settings profile, schema 4: physics (including the downswing boost), hammer rig and cursor target (radius and dead zone) |
| `characters/primary` | `characters/primary.json` | Character profile, or `null` for the procedural character |
| `characters/alternate` | `characters/alternate.json` | Optional second character players can switch to |
| `arm-ik` | `project.json` | Body-relative elbow hints |
| `appearance` | `project.json` + `appearance/<part>.glb` | Per-part GLB replacements and their alignment |
| `models` | `project.json` + `models/<part>/<id>.glb` | Model library: avatars, hammers and pots a release can swap to, each part on its own |
| `theme` | `project.json` | Sky, fog, exposure, camera, lights, sun disc, backdrop, aim marker, procedural character colours |
| `hud` | `project.json` | Release readout labels, unit, scale, decimals and visibility; how trigger messages appear |
| `audio` | `project.json` | Master volume, looping music and sound cues |
| `enemies` | `project.json` | Replacement pixel art per enemy species |
| `art` | `project.json` + `art/<assetId>.glb` | Course artwork: release look, terrain GLBs and the GLBs replacing decoration models |
| `media` | `project.json` + `media/<file>` | Videos and sounds, used as `/media/<file>` |

Nothing else reaches a release: game builds do not copy `public/`, so a project
release ships only its own content plus the site icon.

## Project directory

```text
my-game/
  project.json                  manifest: small sections inline, file references
  level.json
  characters/primary.json       only when the project has a character profile
  characters/alternate.json
  appearance/torso.glb          one GLB per replaced part
  models/avatar/knight.glb      model library, one GLB per entry and part
  models/hammer/club.glb
  art/asset-<sha256>.glb        terrain meshes, named by their content hash
  media/intro.webm
  media/clink.wav
```

The paths are fixed, so a manifest only says which files exist:

```json
{
  "format": "over-the-edge-project",
  "schemaVersion": 6,
  "title": "Lantern Cavern",
  "level": "level.json",
  "art": { "mode": "shapes", "assets": [], "decorations": {} },
  "settings": {
    "schemaVersion": 4, "physics": { "...": "..." },
    "rig": { "handleLength": 1.5, "maxExtension": 1.15 }, "cursor": { "maxTargetRadius": 2.65, "deadZone": 0.1 }
  },
  "characters": { "primary": null, "alternate": null },
  "armIk": { "leftHintX": -0.55, "leftHintY": 0.15, "leftHintZ": -0.35, "rightHintX": 0.55, "rightHintY": 0.15, "rightHintZ": 0.45 },
  "appearance": [],
  "models": { "avatar": [], "hammer": [{ "id": "club", "name": "Club" }], "pot": [] },
  "theme": { "sky": "#0e1418", "fog": { "color": "#0e1418", "near": -2, "far": 35 }, "camera": { "perspective": false, "fieldOfView": 30 }, "...": "..." },
  "hud": { "height": { "visible": true, "label": "DEPTH CLIMBED", "unit": "ft", "scale": 3.28084, "decimals": 0 },
           "timer": { "visible": true, "label": "LANTERN TIME" }, "messages": { "style": "toast" } },
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
  "schemaVersion": 6,
  "files": {
    "project.json": { "format": "over-the-edge-project", "...": "..." },
    "level.json": { "schemaVersion": 4, "labels": [], "objects": [] },
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
  must match the SHA-256 of its GLB. Every decoration model must be in the built-in
  library or drawn by a course artwork asset in `art.decorations`.
- Character GLBs, appearance GLBs and course GLBs pass the same structure,
  rig and budget checks as their existing import paths. Each library GLB passes the
  checks of its part, and each library avatar's bone map must resolve against its
  skin.
- Media files must start with the signature of their extension, so a `.wav` path
  can never serve HTML or script.

A project that fails any check neither builds nor saves; the error names the section.

## Building a standalone game

```sh
GAME_PROJECT=projects/my-game npm run build:game              # a project directory
GAME_PROJECT=projects/my-game/project.json npm run build:game # its manifest
GAME_PROJECT=exports/my-game.project.json npm run build:game  # a project file
```

The path must be inside this repository. The release's shell in `dist-game/` holds
no project data: the validated level, settings and presentation, the character,
appearance and course GLBs, and the media become content files in
`dist-game-content/`, which the shell loads and verifies; see
[content delivery](content-delivery.md). A project whose level events or audio name
external URLs does not build: a game build packages everything it plays. Model and
audio loaders are bundled only when the project uses them, and the build still fails
if an editor module reaches the release. `npm run dev:game` restarts when a project
file changes.

`GAME_PROJECT` is the whole game, so combining it with `GAME_LEVEL`,
`GAME_SETTINGS`, `GAME_SPRITES` or `GAME_ALTERNATE_SPRITES` fails. The project
title replaces `GAME_TITLE`: a `GAME_TITLE` from `.env` files is ignored, and one
passed on the command line fails. `GAME_ART_MODE` still overrides the project's
course artwork look.

Deploy it like any other release: the shell, for example with
`npx wrangler deploy --config wrangler.game.toml`, and the content to the host or CDN
that serves `GAME_CONTENT_URL`. A game whose players must sign in or own it adds its
own module with `GAME_MODULE`, and one that ships custom avatars adds its rig
strategies with `AVATAR_RIG_MODULE`; see [rig strategies](characters.md#rig-strategies).

## Working in the Workshop

**Workshop / Project** shows the game title and whether the page holds a local
project or one from the project server, plus how far saving has got.

A server project saves itself: about a second after you stop adjusting something, in
any tab, the changed sections are written to the project's files. The status says
*saving shortly*, *saving…* or *every change saved*. Leaving the page saves at once,
and the browser warns if something could not be saved yet.

- A section that cannot be saved yet holds back only itself. The status and one message
  say why, for example a character profile that does not validate or a level naming a
  missing media file, and the section saves as soon as you fix it.
- An unfinished outline and trigger event edits not yet applied are not part of the
  level, so they save once finished or applied.
- If the server cannot be reached, saving tries again every few seconds.

Each editor's own Save also has **Save to project** under it: Level's **Save level**,
Physics' **Save game settings**, Appearance's **Save alignment** (models and alignment)
and **Save IK profile**, and the character profile's **Save** in Character and Sprites.
It writes that part into the open server project at once and says so, instead of waiting
for the automatic save; a level takes along the media and course artwork it names. It is
disabled until a server project is open, and a part that also changed in the project waits
for **Keep my version** or **Use the project's**.

- **Open project** loads a server project into every editor at once: the level,
  physics, character profile, appearance models, arm IK and all project sections.
  The page remembers it and reopens it after a reload. A Workshop started with a
  project that the project server holds (`GAME_PROJECT=projects/<id>` under
  `npm run dev` or `npm run studio`) opens that server project at start instead.
- **Save as project ID** stores the whole game as a new project (or replaces the
  project with that ID), which then saves itself.
- **New project** starts from the built-in course and defaults.
- **Export project file** downloads the whole game as one bundle; **Import project
  file** replaces the Workshop's game with one. Both work without a server.
- **Publish standalone game** saves unsaved changes, builds the release on the
  server and links to it at `/play/<id>/`, where the studio also serves its content.

The remaining sections edit what only a project has, with a live preview:
**Theme**, **HUD**, **Audio** (music and cue sounds from the media library, with
test buttons), **Enemy art** (JSON pixel art, starting from the built-in art),
**Media library**, **Alternate character** (use, swap, import or remove a second
profile), **Model library** (add library avatars, hammers and pots from files or the Workshop's
[server models](characters.md#server-models), then preview and remove them; see
[imported 3D characters](characters.md#model-library-and-runtime-swaps)) and
**Course artwork** (release look, or import a `pack:course` package).

Everything else keeps its usual tab. Opening or importing a project replaces the
page's current game, its sprite draft and its browser-saved appearance models; the
Workshop asks first when there are unsaved changes.

While a server project is open, the page checks the server every two seconds.
Sections changed on the server, for example by a script, a language model or a tool
editing the project's files directly, load automatically when you have not changed
them; level changes arrive as incremental edits, so a playtest keeps going.

A section changed on both sides is a conflict. It is kept as you edited it and does not
save until you choose, in Project:

- **Keep my version** saves yours over the project's.
- **Use the project's** replaces yours.

The editor HUD previews the project's HUD labels and units. Opening a project runs
its level like any imported level, including intro events.

## Publishing a Workshop with its project

`GAME_PROJECT` also works for the Workshop build, so a deployed Workshop opens the game
it belongs to instead of whatever an earlier visit left in the browser:

```sh
GAME_PROJECT=projects/my-game npm run build
npx wrangler deploy --config wrangler.toml --keep-vars
```

The project is validated exactly as for `build:game`, and a failure names its section.
Its files become hashed static assets next to the Workshop, downloaded when the page opens
the project: the JavaScript does not grow with the game, and files that did not change keep
their URLs across deployments, so browsers reuse them. Each file must fit your host's
limit; Cloudflare Workers static assets hold at most 25 MiB per file. The page title comes
from the project, with the same `GAME_TITLE` rules as releases. Without `GAME_PROJECT` the
Workshop build is unchanged.

- **Opening.** A page without a project of its own downloads the published project,
  showing its progress, and opens it as **Import project file** does: every section, the
  primary character in its own rigging type and the alternate under **Alternate character**.
- **This browser's copy.** Once the page holds something the published project does not (a
  change, or an imported or new project), it keeps the whole project with its unsaved
  changes in this browser (IndexedDB) and reopens it after a reload. Changes are stored about
  a second after you stop editing; leaving the page before that warns first. **Export project
  file** takes the work out; **Reopen published project** discards the copy, asking first when
  there are unsaved changes.
- **Older browser saves.** Here the editors' own browser saves (the character profile from
  **Save**, Appearance's models and the selected IK profile) do not open at start, and opening
  a project never changes them. The saved character profile remains the Revert target, and
  named IK profiles, game settings profiles and level history stay available. Appearance models
  are kept in the project's copy instead of Appearance's own storage.
- **New deployments.** A page without unsaved changes opens the new version. A page with
  unsaved changes keeps them and says that a newer version is published; **Reopen published
  project** takes it.
- **Server levels.** **Workshop / Level / Server levels** lists the project's level first, then
  the `levels/` folder's levels. Loading the project's level brings it back after trying another
  one, without discarding the project's other changes.
- **Project server.** Under `npm run dev` or `npm run studio`, a remembered server project
  still opens first, then the server's copy of the published project when the server holds
  it; either way every change saves to the server.
  - Opening or saving a server project removes the browser copy.
  - A browser copy that still holds unsaved changes waits in Project instead: **Restore into
    the project** loads them, replacing those sections, and **Discard them** removes them.

**Workshop / Project** says what the page holds: the published project, an older version of
it or another local project, and whether it is kept in this browser. A site has one copy,
shared by its tabs: the tab that stores last wins, and the copy always holds one tab's whole
project. `npm run dev` reads the project once, when the server starts.

## Server copies

Besides projects, the project server shares named copies with everyone who opens the
Workshop: **Server levels** in Level, **Server game settings** in Physics, **Server IK
profiles** in Appearance and **Server character profiles** in Character. Type a name of
1-64 lowercase letters, digits and inner hyphens, then choose **Save to server**; saving
under a listed name replaces that copy, after asking. Choose a copy and load it to replace
the editor's current one, as an import does: a character profile loads as a draft, and the
editor's browser saves stay as they were. **Refresh** picks up copies saved since.

Each kind is a folder of this repository, one JSON file per copy, named by the copy:
`levels/`, `characters/`, `game-settings/` and `arm-ik/`. A copy is checked like the
project section of its kind before it is written, and replaced whole. Commit the folders
to share copies through version control. A static Workshop deployment has no project
server: it lists the `levels/` folder's levels as it was built, and can save none.

## The project server

The project server is part of the Workshop's Vite server, so there is nothing
else to install or host:

```sh
npm run dev      # Workshop and project server at http://localhost:5181
npm run studio   # builds the Workshop, then serves it with the project server at http://localhost:4174
```

It stores projects in `projects/<id>/` and published releases in `releases/<id>/`,
with each release's content beside it in `releases/<id>.content/`, all ignored by Git;
[server copies](#server-copies) go in their own folders, which Git does not ignore. Settings, from the
environment or `.env.local`:

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
project, release and server copy folders as plain files, so they are only reachable
through these checks. Serve it over HTTPS if you expose it beyond a trusted network.

A static Workshop deployment has no project server; its Project tab still opens,
edits and exports project files, and a Workshop built with `GAME_PROJECT` opens its own
game (see above).

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
  `null`.
- Every change is validated before anything is written and fails with
  `{ "error": { "code", "message", "section" } }`, leaving the project unchanged.
- Sections have revisions: `GET` returns `ETag: "<revision>"`, and a change with
  `If-Match` fails with `412` if the section changed meanwhile.
  `GET /api/projects/{id}/revision` is a cheap poll.
- Editing a project's files directly (by a tool, an editor or version control) counts
  too. Every read notices a section whose part of `project.json` or whose files changed
  since the server last counted it, and bumps its revision. The server keeps that
  bookkeeping in the project's `.studio.json`.
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
| GET, PUT, DELETE | `/api/projects/{id}/models/{part}/{model}/model?name=&settings=` | A library GLB for `avatar`, `hammer` or `pot`, adding or replacing its entry |
| GET, PATCH, DELETE | `/api/projects/{id}/models/{part}/{model}` | A library entry: its name and, for an avatar, its settings |
| GET, PUT, DELETE | `/api/projects/{id}/media/{file}` | Media library files |
| POST | `/api/projects/{id}/validate` | Every release check, reported as problems |
| POST, GET | `/api/projects/{id}/publish` | Build the release; latest publish record |
| GET | `/play/{id}/` | The published release; its content is under `/play/{id}/content/` |
| GET | `/api/shared/{kind}` | List the [server copies](#server-copies) of `levels`, `characters`, `game-settings` or `arm-ik` |
| GET, PUT, DELETE | `/api/shared/{kind}/{name}` | One server copy; `PUT` replaces any copy with that name |

For example, starting a new game and shaping it from a shell:

```sh
H='-H X-Studio-Request:1 -H Content-Type:application/json'
curl -s -X POST localhost:5181/api/projects $H -d '{"title":"Night Climb","id":"night-climb"}'
curl -s -X PATCH localhost:5181/api/projects/night-climb/theme $H \
  -d '{"sky":"#0b1020","fog":{"color":"#0b1020","near":0,"far":50},"camera":{"perspective":true},"sunDisc":{"visible":false}}'
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

**Theme.** Colours are lowercase `#rrggbb`. `fog.near` and `fog.far` are depths in
metres behind the course (`near` up to 1,000 and `far` up to 2,000, past the deepest
decoration; `far` must exceed `near`; a negative `near`, down to -20, hazes the course
itself), so fog looks the same with either camera and at any zoom. `camera`
chooses the projection: the default orthographic camera (`perspective: false`) shows
depth flat, while `perspective: true` makes nearer objects look larger and pass faster
than distant ones, with `fieldOfView` (10-90°) the vertical view angle. Both show the
course plane, the [obstacle line](../README.md#obstacle-line) where the physics happens, exactly
the same: the perspective camera stands
back until the plane fills the same view height, so aiming, editing and picking are
unchanged. `exposure` is 0.2-3; light intensities are 0-10. `sunDisc` and `backdrop` can be hidden. `character` recolours the
procedural Mesh parts character (pot, trim, dark details, suit, skin, handle);
imported models keep their own materials. Theme changes restyle existing lights
and materials in place.

**HUD.** `height.label`, `height.unit` (may be empty), `height.scale` (metres are
multiplied by it; `3.28084` shows feet), `height.decimals` (0-3) and
`timer.label`; either readout can be hidden. `messages.style` is how message events
appear, in the Workshop and in releases: `toast` (the default) fades each message in
and away as play goes on; `popup` pauses the game until the player continues. See
[trigger events](../README.md#trigger-objects-and-events). The default readout is
exactly the original one.

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
160 MiB in total. Releases package them as content and resolve the authored paths
to those files through the release's content access, so media keep working wherever
the content is served.

**Appearance, arm IK and characters.** Appearance parts are the Workshop's
per-part GLB replacements (20 MiB each, 64 MiB in total), fitted with the same
alignment as in Workshop / Appearance, and now included in releases. Arm IK is the
Appearance tab's body-relative elbow hints. Character profiles are the files
Workshop / Character exports; see [imported 3D characters](characters.md) and
[sprites](sprites.md).

**Model library.** `models` lists entries per part: `{ "id", "name" }` for hammers
and pots, and for avatars also `boneMap`, `driver`, `armForwardDistance`, `grips` and
`arms`, in the character profile's formats. IDs are 1-64 lowercase letters, digits and inner
hyphens, unique per part; each entry's GLB is `models/<part>/<id>.glb`. Uploading a
model with `PUT .../model` adds its entry: an avatar takes `settings` (JSON with those
five fields), keeps its existing entry's, or maps its joints automatically with a
standard driver. Removing an entry, or leaving it out of a `PUT` of the section, deletes its GLB.
Releases list the library but load an entry only when the game's backend selects it;
see [runtime swaps](characters.md#model-library-and-runtime-swaps).

**Course artwork.** `mode` is `shapes` or `meshes`; assets come from
`npm run pack:course` packages or the API upload. `decorations` maps decoration model IDs
to assets: in mesh releases each asset replaces its model's placeholder on every
decoration, and can draw a model the built-in library lacks. See
[course artwork](course-artwork.md#decoration-models).

## Limits

A project directory has no overall size limit beyond its sections. A project file
is limited to 480 MiB: every file budget (course artwork, appearance models, media and the
model library) together with the JSON files. Export larger games, such as ones with big
character profiles, as directories instead. `project.json`
is limited to 2 MiB, and each section keeps its existing limit. The model library holds
at most 32 models per part, 20 MiB each and 64 MiB in total.

## Verification

```sh
npm run verify:project
```

This builds the example project as a directory and as a project file, checks that
the generated Ashen Ascent example matches its generator and builds and opens as an
editor-free release, checks that invalid projects and conflicting inputs fail, builds
and plays a project with two character profiles, an appearance model and arm IK,
exercises the API (validation, revisions, token and host checks, cross-site
protection, file signatures, references, bundles, publishing), drives the Project tab
end to end (open, save, live sync, conflicts, enemy art, media, alternate character,
export, import, save as, publish, reopen) and measures a 1,000-object project. It
then deploys a Workshop built with a representative project (about 1,000 objects, a
10 MiB track, a skinned avatar and a second character) to a static site and checks
that it opens the project, keeps changes across reloads, leaves older browser saves
unchanged and follows a redeployment. It writes `artifacts/project-report.json`.
