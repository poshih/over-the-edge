# Skyward Ruins

An original, full-length first-pass course for Over the Edge. Climb from
ground level to a **600 m summit** through eight districts. The ground spans
**128 m**, with terrain bounds X -64 to 64 and Y -2 to 600.

The height is a chosen engine-space design target, **not a verified
metre-for-metre measurement of Getting Over It with Bennett Foddy**. The layout,
title movie, and enemy artwork are original. Difficulty tuning is an initial
baseline, not a final balance claim.

## Load or release

Run `npm run dev`, open **Workshop / Level**, and import
[`levels/skyward-ruins.json`](../levels/skyward-ruins.json). Save a named level
snapshot to retain it in that browser. Playtest starts at the authored start.
Importing this course does not replace the built-in demo.

For the editor-free game:

```sh
GAME_LEVEL=levels/skyward-ruins.json npm run dev:game
```

To build the release into `dist-game/` and preview it locally:

```sh
GAME_LEVEL=levels/skyward-ruins.json npm run build:game
npm run preview:game
```

Then deploy `dist-game/` with `wrangler.game.toml`, as described in the README's
[game-only release](../README.md#game-only-release) section. The game HUD
remains limited to current height and elapsed time; Workshop controls are not
part of that release.

The opening event references **`/media/skyward-ruins-intro.webm`**. The silent,
approximately 3.4-second VP8 title movie is stored at
[`public/media/skyward-ruins-intro.webm`](../public/media/skyward-ruins-intro.webm)
and copied into both `dist/` and `dist-game/`, so every deployment of this
project serves it, whatever domain is attached. Importing the JSON does not embed
the video: a different project that loads this level must serve the file at the
same path, or deliberately update the event URL. Browsers that block autoplay
present a **Play video** button.

## Recommended object allocation

These are percentages of **placed objects**, not occupied area or play time.
They describe the delivered 384-object course. Categories are mutually
exclusive: updrafts are triggers internally but are not counted again under
other events.

| Object category | Count | Share |
| --- | ---: | ---: |
| Permanent terrain | 288 | 75.00% |
| Illusion terrain | 32 | 8.33% |
| Updrafts | 24 | 6.25% |
| Birds | 16 | 4.17% |
| Hollow soldiers | 16 | 4.17% |
| Intro, chapter, and ending triggers | 7 | 1.82% |
| Start location | 1 | 0.26% |
| **Total** | **384** | **100.00%** |

Keep roughly three quarters of objects as reliable terrain so hammer movement,
not combat or automatic launches, remains the main activity. Optional illusions
offer risky extra footholds. Updrafts change the pace without replacing the
climb, and sparse enemies interrupt particular maneuvers rather than filling
every landing.

The 288 permanent objects comprise 264 main-route supports, including the
ground, and 24 wind pedestals. Each district has four optional illusion
footholds, three updrafts, two birds, and two soldiers.

## Districts

| District | Elevation | Main terrain and pacing |
| --- | --- | --- |
| Foundry Steps | 0-75 m | Low opening steps, boxes, and broad staging ledges |
| Tilted Quarry | 75-150 m | Inclined surfaces between stable landings |
| Bell Spires | 150-225 m | Rounded supports that favor careful hammer placement |
| The Unraveling | 225-300 m | Clipped masonry crowns and optional fragile footholds |
| Wind Galleries | 300-375 m | Hexagonal supports and the longest wind shortcuts |
| Watchkeepers | 375-450 m | Box ledges with guards on broad patrol platforms |
| Prism Teeth | 450-525 m | Concave notches and triangular supports |
| Quiet Crown | 525-600 m | Hexagonal final climb and a broad summit roof |

The [full-height map](skyward-ruins-map.svg) is generated from the course geometry.
It shows the permanent route, illusion footholds, wind shafts, enemies, events,
and 75 m district boundaries. Dark plaques on the route identify each district.

## Mechanics and event lifecycle

There is **one movable start**, no checkpoints, and a continuous climb. Broad
landings can catch falls but do not save progress. Reset returns to the start,
restores illusions and enemies, and rearms events.

Permanent terrain includes boxes, ramps, circles, hexagons, triangles, and two
reused custom polygon shapes. Illusions are optional: their disappearance does
not remove the permanent route. They start fading only after a supporting pot
landing, not after a hammer strike.

Updrafts launch on entry and can be used again after leaving and re-entering.
Nominal lift ranges from **6.5 to 11.5 m**, with **1x strength** throughout this
course. Most lead two rungs higher; Wind Galleries shafts lead four rungs higher.
Move toward the adjacent landing before falling back down the shaft. Height and
strength remain independently editable on each `launch-player` event.

Birds patrol, warn, and dive; one solid hammer-head strike defeats them.
Hollow soldiers patrol broad platforms and require two separated strikes.
Body contact causes knockback, not health damage. Kills persist until reset;
editing and exporting retain the authored enemy homes.

The once-only opening trigger plays the fullscreen title movie, then displays
the course briefing. Five once-only chapter popups mark selected transitions.
The summit trigger stops the run timer and displays **Above the weather**.
Dismissal does not restart the timer or replay the finish event. Media and popup
presentation pause gameplay, so reading the briefing or watching the movie does
not add to the run time.

## Authoring budget

The course uses **320 terrain objects**, **31 triggers**, **32 enemies**, one
start, **7 terrain geometry templates**, and **9 labels**. Box counts include
thin platforms and broad landings; those do not require separate templates.
Enemies share their sprite atlas and draw batch, and only nearby enemies run
physics and AI.

`levels/skyward-ruins.json` is the authoritative editable level. This course
does not add per-surface friction, checkpoints, or new enemy behaviors.
It uses the existing schema and runtime. The Workshop's
[drawing tool](../README.md#drawing-terrain) can add further custom terrain.
