# Depth and parallax

Scenery looks far away when several cues agree: it drifts by slower than the course
(**parallax**), it looks smaller, it fades into haze, it loses focus, contrast and detail,
and nearer things overlap it. The engine gives you each cue through the theme and through
[decorations](decorations.md), which never collide and can stand anywhere from 1,000 m behind
the [obstacle line](../README.md#obstacle-line) to 15 m in front of it. This guide shows how
to combine them.

## Turn on the perspective camera

Parallax needs the perspective camera. In **Workshop / Project / Theme**, turn on
**Perspective camera**. The course on the obstacle line keeps the same size; everything
behind it moves slower and looks smaller the farther back it stands, and everything in
front moves faster and looks larger.

The default orthographic camera is flat: depth only decides what stands in front of what,
so a decoration 40 m back scrolls by exactly as fast as the course. Only the theme's
backdrop mountains drift slower, by a fixed share (see [the backdrop](#the-backdrop)).

How much slower depends on the depth and on the theme's **Field of view** (10-90°,
default 30°). The camera stands `d = (view height / 2) / tan(field of view / 2)` in front
of the course, and something `depth` metres behind it moves `d / (d + depth)` times as fast
as the course and looks that many times its size on the course. With the default 8.5 m view
height:

| Field of view | Camera distance | 5 m back | 15 m | 40 m | 100 m | 300 m | 1,000 m |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 30° | 15.9 m | 76% | 51% | 28% | 14% | 5% | 2% |
| 50° | 9.1 m | 65% | 38% | 19% | 8% | 3% | 1% |
| 70° | 6.1 m | 55% | 29% | 13% | 6% | 2% | 1% |

A wider field of view brings the camera closer: parallax gets stronger and the course more
three-dimensional, with more of each terrain block's sides showing. A narrower one flattens
both. Small and portrait screens frame the course differently, so check the effect there too.

Decorations in front of the line pass faster than the course: 2 m in front moves 1.14 times
as fast at 30° and 1.28 times at 50°. A few foreground pieces, such as hanging chains, give a
strong sense of depth, but they draw over the character's body, so keep them clear of the
climb.

## Scale up what you push back

Perspective shrinks a decoration by the same share it slows it, so set its **Height** to
the size you want it to look divided by that share. A crag that should look 12 m tall
40 m back, at 30°, needs a height of 12 / 0.28, about 42 m. The library's models start at a
height and depth that already read well, such as the castle at 110 m, 600 m back
(see [the library](decorations.md#the-library)).

With the orthographic camera, size never changes with depth: scale distant decorations down
yourself, though they still scroll at the course's speed.

## Build layers

Put scenery in a few layers at clearly different depths, so each moves at its own speed.
Roughly doubling the depth from one layer to the next keeps them distinct:

| Layer | Depth | Speed at 30° | Use |
| --- | --- | --- | --- |
| Foreground | 1-3 m in front | 107-123% | A few framing pieces; keep clear of the climb |
| Near | 2-10 m back | 89-61% | Walls, trees and ruins beside the path |
| Middle | 15-60 m back | 51-21% | Crags, towers, rock shelves |
| Far | 100-1,000 m back | 14-2% | Castles, ridges and the horizon |

The Level editor works in these layers too: in its **Scenery** mode, **Pick scenery at**
picks only the foreground (**Front**, on or in front of the course), **Near** (up to 12 m back),
**Middle** (12-80 m back) or **Far** (beyond 80 m), so a far piece can be picked and moved behind
the nearer layers covering it (see [placing decorations](decorations.md#placing-decorations)).

Give background scenery ground to stand on. Seen through a perspective camera from above, a
tree standing on empty ground behind the course seems to float as the player climbs past
it; stand it on **Rock shelf** models, whose tops reach 30 m back, or on hills of its own.

## Fade distance into haze

Theme fog fades what is farther away toward **Fog colour**, from **Fog start** to
**Fog end**. Both are depths behind the course, not distances from the camera, so the fog
looks the same with either camera. Keep the fog colour close to the **Sky colour**, so far
layers melt into the sky. Anything deeper than the fog end disappears: set it past your
farthest layer, up to 2,000 m, or let the horizon fade out on purpose. The defaults, 15 m
to 65 m, suit a shallow scene. A fog start below 0 hazes the course itself.

## Soften the background

**Background blur** (0-5% of the view height) blurs what lies behind the course, easing in
from **Blur start** (at least 5 m back) to full at **Full blur** (up to 1,000 m back). The
characters, the course and anything nearer than the blur start stay sharp. A light blur,
about 0.3-1%, sells distance; a heavy one looks like a miniature. At 0 it costs nothing;
on, everything behind the blur start draws through an offscreen image.

## Fade colour and detail

Distant things look lighter, less saturated and closer to the sky's colour; near things are
darker with more contrast. The theme's **Far**, **Middle** and **Near mountains** colours
follow this, and a decoration's **Tint** multiplies its colours, so a pale, cool tint pushes a
far copy back. Glowing parts of the library's models, such as windows, fire and runes, are
unlit and still read through haze, which makes them good distant landmarks.

Far scenery needs little detail: a big, simple silhouette reads better than a busy one.
Let nearer layers cross in front of farther ones: overlap shows depth even through the
orthographic camera.

## The backdrop

The theme's backdrop is three mountain layers, 10 m, 16 m and 24 m back, and a sun disc
35 m back, drawn first behind everything. They also follow the camera by a fixed share,
60% sideways and 25% up and down, so they drift by even slower than their depth alone would
make them, with either camera. They hide whatever stands behind them: when decorations
provide the horizon, turn off **Show backdrop mountains** (and **Show the sun disc**).

A game can replace the backdrop with its own layers, each following the camera at its own
rate, through the `scene.backdrop` [runtime plugin slot](runtime-plugins.md#backdrop).

## Rules that still apply

- Depth is for scenery. Everything that collides is drawn centred on the obstacle line.
- A prop standing on a collider stays within that collider's depth, and one behind the path
  keeps clear of the pot, which reaches 0.5 m behind the line for the default jar.
- Decorations on or in front of the line draw over the character's body; keep them clear
  of the climb.

## Checklist

1. **Project / Theme**: turn on **Perspective camera**; start with a **Field of view** of
   30-50°.
2. **Level / Decoration library**: place scenery in near, middle and far layers, each at
   about twice the depth of the one before.
3. Raise each layer's **Height** by one over its share from the table, so it keeps its size.
4. Set **Fog colour** close to the sky, and **Fog end** past the farthest layer.
5. Tint far layers lighter and cooler.
6. Optionally, add a light **Background blur** from about 10 m to 200 m back.
7. Hide the backdrop mountains if they stand in front of your far layers.
8. Climb: the far layers should crawl, the near ones slide and the course scroll.
