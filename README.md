# Over the Edge

An original browser-based physics climbing playground, inspired by the
two-motor mechanism described by Getting Over It's creator. The first version
has a small climb, dedicated practice positions, procedural 3D artwork, and a
live tuning workshop. It is not a port of the original game's assets or code.

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

The preview uses **http://localhost:4174**. Deploy `dist/` to any static host,
including Cloudflare Pages. There is no backend, account, external asset
download, or runtime network service needed by the built-in course. Authored
video events fetch the media URLs included in their level.

The included `wrangler.toml` is an optional Cloudflare Workers configuration.
Use your own Cloudflare account and configure any custom domains there.

### Game-only release

The playable release has a separate HTML/TypeScript entry and stylesheet. It
does not load the Workshop, level editor, model importer, saved editor profiles,
practice shortcuts, collision overlay, or editor diagnostic globals.
Its HUD contains only current height and elapsed time. On-screen Play/Pause/Reset,
peak height, branding, and help remain in the editor build, not the release.

```sh
npm run build:game
npm run preview:game
```

Publish **`dist-game/`** for a game-only release; preview it at
**http://localhost:4175**. `npm run dev:game` uses **http://localhost:5182**.
The existing `npm run build` and `wrangler.toml` continue to target the
editor/workshop in `dist/`, not this separate release.

Set **`GAME_TITLE`** to publish under your own game name:

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
`GAME_LEVEL`, `GAME_SETTINGS`, and `GAME_SPRITES`. The setting changes display
titles, not repository names, browser storage keys, or deployment identifiers.

For Cloudflare Workers, `wrangler.game.toml` deploys only `dist-game/` to a
separate **gettingover-play** Worker:

```sh
npm run build:game
npx wrangler deploy --config wrangler.game.toml --keep-vars
```

Configure a separate custom domain for that Worker in your Cloudflare account.
This leaves the existing Workshop Worker and its domain unchanged.

To release an authored course, export its JSON from the Level tab, place that
file inside the project (for example `levels/my-level.json`), then build:

```sh
GAME_LEVEL=levels/my-level.json npm run build:game
```

Without `GAME_LEVEL`, the build uses the built-in course. The selected data is
validated and bundled at build time; the game needs no editor or external level
service. Level exports do not contain gameplay settings, sprite layouts,
private imported GLBs, or IK profiles.

To publish your physics and cursor behavior, export a game-settings profile
from **Workshop / Physics**, put it inside the project, and select it with
`GAME_SETTINGS`:

```sh
GAME_SETTINGS=profiles/my-game.json npm run dev:game
GAME_SETTINGS=profiles/my-game.json npm run build:game
# Combine it with your level; GAME_SPRITES remains an independent input:
GAME_LEVEL=levels/my-level.json GAME_SETTINGS=profiles/my-game.json npm run build:game
```

