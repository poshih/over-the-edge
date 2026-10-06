# Game projects

A **project** holds every authored input of one complete game: title, level,
physics, characters, appearance models, arm IK, a model library, theme, HUD, audio,
enemy art, media and course artwork, and the data of the game's
[Workshop plugins](workshop-plugins.md). The engine is the same for every project, so you can
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
| `level` | `level.json` | Level JSON, schema 5, as exported from Workshop / Level |
| `settings` | `project.json` | Game-settings profile, schema 12: physics (including the downswing boost and each material's friction and bounciness), hammer rig (handle length, maximum extension, minimum reach and the default hammer's head outline) and cursor target (radius, dead zone, how much it follows the character and the optional return to the hammer) |
| `characters/primary` | `characters/primary.json` | Character profile, or `null` for the procedural character |
| `characters/alternate` | `characters/alternate.json` | Optional second character players can switch to |
| `arm-ik` | `project.json` | Body-relative elbow hints |
| `appearance` | `project.json` + `appearance/<part>.glb` | Per-part GLB replacements and their alignment |
| `models` | `project.json` + `models/<part>/<id>.glb` | Model library: avatars, hammers and pots a release can swap to, each part on its own |
| `theme` | `project.json` | Sky, fog, exposure, camera, lights, sun disc, backdrop, aim marker, procedural character colours |
| `hud` | `project.json` | HUD readout labels, unit, scale, decimals and visibility, in Workshop play-tests and releases; how trigger messages appear |
| `audio` | `project.json` | Master volume, looping music and sound cues |
| `enemies` | `project.json` | Replacement pixel art per enemy species |
| `art` | `project.json` + `art/<assetId>.glb` | Course artwork: the course look, the GLB meshes terrain places and the GLBs replacing decoration models |
| `media` | `project.json` + `media/<file>` | Videos and sounds, used as `/media/<file>` |
| `plugins/<id>` | `project.json` | One [Workshop plugin](workshop-plugins.md)'s own data, for the Workshop only |

Nothing else reaches a release, and plugin data never does: game builds do not copy
`public/`, so a project release ships only the content its game uses plus the site icon.

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
  level-versions/               the project server's saved levels, kept out of Git; see Level versions
  phantoms/<course>/            phantom recordings played on them
