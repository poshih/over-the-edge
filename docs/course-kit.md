# Course kit

A generated course is written in code, checked for fairness, and saved as an ordinary level.
[`scripts/course-kit/`](../scripts/course-kit) holds the generic tools behind
[Ashen Ascent](ashen-ascent.md), so a project's own generator imports them instead of
copying them. They are plain Node modules. The set piece library and the level validation
come from the engine through Vite's module loader, as in
[`scripts/ashen-ascent/generate.mjs`](../scripts/ashen-ascent/generate.mjs).

| Module | Contents |
| --- | --- |
| `course.mjs` | `CourseBuilder`, which builds terrain, triggers, messages, updrafts, enemies, labels, decorations and set pieces, and groups them for the checks; `random`, a seeded generator; `outline`, `worldBounds` and `UNIT` for the collision outlines of built-in meshes and drawn shapes |
| `trail.mjs` | `Trail`, a cursor that walks the route and adds floors, steps, stairs and set pieces end to end |
| `pieces.mjs` | `PIECE_PATHS`, how the route enters and leaves each library set piece |
| `checks.mjs` | Overlap, footprint, draft, cramped-collider, reach and trap checks, the reach model and the budget |
| `scenery.mjs` | Depth placement for decorations seen through the theme's perspective camera |
| `map.mjs` | An SVG map of the level, and PNG crops of it for review |

## Building a course

```js
import { CourseBuilder, random } from '../course-kit/course.mjs';
import { Trail } from '../course-kit/trail.mjs';

const library = await server.ssrLoadModule('/src/editor/set-pieces.ts');
const { LEVEL_SCHEMA_VERSION } = await server.ssrLoadModule('/src/level.ts');
const builder = new CourseBuilder(library);
builder.beginZone({ code: 'z1', palette: { rock: 0x5b5f5a, stone: 0x7b7d76 } });
builder.add({ kind: 'start', id: 'start', x: 1, y: 0.65, angle: 0, reach: 1.7 }, 'z1:start');
const trail = new Trail(builder, random(1), 0, 0);
trail.floor(6, { tone: 'stone' });
trail.piece('first-boulder', { tone: 'rock' });
trail.stairs(8, 6, { shapes: ['shelf', 'slab'], tones: ['rock', 'stone'] });
const level = builder.level(LEVEL_SCHEMA_VERSION);
```

- **Zones.** `beginZone` starts a zone: its `code` prefixes every ID built in it, and a
  `tone` such as `'stone'` picks a colour from its `palette`. Terrain is Rock unless given
  another `surface` (`wood`, `metal`, `ice` or `rubber`): in the options of `terrain`,
  `block`, `floor` and `step`, a stairs motif's `surface`, or a piece's `floorSurface` for
  the ground it stands on. A set piece's own parts keep the surfaces it was designed with.
- **The trail.** `floor`, `step` and `stairs` build from the cursor and move it. Stairs stay
  within connector reach, switching back when the run is too short for the rise. `at`,
  `go`, `turn` and `edge` move the cursor without building.
- **Set pieces.** `trail.piece(id, options)` places a library piece so its designed entry
  sits at the cursor, builds the ground its path needs, mirrors it when the trail runs
  left, and moves the cursor to its exit. A piece may be placed any number of times: each
  placement is checked as a piece of its own, and a second placement in the same zone takes
  the IDs `<piece>-<zone>-2-<part>`. Options: `gap` and `lift` offset the piece,
  `floor: false` skips the ground (with `floorTone`, `floorThickness` and `floorDepth` to
  style it), `recolor` or `tone` repaint it, `retune` edits a placed part such as a
  message, and `exit` leaves it by another point.
- **Designed moves.** The reach check is conservative. `builder.link(from, to, why)` adds a
  move it cannot see, such as a fling. `allowIn: '<piece>'` lets a terrain part stand
  inside a piece's bounds, and `support: true` marks ground that may merge with neighbours.

Add a piece to `PIECE_PATHS` when you add it to the library. Coordinates are local to the
placed piece's base centre, for travel toward +x. `entry` and `exit` lie on its surfaces,
on the outer edge when they are at height, so neighbours touch. `floor` is the x-range
that needs ground at the base, or `null`. `mirror` marks a piece that travels toward +x
when mirrored, and `down` marks a descent.

## Checks

Run every check before writing, and fail when any reports a problem:

