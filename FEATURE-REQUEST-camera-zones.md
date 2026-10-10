# Feature request: camera zones

**Date:** 2026-10-10 · **Baseline:** `1164f66` · **Status:** Proposed; not implemented. Prerequisite of
[FEATURE-REQUEST-crow-boss.md](FEATURE-REQUEST-crow-boss.md).

The default camera director (`src/camera-director.ts`) frames a fixed 8.5 m of height on a desktop
(`src/view-frame.json`), or the rig's reach on a compact screen, wherever the player is. A level cannot ask
for more room in one place. Only a runtime plugin can, by replacing `CAMERA` entirely, and even then it has no
level data to go by. Large encounters such as a boss several metres across that attacks from above, open vistas
and long falls all need more of the course in view, but only in their own areas.

**In short:** add a **camera zone** level object: a rectangle with a **zoom** (camera distance ×1 to ×2) and
an optional **keep view inside** bound. The default director eases into a zone's zoom and bound. Every director
receives the active zone through `CameraView`. Mouse gain stops following the zoom, so a zone never changes how
the hammer handles.

## Options considered

| Option | For | Against |
| --- | --- | --- |
| **Zoom areas**, as asked: a region sets the camera distance and the camera keeps following the player | Simple and predictable; covers vistas | The view still drifts. A boss rising or flanking leaves the frame, and the arena's edges come and go as the player moves |
| **A trigger event that sets the zoom**: entering a trigger's region changes the zoom until another trigger changes it back | Reuses triggers and their events; one-off moments are easy | The zoom depends on the route taken, not on where the player is. A fall can carry the player past or around the trigger that should reset it, every way in (falling in from above included) needs a pair of triggers, and respawns and saved runs would have to restore the zoom |
| **Dynamic framing**: the director fits the player and the boss together | The threat is always in view | The zoom changes all the time as the boss flies, so the pot and hammer keep changing size on screen. That hurts a precision game and is uncomfortable to watch. It also ties the camera to one enemy |
| **Arena bounds**: the view stays inside a room's rectangle, holding still once the zoom shows it all | Stable, readable framing of the whole arena; the standard boss-room camera | Needs a zoom to fit the room, and the camera must still follow the player in rooms larger than the view |
| **Recommended: zones with zoom and optional bounds** | One object covers vistas (zoom only) and arenas (zoom plus bounds); data that any director can read | Authors size zones by hand. The Workshop previews the framing, and the boss's **Frame arena** fits one |

The literal request also misses three things that would make a zoom area feel wrong. The design adds them:

1. **Handling stays the same.** `pointerDelta` (`src/view.ts:527`) turns mouse pixels into metres using
   `worldHeight / height`, so a ×1.8 zone would make every swing 1.8 times larger. Muscle memory is
   in world metres. Mouse gain therefore follows the un-zoomed framing: the cursor moves less on screen, but the
   hammer moves the same. Touch gain is already independent of zoom.
2. **Smooth, stable transitions.** Zoom eases over about a second with no overshoot, and leaving a zone takes
   1 m of margin, so a player teetering on its edge never sees the zoom go back and forth. Placements snap.
3. **Bounded zoom.** ×2 at most: a 16:9 view about 17 m by 30 m, where the pot is still legible. Enemies wake
   within 18 m of the player (`ENEMY_BEHAVIOR.wakeDistance`). Until then they are drawn standing still, and a
   wide view can show some that are farther away. Zooming in (below ×1) has no use case yet and would hide the
   rig in compact framing, so it is out of scope.

## Stage 1: zones in play

1. **Level data.** Add a new kind, `CameraZoneObject`, to `LevelObject` in `src/level.ts`:
   `{ kind: 'camera', id, x, y, width, height, zoom, bounded }`. `(x, y)` is the rectangle's centre, as for
   pools. Its limits, `CAMERA_ZONE_LIMITS`, are 64 zones, sides of 4 m to `LEVEL_LIMITS.maximumSize`, and a zoom
   from 1 to 2 in steps of 0.05. Validation follows the other kinds (`LevelError`, `OBJECT_KINDS` text). Bump
   `LEVEL_SCHEMA_VERSION` (12 at the baseline) and regenerate the generated levels. `src/phantom-course.ts` adds
   `case 'camera': break;`: framing does not shape play, which holds only because of item 5.
2. **Active zone.** The view picks it each frame from the pot's root (the director's `focus`):
   - The smallest zone containing the root becomes active, or the later object if two are the same size. An inner
     zone therefore takes over from the zone around it.
   - The active zone stays active until the root is more than 1 m outside it, unless a smaller zone takes over.
   - When the level is set, the view builds a static grid of 8 m cells listing the zones that overlap each cell.
     Each frame it tests only the zones of the root's cell, usually none or one.
   - A level without zones does no per-frame work.
   - Death keeps the zone it started in.