```

The paths are fixed, so a manifest only says which files exist:

```json
{
  "format": "over-the-edge-project",
  "schemaVersion": 11,
  "title": "Lantern Cavern",
  "level": "level.json",
  "art": { "mode": "meshes", "assets": [], "decorations": {} },
  "settings": {
    "schemaVersion": 12, "physics": { "...": "..." },
    "rig": { "handleLength": 1.5, "maxExtension": 1.15, "minReach": 0, "head": [{ "x": -0.1, "y": -0.23 }, "..."] },
    "cursor": {
      "maxTargetRadius": 2.65, "deadZone": 0.1, "followCharacter": 100,
      "returnToHammer": false, "returnDelay": 0.15, "returnRate": 8, "returnOffsetX": 0, "returnOffsetY": 0
    }
  },
  "characters": { "primary": null, "alternate": null },
  "armIk": { "leftHintX": -0.55, "leftHintY": 0.15, "leftHintZ": -0.35, "rightHintX": 0.55, "rightHintY": 0.15, "rightHintZ": 0.45 },
  "appearance": [],
  "models": { "avatar": [], "hammer": [{ "id": "club", "name": "Club", "head": [{ "x": -0.1, "y": -0.2 }, "..."] }], "pot": [] },
  "theme": { "sky": "#0e1418", "fog": { "color": "#0e1418", "near": -2, "far": 35 }, "camera": { "perspective": false, "fieldOfView": 30 }, "...": "..." },
  "hud": { "height": { "visible": true, "label": "DEPTH CLIMBED", "unit": "ft", "scale": 3.28084, "decimals": 0 },
           "timer": { "visible": true, "label": "LANTERN TIME" }, "messages": { "style": "toast" } },
  "audio": { "volume": 0.9, "music": { "source": "/media/cavern-loop.wav", "volume": 0.35 }, "cues": { "...": "..." } },
  "enemies": { "bird": { "frames": [["..."], ["..."]], "palette": { "#": "#0b0d10" } }, "hollow-soldier": null },
  "media": [{ "path": "/media/cavern-loop.wav" }],
  "plugins": { "tuner": { "joint": 12, "radius": 0.1 } }
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
  "schemaVersion": 11,
  "files": {
    "project.json": { "format": "over-the-edge-project", "...": "..." },
    "level.json": { "schemaVersion": 6, "labels": [], "objects": [] },
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
- Every terrain mesh's `assetId` must be a course artwork asset, and each asset's ID
  must match the SHA-256 of its GLB. Every decoration model must be in the built-in
  library or drawn by a course artwork asset in `art.decorations`.
- Character GLBs, appearance GLBs and course GLBs pass the same structure,
  rig and budget checks as their existing import paths. Each library GLB passes the
  checks of its part, and each library avatar's bone map must resolve against its
  skin.
- Media files must start with the signature of their extension, so a `.wav` path
  can never serve HTML or script.

A project that fails any check does not save, and the error names the section. A game build
checks everything it packages, and only that: a file the game never uses cannot fail it.

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
[content delivery](content-delivery.md). The build takes only what the game uses: the
course meshes its level draws in the release's look, the media its level and audio
play, and the art of the enemies its level places. From a project directory it never reads
the other files, and copies each file it takes into the content one at a time. That content is the
base game every player loads. Each model library entry, such as a cosmetic avatar, hammer
or pot, is content of its own outside it, which a release downloads from the content URL
only once the game's backend selects it for the player; a build without a
[release facet](release-plugins.md#library-models) has no backend to select one, so it packages
none. A project whose level events or audio name external URLs does not build: a game build
packages everything it plays. Model and audio loaders are bundled only when the project uses
them, and the build still fails if an editor module reaches the release. `npm run dev:game`
restarts when a project file it uses changes. A project directory's `phantoms/` folder holds the
[phantom recordings](phantoms.md#bundled-recordings) the release bundles for its level.

`GAME_PROJECT` is the whole game, so combining it with `GAME_LEVEL`,
`GAME_SETTINGS`, `GAME_SPRITES` or `GAME_ALTERNATE_SPRITES` fails. The project
title replaces `GAME_TITLE`: a `GAME_TITLE` from `.env` files is ignored, and one
passed on the command line fails. `GAME_ART_MODE` still overrides the project's
course look.

Deploy it like any other release: the shell to any static host, and the content to the
host or CDN that serves `GAME_CONTENT_URL`. A game adds its own code with [plugins](plugins.md), named by
`GAME_PLUGINS` alongside `GAME_PROJECT`: one whose players must sign in or own it supplies its
content access in a [release facet](release-plugins.md), and one that ships custom avatars
registers its rig strategies and motion kinds in a [kinds facet](kinds-plugins.md).

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

Level's save is **Save to project**, at the top of the Level tab; each other editor's own
Save also has one under it: Physics' **Save game settings**, Appearance's **Save alignment**
(models and alignment) and **Save IK profile**, and the character profile's **Save** in
Character and Sprites. It writes that part into the open server project at once and says so,
instead of waiting for the automatic save; a level takes along the media and course meshes
it names. It is disabled until a server project is open, and a part that also changed in the
project waits for **Keep my version** or **Use the project's**.

- **Open project** loads a server project into every editor at once: the level,
  physics, character profile, appearance models, arm IK and all project sections.
  The page remembers it and reopens it after a reload. A Workshop started with a
  project that the project server holds (`GAME_PROJECT=projects/<id>` under
  `npm run dev` or `npm run studio`) opens that server project at start instead.
- **Save as project ID** stores the whole game as a new project (or replaces the
  project with that ID), which then saves itself. Its files go one at a time, each
  downloaded from wherever the page has it as it is sent. If saving stops part way, the
  rest saves like any change; until the new project holds everything, a reload opens the
  project the page came from, and this browser's copy stays as it was.
- **New project** starts from the [built-in course](course-artwork.md#the-built-in-course), with its meshes, and defaults.
- **Export project file** downloads the whole game as one bundle; **Import project
  file** replaces the Workshop's game with one. Both work without a server.
- **Publish standalone game** saves unsaved changes, builds the release on the
  server from a copy of the project's folder and links to it at `/play/<id>/`,
  where the studio also serves its content. It is a [studio preview](plugins.md#studio-previews):
  it shows the game's runtime plugins but runs none of its release facets.

The remaining sections edit what only a project has, with a live preview:
**Theme**, **HUD**, **Audio** (music and cue sounds from the media library, with
test buttons), **Enemy art** (JSON pixel art, starting from the built-in art),
**Media library**, **Alternate character** (use, swap, import or remove a second
profile), **Model library** (add library avatars, hammers and pots from files or the Workshop's
[server models](characters.md#server-models), then preview and remove them; see
[imported 3D characters](characters.md#model-library-and-runtime-swaps)) and
**Course artwork** (the course look, the meshes Level imported, with **Remove** for unused
ones, or import a `pack:course` package).

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

## Level versions

The project server is where levels are saved, and a level is played with the project's game
settings, so a **version** holds both: whenever the stored level or game settings change, they
become the project's next numbered version, unless they are the same as the latest. That covers
the Workshop's saves of the level or of Physics, the level, `level/objects`, `level/labels` and
`settings` API changes, bundles, and a `level.json` or `project.json` a tool rewrote on disk,
numbered when the project is next read. The Level tab's status shows the version the page
holds, for example *Saved as version 14*; a change shows as unsaved until the project saves it
a moment later.

Each version keeps its whole level and game settings, so any of them can be read back. The
project folder holds them beside its files, and replacing the project keeps them:

- `level-versions/index.jsonl`: one line per version, oldest first:
  `{ "version", "levelHash", "settingsHash", "course", "savedAt" }`; the hashes are the
  SHA-256 of the level's and the settings' compact JSON, and `course` that of the level's
  [play layout and physics](phantoms.md#courses);
- `level-versions/<sha256>.json.gz`: each distinct level and game settings, compressed, stored
  once however many versions share it; a large course takes about 20 KB, game settings under
  1 KB.

While **Record** is on, the Workshop [records your play](phantoms.md#recording-in-the-workshop)
on the version it holds into `phantoms/<course>/v<version>-<session>-<clip>.phantom`, and
**Level / Replays** plays each run back over the level. Versions
that play the same share a course, so edits to decorations, labels, colours, which mesh draws a
collision, control sensitivity or the cursor keep a level's recordings, while any physics setting starts a new
course; a release bundles the recordings of its level and settings' course. `phantoms/` grows
with use: commit it to keep the recordings, and delete those you no longer need.

`level-versions/` stays with the checkout that saved it: Git ignores it wherever the project
lives, so a fresh clone starts the numbering at 1, as deleting the folder does when the project
next opens. **Level / Replays** lists a recording under the version its name gives only when
this checkout's version of that number plays the same course; releases bundle every recording
of their course either way.

## Publishing a Workshop with its project

`GAME_PROJECT` also works for the Workshop build, so a deployed Workshop opens the game
it belongs to instead of whatever an earlier visit left in the browser:

```sh
GAME_PROJECT=projects/my-game npm run build   # then deploy dist/ to any static host
```

Every file of the project is validated, and a failure names its section.
Its files become hashed static assets next to the Workshop, each listed with its size and
SHA-256 and downloaded only when the page uses it: the JavaScript does not grow with the game,
and files that did not change keep their URLs across deployments, so browsers reuse them. Each
file must fit your host's per-file size limit.
The page title comes from the project, with the same `GAME_TITLE` rules as releases. Without
`GAME_PROJECT` the Workshop build is unchanged.

- **Opening.** A page without a project of its own opens the published project as **Import
  project file** does: every section, the primary character in its own rigging type and the
  alternate under **Alternate character**. It downloads, showing its progress, only what the
  editors use at once: the manifest, the level, the characters and the appearance models.
  Library models, media and course artwork download when the page uses them: a library model
  when you preview or edit it, every file the page sends when you save it to a server or export
  the project file, each checked against its size and SHA-256, while media play straight from
  the site.
- **This browser's copy.** Once the page holds something the published project does not (a
  change, or an imported or new project), it keeps the whole project with its unsaved
  changes in this browser (IndexedDB) and reopens it after a reload. The copy stores the
  files the page holds itself; a file of the published project stays on the site, and the copy
  names it by its SHA-256. Changes are stored about a second after you stop editing; leaving the
  page before that warns first. **Export project file** takes the work out; **Reopen published
  project** discards the copy, asking first when there are unsaved changes.
- **Older browser saves.** Here the editors' own browser saves (the character profile from
  **Save**, Appearance's models and the selected IK profile) do not open at start, and opening
  a project never changes them. The saved character profile remains the Revert target, and
  named IK profiles and game settings profiles stay available. Appearance models
  are kept in the project's copy instead of Appearance's own storage.
- **New deployments.** A page without unsaved changes opens the new version. A page with
  unsaved changes keeps them and says that a newer version is published; **Reopen published
  project** takes it. A copy uses the published files it names from whichever deployment
  serves them, so it opens only while the site still serves every one; otherwise the page opens
  the published project, says which file is gone, and keeps the copy until you change the
  project.
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
Workshop: **Server game settings** in Physics, **Server IK profiles** in Appearance and
**Server character profiles** in Character. Type a name of
1-64 lowercase letters, digits and inner hyphens, then choose **Save to server**; saving
under a listed name replaces that copy, after asking. Choose a copy and load it to replace
the editor's current one, as an import does: a character profile loads as a draft, and the
editor's browser saves stay as they were. **Refresh** picks up copies saved since.

Each kind is a folder of this repository, one JSON file per copy, named by the copy:
`characters/`, `game-settings/` and `arm-ik/`. A copy is checked like the project section
of its kind before it is written, and replaced whole. Commit the folders to share copies
through version control. A static Workshop deployment has no project server and lists none.

Levels are not server copies: a project keeps its level's [versions](#level-versions).
**Workshop / Level / Server levels** loads the levels served with the Workshop, the level JSON
files in the repository's `levels/` folder as it was built or started, after the published
project's level in a Workshop built with `GAME_PROJECT`.

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

`npm run dev` and `npm run studio` listen on `127.0.0.1` only. To use the studio from another
computer, forward its port there instead of exposing it, for example with
`ssh -L 5181:127.0.0.1:5181 <machine>` or VS Code's **Ports** view, and open
**http://localhost:5181**: forwarded requests arrive from this computer, so they need no token.
To listen on another interface, start the server with Vite's `--host`, as in
`npm run dev -- --host 0.0.0.0`, and set `STUDIO_TOKEN`.

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
- Every answer about a project's revisions also says which [level version](#level-versions)
  its stored level and game settings are: `"level": { "version", "course" }`, or `null` while
  the stored level is invalid. `GET` of the level carries it as `X-Level-Version` and
  `X-Level-Course`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create `{ "title", "id"? }` from the built-in course |
| GET, DELETE | `/api/projects/{id}` | Manifest, revisions and file sizes; delete |
| GET, PUT | `/api/projects/{id}/bundle` | Export or import the whole project |
| GET, PUT, PATCH | `/api/projects/{id}/{section}` | Any section in the table above |
| GET, PUT, PATCH, DELETE | `/api/projects/{id}/plugins/{plugin}` | A Workshop plugin's data, or `null` without any |
| DELETE | `/api/projects/{id}/characters/{primary\|alternate}` | Remove a profile |
| GET, POST | `/api/projects/{id}/level/objects` | List or add level objects |
| GET, PUT, PATCH, DELETE | `/api/projects/{id}/level/objects/{objectId}` | One object |
| GET, PUT | `/api/projects/{id}/level/labels` | Course labels |
| GET | `/api/projects/{id}/level/versions` | Every [level version](#level-versions), with its recording count |
| GET | `/api/projects/{id}/level/versions/{version}` | One version: `{ "version", "course", "savedAt", "level", "settings" }` |
| GET, POST | `/api/projects/{id}/level/versions/{version}/phantoms?session=&clip=` | List or store recordings played on a version |
| GET, DELETE | `/api/projects/{id}/level/versions/{version}/phantoms/{name}` | One recording |
| POST | `/api/projects/{id}/art/assets?name=` | Upload a course GLB; returns its asset ID |
| GET | `/api/projects/{id}/art/assets/{assetId}/terrain` | The GLB as terrain to place: its natural size and its `mesh` entry, with the collision it declares or its slice |
| GET, PUT, DELETE | `/api/projects/{id}/appearance/{part}/model?name=` | A part's GLB |
| GET, PATCH, DELETE | `/api/projects/{id}/appearance/{part}` | A part's name and alignment |
| GET, PUT, DELETE | `/api/projects/{id}/models/{part}/{model}/model?name=&settings=` | A library GLB for `avatar`, `hammer` or `pot`, adding or replacing its entry |
| GET, PATCH, DELETE | `/api/projects/{id}/models/{part}/{model}` | A library entry: its name and, for an avatar, its settings |
| GET, PUT, DELETE | `/api/projects/{id}/media/{file}` | Media library files |
| POST | `/api/projects/{id}/validate` | Every release check, reported as problems |
| POST, GET | `/api/projects/{id}/publish` | Build the release; latest publish record |
| GET | `/play/{id}/` | The published release; its content is under `/play/{id}/content/` |
| GET | `/api/shared/{kind}` | List the [server copies](#server-copies) of `characters`, `game-settings` or `arm-ik` |
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

To place a GLB mesh, upload it, read its terrain, and add a terrain object with its `mesh`, at
its natural size or any other (see [course meshes](course-artwork.md#in-level-json)):

```sh
ASSET=$(curl -s -X POST 'localhost:5181/api/projects/night-climb/art/assets?name=Boulder' \
  -H X-Studio-Request:1 -H Content-Type:model/gltf-binary --data-binary @boulder.glb | jq -r .id)
MESH=$(curl -s localhost:5181/api/projects/night-climb/art/assets/$ASSET/terrain | jq -c .mesh)
curl -s -X POST localhost:5181/api/projects/night-climb/level/objects $H -d "{
  \"kind\":\"terrain\",\"id\":\"boulder-1\",\"mesh\":$MESH,\"x\":6,\"y\":1,\"width\":3,\"height\":2,
  \"angle\":0,\"depth\":2,\"mirror\":false,\"color\":7438714,\"illusion\":false,\"surface\":\"rock\"}"
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

**HUD.** A game's [runtime plugin](runtime-plugins.md#hud-readouts) can draw any of the
readouts its own way, in the Workshop, studio previews and releases; these settings still say
which show, and with what labels and formats.
`height.label`, `height.unit` (may be empty), `height.scale` (metres are
multiplied by it; `3.28084` shows feet), `height.decimals` (0-3) and
`timer.label`; either readout can be hidden. `messages.style` is how message events
appear, in the Workshop and in releases: `toast` (the default) fades each message in
and away as play goes on; `popup` pauses the game until the player continues. See
[trigger events](../README.md#trigger-objects-and-events). The default readout is
exactly the original one.

**Audio.** `volume` (master) and each clip's `volume` are 0-1. `music` loops while
the game runs and pauses with it. Cues: `impact` (hammer strikes, louder when
faster), `enemy-hit`, `enemy-defeat`, `launch` (Launch player events), `finish`
(Stop timer events), `hurt` (an enemy, trap or lava hurts the player, who survives),
`death` (health runs out), `fall` (falling out of the level) and `bonfire` (the
player reaches a bonfire that becomes the place a death returns to; see
[health and bonfires](../README.md#health-and-bonfires)). Browsers start audio only
after the player first clicks, taps or presses a key; sounds are fetched ahead of
time and decoded then. Impact cues reach the output at most once per 70 ms. A game's
[runtime audio plugin](runtime-plugins.md#audio) can replace or wrap the output in the
Workshop, studio previews and releases, for example synthesizing just impacts while
music and the other cues keep their authored clips. Releases without audio or sound
events omit the engine's `AudioDirector`, but still resolve the audio point with a
silent base, so plugin audio works there too.

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
160 MiB in total. Releases package the ones the level and the audio play as content and
resolve the authored paths to those files through the release's content access, so media
keep working wherever the content is served.

**Appearance, arm IK and characters.** Appearance parts are the Workshop's
per-part GLB replacements (20 MiB each, 64 MiB in total), fitted with the same
alignment as in Workshop / Appearance, and now included in releases. Arm IK is the
Appearance tab's body-relative elbow hints. Character profiles are the files
Workshop / Character exports; see [imported 3D characters](characters.md) and
[sprites](sprites.md).

**Model library.** `models` lists entries per part: `{ "id", "name" }` for pots,
`{ "id", "name", "head" }` for hammers, whose `head` is the hammer's own collision outline
in the settings' `rig.head` format, and for avatars also `boneMap`, `driver`, `hair`, `motion`,
`armForwardDistance`, `grips` and `arms`, in the character profile's formats. IDs are 1-64 lowercase letters, digits and inner
hyphens, unique per part; each entry's GLB is `models/<part>/<id>.glb`. Uploading a
model with `PUT .../model` adds its entry: an avatar takes `settings` (JSON with those
seven fields), keeps its existing entry's, or maps its joints automatically with a
standard driver; a hammer keeps its existing entry's head or starts with the game's
default head. Removing an entry, or leaving it out of a `PUT` of the section, deletes its GLB.
Releases built with a [release facet](release-plugins.md#library-models) list the library but
load an entry only when the game's backend selects it, and the Workshop downloads one only when
it previews or edits it, so the library has no total size; see
[runtime swaps](characters.md#model-library-and-runtime-swaps).

**Plugin data.** `plugins` maps each [Workshop plugin](workshop-plugins.md)'s ID to its
data, one JSON document of at most 64 KiB, nesting depth 16 and 8,192 values, for at most
16 plugins. Each is a section of its own, `plugins/<id>`, with its own revision. The server
and the project checks hold it to those limits but never interpret it; the Workshop runs the
plugin's own validation whenever the section loads or changes.

**Course artwork.** `mode` is `meshes` or `shapes`: how the Workshop and releases draw the
course, its GLB meshes or every terrain object as its collision extruded (see
[course look](course-artwork.md#course-look)). Assets come from **Level / Meshes**,
`npm run pack:course` packages or the API upload; terrain places them as meshes. `decorations`
maps decoration model IDs to assets: in mesh releases each asset replaces its model's
placeholder on every decoration, and can draw a model the built-in library lacks. See
[course meshes](course-artwork.md).

## Limits

A project directory has no overall size limit beyond its sections, and it moves file by
file: **Save as project ID** uploads it and **Publish** copies it one file at a time, and the
Workshop downloads a file only when it uses it. A project file is one JSON text, read and
written whole, so it is limited to 480 MiB, below the longest text a browser holds, with every
binary file base64-encoded. A game larger than that, for example one with a big model library,
stays a project directory or a server project; exporting it as a project file fails before any
of its files download. `project.json` is limited to 2 MiB, and each section keeps its existing
limit. The model library holds at most 32 models per part and 20 MiB per model, with no total.
