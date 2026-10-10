# Game projects

A **project** holds every authored input of one complete game: title, level,
physics, characters, appearance models, arm IK, a model library, theme, HUD, audio,
enemy art, media and course artwork, and the data of the game's
[Workshop plugins](workshop-plugins.md). The engine is the same for every project, so you can
make different total conversions and switch between them by switching projects.

Project manifests and bundles use **schema 23**; their release content uses **schema 22**.
Both hold course artwork without a course look and enemy art that is pixel art or a model, and embed the audio record's `block` cue, game settings' death wait, archer and bonfire rules, jar
outline and jar side friction, the theme's background blur and character light, the HUD's level readout and death
text/fade, and the hollow archer's enemy art. Other versions are rejected, not converted.

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
| `level` | `level.json` | Level JSON, schema 12, as exported from Workshop / Level, with the level's name or `null` |
| `settings` | `project.json` | Game-settings profile, schema 21: physics (including health, invulnerability, bonfire burn time, hurt box, knockback, hammer damage, enemy rules and archers' arrows, downswing boost, each material's friction and bounciness, and the jar's side friction), hammer rig (handle length, maximum extension, minimum reach, the default hammer's head outline and the jar's collision outline), cursor target and death wait/materials |
| `characters/primary` | `characters/primary.json` | Character profile, or `null` for the procedural character |
| `characters/alternate` | `characters/alternate.json` | Optional second character players can switch to |
| `arm-ik` | `project.json` | Body-relative elbow hints |
| `appearance` | `project.json` + `appearance/<part>.glb` | Per-part GLB replacements and their alignment |
| `models` | `project.json` + `models/<part>/<id>.glb` | Model library: avatars, hammers and pots a release can swap to, each part on its own |
| `theme` | `project.json` | Sky, fog, exposure, camera, lights, the character light and its shadows, sun disc, backdrop, aim marker, procedural character colours |
| `hud` | `project.json` | HUD readout labels, unit, scale, decimals and visibility, the level's name among them, in Workshop play-tests and releases; how trigger messages appear, and death text/fade |
| `audio` | `project.json` | Master volume, looping music and sound cues |
| `enemies` | `project.json` | Each enemy species' pixel art, or its [3D model](enemy-models.md): a skinned GLB of the course artwork with a clip and baked root motion for each role |
| `art` | `project.json` + `art/<assetId>.glb` | Course artwork: the GLB meshes terrain places and the GLBs drawing decoration models |
| `media` | `project.json` + `media/<file>` | Videos and sounds, used as `/media/<file>` |
| `plugins/<id>` | `project.json` | One [Workshop plugin](workshop-plugins.md)'s own data, for the Workshop only |

Nothing else reaches a release, and plugin data never does: game builds do not copy
`public/`, so a project release ships only the content its game uses plus the site icon.

The `theme`, `hud`, `enemies` and `art` sections are the game's look (`GameLook`,
[`src/game-look.ts`](../src/game-look.ts)), the one value that sets how the game looks, so a project
looks the same in the Workshop as in its releases. A release makes its game with the look its
content holds and loads every GLB it lists before play; the Workshop gives its game the open
project's look through `Game.setLook` whenever the project changes, saved or not, and loads each
GLB as the level comes to use it, once the project has opened.

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
  "schemaVersion": 23,
  "title": "Lantern Cavern",
  "level": "level.json",
  "art": { "assets": [], "decorations": {} },
  "settings": {
    "schemaVersion": 21, "physics": { "...": "..." },
    "rig": { "handleLength": 1.5, "maxExtension": 1.15, "minReach": 0, "head": [{ "x": -0.1, "y": -0.23 }, "..."],
             "pot": [{ "x": -0.2, "y": -0.48 }, "..."] },
    "cursor": {
      "maxTargetRadius": 2.65, "deadZone": 0.1, "followCharacter": 100,
      "returnToHammer": false, "returnDelay": 0.15, "returnRate": 8, "returnOffsetX": 0, "returnOffsetY": 0
    },
    "death": { "wait": 4, "angularDamping": 2, "friction": 0.45 }
  },
  "characters": { "primary": null, "alternate": null },
  "armIk": { "leftHintX": -0.55, "leftHintY": 0.15, "leftHintZ": -0.35, "rightHintX": 0.55, "rightHintY": 0.15, "rightHintZ": 0.45 },
  "appearance": [],
  "models": { "avatar": [], "hammer": [{ "id": "club", "name": "Club", "head": [{ "x": -0.1, "y": -0.2 }, "..."] }], "pot": [] },
  "theme": { "sky": "#0e1418", "fog": { "color": "#0e1418", "near": -2, "far": 35 }, "camera": { "perspective": false, "fieldOfView": 30, "blur": 0, "blurNear": 5, "blurFar": 40 }, "...": "..." },
  "hud": { "level": { "visible": false, "label": "LEVEL" },
           "height": { "visible": true, "label": "DEPTH CLIMBED", "unit": "ft", "scale": 3.28084, "decimals": 0 },
           "timer": { "visible": true, "label": "LANTERN TIME" }, "messages": { "style": "toast" },
           "death": { "text": "You are dead...", "fadeIn": 1.5 } },
  "audio": { "volume": 0.9, "music": { "source": "/media/cavern-loop.wav", "volume": 0.35 }, "cues": { "...": "..." } },
  "enemies": { "bird": { "type": "sprite", "frames": [["..."], ["..."]], "palette": { "#": "#0b0d10" } }, "hollow-soldier": null, "hollow-archer": null },
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
  "schemaVersion": 23,
  "files": {
    "project.json": { "format": "over-the-edge-project", "...": "..." },
    "level.json": { "schemaVersion": 12, "name": null, "labels": [], "objects": [] },
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
course meshes its level draws, the media its level and audio
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
passed on the command line fails.

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
- Saving and exporting are not steps, and the [undo history](../README.md#undo-and-redo)
  keeps its steps across them. Undoing a section back to what was saved makes it saved
  again, so autosave writes nothing and no new level version is made; undoing past a save
  is a change that saves like any other.
- Undo and Redo bring back the very file a step removed or added, such as a media file, a
  course mesh or a library model: while the server still holds it, saving uploads nothing.
  Before a save deletes such a file from the server, the page keeps its own copy while the
  history may still bring it back; once it is back, the next save uploads it again.

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
test buttons), **Enemy art** (JSON pixel art, starting from the built-in art, or an imported
[3D model](enemy-models.md) with the clip each role plays),
**Media library**, **Alternate character** (use, swap, import or remove a second
profile), **Model library** (add library avatars, hammers and pots from files or the Workshop's
[server models](characters.md#server-models), then preview and remove them; see
[imported 3D characters](characters.md#model-library-and-runtime-swaps)) and
**Course artwork** (the meshes Level imported, with **Remove** for unused ones, or import a
`pack:course` package).

Everything else keeps its usual tab. Opening or importing a project replaces the
page's current game, its sprite draft and its browser-saved appearance models; the
Workshop asks first when there are unsaved changes. Opening any project, from the server,
a project file, **New project**, the published project or this browser's copy, clears the
[undo history](../README.md#undo-and-redo) and cancels edits still waiting to finish.

While a server project is open, the page checks the server every two seconds.
Sections changed on the server, for example by a script, a language model or a tool
editing the project's files directly, load automatically when you have not changed
them; level changes arrive as incremental edits, so a playtest keeps going.

A section changed on both sides is a conflict. It is kept as you edited it and does not
save until you choose, in Project:

- **Keep my version** saves yours over the project's.
- **Use the project's** replaces yours.

A section loaded from the server, whether a check brings it or **Use the project's** chooses
it, cuts the [undo history](../README.md#undo-and-redo) at that section, even when it matches
yours, so Undo never writes over someone else's change. Course artwork loaded this way that
drops a GLB or a decoration model's entry also cuts it at the level and enemy art, which may
use them, and media that drop a file cut it at the level and audio.

If the server no longer finds the open server project, or it comes back with a lower
revision than the page has seen, as when it is deleted and saved again under the same ID,
the page stops saving to it. It keeps its project and undo history, with every section
unsaved, and one notice names the project and says that **Save as project ID** stores the
page's project on the server again; in a Workshop built with `GAME_PROJECT`, this browser's
copy keeps it meanwhile. A file only that project held is then unavailable until a step
puts back a version the page holds, or removes it: a media file among them cannot play,
saving and **Export project file** stop at it, and this browser's copy waits.

The editor HUD previews the project's HUD labels and units. Opening a project runs
its level like any imported level, including intro events.

## Level versions

The project server is where levels are saved, and a level is played with the project's game
settings, so a **version** holds both, and its [course](phantoms.md#courses) also counts the motion
of the enemies' [3D models](enemy-models.md): whenever the stored level, game settings or that motion
change, they become the project's next numbered version, unless they are the same as the latest.
That covers the Workshop's saves of the level, of Physics or of enemy models' clips, the level,
`level/objects`, `level/labels`, `level/name`, `settings` and `enemies` API changes, bundles, and a
`level.json` or `project.json` a tool rewrote on disk, numbered when the project is next read. The Level tab's status shows the version the page
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
that play the same share a course, so edits to the level's name, decorations, labels, colours, which mesh draws a
collision, control sensitivity or the cursor keep a level's recordings, while any physics setting or a ground
enemy model's clip starts a new course; a release bundles the recordings of its level and settings' course. `phantoms/` grows
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
    Restoring them is one step, **Restore kept changes**, which Undo takes back. Changes that
    include the character profile, appearance models or arm IK ask first and apply outside
    the [undo history](../README.md#undo-and-redo), cutting it at the sections they change,
    as a section loaded from the server does.

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
project's level in a Workshop built with `GAME_PROJECT`. Loading one, like importing a level
file in **Level / Level JSON**, replaces only the project's level, as one step that Undo takes
back, unlike opening a project, which clears the [undo history](../README.md#undo-and-redo).

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
| GET, PUT | `/api/projects/{id}/level/name` | The level's name, a JSON string, or `null` for none |
| GET | `/api/projects/{id}/level/versions` | Every [level version](#level-versions), with its recording count |
| GET | `/api/projects/{id}/level/versions/{version}` | One version: `{ "version", "course", "savedAt", "level", "settings" }` |
| GET, POST | `/api/projects/{id}/level/versions/{version}/phantoms?session=&clip=` | List or store recordings played on a version |
| GET, DELETE | `/api/projects/{id}/level/versions/{version}/phantoms/{name}` | One recording |
| POST | `/api/projects/{id}/art/assets?name=` | Upload a course GLB or an enemy model; returns its asset ID |
| GET | `/api/projects/{id}/art/assets/{assetId}/terrain?turn=` | The GLB as terrain to place, turned `turn` radians about its vertical axis (0 by default): its natural size as turned and its `mesh` entry, with the collision it declares, or its turned slice or projection |
| GET | `/api/projects/{id}/art/assets/{assetId}/enemy` | The GLB as an [enemy model](enemy-models.md): its clips with their lengths and every clip's baked root motion, for an `enemies` model entry |
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

Read the terrain with `?turn=0.6` for the mesh turned 0.6 radians about its vertical axis, to
show another side (see [turning a mesh](course-artwork.md#turning-a-mesh)).

An open Workshop page shows each change within two seconds.

## Section reference

**Game settings.** The nested settings schema is **21**, exported in code as
`GAME_SETTINGS_SCHEMA_VERSION`; the outer project schema is **23**, release content
**22**, and browser game-settings snapshots **13**. All settings are required and
unknown fields or other versions are rejected, with no legacy reader or conversion.
`death.wait` is **0.5–15 s**, step **0.1**, default **4**: the gameplay delay before
returning at a bonfire, or restarting when none was lit. A death captures this
wait at entry, independently of its HUD fade.
Death always releases the hands and hammer and builds a passive corpse from physics
and the [character figure](characters.md#the-character-figure-and-death).
`death.angularDamping` is 0–10 /s, step 0.1, default 2; `death.friction` is
0.05–2, step 0.05, default 0.45. The corpse and released shaft use that friction;
the pot and hammer head keep their own materials. These fields appear in **Physics / Death**,
are saved/exported with the physics, rig and cursor. Death settings and timing do not
count toward the phantom course because recordings never include dying.
Wait and construction settings apply to the next death. Corpse and tool collide
only with terrain and platforms; enemies and traps use the frozen entry point, and
the dying jar cannot trigger illusions. The released head still blocks projectile rays.
Character selections, Workshop edits, appearance changes and completed profile/model
loads apply immediately, without rebuilding the corpse. A new figure is stored for
the next death. A library hammer chosen while dying draws immediately, while its
released collider keeps its entry outline until placement.
Player-body tuning takes effect at placement, never by retuning the corpse.
The separate HUD fields below own only death text and visual fade.

Alive-play rules belong to `physics`, with the same fields in Workshop / Physics and
release builds. They all count toward the [phantom course](phantoms.md#courses).
Defaults keep the engine's original hit counts: five hits defeat the player, and a full-speed
hammer strike defeats a bird or an archer outright and a soldier in two; slower strikes deal less,
and those no faster than the enemy's armor nothing.

**Physics / Health**

| Field | Values | Default |
| --- | --- | --- |
| `health` | 1–1000 whole hit points | 100 |
| `hurtInvulnerability` | 0–5 s, step 0.05 | 1 |
| `respawnInvulnerability` | 0–10 s, step 0.1 | 2 |

Every damage, from enemies, arrows, traps and lava, counts in these hit points.
Invulnerability durations apply at the next damaging hit or bonfire respawn; an active
protection keeps its deadline. Zero turns off that protection. A reset before any
bonfire is lit starts a new attempt, not a protected bonfire return.

**Physics / Bonfires**

| Field | Values | Default |
| --- | --- | --- |
| `bonfireBurnTime` | 1–120 s, step 0.5 | 10 |

The player's foot, the jar's base, lights a bonfire as it comes within `BONFIRE.reach`
(1.5 m) of its base. Lighting it heals the player to full, brings every enemy back home at
full health, sweeps the [rest effect](runtime-plugins.md#effects) across the screen and makes
it the bonfire a death returns to, which brings the enemies back too. It burns
`bonfireBurnTime` seconds, and coming within reach lights it once more only after it has
gone out and the player has left its reach; a player placed within reach, as on returning
there after a death, lights it once they leave and come back. A burn time applies to the next
bonfire lit, while a burning one keeps its time.

**Physics / Hazards**

| Field | Values | Default |
| --- | --- | --- |
| `hurtWidth` | 0.2–4 m, step 0.05 | 1 |
| `hurtHeight` | 0.2–4 m, step 0.02 | 1.58 |
| `hurtDepth` | 0.1–3 m, step 0.05 | 0.9 |
| `projectilePush` | 0–20 m/s, step 0.1 | 4 |
| `projectileLift` | 0–20 m/s, step 0.1 | 1.5 |
| `axePush` | 0–30 m/s, step 0.1 | 9 |
| `axeLift` | 0–20 m/s, step 0.1 | 4 |

The hurt box is centred on the player's root horizontally, rises from the pot's bottom
by `hurtHeight`, and reaches half of `hurtDepth` either side of the obstacle line.
It is a trap-hit region, not a new collider. Width and height apply live without
rebuilding anything; a depth change rebuilds only the axe reach-index proxies.
Projectile push follows the shot's direction plus an upward lift; axe push is horizontal
away from its strike plus an upward lift. These velocity changes apply at the next hit,
including to projectiles already in flight. No setting change mutates the authored level.

**Physics / Enemies**

| Field | Values | Default |
| --- | --- | --- |
| `hammerDamage` | 1–1000 whole hit points | 100 |
| `hammerFullSpeed` | 1–20 m/s, step 0.5 | 8 |
| `birdHealth` | 1–2000 whole hit points | 100 |
| `birdArmor` | 0.8–20 m/s, step 0.1 | 2.5 |
| `birdMass` | 0.1–10 kg, step 0.05 | 0.55 |
| `birdAcceleration` | 1–80 m/s², step 1 | 22 |
| `birdSight` | 0–30 m, step 0.5 | 6 |
| `birdDiveSpeed` | 0.5–20 m/s, step 0.1 | 5 |
| `soldierHealth` | 1–2000 whole hit points | 200 |
| `soldierArmor` | 0.8–20 m/s, step 0.1 | 4 |
| `soldierMass` | 0.5–30 kg, step 0.1 | 3 |
| `soldierAcceleration` | 1–80 m/s², step 1 | 28 |
| `archerHealth` | 1–2000 whole hit points | 100 |
| `archerArmor` | 0.8–20 m/s, step 0.1 | 3 |
| `archerMass` | 0.5–30 kg, step 0.1 | 2.5 |
| `archerAcceleration` | 1–80 m/s², step 1 | 24 |
| `archerSight` | 0–30 m, step 0.5 | 14 |
| `arrowSpeed` | 2–30 m/s, step 0.5 | 12 |
| `arrowDamage` | 0–1000 whole hit points | 20 |
| `bumpDamage` | 0–1000 whole hit points | 20 |
| `bumpSpeed` | 0–20 m/s, step 0.1 | 3 |
| `bumpLift` | 0–20 m/s, step 0.1 | 1.4 |

Mass updates live enemy bodies immediately; inactive enemies use it when their bodies
next wake. Acceleration limits steering toward a desired velocity; sight and dive speed
apply immediately, including mid-dive. Sight is for active birds, also limited to that
distance beyond their authored patrol radius; wake/sleep distances and AI scheduling
remain engine internals. An active hollow archer that sees the player within `archerSight`
draws only when an arrow leaving at `arrowSpeed` can reach the middle of the player's hurt
box, within the 80 m an arrow flies, along an arc clear of terrain and platforms, the low arc or else the high one; at the end
of its draw it aims again and looses, or walks on. Arrows fall under gravity, so `arrowSpeed`
sets their reach, its square over gravity on level ground (14.7 m at 12 m/s). An arrow deals
`arrowDamage`, fixed as it is loosed, and knocks the player like any projectile, by the
Hazards group's `projectilePush` along its flight plus `projectileLift`; zero damage keeps
that knockback without hurting. Bump damage, horizontal speed away from the enemy and upward
lift apply at the next bump. Zero bump damage retains knockback, but causes no damage,
hurt effects or invulnerability.

A hammer-head strike hurts an enemy only when it closes faster than the species' armor:
`birdArmor`, `soldierArmor` or `archerArmor`. Slower strikes glance off, dealing no damage,
and armor is never below 0.8 m/s, so brushing never hurts. A strike that beats the armor and
closes at `hammerFullSpeed` or faster takes `hammerDamage` hit points from the enemy; a slower
one takes proportionally less, rounded, and at least 1. Repeats on an enemy within 0.25 s deal
none. Armor, hammer damage and its full-damage speed apply at the next strike.

A species' health applies only at its next reset or new spawn. Existing enemies keep
their current and maximum health, including when sleeping/waking; a tuning edit does not
heal, damage or revive them. Collider/drawn sizes, per-object patrol settings and
presentation timings are unchanged.

**Theme.** Colours are lowercase `#rrggbb`. `fog.near` and `fog.far` are depths in
metres behind the course (`near` up to 1,000 and `far` up to 2,000, past the deepest
decoration; `far` must exceed `near`; a negative `near`, down to -20, hazes the course
itself), so fog looks the same with either camera and at any zoom. `camera`
chooses the projection: the default orthographic camera (`perspective: false`) shows
depth flat, while `perspective: true` makes nearer objects look larger and pass faster
than distant ones, with `fieldOfView` (10-90°) the vertical view angle. `camera.blur` puts the
background out of focus for an illusion of distance: the blur, 0-5% of the view height, of
what lies at `camera.blurFar` metres (1-1,000, default 40) or farther behind the course,
easing in from sharp at `camera.blurNear` (5-999, default 5; `blurFar` must exceed it). The
backdrop, the sky and the course's scenery blur by their depth. The blur starts behind everything
on the course plane, whose deepest terrain reaches 4 m back, so the terrain, pools, bonfires and
traps draw as ever, as do the characters, enemies and everything in front of the course; only
the back of a long axe's swing reaches past it. The default 0 turns it off and costs nothing. On,
what lies behind the blur start draws first into a multisampled offscreen image the size of the
view, which is tone-mapped and encoded over the sky as the screen does and blurred on a copy of
about 360 lines, so the blur looks the same at any size. The sharp part reaches a
little past the blur start, as deep as 16 pixels are tall there, so no seam shows where scenery
crosses it; translucent scenery in that sliver draws in both. Behind the blur start, colours match the screen's, unfogged or fully fogged, but
partly fogged scenery comes out a little lighter or darker, translucent layers blend before tone
mapping, and additive glows over the bare sky blend with it rather than add to it. A material that
opts out of tone mapping, such as a glow, is tone-mapped there like the rest; translucent scenery
that writes no depth takes the blur of what lies behind it; and glass nearer than the blur start
refracts only what is nearer too. Both cameras show the
course plane, the [obstacle line](../README.md#obstacle-line) where the physics happens, exactly
the same: the perspective camera stands
back until the plane fills the same view height, so aiming, editing and picking are
unchanged. `exposure` is 0.2-3; light intensities are 0-10. `characterLight` is the sunlight on the
characters, the player's, enemies and phantoms, with the sunlight's colour and intensity, while the
course keeps its own sunlight from the upper left and in front: `angle` (0-360°) is where it comes
from around the view, 0° from the right, 90° from above and 180° from the left, and `tilt` (-90 to 90°)
how far it leans toward the camera, lighting their fronts, or comes from behind the course (negative).
`characterLight.shadow` (0-100%, default 60) is how dark the shadows the player's 3D character casts
on itself are: its jar, body, head, arms and hammer shadow one another, such as the hammer and arms
on the jar and body or the head on the shoulders; 100% takes all of the character light from what lies
in shadow, leaving the sky, ambient and rim light. `softness` (0-5 cm, default 1) blurs their edges.
Glass and translucent parts cast none. The shadow map is a 1,024-texel square 5 m across, centred on
the shoulder hinge and drawn once a frame from the character alone, so it costs the same anywhere in
a level; while it draws, the character's arms and hammer also draw in the actors pass, where they
cast, under the passes that draw them over the body. Enemies, phantoms, 2D characters and the course
neither cast nor receive these shadows, and 0% turns them off at no cost. `sunDisc` and `backdrop` can be hidden. `character` recolours the
procedural Mesh parts character (pot, trim, dark details, suit, skin, handle);
imported models keep their own materials. Theme changes restyle existing lights
and materials in place.

**HUD.** A game's [runtime plugin](runtime-plugins.md#hud-readouts) can draw any of the
readouts its own way, in the Workshop, studio previews and releases; these settings still say
which show, and with what labels and formats.
`level.visible` (off by default) shows the level's name before the other readouts, under
`level.label` (1-32 characters, default `LEVEL`); a level without a name shows none, and a
project that leaves it off shows players no name.
`height.label`, `height.unit` (may be empty), `height.scale` (metres are
multiplied by it; `3.28084` shows feet), `height.decimals` (0-3) and
`timer.label`; either readout can be hidden. `messages.style` is how message events
appear, in the Workshop and in releases: `toast` (the default) fades each message in
and away as play goes on; `popup` pauses the game until the player continues. See
[trigger events](../README.md#trigger-objects-and-events). The default readout is
exactly the original one.

`death.text` is single-line text of 1-64 characters, **“You are dead...”** by default.
`death.fadeIn` is 0.1-5 seconds (default 1.5), with 0.1-second slider steps in
**Project / HUD**. It is presentation only: game settings' `death.wait` in
**Physics / Death** decides when health deaths and falls end their
[death sequence](runtime-plugins.md#death-sequence) and return to play. Presentation
elapsed time is clamped to that wait; a longer fade ends unfinished, without an error
or a longer wait. The world and run timer keep going; Pause and a hidden tab hold the
clock. An active death keeps its entry wait, text and fade. A runtime facet can replace
the screen and character death pose independently; gameplay timing and wording remain
separate project settings.

**Audio.** `volume` (master) and each clip's `volume` are 0-1. `music` loops while
the game runs and pauses with it. Cues: `impact` (hammer strikes, louder when
faster), `block` (a projectile strikes the hammer head, held or released),
`enemy-hit`, `enemy-defeat`, `launch` (Launch player events), `finish`
(Stop timer events), `hurt` (an enemy, trap or lava hurts the player, who survives),
`death` (health runs out), `fall` (falling out of the level) and `bonfire` (the
player reaches and lights a bonfire, which heals the player, brings every enemy back and becomes the
place a death returns to; see [health and bonfires](../README.md#health-and-bonfires)). Browsers start audio only
after the player first clicks, taps or presses a key; sounds are fetched ahead of
time and decoded then. Impact moments are limited at their source in Simulation to one
per 70 ms of run time in a placement, before effects, audio or observers receive them.
Workshop cue tests call the output's `preview` at full strength, without that limit and
without gameplay moments, even after gameplay stops. A game's
[runtime audio plugin](runtime-plugins.md#audio) can replace or wrap the output in the
Workshop, studio previews and releases, for example synthesizing just impacts while
music and the other cues keep their authored clips. Releases without audio or sound
events omit the engine's `AudioDirector`, but still resolve the audio point with a
silent base, so plugin audio works there too.

**Play sound event.** Triggers can play a sound without pausing:
`{ "type": "play-sound", "source": "/media/bell.wav", "volume": 1 }`. The next event
starts immediately. Levels using it need an updated runtime.

**Enemy art.** Per species (`bird`, `hollow-soldier`, `hollow-archer`): `null` for the built-in art,
pixel art `{ "type": "sprite", "frames": [rows, rows], "palette": { "<char>": "#rrggbb" } }` with exactly two
frames of equal size, at most 64 x 64 pixels and 32 palette colours, or a 3D model
`{ "type": "model", "asset", "clips", "motion" }`, described in [enemy models](enemy-models.md#format).
Pixel-art rows read top to bottom and face right; `.` is transparent. Pixel art is cosmetic: colliders,
health, behaviour and display size stay the same, and all sprite enemies share one draw batch.

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
plugin's own validation whenever the section loads or changes, except on Undo and Redo (see
[a plugin's own data](workshop-plugins.md#a-plugins-own-data)).

**Course artwork.** Assets come from **Level / Meshes**, `npm run pack:course` packages or the
API upload; terrain places them as meshes. `decorations` maps decoration model IDs to assets:
in the Workshop and in releases each asset replaces its model's placeholder on every decoration,
and can draw a model the built-in library lacks. See [course meshes](course-artwork.md).

## Limits

A project directory has no overall size limit beyond its sections, and it moves file by
file: **Save as project ID** uploads it and **Publish** copies it one file at a time, and the
Workshop downloads a file only when it uses it. A project file is one JSON text, read and
written whole, so it is limited to 480 MiB, below the longest text a browser holds, with every
binary file base64-encoded. A game larger than that, for example one with a big model library,
stays a project directory or a server project; exporting it as a project file fails before any
of its files download. `project.json` is limited to 2 MiB, and each section keeps its existing
limit. The model library holds at most 32 models per part and 20 MiB per model, with no total.