3. **Director contract** (`src/camera-director.ts`, exported from the runtime SDK):
   - `CameraView.zone: CameraZone | null`, a reused, read-only
     `{ id, zoom, bounded, minX, minY, maxX, maxY }` for the active zone.
   - `CameraAim.controlHeight`, a finite, positive height that every director writes, as with `worldHeight`. It is
     the framing mouse gain is measured against, and `checkCameraAim` validates it.
   - The default `FollowCamera`:
     - Its full or compact height stays the base. It writes the base as `controlHeight` and the base times the
       eased zoom as `worldHeight`.
     - The zoom eases on a log scale at 2.5/s. `snap` applies it at once.
     - `cameraLead`, `cameraLift` and `cameraMinimumY` scale with the zoom, so the pot keeps its place on
       screen and the ground below y = 0 shows in the same proportion.
     - **Bounded:** the director clamps its target so the view stays inside the zone, or centres it on the zone along
       any axis where the view is larger, then eases toward it as now. The bound gives way to the player. The target
       never puts the pot within 1.5 m of the view's edge, and in compact framing the keep-the-rig-visible clamp
       still runs last. So once the camera settles, the view shows nothing outside the zone while the pot is at
       least 1.5 m inside it. It shows past the edge only while easing in, or when the pot is nearer the edge.
     - In compact framing the base is fitted to the rig's reach, and a zone multiplies it. On a portrait phone with
       the default rig, ×2 shows about 12.6 m × 22.4 m.
     - Death framing holds as now. `inspect()` reports `{ compact, zone, zoom }`.
   - While the Workshop's `setFraming` overrides the camera, `controlHeight` is the framing's `worldHeight`, as
     mouse gain is today.
4. **Live edits.** Any change to a zone (`LevelChange` reset, upsert or remove) rebuilds the grid, which holds at
   most 64 zones, and picks the active zone again. The camera eases to the new framing, and a removed active zone
   eases out as if the player had left it.
5. **Input.** `pointerDelta` uses `controlHeight / height`. In `docs/runtime-plugins.md`, rewrite **Input
   coupling** (camera section): mouse gain follows `controlHeight`, and a director that wants zoom to change
   handling writes `controlHeight = worldHeight`.
6. **Performance.** No zones means no cost. With zones, each frame tests only the zones in the root's cell. Fog,
   near and far already update with the camera distance (`updateFrustum`), and recompute only while the zoom eases.
   A ×2 view shows four times the area, so check draw calls and triangles in the rendering diagnostics on the
   largest generated levels at ×2.
7. **Docs.** Add a README **Camera zones** section under **Level editing**, beside **Liquid pools**, covering
   the fields, limits, selection rules and the handling guarantee. Add the `CameraView`/`CameraAim` additions and
   the default's zone behaviour to `docs/runtime-plugins.md#camera-director`, with an example director that reads
   `view.zone`.

## Stage 2: authoring

1. **Camera zone tool** in the level editor's palette. Click to place a 30 m × 17 m zone, which is ×2 at
   16:9, then drag its handles to resize it as with box triggers.
   - The inspector has **Zoom** (×1 to ×2, step 0.05) and **Keep view inside**.
   - Edits are Workshop History commands, like every other level object (`src/editor/document`).
2. **Overlay.** A dashed outline with its zoom ("Camera ×1.6"). While a zone is selected, a translucent frame
   shows what play would show at 16:9 desktop framing, centred at the zone's centre, or clamped as play would
   clamp it when the zone is bounded. The overlay is editor-only, and the editor's own camera (`setFraming`)
   ignores zones.
3. Play-tests, studio previews and releases use zones through the runtime alone. No editor code reaches a release.

## Acceptance

- A level without zones frames exactly as at the baseline, frame for frame.
- Entering a ×1.6 zone eases out in about a second with no overshoot. Standing on its edge never makes the zoom
  go back and forth. Respawning inside a zone starts zoomed.
- In a bounded zone larger than the view, once the camera has settled, nothing outside the zone shows while the pot
  is at least 1.5 m inside it. A zone smaller than the view is centred. The pot is never pushed off screen, and in
  compact framing neither is the rig.
- Moving, resizing or deleting the active zone in the Workshop eases the camera to the new framing without a jump.
- The hammer moves the same metres per mouse pixel in and out of zones. Phantom course hashes do not change when
  zones are added.
- A level without zones does no per-frame zone work.
- Validation, per the project's practice: type-checking (`npm run build`), code review, and a Workshop
  play-test at 16:9 desktop and on a portrait phone.

## Out of scope

- Zooming in, rotation, scripted pans and cut-scenes, and framing that follows an enemy. A game can still do all of
  these with its own director, which now receives zone data.
- Depth-placed course-kit scenery (`scripts/course-kit/scenery.ts:33`) is composed for the default framing. Inside a
  zone it appears smaller and nearer the centre, so authors should check the scenery that shows in their zones.

## Context

A downstream game is adding a large flying boss whose attacks come from well above and beside the player. At the
default framing they start off screen. Camera zones give its arena room without changing the rest of the course.
