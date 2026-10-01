# Over the Edge

An independent browser-based physics climbing playground, inspired by the
two-motor mechanism described by Getting Over It's creator. The first version
has a small climb, dedicated practice positions, procedural 3D artwork, and a
live tuning workshop. It is not a port of Getting Over It's assets or code.

## Run

Requires Node.js 22.12 or newer and a modern browser with WebGL2.

```sh
git clone https://github.com/poshih/over-the-edge.git
cd over-the-edge
npm ci
npm run dev
```

Open **http://localhost:5181**. The port is fixed; Vite fails explicitly if it is
occupied. Mouse/keyboard and one-finger touch controls are supported.
This is the editor/workshop entry, including physics, appearance, sprite, and level tools.

```sh
npm run build
npm run preview
```

`npm run build` writes the Workshop to `dist/`. `npm run preview` serves that
build locally at **http://localhost:4174**; previewing does not deploy it.
The built-in course needs no backend, player account, external asset download,
or runtime network service. Authored video events fetch the media URLs included
in their level.

`npm run dev` and `npm run studio` (which builds the Workshop, then serves it at
**http://localhost:4174**) also run a self-hosted **project server**: it stores
complete games on disk and gives scripts and language models a JSON API for every
setting. See [game projects](docs/projects.md). A static deployment of `dist/` has
no project server; its Workshop still opens and saves project files.

To deploy the Workshop, upload `dist/` to the **gettingover** Cloudflare Worker
defined in `wrangler.toml`. It is a static-assets Worker, not a Cloudflare Pages
project. Deploying requires your own Cloudflare account:

```sh
npm run build
npx wrangler deploy --config wrangler.toml --keep-vars
```

The deployment serves the level files in `levels/` as the Workshop's
[server levels](#level-editing). To deploy a Workshop for one game, build it with `GAME_PROJECT=<project> npm run build`.
The deployed Workshop then opens that game, keeps each visitor's changes in their browser
and picks up redeployments; see [publishing a Workshop with its
project](docs/projects.md#publishing-a-workshop-with-its-project).

The Workshop also offers the GLBs in `models/avatar/`, `models/hammer/` and `models/pot/`
as [server models](docs/characters.md#server-models), which designers pick in the Character
tab and the project's model library instead of choosing files. They are delivered from a
CDN, not with the Workshop: `npm run build` writes them to **`dist-content/`**, named by
SHA-256, and the Workshop downloads them from **`WORKSHOP_CONTENT_URL`** (default
`content/`, beside the Workshop, as `npm run dev` and `npm run preview` serve them).
Upload `dist-content/` there, with CORS for the Workshop's origin:

```sh
WORKSHOP_CONTENT_URL=https://cdn.example.com/workshop/ npm run build
npx wrangler deploy --config wrangler.toml --keep-vars
# then upload dist-content/ to https://cdn.example.com/workshop/
```

A custom domain is optional. Attach it to the Worker in your Cloudflare account
after deploying; domains are not stored in this repository.

### Game-only release

The playable release has a separate HTML/TypeScript entry and stylesheet. It
does not load the Workshop, level editor, model importer, saved editor profiles,
practice shortcuts, collision overlay, or editor diagnostic globals.
Its HUD contains only current height and elapsed time, plus a character choice when
the release bundles two character profiles. On-screen Play/Pause/Reset,
peak height, branding, and help remain in the editor build, not the release.

```sh
npm run build:game
npm run preview:game
```

`npm run build:game` writes the game-only release as a public **shell** in
**`dist-game/`** (the page, code, styles and icon) and its **content** in
**`dist-game-content/`**: the level, settings, profiles, theme, HUD, audio settings,
images, models and media, each file named by its SHA-256. The shell holds no content;
it loads the content from **`GAME_CONTENT_URL`** (default `content/`, beside the shell)
and verifies every file. `npm run preview:game` serves both locally at
**http://localhost:4175**. `npm run dev:game` uses **http://localhost:5182**. Neither
local server deploys anything; deploy both outputs as described below.
The existing `npm run build` and `wrangler.toml` continue to target the
editor/workshop in `dist/`, not this separate release.

A game whose content only some players may load bundles its own module with
**`GAME_MODULE`**. The module signs players in with the game's own identity management
and grants the release access to its content, typically short-lived signed CDN URLs
from the game's backend; the engine never sees accounts or credentials. See
[content delivery](docs/content-delivery.md).

A game that ships custom avatars adds its own rig strategies with
**`AVATAR_RIG_MODULE`**, and its profiles then name them in each avatar's `driver`.
See [rig strategies](docs/characters.md#rig-strategies).

A release built with **`GAME_PHANTOMS_URL`** records a random 10 seconds of the player now and
then, sends it to the game's backend, and replays other players' recordings near the player as
translucent white phantoms. Ten seconds take under 4 KB and reproduce every physics step within
1.5 cm; arms are placed by the game's own IK rather than recorded. The backend decides what it
keeps and whom it sends what. `GAME_PHANTOMS_URL=phantoms/ npm run dev:game` tries it locally
with the development server's own store. Without the variable a release carries no phantom
code. See [phantoms](docs/phantoms.md).

Set **`GAME_TITLE`** to use your own game name:

```sh
GAME_TITLE="My Climbing Game" npm run build:game
GAME_TITLE="My Climbing Game" npm run dev:game
```

The same setting works with `npm run dev` and `npm run build` for the Workshop.
It controls the browser tab title and Workshop heading; the game-only HUD
still contains only height and elapsed time. Omit it to keep **Over the Edge**.
Titles are plain text, support Unicode, and must contain 1-80 characters on
one line after trimming surrounding spaces. Empty or invalid titles fail
instead of silently using the default.

To keep the name between commands, put this in the project-root `.env.local`
(which is ignored by Git):

```dotenv
GAME_TITLE="My Climbing Game"
```

A command-line `GAME_TITLE` overrides the file. It can be combined with
`GAME_LEVEL`, `GAME_SETTINGS`, `GAME_SPRITES`, and `GAME_ALTERNATE_SPRITES`. The setting changes display
titles, not repository names, browser storage keys, or deployment identifiers.

To deploy the game-only release, `wrangler.game.toml` uploads only the shell,
`dist-game/`, to a separate **gettingover-play** Worker. Upload `dist-game-content/`
to the static host or CDN that serves your content URL, with CORS headers for the
shell's origin, and build with that URL:

```sh
GAME_CONTENT_URL=https://cdn.example.com/my-game/ npm run build:game
npx wrangler deploy --config wrangler.game.toml --keep-vars
# then upload dist-game-content/ to https://cdn.example.com/my-game/
```

Deploying the shell alone never publishes content. This leaves the Workshop Worker
and its domain unchanged. A custom domain is optional; attach a separate one to
**gettingover-play** in your Cloudflare account after deploying.

To include an authored course in the game-only release, export its JSON from the
Level tab, place that file inside the project (for example
`levels/my-level.json`), then build:

```sh
GAME_LEVEL=levels/my-level.json npm run build:game
```

Without `GAME_LEVEL`, the build uses the built-in course. The selected data is
validated and packaged as content at build time; the game needs no editor or external
level service. The `/media/` files its events play are packaged from `public/media/`,
and a game build fails on any source it cannot package, such as an external URL. Level exports do not contain gameplay settings, sprite layouts,
private character GLBs, or IK profiles; a [project](docs/projects.md) holds all of them. To dress terrain and decorations with meshes
from your own art pipeline, combine the level JSON and your GLBs into a course package with
`npm run pack:course`, then pass the package as `GAME_LEVEL`. `GAME_ART_MODE=shapes`
or `GAME_ART_MODE=meshes` overrides the package's look; shape-only releases omit
the GLBs and mesh loader. See [course artwork](docs/course-artwork.md).

To bundle your physics and cursor behavior into the game-only release, export a
game-settings profile from **Workshop / Physics**, put it inside the project,
and select it with `GAME_SETTINGS`:

```sh
GAME_SETTINGS=profiles/my-game.json npm run dev:game
GAME_SETTINGS=profiles/my-game.json npm run build:game
# Combine it with your level; GAME_SPRITES remains an independent input:
GAME_LEVEL=levels/my-level.json GAME_SETTINGS=profiles/my-game.json npm run build:game
```

Omitting `GAME_SETTINGS` uses the built-in game settings: a **1.5 m** handle
that slides up to **1.15 m** past the shoulder hinge, a **2.65 m** target radius
around the hinge (the hammer's full reach) and a **0.1 m** dead zone. A supplied profile is validated and packaged with the content; an invalid,
missing, oversized, or outside-project file fails rather than reverting to
defaults. Development reloads when the selected file changes. Browser-local
saves do not change a release unless you export and select one.

To let players switch between two characters, for example a 2D sprite character
and your own skinned 3D avatar, export both profiles from **Workshop / Character**
and select the second with `GAME_ALTERNATE_SPRITES`:

```sh
GAME_SPRITES=skins/paper.json GAME_ALTERNATE_SPRITES=skins/hero.json npm run build:game
```

Players choose **2D** or **3D** in the release's corner control, including
mid-level; the choice persists in the browser. Both profiles and their GLBs are
validated at build time and load once. Switching changes only the presentation,
including each profile's grips and arm lengths; physics and the level continue unchanged. Without `GAME_ALTERNATE_SPRITES`,
the release has no such control. See [imported 3D characters](docs/characters.md).

`src/editor/` owns all authoring UI, persistence, imports, and debugging tools.
The editor depends on the shared game runtime, never the reverse.
`tsconfig.game.json` checks the playable dependency graph separately, and
`vite.game.config.ts` fails the build if an editor module or editor asset enters
that graph. Hiding editor controls with a runtime flag is not the release
boundary.

`npm run verify:game` exercises the release, custom-course/sprite/aim-flipbook/settings/two-character builds,
development entry, and editor-dependency rejection in isolation. `npm run verify:art`
does the same for course packages and terrain meshes, `npm run verify:content`
for the shell and content split, grants, verification and the module boundary, and
`npm run verify:model-swap` for [runtime model swaps](docs/characters.md#model-library-and-runtime-swaps)
and the Workshop's model library.

### Complete games from a project

A project holds a whole game in one place: title, level, physics, both character
profiles, appearance models, arm IK, theme, HUD, audio, enemy art, media and course
artwork. Build any project into the game-only release instead of combining the
separate inputs above:

```sh
GAME_PROJECT=examples/projects/lantern-cavern npm run build:game
GAME_PROJECT=projects/my-game npm run build:game            # a project directory
GAME_PROJECT=exports/my-game.project.json npm run build:game # or a single project file
```

Switching the project switches the entire game; the engine stays the same. Make
and edit projects in **Workshop / Project**, through the project server's API, or
as files. `GAME_PROJECT` cannot be combined with `GAME_LEVEL`, `GAME_SETTINGS`,
`GAME_SPRITES` or `GAME_ALTERNATE_SPRITES`, and the project's title replaces
`GAME_TITLE`. See [game projects](docs/projects.md) for the format, the Workshop
workflow, publishing from the server and the API.

### Included full-length course

**Skyward Ruins** is a custom 600 m climb through eight districts, with
384 placed objects: permanent and illusion terrain, updrafts, birds, hollow
soldiers, an opening video, chapter events, and a timer-stopping summit.
The 600 m height is a design target, not a verified measurement of another game.

Choose **skyward-ruins** in **Workshop / Level / Server levels** (it is
[`levels/skyward-ruins.json`](levels/skyward-ruins.json)), or select it for an
editor-free release:

```sh
GAME_LEVEL=levels/skyward-ruins.json npm run dev:game
# Or build it into dist-game/, then deploy that as described in Game-only release:
GAME_LEVEL=levels/skyward-ruins.json npm run build:game
```

The default demo remains unchanged. See the [course guide](docs/skyward-ruins.md)
for the object allocation, district progression, and media requirements, or
open the [full-height map](docs/skyward-ruins-map.svg).

### Included souls-like example game

**Ashen Ascent** is a complete project that uses all 67 set pieces from the
[library](#set-piece-library) once each. Its climb runs through eight themed zones
of lying messages, secrets and ambushes, to a castle drifting in the sky at about
407 m:

```sh
GAME_PROJECT=examples/projects/ashen-ascent npm run dev:game
GAME_PROJECT=examples/projects/ashen-ascent npm run build:game
```

It is generated by `node scripts/ashen-ascent/generate.mjs`, which checks the route's
reach and fairness before writing. Its builder, route tools and checks form a reusable
[course kit](docs/course-kit.md) for your own generated courses. See the
[course guide](docs/ashen-ascent.md) and the [map](docs/ashen-ascent-map.svg).

## Controls

| Input | Action |
| --- | --- |
| Click the game canvas with a mouse, or Play in the editor | Capture the mouse |
| Play in the editor on a touchscreen | Resume touch controls without mouse capture |
| Move the captured mouse | Rotate and extend the hammer |
| Hold and drag on the canvas | Move the hammer without pointer capture |
| Lift and reposition a finger | Continue a relative touch drag without snapping the hammer |
| Esc | Release the mouse |
| R | Restart at the level start, or the selected editor practice |
| P or Space | Pause / resume |
| D | Toggle collision outlines and joint anchors (editor only) |
| C | Recenter the camera |
| 1 / 2 / 3 / 4 | Ascent / ledge hold / ground push / vault (editor only) |
| / | Find a Workshop control (editor only) |

Touch gain is independent of camera zoom and orientation: at the default
**Control sensitivity**, 100 CSS pixels move the world-space target one hammer
reach (**2.65 m** by default).
Target movement is not limited by hammer reach. The same swipe has the same
effect in portrait and landscape, in both the game and editor. Mouse input
continues to follow the displayed scene scale. Touch cancellation, focus loss
and resizing clear pending gestures.

Compact viewports use wider reach-aware framing to keep the player and hammer
visible. On phones, the Workshop is a bottom sheet in portrait and a side panel
in landscape, with a visible game preview. Opening it pauses physics; closing
it restores the previous pause state. Play closes the compact editor and resumes.
Desktop Physics, Appearance, and Sprites tabs remain live; Level editing always pauses.

Touch-sized controls include `+` and `-` buttons for exact single-step adjustments
to physics and appearance ranges. They respect limits and disabled settings.

Press the head against the ground and extend to raise the pot. Swing around an
edge to hook it; the contact and the two motors do the lifting. Practice buttons
explicitly reposition the mechanism and restart the attempt, rather than
introducing hidden checkpoints into the climb.

Falling **20 m** below everything in a level (its lowest terrain or launch zone)
restarts the attempt exactly like Reset. It only arms once the pot or hammer head
has stood on terrain during that attempt, so a start with nothing beneath it keeps
falling instead of restarting in a loop.

### Finding Workshop controls

Each Workshop tab opens on the controls used most: the game title and project
actions in **Project**, practice positions and the
mass and motor sliders in **Physics**, the character type and quick-start buttons in
**Character**, the body part and GLB model in **Appearance**, the layer list in
**Sprites**, and the build tools in **Level**. Everything else sits in named,
collapsible sections; select a heading to open or close it. Each browser
remembers which sections you opened or closed, only as a layout preference.
Chromium's find-in-page also opens a closed section that contains a match.

**Find a control** at the top of the Workshop searches every labeled control and
section in all six tabs. Press **/** anywhere outside a text field (while the mouse
is not captured), type part of a name, then choose a result with Enter or a click: the Workshop switches to
its tab, opens its sections, scrolls to it and focuses it. Results show where each
control lives, for example **Physics › Materials**; controls that are currently
disabled are marked **unavailable now**. Escape clears the search; a second Escape
closes the Workshop. **Overlay** (D) and **Recenter camera** (C) stay in the
Workshop header on every tab.

## Physics architecture

Runtime dependencies are **Planck.js** and **Three.js**. Development uses
**TypeScript** and **Vite**. Planck 1.4.2 is pinned for its Node 22-compatible
package contract and its Box2D-style joint API.

```text
Dynamic root, rotation locked
  +-- limited unpowered hinge --> pot
  +-- powered hinge --> invisible carrier
          +-- powered slider --> handle base
                  +-- three welded handle segments --> hammer head
```

The player rig has eight dynamic bodies and seven joints. Only its hinge and
slider have motors. Arms are visual two-bone IK, never collision bodies or
actuators. The pot and hammer head collide with terrain and nearby living enemies;
the shaft fixtures supply mass and
inertia but never generate contacts. Normal locomotion does not teleport bodies,
apply assistance forces, or turn off the head's collisions. Authored updrafts
and enemy contact knockback apply explicit, mass-aware impulses without changing
the rig or disabling collisions. Terrain collides only from the outside: a body
whose centre ends up inside a terrain outline, for example after an edit or a
restored illusion, passes out of it instead of being trapped or shoved.

The simulation runs at a fixed **240 Hz**, with continuous collision handling,
64 velocity iterations and 20 position iterations. Time steps and solver
iterations are distinct. Rendering interpolates the previous and current
physics poses. Catch-up is bounded under overload; switching tabs discards
elapsed wall-clock time rather than advancing a huge physics step.

Mouse or touch movement moves the white circle, the cursor, relative to the
shoulder hinge the hammer pivots on. The hammer drives toward a target that
follows the cursor with a little slack: while the cursor moves within the
**dead zone** around the target (**0.1 m** by default, about half the head's
width), the target and the hammer hold still, so small or unsteady input does not
disturb a delicate hold. Once the cursor leaves the dead zone it drags the target
along, a dead zone behind it, and the target moves no farther than it must. The
target stays within a configurable radius of the hinge, and the cursor can go the
dead zone beyond it. Without input, both offsets stay unchanged: walking,
falling, or being launched carries them with the character. They do not rotate
with the pot, follow the hammer, or drift back to the hinge. Camera movement
does not modify them.

Motion beyond the cursor's reach, the target radius plus the dead zone, is
discarded, so reversing input only has to cross the dead zone again, without
unwinding accumulated movement. At the edge of the radius the target slides
around it as the cursor sweeps past. Starting or resetting an attempt aims at the
initial hammer position, clamped inside the chosen radius, with the cursor on the
target.

As in Getting Over It, the target and the head's mechanical reach (the handle
length plus the maximum extension, **2.65 m** by default) share the hinge as their
origin, and the default radius is that full reach, so
every reachable point can be targeted in every direction. A smaller radius
limits how far input can extend the hammer; it never lengthens the tool. The
head still cannot pass through solid terrain, and contact can transfer motor
effort to the player. There is no return-to-hammer behavior.

The slider can retract the head all the way to the hinge, so there is no
unreachable inner ring. The hinge's own orientation defines aim even at zero
reach; aiming does not normalize a zero-length hinge-to-head vector.

Motor velocity targets come from angular and axial errors with measured joint
velocity damping, speed caps, and independent force/torque limits. While input
moves the target down, a **downswing boost** raises the limit of each motor that
speeds the head up downward: the hinge swinging the head down, or the slider
extending a hammer that points down or retracting one that points up. The boost
scales with how directly downward that motor moves the head, so a head swung
straight down gets all of it and a sideways swing none. Braking or lifting the
head never gets it, and neither do the motors' own corrections without input,
such as holding a hang: only the player swings the hammer down. The motors push
between the player's own bodies, so the boost adds no outside force: a harder
downswing into the ground lifts the player higher. All angular quantities use
radians. Collision visualization uses the authored physics
geometry and fixture filters, so it does not draw the non-colliding shaft as a
terrain collider.

## Game settings

The workshop applies parameters to the existing mechanism without restarting,
except the hammer rig, which rebuilds the player. Its first section, **Mass & recoil**, groups head mass, player mass and rotation
speed with sliders for total shaft mass, hinge carrier mass and slider carriage
mass. Shaft mass is divided equally among the three handle segments; guide-body
inertia scales with mass. The new defaults preserve the original 0.66 kg shaft
and 0.5 kg per guide body. All masses stay positive.

The other sections include motor strength and speed limits, the downswing boost,
response gains, damping, contact friction, handle compliance, and control
sensitivity. **Downswing** has a **Hinge downswing boost** and a **Slider
downswing boost**, each 1-3x (default **1.3x**; 1 turns it off), multiplying that
motor's strength while input moves the target down and the motor speeds the head
up downward.
Zero handle frequency means rigid weld constraints; positive frequency enables
rotational spring compliance.

Ground and every obstacle share a **3.0** rough-rock friction coefficient.
The hammer defaults to **2.5**. Planck mixes the two as `sqrt(3.0 * 2.5)`,
giving a contact coefficient of about **2.74**. This is ordinary contact
friction, not a sticky constraint: the head must still press against a surface
to hold. The pot's own friction coefficient remains **0.45**.

The **Hammer rig** section sets the tool's geometry. **Handle length** (0.75-3 m,
default **1.5 m**) runs from the butt to the centre of the head; the slider always
retracts the head to the shoulder hinge, so the butt can travel that far behind
it. **Maximum extension** (0-2 m, default **1.15 m**) is how far the butt can slide
past the hinge. The reach is their sum. The three welded handle segments share the
handle length, and everything else follows the rig: the two-part hammer, the
one-model hammer's handle, touch gain, compact framing and the target radius limit.
A rig is never changed in place: a new one rebuilds the player and restarts the run
from its start, like **Reset**. A longer handle with a shorter extension keeps the
reach while letting characters with sliding grips (see [hand grips](#hand-grips))
use shorter arms.

The **Cursor target** section has a **Maximum target radius** slider, from
**0.25 m** up to the hammer's reach, default the full reach. A saved radius beyond
the reach is rejected. When the rig changes in the Workshop, a full-reach radius
follows the new reach and a smaller one is capped at it. Reducing the radius
immediately pulls an out-of-range target straight in, including while paused;
increasing it preserves the current offset. Its **Dead zone** slider (0-0.5 m,
default **0.1 m**) sets the slack between the cursor and the target; 0 makes the
hammer follow every movement. Changing the dead zone never moves the target: a
smaller one pulls the cursor toward it. Neither setting restarts the attempt,
alters body masses, or changes the rig's forces, mechanical reach, or collision
rules.

In **Workshop / Physics / Saved game settings**, enter a **Game settings name** and choose
**Save game settings** (or press Enter). Each save creates a separate timestamped
profile containing every physics setting, the hammer rig, the target radius and
the dead zone.
Reusing a name keeps both versions. Choose an entry in **Past game settings**,
then **Load game settings** to apply it. Selecting an entry alone does not
change the game. History survives reloads; loading remains manual.

**Export settings JSON** downloads the current complete profile as
`game-settings.json`. **Import settings JSON** validates and applies a profile;
save it under a name if you also want it in browser history. Files are limited
to **64 KiB**, with strict schema, field, and numeric-range validation. A bad
import leaves current settings and saved profiles unchanged. If settings change
while a file is being read, the import is canceled rather than overwriting the
newer edits. Use this same JSON with the `GAME_SETTINGS` build input above.

Snapshots are stored independently in this browser's localStorage, on this site,
so saves from different tabs do not overwrite one shared record. Nothing is
uploaded unless you save a [project](docs/projects.md) to your own project server. Settings use
**schema version 4**, with `physics`, `rig` and `cursor` sections; files and saves
in any other version are rejected, not converted. Unreadable saves are marked and
retained, while other valid snapshots remain available.

Profiles contain gameplay configuration, not saved body trajectories, levels,
or character artwork. Height and peak readouts describe the current attempt.

Saved profiles preserve their stored hammer friction. **Defaults** restores
all built-in physics, rig and cursor settings without changing saved profiles.

The practice positions make the important behaviors easy to revisit: resting
on a ledge, smooth ground pushes, launches, and vaulting a low block. The
controller and artwork are a prototype, not a claim of matching Getting Over
It's exact tuning.

## Level editing

Open **Workshop / Level** to edit the course. Editing pauses gameplay and
separates placement gestures from hammer input. Choose a block, thin platform,
ramp, triangle, circle, or hexagon, then click/tap the game preview to place it.
Select an object to move it or adjust its position, dimensions, rotation, and
illusion property. Dragging previews the change; releasing commits it.
Pan and zoom let you work beyond the player's current camera view.

The start location and trigger zones are map objects, not special summit
settings. Place or drag **Start location** to choose the spawn and adjust its
initial hammer pose: its angle and its **reach**, the head's distance from the
shoulder hinge. Reach keeps the start pose the same for any handle length; a
hammer that cannot reach that far starts fully extended. Each level has one start. Playtest from that position,
and use Reset to repeat the course. Runtime effects never delete objects from
the editor's authored definition.

To test one part of a course without moving its start, choose **Place player** and
click/tap where the pot should stand. The player moves there in the start's hammer
pose, and the level is not edited. Playtests, Reset and falls out of the level then
start from the placed player until you choose **Use the level start** in the Level
tab, pick a starting point in **Physics**, or load another level.

Named level saves use the existing snapshot-history mechanism: repeated names
keep separate versions, choosing an entry does not apply it, and loading is
explicit. **Save level** stays at the top of the Level tab; load past saves from
**Saved levels**. Use **Level JSON** to export/import level data between browsers or feed the
game-only build. Imports are validated before replacing the current level;
malformed files and unavailable storage produce visible errors.

**Server levels** lists the levels the Workshop itself serves, the same for everyone
who opens it: every level JSON file in this repository's `levels/` folder, named by
its file name, and first, in a Workshop built with `GAME_PROJECT`, that project's
level. Builds validate each file and fail, naming it, when one is not a valid level;
`npm run dev` reads the folder when it starts. The page lists only names and sizes:
a level downloads when you load it, and replaces the current level like an import,
asking first when there are unsaved changes.

### Drawing terrain

Choose **Workshop / Level / Draw shape**. Click or tap individual corners, or
hold and drag to trace an outline. You can combine separate strokes and point
placements. Freehand strokes are simplified with a two-screen-pixel tolerance
at the drawing zoom, so pointer samples do not become hundreds of physics edges.

Tap the first point, press **Enter**, or choose **Finish shape** to close the
outline. Clockwise and counterclockwise input both work; the shared terrain
converter normalizes winding and rejects invalid geometry. Concave outlines,
including ledges and notches, use the same polygon format as the built-in course.

**Undo point / stroke**, Backspace, or Ctrl/Cmd+Z removes the last point or
completed stroke. During a stroke, undo cancels only that in-progress stroke.
**Cancel outline** or Escape discards the draft without changing the level.
Pointer cancellation or a viewport resize cancels the current stroke while
retaining completed points. Pan, zoom, and switching Workshop tabs preserve
the draft. Unfinished outlines must be finished or canceled before saving,
exporting, or starting a playtest.
Drafts are not saved terrain and do not create physics bodies or render meshes.

Finished drawings are ordinary terrain objects: select, move, resize, rotate,
set depth, or enable **Illusion** as usual. Named saves, JSON exchange, and
editor-free game builds preserve them without a new level format.

Outlines support **3-64 points**, **0.25-128 m** width and height, and the existing
limit of **32 distinct terrain geometry templates** per level. Crossing or
overlapping edges, holes, and zero-area shapes are rejected without changing the
authored level; the draft remains available for undo or cancellation. Curves are
polygonal approximations, not Bezier surfaces. Separate objects can surround an
opening without requiring a polygon with holes.

The built-in demo's large `ascent` obstacle is an **18-point hand-authored
concave polygon** in `src/course.ts`, not a stack of blocks. Its extrusion has
**68 triangles**, and its collision is one static closed chain with 18 edges.
Geometry is cached and shared, and static objects do not rebuild geometry or
rewrite instance transforms each frame. Drawing uses this same rendering and
collision path; finished outlines cost according to their edge/template count,
not their on-screen size.

### Trigger objects and events

Place a **Trigger** to define a circular or rectangular proximity zone.
The player's foot position activates the zone; the hammer and terrain do not.
**Ending trigger** is a preset of the same trigger type, with a flag and an
ordered **Stop timer**, then **Message** event list. Move it, change its region,
or edit its events like any other trigger. Place a trigger around the start
to play an intro or show instructions.

Supported events:

| Event | Behavior |
| --- | --- |
| Message | Shows a plain-text title and message, as a toast or a popup (see below) |
| Play video | Plays a public video URL or site-relative media path in a full-window overlay |
| Stop timer | Freezes the run timer without stopping physics or illusion effects |
| Launch player | Applies a mass-aware upward impulse with configurable lift height and strength |
| Play sound | Plays a sound (0-1 volume) from a public URL or site-relative media path, without pausing; the next event starts immediately |

Events execute in their authored order. Only one presentation runs at a time;
simultaneous triggers queue deterministically. Popups and videos pause gameplay and
suspend hammer input until they close. Skipping a presentation continues its
remaining events. Failures are reported, not silently retried.

The project's HUD settings choose how messages appear, in the Workshop and in releases
(Workshop / Project / **HUD** / **Trigger messages**):

- **Toast** (the default): an arcane seal gathers at the centre and draws a line of
  light outward, and the words form as its beams pass. Once there has been time to
  read them, they burn away into embers from the ends inward.
  - Play goes on: a toast never pauses the game, takes input or holds up the next event.
  - It stays readable for about 1.4 s plus 0.06 s per character, between 3 and 14 s.
  - Messages show one at a time. A waiting message shortens the current one, never
    below its fast reading time.
  - Up to three messages wait. A further distinct message reports an event failure
    instead of silently replacing one that was already queued.
  - Toasts wait while a popup or video is showing. A restart dissolves the current toast
    quickly and drops waiting ones.
  - The effect is procedural (curves, easing and a swirling flow field) on one small
    canvas with pooled particles, and costs nothing while no toast is showing.
  - With reduced motion, a toast only fades in and out. Screen readers hear each
    message through a live region.
- **Popup**: a dialog that pauses the game until **Continue**; Escape skips it.
The timer starts on a new attempt; Reset resets both its value and running state.

**Once per run** claims activation before queuing, so repeated physics ticks
cannot fire it again. **On each entry** requires leaving and re-entering;
exit hysteresis avoids repeated activation at a zone boundary. Restarting
rearms triggers. Removing or editing a trigger cancels its pending work and
rearms the edited definition. Level replacement and shutdown cancel all pending
events, so late media callbacks cannot resume an old run.

Video sources are part of saved/exported level data. Use public URLs; do not
put private signed links or credentials in a level you intend to publish.
For bundled media, put the file in `public/media/` and use a path such as
`/media/intro.webm`. Level JSON references videos rather than embedding or
uploading them. The browser must support the file's codec.
Autoplay with sound may require a user gesture: the overlay offers **Play video**
when blocked. It always fills the game window; native browser fullscreen is
requested through a user-operated fullscreen control.

Level JSON uses **schema version 4**, with typed terrain, start, trigger and enemy
objects. A start is `{ "kind": "start", "id", "x", "y", "angle", "reach" }`.
Files and saved snapshots in any other version are rejected, not converted.

### Updrafts

Choose **Workshop / Level / Updraft**, then click or tap the desired base position.
This places a generic trigger preset with a visible wind marker and one
**Launch player** event. It does not add a solid platform or an extra physics body.
Move/resize its region like any trigger; activation uses the player's foot position.

In **Trigger events**, adjust **Lift height (m)** and **Launch strength (x)**,
then **Apply events**. Level saves/exports also apply valid pending event edits.
The default is an 8 m lift at 1x strength. Height supports 0.5-100 m; strength
supports 0.25-2x. The action serializes as
`{"type":"launch-player","height":8,"strength":1}` and the visual marker is
`"updraft"`. Existing levels and event types remain valid; levels using the new
event/marker need an updated runtime.

At 1x, height is the estimated clear-air rise of the whole rig's center of mass,
compensating for the current body damping. Strength scales the upward launch
speed, not the number of metres. Current mass determines the required impulse,
so heavier tuning does not automatically weaken the vent. Falling momentum is
cancelled first; a player already rising faster is never slowed down.
The pot's exact apex depends on hammer pose, input, and terrain contacts.

The impulse is distributed by mass across the existing player bodies at their
centers of mass. It does not teleport, change horizontal/angular velocity, turn
off collisions, or pull only one body against its joints.
**Every entry** fires once per overlap, rearms after leaving, and resets with the
run. Remaining inside a vent does not repeatedly apply force. Choose **Once per
run** when a level needs a single-use launcher.

Updrafts reuse the existing indexed/swept proximity detection and event lifecycle.
Their base rings and wind arrows use two shared instanced batches; only changed
marker transforms are uploaded. Wind motion uses one shader clock instead of
per-vent simulation, allocation, or particle updates, and pauses with gameplay.
The same runtime works in editor-free builds; authoring controls stay in the Workshop.

### Enemies

Choose **Workshop / Level / Bird** or **Hollow soldier**, then click/tap the
desired base position. Select the enemy's body to drag or delete it. The inspector
edits its center/home position, facing, **Patrol radius** and **Patrol speed**;
the selection guide shows the radius on each side of home. Birds patrol, warn,
then dive. Soldiers only patrol their configured range, turning at terrain
obstacles and edges.

A **hammer-head strike** with a closing speed of **at least 0.8 m/s** defeats a
bird in one hit; a hollow soldier takes **two separated strikes**. Damage has a
**0.25 s anti-jitter cooldown**: brushing or holding the head against an enemy
does not repeatedly deal damage. The shaft does not deal damage.
Body collisions knock the player back; there is no player health system.
Dead enemies stay dead until Reset or an editor rebuild. Patrol positions,
damage and deaths are runtime state: editor gizmos, saves and exports retain
authored homes. Entering Level mode restores both authored enemy poses and terrain
state, including dead enemies and disappeared illusions.

Up to **64 enemies** share one sprite draw batch with custom sprite artwork;
the palette and editor guides use custom SVG glyphs. Only nearby enemies allocate
physics bodies: they wake within **18 m** and sleep beyond **26 m** once settled.
Distant enemies keep their authored/current sprites, with no physics bodies or AI work.
A soldier knocked off a ledge stays simulated while it falls, so it lands or is
defeated **30 m** below its home instead of freezing in mid-air; one resting on an
illusion keeps a sleeping body so it drops if the illusion vanishes.
Contact effects are deferred until the physics world unlocks. Exported enemies
also work in editor-free releases using the updated runtime. No enemies are
added to the built-in course.

### Illusions

An illusion is initially an ordinary rough-rock obstacle. Only a supporting,
upward-facing contact beneath the **player's pot** starts its fade. A hammer
strike, side contact, underside contact, or merely being nearby does not.
The obstacle fades over **0.8 seconds of simulation time**, remains solid during
that fade, then loses both its collision and visible surface. Pausing freezes
the effect. Restarting restores it; a player caught inside the restored rock
drops out of it rather than being trapped.

The physics callback records landings; body removal happens only after the
physics step unlocks. Authored data and transient disappearance state have
separate owners, so saving/exporting after playtesting still includes illusions.

### Set piece library

**Workshop / Level / Set piece library** holds **67 prefabricated obstacles** based on
classic hammer-climber tropes. They are grouped into 11 categories: onboarding,
vertical climbs, gaps & leaps, balance, hammer technique, descents, surfaces,
updrafts, enemies, route tricks, and stakes & finish. Examples include the snake
slide and its **DO NOT RIDE SNAKE** sign, orange hell, the chimney, pole vaults,
crumbling illusion bridges, a rotten scaffold, a flying buttress, a castle window to
squeeze through, updraft ambushes, a mimic chest, and a summit. Each thumbnail's tooltip
and the detail line describe the skill the piece tests. The
[Ashen Ascent](docs/ashen-ascent.md) example places every piece in one course.
Choose a piece and a ghost preview follows the pointer; click/tap the game preview
to drop it. Press **M** or tick **Mirror left / right** while placing to flip it, or
press Escape to cancel.

The ghost rests on the nearest exposed terrain top within **28 screen pixels** of
the pointer, and its base line turns solid when it snaps. Elsewhere, it floats at
the pointer. Each drop is **one atomic level edit** that adds ordinary terrain,
trigger, enemy, and label objects, then returns to Select. Parts are not grouped:
select, move, resize, retune, or delete any of them as usual. Object IDs follow
`<piece>-<stamp>-<part>`. **Remove last placed set piece** removes whatever remains
of the most recent drop, remembering up to **64** drops. Importing, loading, or
starting a new level clears that history.

Pieces use only the built-in block, ramp, triangle, circle, and hexagon shapes, so
they share existing geometry templates and never add custom polygons. A piece whose
objects would exceed the terrain, trigger, enemy, or label limit is disabled. A drop
that would exceed the geometry template limit is rejected with a notice and leaves
the level unchanged. Previews never modify the authored level. Surface snapping uses
a column index built lazily at most once per level change. A drop uploads only its
new terrain instances. The catalog, thumbnails, and ghost are editor modules and are
excluded from game-only builds. Tropes that need moving props, such as swinging or
sliding platforms, are not included because terrain does not move.

### Decorations

Decorations are scenery that **never collides**: models placed anywhere from the far
horizon, up to 1,000 m behind the course, to 15 m in front of it, to set a level's mood.
**Workshop / Level / Decoration library** holds 26 original dark-fantasy placeholder
models in four categories: ruins (a cathedral, a castle on the horizon, towers, arches,
an obelisk, a knight statue), wilds (dead trees, a glowing golden great tree, crags, a
rock shelf for background scenery to stand on, a mountain ridge), relics (graves, a sword grave, skulls, a hanging cage, chains, banners,
fences) and fire & light (an ember cairn, a brazier, a candelabra, a lantern post). Pick
one, tune its depth, height, tint and mirror under **Object properties**, then click/tap
where its base should stand. Near the course its base rests on the terrain top under the
pointer. **Select decorations** picks and drags them, nearest first, at their own depth;
**Select / move** never picks them, so scenery cannot get in the way of editing the course.

Dress levels with decorations, not small terrain. Small colliders close together, such
as headstones, fence posts or rubble within about 1.2 m of each other, leave slots that
trap the pot and the hammer head, so keep colliders for the course itself.

Depth reads best with the theme's [perspective camera](docs/projects.md#section-reference):
distant decorations look smaller and drift slowly by, and near ones pass quickly in front.
Fog still applies, so raise the theme's fog end to see the far horizon, and hide the
theme's backdrop mountains if they stand in front of it. Decorations draw in instanced
batches with no physics, and a game-only release includes their code only when its level
places any. The models are placeholders: [course artwork](docs/course-artwork.md#decoration-models)
replaces any model, by ID, with your own textured GLB in mesh releases. See the
[decoration guide](docs/decorations.md) for every model, the level format and performance.

### Obstacle line

The physics is 2D and plays out on one plane, the **obstacle line** at z = 0 (`OBSTACLE_LINE` in
`src/obstacle-line.ts`). The camera frames the course on it, the level editor picks on it and
decoration depths are measured from it. Everything that collides is drawn centred on it, so with
the perspective camera each collision outline runs through the middle of what it looks like. Each
terrain object and its [course artwork](#course-artwork-from-your-own-pipeline) reach half their
depth toward the camera and half behind, and the pot, enemies and phantoms stand on the line. The
engine places them there, so no level can put a collider anywhere else. The collision overlay (**D**)
draws on the line too. The hammer and hands are drawn in front of the chest (see
[arm forward distance](#custom-visuals)), so in perspective the hammer model sits slightly off its
outline while its contacts stay on the line.

Colliders reach toward the camera, so the view draws in passes, each over the last: the course
(terrain, its artwork and the decorations behind the line); then the actors (the characters, phantoms
and enemies); then a 3D character's [arms over its body](#custom-visuals); then the front (the
decorations on or in front of the line, the aim cursor and line, course labels and the collision
overlay); and last the hammer. A character whose head or arms overlap a collider on screen, such as
under a low roof, is never hidden by it. A decoration in front of the line hides the arms only where
it is nearer, but always draws over the body and the other actors, so keep it clear of the jar, which
reaches 0.5 m toward the camera. Glass (`KHR_materials_transmission`) in a model drawn after the
course, such as a pot, an avatar or a decoration in front of the line, refracts only its own pass and
the sky colour, not the course.

Decorations never collide and may sit at any depth. A prop standing on a collider must stand within
that collider's depth, and one behind the path must also keep clear of the pot, which reaches 0.5 m
behind the line. A 1.5 m-deep block leaves only 0.25 m there, so give terrain that carries props
behind the path more depth. Deep terrain also reaches further toward the camera: an 8 m-deep block
comes 4 m in front of the line, which a wide field of view exaggerates.

### Course artwork from your own pipeline

Terrain collision is always the authored 2D polygon outline. By default the game
draws each terrain object as a 2.5D extrusion of that outline, `depth` deep and centred
on the [obstacle line](#obstacle-line), so what you see matches what the hammer grips. For bespoke artwork, make
static GLB meshes with any pipeline you like and assign them to terrain objects
when packing a course. Each mesh is fitted to its object's width, height, and
depth, rotates with it, and replaces its extruded shape. Collision never comes
from a mesh, and illusion fades, disappearance, and resets remain per object.
A course can also map decoration model IDs to GLBs, replacing those placeholders.

The editor designs collision only and never generates artwork. Levels that already
reference meshes keep those references while you edit them, and **Workshop / Project /
Course artwork** can import a packed course into a [project](docs/projects.md). See the [course artwork guide](docs/course-artwork.md) for the fitting
rules, packing command, package format, and limits.

### Performance boundaries

The level format supports **1,000 terrain objects**, **128 triggers**, **64 enemies**,
**1,000 decorations**, one start, **32 distinct terrain geometry templates**, up to
**64 vertices per custom polygon**, and **16 course labels**. Each trigger supports up to **8 ordered events**. Dimensions,
coordinates, winding, intersections, IDs, and import size are validated.
Preset objects reuse normalized geometry rather than allocating a new mesh and
material for every placement.

Terrain changes are incremental. Moving an object does not reconstruct the
whole physics world; static terrain is not regenerated each frame. Illusion
processing visits active landings/fades instead of polling every level object.
Shared batched rendering and cached materials keep draw calls tied to visible
geometry batches rather than the number of placed objects.
Decorations batch by model in chunks that grow with depth, so a representative
1,000-decoration level draws in about 60 calls and idle frames upload nothing.
Trigger proximity uses a spatial index rather than scanning the level every
physics tick. Flag markers share instanced geometry, and their buffers update
only when marker positions change. Runtime event state is separate from authored
objects and remains available in editor diagnostics.
[Phantoms](docs/phantoms.md) cost only while they play: at most three, each drawing 12
meshes that share one geometry set, about 0.05 ms a frame on the full Ashen Ascent course.
Recording checks only the stretch since its last keyframe, a few microseconds per physics step.

These performance and editor-free release requirements are recorded in
[`AGENTS.md`](AGENTS.md).

## Custom visuals

Open **Workshop / Character** to choose the character's presentation. The
default is **Mesh parts (3D)**: separate Three.js objects for the torso, head,
and arm segments, driven by visual arm IK.
All character types use the same Planck.js 2D physics, and their hands follow the
profile's [grips](#hand-grips) on the physical tool, with its [arm lengths](#arm-lengths).

| Character type | What is rendered |
| --- | --- |
| Mesh parts (3D) | Separate articulated meshes, with optional per-part GLB replacements from Appearance |
| 2D sprite character | PNG cutouts or a custom 2D bone/weighted rig; all 3D character underlays are hidden |
| Avatar (3D, connected body) | One connected, GPU-skinned character, built in or an imported skinned GLB, containing the torso, head, arms and hands; pot and hammer remain separate |

The choice is stored as `characterRiggingType` in the character/sprite profile.
Changing it retains the other artwork, but does not silently save it. Use the
profile's **Save**, **Revert**, and JSON controls. Profiles use **schema version
14**; profiles in any other version are rejected, not converted.

Choose **Use Avatar** for a built-in skinned character, included
under this project's MIT license. Its shoulder, elbow and wrist weights bend
the connected surface instead of moving disconnected rigid pieces. The same
physical grip targets drive its hands; the pot is not part of the skin.
The avatar is constructed once and reused, with bone updates only while active.

To use your own character, import a **skinned avatar GLB** in Character, for
example a Mixamo-rigged humanoid. A bone map names its body, head, upper-arm,
forearm and hand joints. The existing arm IK, grips, head gaze and arm forward
distance then drive them, with arm lengths from the GLB's bind pose; unmapped
joints follow their nearest mapped ancestor, and chains of them can swing as
[spring-bone hair](docs/characters.md#hair), such as a braid. Mixamo names map automatically,
and invalid models or maps fail with typed error codes. The same tab adds a
**one-model hammer** GLB on the physical tool frame, with its handle fitted to the
game's, a **pot model** GLB that follows the physical pot body and hides the body
inside it, and **PBR or cel shading** (stepped bands with an optional outline) that
can be flipped live to compare. All of these are part of the character profile, so Save, JSON and
`GAME_SPRITES` carry them. See [imported 3D characters](docs/characters.md).
Appearance's per-part GLB replacements are separate, browser-local assets that
only a [project](docs/projects.md) carries into a release; imported animation clips
are not played.

Character heads follow the direction from the hammer hinge toward the aim
cursor, without turning the torso or moving the grips. Mesh parts and Avatar share smooth, neck-pivoted 3D gaze;
imported head-part GLBs inherit the same motion. The 3D gaze keeps a slight
camera-facing bias and limits yaw/pitch to avoid unnatural neck turns.
Pausing freezes head motion, and resetting initializes it from the current aim.
Sprite heads use their own 2D artwork and authored directional limits.

The hammer always renders in the foreground in every character type.
Its shared 3D grip plane sits in front of the chest, so mesh-part and avatar
arms reach forward to hold it instead of intersecting a behind-the-body tool.
Tune **Workshop / Character / Arm forward distance** from **0-2 m** in
**0.01 m** steps; the default remains **0.25 m**. It moves both hands and the
hammer together in the two 3D modes. The value is part of the character profile:
Save, Revert and JSON export/import preserve it, including game-only releases.
Pure 2D rendering retains its authored depths and keeps this 3D setting dormant.
**Waist lean** (0-45°, default 0) leans a 3D character's upper body toward the hammer, turning at the waist on the
jar's rim, with the arms and head following; see [waist lean](docs/sprites.md#waist-lean).
The pot keeps its own depth. This affects only presentation, not hammer length,
aim, contacts, or physics. Imported models and all hammer sprite bindings use
the same foreground pass.

A 3D character's arms and hands always draw over its own body, jar and head. The camera sees the
character from the front, where arms reaching for a hammer held in front of the chest would otherwise
clip into them, so the view draws the body first and then the arms over it, with depth of their own.
That covers the mesh-part arms and their Appearance imports, the built-in avatar's arms, and an
imported avatar's arm surfaces: its triangles skinned mostly to the arm joints or to joints that follow
them, such as fingers and twist bones, and any rigid mesh attached below an arm joint (see
[avatar motion](docs/characters.md#motion)). The hammer still draws over the hands. 2D characters
keep their authored layer depths.

For a complete starting point, choose **Load complete 2D example** in Character.
**Paper Climber** supplies custom PNG artwork for the body, pot, arms, hands,
and hammer, plus a custom 2D arm rig that follows the actual grip targets.
Loading it changes the draft only. Save it or export its embedded-PNG profile
for an editor-free release; the example generator itself stays out of the game.

The **Sprites** tab adds named PNG layers with anchor selection, size, local
offsets/depth and rotation. Save or exchange complete
layouts as JSON, and select one with `GAME_SPRITES=skins/my-sprites.json` for
an editor-free release. The renderer is game-agnostic, with a self-contained
geometric example in `examples/sprites.mjs`. See [sprite authoring, runtime API,
limits, and release instructions](docs/sprites.md). No external artwork is
required or included in default builds.

The same tab supports [2D skeletons](docs/sprites.md#2d-skeletal-rigging):
bone-bound cutouts, weighted sprite meshes, eight-way artwork and poses,
keyframed animation, hand IK, a tiled fixed-length shaft, and cosmetic spring-bone
hair with body circles. Save/export includes the complete rig; `GAME_SPRITES`
bundles it without the editor. Supply directional artwork yourself. Rigging
changes the character's appearance, not its physics or hammer reach.

**Directional Presentation** adds shared angle-sector boundaries, per-direction
hysteresis, and smoothly limited head rotation around an authored neck pivot.
Explicitly selected face, crown, and head owners move together; braid sockets
follow before hair constraints run, without resetting the remaining particles.
The editor's visual-only aim preview is separate from live gameplay state.
See [directional controls and lifecycle](docs/sprites.md#directional-presentation).
Layouts without it keep fixed-sector facing.

An **aim flipbook** gives one layer 2-128 evenly spaced images, for example a
72-frame head turnaround with a new image every 5 degrees. The hammer aim picks
the nearest frame, with optional hysteresis against flicker. Frames are decoded
and uploaded at load, so changing frames allocates nothing. Choose the frame PNGs
in Sprites; Save, JSON and `GAME_SPRITES` carry them. See
[aim flipbooks](docs/sprites.md#aim-flipbooks).

Open **Workshop / Appearance**, choose a **Body part**, and select a **GLB model**.
Parts can be replaced independently: pot, torso/neck, character head, each upper
arm, forearm, elbow and hand, the full hammer shaft, and the hammer head. Parts
without an import keep their procedural visual in Mesh parts mode. In Avatar
mode, body-part imports remain stored but hidden; pot and hammer imports still
apply. A character profile's hammer or pot model hides the matching imports.
Invisible physics guide bodies do not need models.

Imports are **cosmetic only**. They attach to the existing physics and visual-IK
anchors; they do not replace colliders, change mass, or create new rigid bodies.
Use the collision overlay to compare the visual with the actual contact shape.
GLB import does not author colliders or retarget whole-character animations.

### Hand grips

**Workshop / Character / Hand grips and handle** chooses where the hands hold the handle.
Each hand's grip is a distance from the butt, **0.04 m** and **0.22 m** by default, set with
**Left hand grip** and **Right hand grip**; no grip comes nearer than 0.2 m to the head's centre.
**Fixed** hands stay on their grips and travel with the butt, so arms must reach as far as
the handle slides. **Slide along the handle**, the default, holds the grips too, until a hand
would be farther from its shoulder than **Slide beyond**, a share of that arm's length (40-100%,
default **85%**). Then the handle slides through both hands together, toward the butt or the head,
by the least amount that brings them back within it, as in Getting Over It: a bent arm keeps its
grip, and a nearly straight one lets the handle run. A hand that cannot come that close to the
handle's line holds the point nearest its shoulder, and when no shared slide suits both hands they
split the difference. The hands never leave the handle or come within 0.2 m of the head's centre,
so at full extension they may hold the butt beyond the slide point. Lower slide points keep the
hands nearer the shoulders; at 100% they slide only when an arm could not otherwise reach.

Reach is measured from the body's shoulders, the built-in ones or an imported avatar's, with the
arm lengths the character draws: forward to the handle at the tool's depth, or, for a 2D arm chain
that targets `left-grip` or `right-grip`, in the drawing plane, from the same shoulders where the
example's arm bones start; a 2D character's hand without such a chain has the built-in arm. At 85%
the built-in 0.82 m arms never stretch on the default rig, reaching at most about 95% of their
length while holding the butt at full extension; with a 2.1 m handle and 0.55 m extension they stay
within the slide point everywhere, and 0.55 m upper arms and forearms reach at most about 90%. The
placement is continuous in aim and extension: extending the handle by a millimetre moves no hand
more than a millimetre along it. It costs the same every frame. The same section's **Handle
length** is the game's [hammer rig](#game-settings) setting, shown here too: it is shared by every
character, and changing it restarts the run.

**Hand rotation**, in the same section, turns each 3D hand on its grip so its palm and fingers
close around the handle. Each hand has **X**, **Y** and **Z** sliders from -180° to 180°, all 0 by
default. X runs along the handle toward the head, Y across it in the course plane and Z toward the
camera. The axes follow the handle as it swings, and the hand pivots on its grip, turning about X,
then Y, then Z. Mesh-part hands, the built-in avatar's gloves and an imported avatar's hand bones
turn; when an imported avatar's [rig strategy](docs/characters.md#rig-strategies) holds the wrist
off the handle, that wrist swings about the grip too and the arm follows it. 2D characters keep the
wrist rotation authored on their IK chains in Sprites. **Reset hand rotation** returns both hands
to 0, and **Reset hand grips** leaves them. An unrotated hand does no extra work per frame.

Grips are saved as `grips: { "placement", "left", "right", "slideAt", "rotation" }` in the character
profile, with `slideAt` a fraction (0.4-1) and `rotation` each hand's `{ "x", "y", "z" }` in degrees
(`{ "left": {...}, "right": {...} }`), so each character keeps its own; Mesh parts, both avatars and
the 2D `left-grip` and `right-grip` targets share the grip positions, and the 2D targets ignore
`rotation`. Grips are presentation: physics, input and the hammer models never read them.

### Arm lengths

**Workshop / Character / Arm lengths** sets each arm's **upper arm** and **forearm** in metres,
for every character type: the built-in avatar's and mesh parts' arms, an imported avatar's arm
bones, and the 2D arm chains that target `left-grip` and `right-grip`, whose bones stretch along
their length with their arm artwork, while joint caps and hands keep their size. They are saved as `arms` in the
character profile. **Use natural arm lengths** clears them (`"arms": null`), and each type keeps
its own: 0.82 m and 0.82 m for the built-in arms, an imported avatar's bind pose, and a 2D
skeleton's authored bones. Arm lengths are visual only: physics and reach are unchanged. Sliding
hands measure their slide point against them, and an arm too short for its grip straightens
toward it as before.

### Body-relative arm IK

In **Workshop / Appearance / Body-relative elbow hints**, adjust each arm's
**X**, **Y**, and **Z** hint coordinates independently. These are preferred elbow
positions in torso-local metres: positive X goes right, positive Y goes up,
and positive Z goes toward the camera. The torso origin follows the player root,
not the shoulder. Defaults prefer elbows below and outside the shoulders, with
separate front/back preferences.

The two-bone solver projects the hint onto the elbow's possible bend circle;
the hint is not an exact elbow destination. Its reference follows the body,
not the rotating shoulder-to-hand ray, so no up/down/left/right mode switching
is required. Near a collinear hint, the solver transports the previous bend
plane instead of normalizing an undefined direction. Bend rotation is bounded
in radians per second, including when leaving a singular pose, so small hand
movements cannot cause an instantaneous elbow half-turn. Reachable poses preserve
both limb lengths. Fully extended arms have no lateral bend; unreachable grips
retain the existing visual forearm stretching rather than moving the hammer.

Shoulders use the torso's transform. Both hands hold the physical slider-to-head
frame, including its depth, where the profile's grips put them, and the arms take the
profile's arm lengths when it has them. Procedural segments,
straight replacements, GLB models, and tiled sprites share these same targets;
artwork never changes hammer length or hand placement. The preview
works with procedural and imported arm parts. Model alignment remains cosmetic;
it does not redefine skeleton anchors. These controls do not change colliders,
mass, reach limits, or motor tuning. **D** / the Workshop's **Overlay** toggle also
shows arm chains and crosses at the body-relative hints.

Enter an **IK profile name**, then **Save IK profile** (or press Enter). Every
save creates a timestamped snapshot of all six coordinates; reusing a name
keeps earlier versions. Choose **Past IK profiles**, then **Load IK profile**
to apply one. Selecting an entry alone does not change the preview. The last
successfully saved or loaded profile restores on reload. **Reset arm IK** only
previews the defaults; save a profile afterward to keep the reset.

Profiles use independent localStorage keys and a separate active-profile
reference. Other tabs refresh the history without replacing the current draft.
If a profile saves but updating the active reference fails, the UI reports
that partial result; the snapshot remains in history and can be loaded to retry.
Malformed profiles are marked and preserved. An unreadable active profile or
selection is reported, never silently replaced by another saved profile.
Model files, model alignment, and named physics presets remain separate.

The previous v1 swivel-angle record is left untouched for rollback. Those
ray-relative angles cannot be faithfully converted to body-relative targets:
when only that old selection exists, the editor explains the change and starts
with the new hints. Saving a named profile does not rewrite or delete the old
record.

### Model files

Use a self-contained **binary glTF 2.0 (`.glb`)** with embedded textures:

- Maximum file size: 20 MiB; maximum 128 meshes and 250,000 triangles per part.
- PNG, JPEG, WebP or AVIF textures, at most 4096 pixels on either edge.
- Export without Draco/Meshopt geometry or KTX2 texture compression.
- External resource URLs/files are rejected. Imported lights, cameras, line
  helpers and animations are not applied.

Each model is uniformly fitted to the original visual's bounds. **Visual
scale**, rotation in degrees, and local offsets preview immediately.
**Save alignment** preserves those adjustments; **Reset fit** previews the
original fit. **Use default** removes only the selected part's saved replacement.
For arm pieces, length should run along local Y; the shaft runs along local X.
Use the rotation controls if the export uses a different orientation.

A custom shaft is drawn as one straight mesh spanning the physical handle's
endpoints: it is fitted to a 1.5 m artwork length and stretched to the physical
handle, so it follows any handle length. The underlying three-segment shaft and
its mass/compliance remain in the physics simulation.

Files are saved locally in IndexedDB when imported, and saved appearances restore
on reload; a Workshop built with `GAME_PROJECT` keeps them in the project's browser
copy instead. Nothing is uploaded unless you save a [project](docs/projects.md) to your
own project server; projects carry these parts into their standalone releases. This
storage belongs to the current browser and site address; it is separate from physics
presets and is not bundled into `dist/` or shared with other players. Original files on your computer are
never modified.

## Runtime inspection

```sh
npm run verify
```

This builds both entries and exercises browser gameplay with Playwright, including
the course-artwork checks from `npm run verify:art` and the project, project server
and Project tab checks from `npm run verify:project`. If Chromium
is not installed for Playwright, install it with `npx playwright install chromium`
and rerun. Runtime artifacts are written to the ignored `artifacts/` directory.
There is no unit-test suite.

The editor entry exposes the read-only `window.gettingOver.snapshot()` and
`window.gettingOver.project({ x, y })` diagnostics for observing actual physics,
motor effort, camera state, and world-to-screen coordinates. `snapshot().rig` is
the rig's geometry: handle length, extension range, reach and segment length.
They do not expose commands that bypass the game's input or motor mechanism.
`window.gettingOver.appearance()` reports imported parts, saved/draft alignment,
loading errors, current rendering anchors and world transforms, and the arm IK
settings, selected profile, and save state.
`window.gettingOver.level()` reports the immutable authored definition, current
illusion/collider state, editor selection/mode, set piece placement state, and
render/cache counts, including the imported avatar's joints and bone writes, the
hammer model, shading, the active character profile, the arm chains it draws, and its
grip placement and slide point with both grips' current distances from the butt.
`window.gettingOver.events()` reports trigger/action lifecycles, presentation
state (including the message toast showing and how many wait), and the independent
run timer. Restart resets the attempt; physics time continues to be available
separately as `snapshot().time`.
`window.gettingOver.sprites()` reports the character/sprite draft and save state
with the sprite renderer's `inspect()` result, including each aim flipbook
layer's shown frame.
`window.gettingOver.gameProject()` reports the open project: title, server binding
and revisions, unsaved and conflicting sections, the project sections and audio
playback, and in a Workshop built with `GAME_PROJECT` the published project and this
browser's copy.
These globals are absent from the game-only release.

## Contributing

Issues and pull requests are welcome. Include steps to reproduce gameplay
problems, and run `npm run verify` before submitting code changes.

## License

The project source and included procedural artwork are available under the
[MIT License](LICENSE). Dependencies retain their own licenses. Models imported
through the Workshop are not included in this repository and retain their
original licenses.

This is an independent project, not affiliated with or endorsed by the creators
of Getting Over It.
