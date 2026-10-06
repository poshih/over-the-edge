# Over the Edge

An independent browser-based physics climbing playground, inspired by the
two-motor mechanism described by Getting Over It's creator. The first version
has a small climb, dedicated practice positions, procedural 3D artwork, and a
live tuning workshop. It is not a port of Getting Over It's assets or code.

It is also an engine: downstream games build on it and change what players see
and play through their own content and plugins, without forking it. See
[Customizing a game](#customizing-a-game).

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

Every local server, these and the game-only release's below, listens on `127.0.0.1`
only, so nothing is reachable from another machine and this repository hosts nothing
online. When the server runs on a remote machine, forward its port to your own
computer, for example with `ssh -L 5181:127.0.0.1:5181 <machine>` or VS Code's
**Ports** view, and open **http://localhost:5181** there. To listen on another interface
instead, pass Vite's `--host`, as in `npm run dev -- --host 0.0.0.0`; the project server
still answers only this computer until you set [`STUDIO_TOKEN`](docs/projects.md#the-project-server).

`dist/` is a static site that any static host can serve. It serves the level files in
`levels/` as the Workshop's [server levels](#level-editing). A Workshop for one game is
built with `GAME_PROJECT=<project> npm run build`; deployed, it opens that game, keeps
each visitor's changes in their browser and picks up redeployments; see [publishing a
Workshop with its project](docs/projects.md#publishing-a-workshop-with-its-project).

The Workshop also offers the GLBs in `models/avatar/`, `models/hammer/` and `models/pot/`
as [server models](docs/characters.md#server-models), which designers pick in the Character
tab and the project's model library instead of choosing files. They are delivered from a
CDN, not with the Workshop: `npm run build` writes them to **`dist-content/`**, named by
SHA-256, and the Workshop downloads them from **`WORKSHOP_CONTENT_URL`** (default
`content/`, beside the Workshop, as `npm run dev` and `npm run preview` serve them).
Upload `dist-content/` there, with CORS for the Workshop's origin:

```sh
WORKSHOP_CONTENT_URL=https://cdn.example.com/workshop/ npm run build
# then deploy dist/ and upload dist-content/ to https://cdn.example.com/workshop/
```

### Game-only release

The playable release has a separate HTML/TypeScript entry and stylesheet. It
does not load the Workshop, level editor, model importer, saved editor profiles,
practice shortcuts, collision overlay, or editor diagnostic globals.
Its HUD shows the height, health and timer readouts, plus a character choice when
the release bundles two character profiles. The project's
[HUD settings](docs/projects.md#section-reference) choose whether the height and timer
show, health shows in levels where something can hurt the player, and a game's runtime
plugin can replace any readout; see [HUD readouts](docs/runtime-plugins.md#hud-readouts).
The HUD settings also author the death message and its fade/hold timing, shared by
Workshop play-tests and releases.
On-screen Play/Pause/Reset, peak height, branding, and help remain in the editor build,
not the release.

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
`npm run build` still builds the editor/workshop into `dist/`, not this separate release.

A game adds its own code with **plugins**, listed in a JSON manifest that **`GAME_PLUGINS`**
names. Each plugin has up to four facets, one for each place its code runs:

- **kinds**, the rig strategies and secondary-motion kinds its avatars select by ID in their
  `driver` and `motion`, checked identically wherever content is validated;
- **runtime**, how play looks, sounds and responds: HUD readouts and extras, camera following, backdrop,
  aim marks, hurt effects, death animation and screen, object, enemy and phantom looks,
  scene layers, audio, message presentation,
  gameplay observers, key bindings and additional input devices, in the Workshop's play-test,
  studio previews and releases; character choice in releases and studio previews;
- **release**, notices, fatal errors and release-only services: a game whose content only some players may load signs
  players in there with its own identity management and grants the release access to its
  content, typically short-lived signed CDN URLs from the game's backend, so the engine never
  sees accounts or credentials;
- **workshop**, the game's own Workshop tools: tabs and sections built from the Workshop's
  controls, edits through the engine's own operations, data of its own kept in the project, and
  overlays, canvas drags and previews in the running game. Releases contain none of it.

```sh
GAME_PLUGINS=examples/plugins/plugins.json npm run dev     # the example plugin, in the Workshop
GAME_PLUGINS=games/my-game/plugins.json npm run build:game
```

See [plugins](docs/plugins.md), [content delivery](docs/content-delivery.md) and
[Workshop plugins](docs/workshop-plugins.md).

Releases replay recordings of players near the player as translucent white phantoms. While
**Record** is on, the Workshop records your play on each saved version of a server project's
level and game settings, marked by a pulsing red **REC**, and a release built from the project
bundles the recordings made on its level's layout with its physics. A release built with **`GAME_PHANTOMS_URL`** also records
a random 10 seconds of its player now and then, sends it to the game's backend and replays what
the backend sends. Ten seconds take under 4 KB and reproduce every physics step within 1.5 cm;
arms are placed by the game's own IK rather than recorded. `GAME_PHANTOMS_URL=phantoms/ npm run
dev:game` tries a backend locally with the development server's own store. A release with
neither carries no phantom code. See [phantoms](docs/phantoms.md).

Set **`GAME_TITLE`** to use your own game name:

```sh
GAME_TITLE="My Climbing Game" npm run build:game
GAME_TITLE="My Climbing Game" npm run dev:game
```

The same setting works with `npm run dev` and `npm run build` for the Workshop.
It controls the browser tab title and Workshop heading; the game-only HUD shows
no title, only the readouts and character choice described under
[Game-only release](#game-only-release). Omit it to keep **Over the Edge**.
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

To deploy the game-only release, serve the shell, `dist-game/`, from any static host,
on a site of its own rather than the Workshop's. Upload `dist-game-content/` to the
static host or CDN that serves your content URL, with CORS headers for the shell's
origin, and build with that URL:

```sh
GAME_CONTENT_URL=https://cdn.example.com/my-game/ npm run build:game
# then deploy dist-game/ and upload dist-game-content/ to https://cdn.example.com/my-game/
```

Deploying the shell alone never publishes content.

To include an authored course in the game-only release, export its JSON from the
Level tab, place that file inside the project (for example
`levels/my-level.json`), then build:

```sh
GAME_LEVEL=levels/my-level.json npm run build:game
```

Without `GAME_LEVEL`, the build uses the built-in course with its meshes. The selected data is
validated and packaged as content at build time; the game needs no editor or external
level service. The `/media/` files its events play are packaged from `public/media/`,
and a game build fails on any source it cannot package, such as an external URL. Level exports do not contain gameplay settings, sprite layouts,
private character GLBs, or IK profiles; a [project](docs/projects.md) holds all of them. A level that places GLB
meshes from your own art pipeline, or maps decorations to them, builds from a course package, the level JSON with
its GLBs, made with `npm run pack:course`; pass the package as `GAME_LEVEL`. `GAME_ART_MODE=shapes`
or `GAME_ART_MODE=meshes` overrides the package's look; shape-only releases omit
the GLBs and mesh loader. See [course meshes](docs/course-artwork.md).

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
Project manifests and bundles use **schema 12**, and release content **schema 11**,
including the required HUD death text and timing; other versions are rejected.

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

**Showcase** is a short, labelled left-to-right tour of all five terrain surfaces,
illusion terrain, a bonfire, timer and switch-fired projectile traps, a swinging
axe, swamp and lava pools, both enemy species, an updraft and a rideable lift with
landing call switches, ending at a timer-stopping flag. Open **showcase** in
**Workshop / Level / Server levels**, or select `GAME_LEVEL=levels/showcase.json`
for a game-only build. Regenerate it with `node scripts/showcase/generate.mjs`;
change the generator, not the generated JSON.

### Included souls-like example game

**Ashen Ascent** is a complete project that uses all 67 set pieces from the
[library](#set-piece-library) once each. Its climb runs through eight themed zones
of lying messages, secrets and ambushes, to a castle drifting in the sky at about
407 m:

```sh
GAME_PROJECT=examples/projects/ashen-ascent npm run dev:game
GAME_PROJECT=examples/projects/ashen-ascent npm run build:game
```

It is generated by `node scripts/ashen-ascent/generate.mjs`, which checks course geometry
before writing and reports reach suggestions. Its mesh-aware builder, route tools and bounded
checks form a reusable [course kit](docs/course-kit.md), using the engine's authored collision for checks and maps. See the
[course guide](docs/ashen-ascent.md) and the [map](docs/ashen-ascent-map.svg).

## Customizing a game

A downstream game changes the engine without forking it. Its [project](docs/projects.md)
holds the data that sets most of what players see and hear, and its [plugins](docs/plugins.md),
the game's own code that `GAME_PLUGINS` names, replace or extend the engine where data cannot.
Each extension point has the engine's own look and behaviour as its default, so a game replaces
only what it needs.

| To change | Use |
| --- | --- |
| The title, theme and lights, HUD labels and units, music and sound cues, characters and their models, course meshes, decorations, enemy art and game settings | The project: see [projects](docs/projects.md) |
| How imported avatars are rigged, and their secondary motion: code that content selects by ID | A plugin's kinds facet: see [kinds plugins](docs/kinds-plugins.md) |
| How the HUD's readouts (height, health, timer and extras), camera following, backdrop, aim marks, flags, updrafts, pressure switches, bonfires, platforms, traps, projectiles, lava and swamp pools, enemies and phantoms look, plus death animation and screen, scene layers, audio, message presentation, gameplay observers, key bindings and additional input devices, in Workshop play-tests, studio previews and releases; character choice in releases and studio previews | A plugin's runtime facet: see [runtime plugins](docs/runtime-plugins.md) |
| Notices and fatal errors, sign-in and content access, the phantom backend, the library models each player has, and the load's failures and progress, in releases | A plugin's release facet: see [release plugins](docs/release-plugins.md) and [content delivery](docs/content-delivery.md) |
| The Workshop: the game's own tabs, sections, data, overlays, previews and motion controls | A plugin's workshop facet: see [Workshop plugins](docs/workshop-plugins.md) |

Plugins are build inputs, the game's own trusted code, never project data, so nothing sent to a
project server can add code to a game. Each facet runs where its code belongs: kinds wherever
the game runs and is validated, runtime wherever it plays, release in the releases built with it,
and workshop in the Workshop alone. [`AGENTS.md`](AGENTS.md) makes this a requirement: every
new feature ships with its extension point.

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

These are the engine's default controls. Runtime plugins can change the reset, pause and
recenter key bindings or add devices; see [Input](docs/runtime-plugins.md#input).

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
is a death: it brings the player back at the [bonfire](#health-and-bonfires) reached
last, or, before any, restarts the attempt exactly like Reset. It only arms once the
pot or hammer head has stood on terrain since the player was placed, so a start with
nothing beneath it keeps falling instead of restarting in a loop.

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

The Workshop never plays trigger videos: a **Play video** event is skipped at once and its
trigger goes on, so an intro film never interrupts testing. A game-only release plays them
(`npm run dev:game`).

## Physics architecture

Runtime dependencies are **Planck.js** and **Three.js**. Development uses
**TypeScript** and **Vite**. Planck 1.4.2 is pinned for its Node 22-compatible
package contract and its Box2D-style joint API.

```text
Dynamic root, rotation locked
  +-- limited unpowered hinge --> pot
  +-- coupled polar drive (angular + axial motors, passive slide stops)
          +-- rigid: one compound carriage / shaft / head body
          +-- compliant: carriage + three spring-welded segments + head
```

A rigid player has three dynamic bodies and two joints; a compliant player has
seven bodies and six joints. The polar drive solves its lateral constraint and
both bounded motor rows together against the actual driven body's mass, without
light guide bodies in the force path. The rigid tool has no welds to converge.
Component mass, centre of mass and inertia are preserved: the hinge component's
translation mass belongs to the root, and its rotor inertia belongs to the tool.
Arms are visual two-bone IK, never collision bodies or actuators. The pot and
hammer head collide with terrain and nearby living enemies; the shaft fixtures
supply geometry and mass distribution but never generate contacts. Normal locomotion does not teleport bodies,
apply assistance forces, or turn off the head's collisions. Authored updrafts
and enemy contact knockback apply explicit, mass-aware impulses once per physical
body without changing the rig or disabling collisions. Terrain collides only from
the outside: a colliding fixture whose own centroid ends up inside a terrain
outline, for example after an edit or a restored illusion, passes out of it instead
of being trapped or shoved. A non-colliding shaft inside rock never suppresses a
head contact just because they share a body. See [ground-hold stability](docs/ground-hold-stability.md).

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
dead zone beyond it. Without input, both offsets stay unchanged by default: walking,
falling, or being launched carries them with the character. A game's **Follow
character** setting can make them follow only part of that movement, staying partly
where they were in the world (see [game settings](#game-settings)). They do not rotate
with the pot, follow the hammer, or drift back to the hinge, unless a game turns
on **Return target to hammer**. Camera movement does not modify them.

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

By default the slider can retract the head all the way to the hinge, so there is
no unreachable inner ring. The hinge's own orientation defines aim even at zero
reach; aiming does not normalize a zero-length hinge-to-head vector. A **Minimum
reach** keeps the head that far from the hinge: aiming inside it only turns the
hammer toward the target, and the head stays on that inner ring.

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

The workshop applies parameters without restarting, except rig dimensions and
crossing between zero and positive handle compliance, which rebuild the player
and restart the run. Its first section, **Mass & recoil**, groups head mass, player
mass and rotation speed with total shaft mass, hinge component mass and carriage
mass. Shaft mass is uniform along the handle, in one body when rigid and divided
equally among three segments when compliant. Component inertia scales with mass;
the defaults remain 0.66 kg for the shaft and 0.5 kg for each hinge/carriage
component. All masses stay positive.

The other sections include motor strength and speed limits, the downswing boost,
response gains, damping, contact friction, handle compliance, control
sensitivity, the player's [health](#health-and-bonfires) and [liquids](#liquid-pools). **Downswing** has a **Hinge downswing boost** and a **Slider
downswing boost**, each 1-3x (default **1.3x**; 1 turns it off), multiplying that
motor's strength while input moves the target down and the motor speeds the head
up downward.
Zero handle frequency makes the carriage, shaft and head one rigid body; positive
frequency joins a carriage, three shaft segments and the head with rotational
spring welds.

**Physics › Materials** sets each contact friction coefficient (0.05-10): **Hammer
friction** (default **2.5**, from 0.2), **Jar friction** (**0.45**) and one setting for each
terrain surface: **Rock** (**3**, every obstacle's default), **Wood** (**2**), **Metal**
(**1**), **Ice** (**0.1**) and **Rubber** (**6**). Planck mixes a contact's two sides as their
geometric mean, so the hammer on rock grips with `sqrt(2.5 * 3)`, about **2.74**, and the
jar with about **1.16**, resting on rock slopes up to about 49°. This is ordinary contact
friction, not a sticky constraint: the head must still press against a surface to hold.

**Physics › Materials** also sets bounciness, from 0% (stops dead) to 100% (bounces
back as fast as it came): **Jar bounciness** (default **10%**), **Hammer bounciness**
(default **0%**), and one setting for each terrain surface: **Rock** (**10%**, every
obstacle's default), **Wood** (**20%**), **Metal** (**30%**), **Ice** (**5%**) and
**Rubber** (**80%**). Each terrain object has a **Surface**, set under **Object
properties** in Level. A contact bounces as much as the bouncier of its two sides,
Planck's rule, so a rubber block bounces even a dead jar, and only when they meet
faster than 1 m/s, so resting contacts stay still. Enemies take each surface's
friction and bounciness too. Changes apply at once, also to contacts already touching.

The **Hammer rig** section sets the tool's geometry. **Handle length** (0.75-3 m,
default **1.5 m**) runs from the butt to the centre of the head. **Maximum
extension** (0-2 m, default **1.15 m**) is how far the butt can slide past the
shoulder hinge; the reach is their sum. **Minimum reach** (0 m up to 5 cm short of
the reach, so the slider can still move; default **0 m**) is how close the head can
come to the hinge: fully retracted it stops that far out, so the butt travels the
handle length less the minimum reach behind the hinge, and at 0 the head reaches the
hinge. A shorter handle or extension caps the minimum reach 5 cm short of the new reach. The three handle segments share the
handle length, and everything else follows the rig: the two-part hammer, the
one-model hammer's handle, touch gain, compact framing and the target radius limit.
Apart from its head, below, a rig is never changed in place: a new one rebuilds the
player and restarts the run from its start, like **Reset**. A longer handle with a shorter extension keeps the
reach while letting characters with sliding grips (see [hand grips](#hand-grips))
use shorter arms.

The **Hammer head** section shapes each hammer's collision outline: the **Default
hammer**'s, a game setting (`rig.head`), and each [model-library hammer's](docs/characters.md#model-library-and-runtime-swaps)
own, which collides instead while that hammer is shown. The canvas shows the outline
around the head's centre, with the handle coming in from the left. Drag a point, press
an edge to add one there, and select a point to nudge it with the arrow keys (one step of
the grid, or ten with Shift) or remove it with **Remove point** or Delete. Moved and added
points snap to the **Snap grid**, which the slider below the canvas sets from 1 mm to 10 cm
(5 mm until you change it; the browser remembers your choice); the canvas draws grids of
2 cm and more between its 10 cm lines. **Mirror** keeps both sides of the
handle alike, and **Sledge**, **Round** and **Pick** start from a preset. The outline is
always the smallest convex one around its points, so a head can be a block, a disc, a
wedge or a pointed pick, never hooked: 3-12 points within 0.6 m of the centre, which
stays inside. The head's mass stays **Hammer head mass**, and its outline sets how that
mass turns. A head changes in place, without restarting the run, and the built-in
hammer mesh, the debug overlay, framing and how near the hands come follow it; imported
hammer models and sprites keep their own artwork. Phantoms draw the default head.

The **Cursor target** section has a **Maximum target radius** slider, from
**0.25 m** up to the hammer's reach, default the full reach. A saved radius beyond
the reach is rejected. When the rig changes in the Workshop, a full-reach radius
follows the new reach and a smaller one is capped at it. Reducing the radius
immediately pulls an out-of-range target straight in, including while paused;
increasing it preserves the current offset. Its **Dead zone** slider (0-0.5 m,
default **0.1 m**) sets the slack between the cursor and the target; 0 makes the
hammer follow every movement. Changing the dead zone never moves the target: a
smaller one pulls the cursor toward it. Its **Follow character** slider (0-100%,
default **100%**) sets how much of the character's movement the cursor and target
share. At 100% they keep their offset from the shoulder hinge, so a jar that sinks or
bounces drives the hammer into what it rests on, which can bounce the character with
no input; lower values leave them partly where they were in the world, and at 0% only
aiming and the return to the hammer move them, always within the radius. None of
these settings restarts the attempt, alters body masses, or changes the rig's forces,
mechanical reach, or collision rules.

The section also has **Return target to hammer**, off by default, with a **Return
delay** (0.05-5 s, default **0.15 s**), a **Return speed** (0.1-60 /s, default **8
/s**; the target closes 63% of the gap in 1/speed seconds) and **Return offset X** and
**Y** in metres (default 0). When it is on and no aiming input has arrived for the
return delay, in run time, while the hammer head touches a surface, the target eases
toward the head's centre plus the offset, staying inside the target radius, and the
cursor moves with it, keeping its place in the dead zone. Any aiming input restarts
the wait; the delay is at least 0.05 s so the target never eases back between pointer
updates while you aim. Input always comes first, and easing back never boosts a
downswing. Positive X goes right and positive Y up; the offset does not turn with the
hammer. Turning return off keeps its values. Like the other cursor settings, it never
restarts the attempt or changes a phantom course.

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
uploaded unless you save to your own project server: **Save to project** writes the
settings into the open [project](docs/projects.md), and **Server game settings** shares
named [copies](docs/projects.md#server-copies). Settings use
**schema version 12**, with `physics`, `rig` and `cursor` sections; files and saves
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
separates placement gestures from hammer input. Terrain is made of meshes, and each brings
its collision: choose a block, thin platform, ramp, triangle, circle, or hexagon, draw a
shape, or import a GLB under **Meshes**, then click/tap the game preview to place it. A GLB
collides as the simple shape it declares or as its slice on the [obstacle line](#obstacle-line);
see [course meshes](docs/course-artwork.md). Select an object to move it or adjust its
position, dimensions, rotation, mirroring, surface and illusion property. Dragging previews
the change; releasing commits it. Drag empty
space, or drag with the middle button from anywhere, to pan; the wheel and + / - zoom.
On a touch screen, drag with two fingers to pan and pinch to zoom. There are no
separate select and pan modes: a pressed tool, such as a shape to place, goes back to
selecting when you click it again or press Escape.

The start location and trigger zones are map objects, not special summit
settings. Place or drag **Start location** to choose the spawn and adjust its
initial hammer pose: its angle and its **reach**, the head's distance from the
shoulder hinge. Reach keeps the start pose the same for any handle length; a
hammer that cannot reach that far starts fully extended, and one whose minimum
reach is farther starts at its minimum reach. Each level has one start. Playtest from that position,
and use Reset to repeat the course. Runtime effects never delete objects from
the editor's authored definition.

To test one part of a course without moving its start, choose **Place player** and
click/tap where the pot should stand. The player moves there in the start's hammer
pose, and the level is not edited. Playtests, Reset and deaths before any bonfire then
start from the placed player until you choose **Use the level start** in the Level
tab, pick a starting point in **Physics**, or load another level.

Levels are saved in the open [server project](docs/projects.md#working-in-the-workshop):
it saves the level a moment after you stop editing, and **Save to project**, at the top of
the Level tab, saves it at once. Every save becomes the project's next numbered
[level version](docs/projects.md#level-versions), and the status line shows the one the page
holds. Without a server project, use **Level JSON** to export/import level data between
browsers or feed the game-only build. Imports are validated before replacing the current
level; malformed files produce visible errors.

**Server levels** loads the levels served with the Workshop: every level JSON file in this
repository's `levels/` folder, named by its file name, and first, in a Workshop built with
`GAME_PROJECT`, that project's level. Builds validate each file and fail, naming it, when one
is not a valid level. A level downloads when you load it, and replaces the current level like
an import, asking first when there are unsaved changes.

**Replays** plays back the runs the Workshop [recorded](docs/phantoms.md#recording-in-the-workshop)
on each saved version: pick a version and a run, then **Play**, change the speed, move through
the run with **Position**, and let **Follow** keep the camera on the phantom.

### Level board

**Board**, on until you turn it off, lays a chessboard over the course so you can name an
area in one word, for example when asking a person or a language model for a fix: "the gap
in D7 is too wide". Squares are 10 m. Rows count up from the ground at y = 0: row 1 is
0-10 m high, row 7 is 60-70 m and row 0 is the band just below the ground. Columns are
lettered A, B, ... Z, AA, AB, ... from the left: column A is the 10 m band, on multiples of
10 m, that holds the level's leftmost terrain point (for terrain that is not rotated, the
smallest `x - width/2`). The letters shift when that point moves into another 10 m band:
when terrain is added or moved left of column A, or the leftmost piece is moved right or
removed.

Squares show their names; zoomed out, only every 2nd, 5th, 10th, 20th, ... column and row
is named. Pointing at the course names the square and the position under the pointer. Type
a square such as `D7` and choose **Go to** to centre the view on it, for example one a
language model names in its answer.

### Drawing terrain

Choose **Workshop / Level / Draw shape**. Click or tap individual corners, or
hold and drag to trace an outline. You can combine separate strokes and point
placements. Freehand strokes are simplified with a two-screen-pixel tolerance
at the drawing zoom, so pointer samples do not become hundreds of physics edges.

Tap the first point, press **Enter**, or choose **Finish shape** to close the
outline. Clockwise and counterclockwise input both work; the shared terrain
converter normalizes winding and rejects invalid geometry. Concave outlines,
including ledges and notches, are stored as one outline mesh like any drawn shape.

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

Outlines support **3-64 points**, **0.25-128 m** width and height, and the level's
limit of **64 distinct terrain collision shapes**, each mirroring counted on its own. Crossing or
overlapping edges, holes, and zero-area shapes are rejected without changing the
authored level; the draft remains available for undo or cancellation. Curves are
polygonal approximations, not Bezier surfaces. Separate objects can surround an
opening, or a GLB mesh can bring a slice with holes.

The built-in course is built from GLB meshes, as any course can be: its
`ascent` is a **Cliff** mesh, not a stack of blocks, whose slice on the obstacle line is
one static closed chain of 19 edges with the climb's ledges and overhang; its ground declares
a box, and a boulder and a mirrored crag make the rest. Its level also has one of each hazard:
a bonfire on the first ledge, a projectile trap in the left crag firing across the second, a
swamp against the fourth ledge's riser, an axe over the last step and a lava lake past the
summit's far edge (see [the built-in course](docs/course-artwork.md#the-built-in-course)). Geometry is cached and
shared, and static objects do not rebuild geometry or rewrite instance transforms each frame.
Drawn outlines use the same rendering and collision path; they cost according to their
edge/template count, not their on-screen size.

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
| Fire trap | Starts a burst of 1-20 shots from a selected projectile trap |
| Move platform | Toggle alternates a selected platform's destination; To start / To end call it to that end, reversing if it is moving away |

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
requested through a user-operated fullscreen control. The Workshop skips every video while
you test (see [Finding Workshop controls](#finding-workshop-controls)); videos play in the
game-only release.

Level JSON uses **schema version 8**, with typed terrain, start, trigger, enemy,
decoration, bonfire, projectile trap (`shooter`), swinging axe (`axe`), liquid pool
(`pool`) and platform objects. Terrain has a `surface`, one of `rock`, `wood`, `metal`,
`ice` and `rubber`.
A start is `{ "kind": "start", "id", "x", "y", "angle", "reach" }`.
Files in any other version are rejected, not converted.

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
A game's runtime plugin can draw flag and updraft markers its own way; see
[object looks](docs/runtime-plugins.md#object-looks).

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
Body collisions knock the player back and cost **1** [health](#health-and-bonfires).
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

### Health and bonfires

In levels with enemies, [traps](#traps) or [lava](#liquid-pools) the player has **health**,
set in **Physics / Health**: 1-20 damage points, 5 by default, shown as a row of pips beside
the readouts. An enemy's bump costs 1, a trap its own damage and lava its damage each second.
A hit leaves the character unharmed for **1 s**, so one blow counts once. Levels without
enemies, traps or lava show no health.

Choose **Workshop / Level / Bonfire**, then click/tap: its base rests on the terrain top
under the pointer. A bonfire lights when the player's foot comes within **1.5 m** of its
base, and the one reached last is where a death returns the player. Health running out
or a fall out of the level starts a death animation: 3D characters slump and nod, and
2D sprites hold their pose and dim. **“You are dead...”** slowly fades in over **1.5 s**
and stays for **2.5 s** before the player returns. Author its text and timing in
**Workshop / Project / HUD**. The world and run timer (unless stopped) keep going while the dead player
has frozen aim, takes no damage, hits no enemies, lights no bonfires and gains no best
height. Outstanding trigger runs cancel and pressure switches release. Pause and a
hidden tab hold the sequence; movement is discarded, but Reset and other controls remain.

After the wait the player returns at that bonfire, healed and unharmed for **2 s**,
holding the hammer as at the level's start. The run goes on: its clock, best height,
consumed once-triggers and level state carry on. Before any
bonfire is reached, a death restarts the attempt exactly like Reset; Reset always
restarts from the start and puts every bonfire out. Bonfires never collide; they stand on
the obstacle line, behind the player.

Health, lit bonfires and deaths are runtime state: saves and exports keep only the
authored bonfires. The `hurt`, `death`, `fall` and `bonfire` [audio cues](docs/projects.md)
sound them; death/fall arrive at entry, respawn after placement. Both
[phantom recorders](docs/phantoms.md) stop before the fatal sample: no corpse movement,
teleport or placement pose becomes a phantom. Reset, replacement, Workshop placement and
entering Level editing cancel the sequence; incremental edits apply while it continues. A
game's runtime plugin can draw the [health readout](docs/runtime-plugins.md#hud-readouts) and
[bonfires](docs/runtime-plugins.md#object-looks) its own way. Each hit says what dealt it, an
enemy, a trap's projectile, an axe or lava, which level object did, where it struck and how hard
it knocked the player, so a game's [hurt effects](docs/runtime-plugins.md#hurt-effects) can show
its own effect for each and its [gameplay observers](docs/runtime-plugins.md#gameplay-events) can
tell them apart. The engine's sets the character alight while lava burns it, and shows a blade's
or a projectile's blow where it lands.
Two independent runtime points replace the [death screen and animation](docs/runtime-plugins.md#death-sequence).
Fatal lava keeps the corpse alight until placement clears it.

### Traps

Traps hurt the character as it is drawn, the pot and the body standing in it. They never
collide, so they can sit anywhere, and a hit knocks the player as well as costing health.
Choose **Workshop / Level / Projectile trap** or **Swinging axe**, then click/tap.

A **projectile trap** fires from its muzzle, its position, along its rotation: at
**First shot** seconds into the run and every **Shot interval** after, at its
**Projectile speed**, while the player is within **40 m**, when **Fires** is **On its timer**.
Set **Fires** to **Only when triggered** for a trap that never shoots on its own: a trigger can
start a burst, where First shot is the delay after the trigger and Shot interval is the time
between burst shots. Projectiles fly straight for up to 40 m. Terrain and elevator platforms
stop them, and so does the hammer head, which makes the hammer a
shield. Terrain stops them only from outside, so a muzzle set into a wall's face shoots
out of it. A hit costs the trap's **Damage** and knocks the player along the shot, and
where it strikes the burning bolt bursts in a hot flash, sparks and glowing chips.

A **swinging axe** hangs its blade **Length** below its pivot, its position, and swings in
and out of the view, toward the camera and away, up to 63° either side, once every
**Swing period**, rather than sideways along the climb. The blade lies in the plane of its
swing, its curved edge below, so it swings edge first and is edge-on to the camera: 1.3 m
toward the camera and away, 0.7 m tall and 6 cm thick along the climb. It cuts through the
play line at **Swing offset** seconds and every half period after. There a blade that meets
the player costs its **Damage** and knocks the player hard away from where it struck, 9 m/s
along the climb and 4 m/s up, with a steel flash, a slash and a spray of sparks. The half of the swing in
front of the obstacle line draws over the player, the half behind it under the player.
Stagger neighbouring axes with their offsets.

Traps run on the run's clock, so their rhythm is the same every attempt. Up to **256**
projectiles fly at once across a level; a trap skips its shot while they all fly. A game's
runtime plugin can draw traps and projectiles its own way; see [object looks](docs/runtime-plugins.md#object-looks).

### Pressure switches and elevator platforms

Choose **Workshop / Level / Pressure switch** to place a small trigger with the **switch**
marker and **On each entry** activation. It has no events until you add them. In **Trigger
events**, **Fire trap** starts a burst on a projectile trap (default **3** shots, 1-20), and
**Move platform** sends an elevator platform to the selected destination: **Toggle**
alternates its ends, even mid-trip; **To start** and **To end** call it to that end, reversing
if it is moving away and doing nothing if it is already resting or heading there.

Select a switch or trigger to see its outgoing connections; select a projectile trap or
platform to see incoming connections from every trigger that controls it. **Links**, beside
**Board**, shows all connections, emphasising the selected object's links and dimming the
others. Arrowheads point towards the target. Midpoint labels show **×N** shots, **toggle**,
**→ start** or **→ end**; several events for the same target share one line, labelled in order,
such as **×3 · ×2**.
Arrowheads and labels stay readable as you zoom, and connections follow objects you drag.

Drag the selected trigger's small link handle, beside its region's right edge, onto a
projectile trap or platform to connect it. This adds a **Fire trap** event with **3** shots or a
**Move platform** event set to **Toggle**, applying it together with any pending Trigger events
edits. Invalid edits stay in the draft for you to fix and apply. An existing connection or a
full event list adds nothing; release elsewhere or press **Escape** to cancel. Edit or remove a link in
**Trigger events**, then **Apply events**.

Choose **Workshop / Level / Elevator platform** to place a colliding slab. **Position X/Y** is
its start centre; **Travel X/Y** is the offset in metres to its other centre, up to ±200 m on
each axis (`travelX`/`travelY` in JSON). **Width**, **Height**, **Depth**, **Speed** and
**Surface** set its box, motion and material. The Workshop draws the start slab, a dashed end
preview and travel line. Dragging the slab moves the whole platform, both ends together;
dragging the end handle changes only the travel.

**Starts when stepped on** (`ride`, a required boolean in JSON) makes it a rideable lift.
The preset has this checked and travels **4 m up**. When the platform rests, the pot landing
on its top sends it to the other end, carrying the player. The hammer, sides and underside
do not start it. Staying aboard at arrival does not turn it back; step off for at least
**0.3 s** while it rests, then board again to return. Brief bounces at departure or arrival
do not rearm it, and a dying player cannot start it. The default platform look draws a thin,
darker metal pressure plate on the deck of a `ride` platform; it moves with the slab, without
a separate trigger.

To call an upward lift, put a pressure switch at each landing, outside its travel path.
Give the bottom switch a **Move platform / To start** event and the top switch a
**Move platform / To end** event, both targeting that lift. A landing switch calls it to
you without sending it away when it is already there; step onto the deck to ride.
Do not put a separate switch over the deck or under the lift's path: trigger zones stay
at their authored positions and do not move with platforms.

Keep its path clear: a platform moves through terrain and can push the player into rock.
Reset returns platforms to their starts; returning to a bonfire leaves them where the run
moved them. Both placements rearm boarding as though the player had been off every platform.
Use a trigger's **switch** marker for a landing's pressure plate. A game's runtime plugin
can draw switches and platforms, including their deck plates, through `LOOKS.switch` and
`LOOKS.platform`; see
[object looks](docs/runtime-plugins.md#object-looks).

### Liquid pools

A liquid pool fills a box with still **lava** or **swamp**, its top the surface. Choose
**Workshop / Level / Lava pool** or **Swamp pool**, then click/tap where the middle of its
surface goes, and set its width, height and depth under Object properties. The liquid never
collides, so fit the box into a basin of terrain, which holds the player where the pool ends.

The liquid acts on the player as a thick liquid would. The pot is held up by the liquid it
displaces, at the centre of what is under the surface, so a tilted pot floats tilted. Every part
of the pot and hammer under the surface is slowed where it moves, so a hammer swept through the
liquid pushes against it and rows the player along. Only the pot floats: a liquid slows the
hammer but does not hold it up. **Physics / Liquids** sets each liquid's
**buoyancy**, the share of the player's weight it holds up with the pot all under the
surface, and its **drag**, the rate it then slows the player at:

- **Lava** holds up more than the player weighs (160% by default), so the pot floats with part
  of it out, and is fairly thick (3/s). It burns the character while the pot is in it: its
  **Lava damage** (1 by default) on touching it, then each second the pot stays, and sets the
  character alight while it does. The hammer does not burn.
- **Swamp** holds up less than the player weighs (85%), so the player sinks through it, and is
  thick (6/s), so it sinks slowly and every move is slow. It does no damage.

The half of a pool behind the obstacle line draws with the course, and the half in front draws
translucent over the actors, so whatever is in the liquid looks in it. Like a decoration in front
of the line, it draws under a 3D character's arms and the hammer, which keep their own depth so
the hands hold the hammer. A game's runtime plugin can draw lava and swamp its own way; see
[object looks](docs/runtime-plugins.md#object-looks). Lava glows and crusts
over as it flows; swamp is murky, with scum near its surface. Enemies and projectiles pass
through liquids untouched. Pools count toward the level's floor: a fall out of the level is
20 m below its lowest terrain, launch zone or pool.

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

Pieces use only the built-in block, ramp, triangle, circle, and hexagon meshes, so
they share the built-in collision shapes and never add custom outlines; a mirrored piece's
ramps share the mirrored ramp. A piece whose objects would exceed the terrain, trigger,
enemy, or label limit is disabled. A drop that would exceed the collision shape limit is
rejected with a notice and leaves the level unchanged. Previews never modify the authored level. Surface snapping uses
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
ordinary selecting never picks them, so scenery cannot get in the way of editing the course.

Dress levels with decorations, not small terrain. Small colliders close together, such
as headstones, fence posts or rubble within about 1.2 m of each other, leave slots that
trap the pot and the hammer head, so keep colliders for the course itself.

Depth reads best with the theme's [perspective camera](docs/projects.md#section-reference):
distant decorations look smaller and drift slowly by, and near ones pass quickly in front.
Fog still applies, so raise the theme's fog end to see the far horizon, and hide the
theme's backdrop mountains if they stand in front of it. Decorations draw in instanced
batches with no physics, and a game-only release includes their code only when its level
places any. The models are placeholders: a [course package](docs/course-artwork.md#decoration-models)
replaces any model, by ID, with your own textured GLB in mesh releases. See the
[decoration guide](docs/decorations.md) for every model, the level format and performance.

### Obstacle line

The physics is 2D and plays out on one plane, the **obstacle line** at z = 0 (`OBSTACLE_LINE` in
`src/obstacle-line.ts`). The camera frames the course on it, the level editor picks on it and
decoration depths are measured from it. Everything that collides is drawn centred on it, so with
the perspective camera each collision outline runs through the middle of what it looks like. Each
terrain object's [mesh](#course-meshes-from-your-own-pipeline) reaches half its depth toward the
camera and half behind, and a GLB mesh's collision is its slice there, through the middle of its
depth; the pot, enemies and phantoms stand on the line. The engine places them there, so no level
can put a collider anywhere else. The collision overlay (**D**)
draws on the line too. The hammer and hands are drawn in front of the chest (see
[arm forward distance](#custom-visuals)), so in perspective the hammer model sits slightly off its
outline while its contacts stay on the line.

Colliders reach toward the camera, so the view draws in passes, each over the last: the course
(terrain, its meshes and the decorations behind the line); then the actors (the characters, phantoms
and enemies); then the decorations on or in front of the line, the half of each swinging axe swung
toward the camera and the liquid in front of whatever is in a pool; then a 3D character's
[arms with the hammer](#custom-visuals), sharing one depth so the hands hold it, with the aim cursor
and line, course labels and the collision overlay drawn over the arms but under the hammer. A
character whose head or arms overlap a collider on screen, such as under a low roof, is never hidden
by it. A decoration in front of the line draws over the body and the other actors but under a 3D
character's arms and the hammer, so keep it clear of the jar, which reaches 0.5 m toward the camera.
Glass (`KHR_materials_transmission`) in a model drawn after the course, such as a pot, an avatar or a
decoration in front of the line, refracts only its own pass and the sky colour, not the course.

Decorations never collide and may sit at any depth. A prop standing on a collider must stand within
that collider's depth, and one behind the path must also keep clear of the pot, which reaches 0.5 m
behind the line. A 1.5 m-deep block leaves only 0.25 m there, so give terrain that carries props
behind the path more depth. Deep terrain also reaches further toward the camera: an 8 m-deep block
comes 4 m in front of the line, which a wide field of view exaggerates.

### Course meshes from your own pipeline

A course is built from meshes, and each brings its collision. The built-in meshes and drawn
shapes are 2.5D extrusions of their outline, `depth` deep and centred on the
[obstacle line](#obstacle-line), and collide as that outline. Make static GLB meshes with any
pipeline you like and import them under **Workshop / Level / Meshes**: each placement is fitted
to its object's width, height and depth, rotates and mirrors with it, and collides as the
simple shape its GLB declares (`extras.collision`: `box`, `ramp`, `triangle`, `circle` or
`hexagon`) or, without one, as its slice: its cross-section through the middle of its depth,
where it meets the obstacle line, traced into outlines that may have holes. The collision is
stored in the level, so physics never loads a GLB, and illusion fades, disappearance and
resets remain per object. A course package can also map decoration model IDs to GLBs,
replacing those placeholders.

The editor never generates meshes. The GLBs are the [project's](docs/projects.md) course
artwork, and **Workshop / Project / Course artwork** chooses whether the Workshop and releases
draw them or every terrain object as its extruded collision. See the
[course meshes guide](docs/course-artwork.md) for the fitting and slicing rules, the level
format, packing, and limits.

### Performance boundaries

The level format supports **1,000 terrain objects**, **128 triggers**, **64 enemies**,
**1,000 decorations**, **32 bonfires**, **128 traps**, **64 liquid pools**, one start, **64 distinct terrain collision shapes**, up to
**64 points per drawn outline**, slices of up to **16 outlines and 256 points**, and **16 course labels**. Each trigger supports up to **8 ordered events**. Dimensions,
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
Traps cost what is active, not what is placed: shooters wait in a schedule ordered by
their next shot, each projectile in flight casts one ray a physics step, and a spatial
index of where blades reach finds only the axes near the player. Axes swing in their
vertex shader, so frames write nothing for them; projectile instances are written only
for those in flight, and bonfires find the player through a spatial index too. Liquid
pools do as well: a step clips only the player's parts in the pools it is near, and the
liquid moves in its shaders, so frames write nothing for pools.
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
profile's **Save**, **Revert**, and JSON controls; **Save to project** writes it into
the open [server project](docs/projects.md#working-in-the-workshop), and **Server character
profiles** shares named [copies](docs/projects.md#server-copies). Profiles use **schema version
18**; profiles in any other version are rejected, not converted.

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
game's, and a **pot model** GLB that follows the physical pot body and hides the body
inside it. Models render with their own PBR materials. All of these are part of the character
profile, so Save, JSON and `GAME_SPRITES` carry them. See [imported 3D characters](docs/characters.md).
Appearance's per-part GLB replacements are separate, browser-local assets that
only a [project](docs/projects.md) carries into a release; imported animation clips
are not played.

Character heads follow the direction from the hammer hinge toward the aim
cursor, without turning the torso or moving the grips. Mesh parts and Avatar share smooth, neck-pivoted 3D gaze;
imported head-part GLBs inherit the same motion. The 3D gaze keeps a slight
camera-facing bias and limits yaw/pitch to avoid unnatural neck turns.
Pausing freezes head motion, and resetting initializes it from the current aim.
Sprite heads use their own 2D artwork and authored directional limits.

The hammer always renders in its own foreground pass, over the body, in every character type; a 3D
character's hands share its depth so they [hold it](#custom-visuals).
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

A 3D character's arms and hands always draw over its own body, jar and head, and hold the hammer. The
camera sees the character from the front, where arms reaching for a hammer held in front of the chest
would otherwise clip into them, so the view draws the body first and then the arms together with the
hammer, sharing one depth of their own: fingers in front of the handle cover it, and the handle
passes in front of the palm and arm behind it, so each hand closes around the grip (seat it with
[hand rotation](#hand-grips)). That covers the mesh-part arms and their Appearance imports, the
built-in avatar's arms, and an imported avatar's arm surfaces: its triangles skinned mostly to the arm
joints or to joints that follow them, such as fingers and twist bones, and any rigid mesh attached
below an arm joint (see [avatar motion](docs/characters.md#motion)). 2D characters keep their authored
layer depths, and their hammer draws over them as before.

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

Imports are **cosmetic only**. They attach to the existing physics and visual-IK
anchors; they do not replace colliders, change mass, or create new rigid bodies.
Use the collision overlay to compare the visual with the actual contact shape.
GLB import does not author colliders or retarget whole-character animations.

### Hand grips

**Workshop / Character / Hand grips and handle** chooses where the hands hold the handle.
Each hand's grip is a distance from the butt, **0.04 m** and **0.22 m** by default, set with
**Left hand grip** and **Right hand grip**; no grip comes nearer than 0.2 m to the head's centre.
**Fixed** hands stay on their grips and travel with the butt, so arms must reach as far as
the handle slides. **Slide along the handle**, the default, starts the hands on their grips, and
they hold on as the handle extends or retracts, riding with it, until a hand would be farther from
its shoulder, ahead of it or behind, than **Slide beyond**, a share of that arm's length (0-100%,
default **85%**). Then the handle slides through both hands together by the least amount that
brings them back within it, and they hold on where they are: reversing the handle carries the hands
with it again until one reaches the slide point on the other side, as in Getting Over It. A hand
that cannot come that close to the handle's line holds the point nearest its shoulder, and when no
shared slide suits both hands they split the difference. The hands never leave the handle or come
within 0.2 m of the head's centre, so near full extension or retraction they may hold beyond the
slide point. Lower slide points keep the hands nearer the shoulders: at 0% each hand heads for the
point nearest its shoulder, and as both rarely can, they split the difference, so the handle slides
through them all the time; at 100% they slide only when an arm would otherwise be stretched straight. The hands go back to their grips when the run
restarts or the grips change.

**Butt-end limit** and **Head-end limit** keep sliding hands on a stretch of the handle, as shares of
the part a hand can hold: 0% is the butt and 100% is 0.2 m short of the head's centre, as near the
head as a hand may come. They are 0% and 100% by default, so the hands may slide along all of it.
Raise the butt-end limit to keep the hands off the butt, or lower the head-end limit to keep them
off the head end. At a limit the hands hold on even past **Slide beyond**, and the arms reach
farther, stretching if the limit is out of their reach. Both hands stay within the limits, so when
they are farther apart than the stretch is long, they straddle its middle. Moving one limit past the
other carries the other along. Fixed hands ignore both, like **Slide beyond**.

Reach is measured in the course plane, as the camera sees it, from the body's shoulders, the
built-in ones or an imported avatar's, with the arm lengths the character draws; a 2D arm chain
that targets `left-grip` or `right-grip` has its own lengths, from the same shoulders where the
example's arm bones start, and a 2D character's hand without such a chain has the built-in arm.
The depth between the body and the handle never counts against the slide point, so it works the
same at any **Arm forward distance**; an arm too short to also reach that depth straightens toward
its grip and stretches its forearm. At 85% the built-in 0.82 m arms never stretch on the default
rig. The placement is continuous in aim and extension: extending the handle by a millimetre moves
no hand more than a millimetre along it. It costs the same every frame. The same section's **Handle
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

Grips are saved as `grips: { "placement", "left", "right", "slideAt", "slideRange", "rotation" }` in the
character profile, with `slideAt` a fraction (0-1), `slideRange` the butt-end and head-end limits as
`{ "from", "to" }` fractions (0-1) and `rotation` each hand's `{ "x", "y", "z" }` in degrees
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
previews the defaults; save a profile afterward to keep the reset. **Save to project**
writes the hints into the open [server project](docs/projects.md#working-in-the-workshop),
and **Server IK profiles** shares named [copies](docs/projects.md#server-copies); loading
one only previews it.

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

The editor entry exposes the read-only `window.gettingOver.snapshot()` and
`window.gettingOver.project({ x, y })` diagnostics for observing actual physics,
motor effort, camera state, and world-to-screen coordinates. `snapshot().rig` is
the rig's geometry: handle length, extension range, reach and segment length.
`snapshot().dying` reports an active death sequence, and `snapshot().death` is
`'health'`, `'fall'` or `null` while alive.
They do not expose commands that bypass the game's input or motor mechanism.
`window.gettingOver.appearance()` reports imported parts, saved/draft alignment,
loading errors, current rendering anchors and world transforms, and the arm IK
settings, selected profile, and save state.
`window.gettingOver.level()` reports the immutable authored definition, current
illusion/collider state, editor selection/mode, set piece placement state, and
render/cache counts, including the imported avatar's joints and bone writes, the
hammer model, the active character profile, the arm chains it draws, and its
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
`window.gettingOver.plugins()` lists the game's [plugins](docs/plugins.md): each one's facets,
whether its [workshop facet](docs/workshop-plugins.md) runs and its last error, and why the
workshop facets do not run while they are invalid.
These globals are absent from the game-only release.

## Contributing

Issues and pull requests are welcome. Include steps to reproduce gameplay
problems, and make sure `npm run build` and `npm run build:game`, which type-check
the editor, the build tools and the game-only release, succeed before submitting
code changes. The project has no test suite.

## License

The project source and included procedural artwork are available under the
[MIT License](LICENSE). Dependencies retain their own licenses. Models imported
through the Workshop are not included in this repository and retain their
original licenses.

This is an independent project, not affiliated with or endorsed by the creators
of Getting Over It.