| Check | Finds |
| --- | --- |
| `overlaps(level, groups, supports)` | Terrain of a set piece overlapping anything built separately; enemies starting inside terrain |
| `keepOut(level, groups, pieces, allowed)` | Anything built outside a piece that reaches into its bounds |
| `ventShafts(level, groups)` | Solid terrain in the column of the course's own updrafts, below their apex |
| `crampedColliders(level, groups)` | Small colliders (`CRAMPED.small`, 1.5 m) closer than `CRAMPED.clearance` (1.2 m), which trap the pot or the hammer head; a piece's own parts are exempt |
| `reachGraph(level, groups, pieces, links, reach, goal)` | Whether the ending is reachable from the start, pieces never reached, and traps: reachable points from which the ending is not |

`budget(level)` counts objects and reports the course's extent. Also validate the level
with the engine's `validateLevel`, and add your project's own rules, such as Ashen Ascent's
rule that every piece appears exactly once. While a course is still being built and has no
ending, `goal` stands in for it.

## The reach model

`reachGraph` and `standPoints` take the reach model explicitly. `ENGINE_DEFAULT_REACH`
matches the engine's default rig and physics, with a margin:

| Field | Default | Meaning |
| --- | ---: | --- |
| `shoulder` | 1.15 m | Height of the hammer's pivot above the pot's base |
| `pull` | 2.35 m | Farthest a lip may be from the shoulder to be pulled over |
| `rise` | 2.5 m | Highest a connector may ask the player to climb in one move |
| `hop` | 1.9 m | Widest gap between surfaces at about the same height |
| `drop` | 9 m | Deepest deliberate drop onto a lower surface |
| `maxStandSlope` | 40° | Steepest face the pot is assumed to rest on |

Pass your own model when your game's physics differ. The pot's grip on a surface is
`sqrt(surfaceFriction * potFriction)`, from the game settings' `rockFriction` (or the
surface's own) and `potFriction`, and it slides on slopes steeper than `atan(grip)`.
With the engine's defaults (rock 3 and jar 0.45) that is about 49°. A game with rock
friction 0.8 and jar friction 0.45 slides above about 31°, so it passes a `maxStandSlope` a
few degrees lower, such as `{ ...ENGINE_DEFAULT_REACH, maxStandSlope: 28 }`. A longer or
shorter hammer changes `pull` and `rise`. Every field must be a finite positive number and
`maxStandSlope` must be below 90°; anything else throws `ReachModelError`.

The check trusts the library inside a piece's bounds, so a low-friction game should also
choose pieces that suit its grip. The library keeps the surfaces the pot must rest on at 30°
or flatter unless sliding is the point, except for a few older pieces that expect more grip:
the hut roof, the house roof in Grill, umbrella and house, the friction slab, the tilted slab
and the scree slope.

## Scenery

`sceneryHelpers(theme.camera)` returns helpers for placing decorations by depth through a
perspective camera. It throws `SceneryCameraError` for the orthographic camera, whose view
does not shrink distant decorations. The camera frames the engine's course view height,
read from [`src/view-frame.json`](../src/view-frame.json), on the
[obstacle line](../README.md#obstacle-line) at z = 0.

Every collider the builder makes is drawn centred on that line, reaching half its depth behind
it. A prop placed to stand on the course therefore needs a depth within that half: behind the
path, between `-depth / 2` of the terrain it stands on and -0.5 m, where the pot ends. Give
terrain that carries such props enough depth; a 1.5 m-deep piece leaves only 0.25 m.

- `far(builder, model, from, [dx, dy], z, size)` places a model so that it appears `dx`, `dy`
  from the centre of the view, `size` tall, while the camera looks at `from`. It barely
  drifts from there as the player climbs.
- `landmark(builder, model, x, dx, z, size)` does the same for a model standing on the
  valley floor.
- `shelves(builder, left, right, top, z, height, tint)` lays rock shelves side by side, their
  tops level with `top`, as ground for background scenery.
- `row(builder, model, from, to, y, z, height, step)` lines up models, alternating mirror
  and leaning a little.
- `depthScale(z)` is how much larger a decoration at depth `z` must be than it looks,
  measured on the course plane.

## Map

`courseMap(level, { sky, scale, zones, reach })` draws the level as SVG: terrain in its own
colours (illusions dashed), updrafts with their lift, messages, the ending, enemies and
labels. `sky` gives the background's three colours, from the bottom of the map to the top.
`zones` marks zone boundaries, and `reach` overlays the reach check's stand points. To
review a course without the game, `renderCrops(map, crops, directory)` renders crops of the
map to PNG files with Playwright. If Chromium is not installed for Playwright, install it with
`npx playwright install chromium`.