Omitting `GAME_SETTINGS` uses the built-in game settings, with a **2.65 m**
target radius around the shoulder hinge (the hammer's full reach). A supplied profile is validated and embedded in the game; an invalid,
missing, oversized, or outside-project file fails rather than reverting to
defaults. Development reloads when the selected file changes. Browser-local
saves do not change a release unless you export and select one.

`src/editor/` owns all authoring UI, persistence, imports, and debugging tools.
The editor depends on the shared game runtime, never the reverse.
`tsconfig.game.json` checks the playable dependency graph separately, and
`vite.game.config.ts` fails the build if an editor module or editor asset enters
that graph. Hiding editor controls with a runtime flag is not the release
boundary.

`npm run verify:game` exercises the release, custom-course/sprite/settings builds,
development entry, and editor-dependency rejection in isolation.

### Included full-length course

**Skyward Ruins** is an original 600 m climb through eight districts, with
384 placed objects: permanent and illusion terrain, updrafts, birds, hollow
soldiers, an opening video, chapter events, and a timer-stopping summit.
The 600 m height is a design target, not a verified measurement of another game.

Import [`levels/skyward-ruins.json`](levels/skyward-ruins.json) in
**Workshop / Level**, or select it for an editor-free release:

```sh
GAME_LEVEL=levels/skyward-ruins.json npm run dev:game
# Or build the same course for hosting:
GAME_LEVEL=levels/skyward-ruins.json npm run build:game
```

The default demo remains unchanged. See the [course guide](docs/skyward-ruins.md)
for the object allocation, district progression, and media requirements, or
open the [full-height map](docs/skyward-ruins-map.svg).

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

Touch gain is independent of camera zoom and orientation: at the default
**Control sensitivity**, 100 CSS pixels move the world-space target **2.65 m**.
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

Mouse or touch movement updates the white circle's offset from the shoulder
hinge the hammer pivots on, limited to a configurable radius. Without input,
that offset stays unchanged: walking, falling, or being launched carries the
target with the character. It does not rotate with the pot, follow the hammer,
or drift back to the hinge. Camera movement does not modify the offset.

Motion beyond the circle is discarded, so reversing input responds immediately
without unwinding accumulated movement. Starting or resetting an attempt aims
toward the initial hammer position, clamped inside the chosen radius.

As in Getting Over It, the target and the head's **2.65 m** mechanical reach
share the hinge as their origin, and the default radius is that full reach, so
every reachable point can be targeted in every direction. A smaller radius
limits how far input can extend the hammer; it never lengthens the tool. The
head still cannot pass through solid terrain, and contact can transfer motor
effort to the player. There is no return-to-hammer behavior.

The slider can retract the head all the way to the hinge, so there is no
unreachable inner ring. The hinge's own orientation defines aim even at zero
reach; aiming does not normalize a zero-length hinge-to-head vector.

Motor velocity targets come from angular and axial errors with measured joint
velocity damping, speed caps, and independent force/torque limits. All angular
quantities use radians. Collision visualization uses the authored physics
geometry and fixture filters, so it does not draw the non-colliding shaft as a
terrain collider.

## Game settings

The workshop applies parameters to the existing mechanism without restarting.
Its first section, **Mass & recoil**, groups head mass, player mass and rotation
speed with sliders for total shaft mass, hinge carrier mass and slider carriage
mass. Shaft mass is divided equally among the three handle segments; guide-body
inertia scales with mass. The new defaults preserve the original 0.66 kg shaft
and 0.5 kg per guide body. All masses stay positive.

The other sections include motor strength and speed limits, response gains, damping,
contact friction, handle compliance, and control sensitivity.
Zero handle frequency means rigid weld constraints; positive frequency enables
rotational spring compliance.

Ground and every obstacle share a **3.0** rough-rock friction coefficient.
The hammer defaults to **2.5**. Planck mixes the two as `sqrt(3.0 * 2.5)`,
giving a contact coefficient of about **2.74**. This is ordinary contact
friction, not a sticky constraint: the head must still press against a surface
to hold. The pot's own friction coefficient remains **0.45**.

The **Cursor target** section has a **Maximum target radius** slider:
**0.25-2.65 m** around the shoulder hinge, default **2.65 m** (the full reach).
Profiles saved with a larger radius load capped at 2.65 m. Reducing the radius
immediately clamps an out-of-range target, including while paused; increasing
it preserves the current offset. Changing it does not restart the attempt, alter
body masses, or change the rig's forces, mechanical reach, or collision rules.

In **Workshop / Physics**, enter a **Game settings name** and choose
**Save game settings** (or press Enter). Each save creates a separate timestamped
profile containing every physics setting and the target radius.
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
uploaded. New saves use **game-settings v2**, with a cursor document containing
only `maxRadius`. Previous game-settings v1 profiles and tuning v1-v4 records
remain loadable, labeled **(physics only)**. They preserve their physics values
and use the default target radius; retired return/settling settings are never
reactivated. Importing or building with a valid v1 settings document performs
the same conversion. Invalid older documents are rejected, not silently repaired.

The previous single-slot v2 save appears as **Previous saved tuning (v2)**.
If v2 is absent, a v1 save is available instead, with its original fixed tool
masses supplied when loaded. Loading never rewrites legacy records;
saving loaded settings under a name creates a new game-settings profile. An invalid v2
record never causes v1 to be loaded instead. Unreadable saves are marked and
retained, while other valid snapshots remain available. Older releases can
still read their original records and ignore the separate v2 game-settings keys.

Profiles contain gameplay configuration, not saved body trajectories, levels,
or character artwork. Height and peak readouts describe the current attempt.

Saved profiles preserve their stored hammer friction. **Defaults** restores
all built-in physics and cursor settings without changing saved profiles.

The practice positions make the important behaviors easy to revisit: resting
on a ledge, smooth ground pushes, launches, and vaulting a low block. The
controller and artwork are a prototype, not a claim of matching the original
game's exact tuning.

## Level editing

Open **Workshop / Level** to edit the course. Editing pauses gameplay and
separates placement gestures from hammer input. Choose a block, thin platform,
ramp, triangle, circle, or hexagon, then click/tap the game preview to place it.
Select an object to move it or adjust its position, dimensions, rotation, and
illusion property. Dragging previews the change; releasing commits it.
Pan and zoom let you work beyond the player's current camera view.

The start location and trigger zones are map objects, not special summit
settings. Place or drag **Start location** to choose the spawn and adjust its
initial hammer pose. Each level has one start. Playtest from that position,
and use Reset to repeat the course. Runtime effects never delete objects from
the editor's authored definition.

Named level saves use the existing snapshot-history mechanism: repeated names
keep separate versions, choosing an entry does not apply it, and loading is
explicit. Export/import JSON to move level data between browsers or feed the
game-only build. Imports are validated before replacing the current level;
malformed files and unavailable storage produce visible errors.

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
ordered **Stop timer**, then **Popup** event list. Move it, change its region,
or edit its events like any other trigger. Place a trigger around the start
to play an intro or show instructions.

Supported events:

| Event | Behavior |
| --- | --- |
| Popup | Shows a plain-text title and message until Continue; Escape skips it |
| Play video | Plays a public video URL or site-relative media path in a full-window overlay |
| Stop timer | Freezes the run timer without stopping physics or illusion effects |
| Launch player | Applies a mass-aware upward impulse with configurable lift height and strength |

Events execute in their authored order. Only one presentation runs at a time;
simultaneous triggers queue deterministically. Popup/video presentation pauses
gameplay and suspends hammer input until it closes. Skipping a presentation
continues its remaining events. Failures are reported, not silently retried.
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

Level JSON uses **schema version 2**, with typed terrain, start, trigger and enemy
objects. Existing version 2 levels without enemies remain valid. Version 1
imports and saved snapshots are normalized at the boundary:
terrain and labels are retained, spawn becomes a start object, and the old summit
becomes an ending zone above its original arrival line. That zone extends two
maximum hammer reaches upward and is editable. Original files and snapshots
are not rewritten. Saving/exporting produces version 2; old game versions
cannot read new enemy kinds or trigger actions/markers, but their original version 1 saves remain
available for rollback.

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

Up to **64 enemies** share one sprite draw batch with original sprite artwork;
the palette and editor guides use original SVG glyphs. Only nearby enemies allocate
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

### Performance boundaries

The level format supports **1,000 terrain objects**, **128 triggers**, **64 enemies**, one start,
**32 distinct terrain geometry templates**, up to **64 vertices per custom polygon**,
and **16 course labels**. Each trigger supports up to **8 ordered events**. Dimensions,
coordinates, winding, intersections, IDs, and import size are validated.
Preset objects reuse normalized geometry rather than allocating a new mesh and
material for every placement.

Terrain changes are incremental. Moving an object does not reconstruct the
whole physics world; static terrain is not regenerated each frame. Illusion
processing visits active landings/fades instead of polling every level object.
Shared batched rendering and cached materials keep draw calls tied to visible
geometry batches rather than the number of placed objects.
Trigger proximity uses a spatial index rather than scanning the level every
physics tick. Flag markers share instanced geometry, and their buffers update
only when marker positions change. Runtime event state is separate from authored
objects and remains available in editor diagnostics.

These performance and editor-free release requirements are recorded in
[`AGENTS.md`](AGENTS.md).

## Custom visuals

Open **Workshop / Character** to choose the character's presentation. The
default is **Mesh parts (3D)**: separate Three.js objects for the torso, head,
and arm segments, driven by visual arm IK.
All character types use the same Planck.js 2D physics and physical grip targets.

| Character type | What is rendered |
| --- | --- |
| Mesh parts (3D) | Separate articulated meshes, with optional per-part GLB replacements from Appearance |
| 2D sprite character | PNG cutouts or a custom 2D bone/weighted rig; all 3D character underlays are hidden |
| Avatar (3D, connected body) | One connected, GPU-skinned upper body containing the torso, head, arms and hands; pot and hammer remain separate |

The choice is stored as `characterRiggingType` in the character/sprite profile.
Changing it retains the other artwork, but does not silently save it. Use the
profile's **Save**, **Revert**, and JSON controls. Hybrid is no longer a
character type. Older Hybrid layouts with sprite artwork migrate to pure 2D;
those without artwork use Mesh parts. Incomplete sprite layouts no longer
reveal 3D parts behind missing artwork. Original saved records are retained
until Save.

Choose **Use built-in Avatar** for an original skinned character, included
under this project's MIT license. Its shoulder, elbow and wrist weights bend
the connected surface instead of moving disconnected rigid pieces. The same
physical grip targets drive its hands; the pot is not part of the skin.
The avatar is constructed once and reused, with bone updates only while active.
GLB replacements remain separate, browser-local Appearance assets; arbitrary
whole-avatar GLB import and animation retargeting are not supported.

Character heads follow the direction from the hammer hinge toward the aim
cursor, without turning the torso or moving the grips. Mesh parts and Avatar share smooth, neck-pivoted 3D gaze;
imported head-part GLBs inherit the same motion. The 3D gaze keeps a slight
camera-facing bias and limits yaw/pitch to avoid unnatural neck turns.
Pausing freezes head motion, and resetting initializes it from the current aim.
Sprite heads use their own 2D artwork and authored directional limits.

The hammer always renders in the foreground in every character type.
Its shared 3D grip plane sits in front of the chest, so mesh-part and avatar
arms reach forward to hold it instead of intersecting a behind-the-body tool.
Tune **Workshop / Character / Arm forward distance** from **0-1 m** in
**0.01 m** steps; the default remains **0.25 m**. It moves both hands and the
hammer together in the two 3D modes. The value is part of the character profile:
Save, Revert and JSON export/import preserve it, including game-only releases.
Pure 2D rendering retains its authored depths and keeps this 3D setting dormant.
The pot keeps its own depth. This affects only presentation, not hammer length,
aim, contacts, or physics. Imported models and all hammer sprite bindings use
the same foreground pass.

For a complete starting point, choose **Load complete 2D example** in Character.
**Paper Climber** supplies original PNG artwork for the body, pot, arms, hands,
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
Older sprite layouts keep their fixed-sector behavior until opted in.

Open **Workshop / Appearance**, choose a **Body part**, and select a **GLB model**.
Parts can be replaced independently: pot, torso/neck, character head, each upper
arm, forearm, elbow and hand, the full hammer shaft, and the hammer head. Parts
without an import keep their procedural visual in Mesh parts mode. In Avatar
mode, body-part imports remain stored but hidden; pot and hammer imports still
apply. Invisible physics guide bodies do not need models.

Imports are **cosmetic only**. They attach to the existing physics and visual-IK
anchors; they do not replace colliders, change mass, or create new rigid bodies.
Use the collision overlay to compare the visual with the actual contact shape.
GLB import does not author colliders or retarget whole-character animations.

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

Shoulders use the torso's transform. Both hands use fixed-distance grip offsets
in the physical slider-to-head frame, including its depth. Procedural segments,
straight replacements, GLB models, and tiled sprites share these same targets;
artwork never changes hammer length or hand placement. The preview
works with procedural and imported arm parts. Model alignment remains cosmetic;
it does not redefine skeleton anchors. These controls do not change colliders,
mass, reach limits, or motor tuning. **D** / **Toggle collision overlay** also
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
endpoints. The underlying three-segment shaft and its mass/compliance remain in
the physics simulation.

Files are saved locally in IndexedDB when imported, and saved appearances restore
on reload. Nothing is uploaded to the server. This storage belongs to the current
browser and site address; it is separate from physics presets and is not bundled
into `dist/` or shared with other players. Original files on your computer are
never modified.

## Runtime inspection

```sh
npm run verify
```

This builds both entries and exercises browser gameplay with Playwright. If Chromium
is not installed for Playwright, install it with `npx playwright install chromium`
and rerun. Runtime artifacts are written to the ignored `artifacts/` directory.
There is no unit-test suite.

The editor entry exposes the read-only `window.gettingOver.snapshot()` and
`window.gettingOver.project({ x, y })` diagnostics for observing actual physics,
motor effort, camera state, and world-to-screen coordinates. They do not expose
commands that bypass the game's input or motor mechanism.
`window.gettingOver.appearance()` reports imported parts, saved/draft alignment,
loading errors, current rendering anchors and world transforms, and the arm IK
settings, selected profile, and save state.
`window.gettingOver.level()` reports the immutable authored definition, current
illusion/collider state, editor selection/mode, and render/cache counts.
`window.gettingOver.events()` reports trigger/action lifecycles, presentation
state, and the independent run timer. Restart resets the attempt; physics time
continues to be available separately as `snapshot().time`.
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
