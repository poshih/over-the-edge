# Phantoms

Recordings of players' movement replay as translucent white **phantoms** that climb beside the
player. Phantoms are drawn only: they never collide, block or touch anything. A release gets
them from two places:

- **its own content**: the Workshop records your play on each saved version of a project's
  level, and a release [bundles](#bundled-recordings) the recordings made on its level;
- **the game's backend** (`GAME_PHANTOMS_URL`), which also receives recordings of the release's
  players.

A release with neither contains no phantom code.

## Recording in the Workshop

While **Record** is on in the Workshop header, on until you turn it off in that browser, the
Workshop records every run you play on a saved [level version](projects.md#level-versions) of
the open server project: its level together with its game settings. A pulsing red **REC**
beside the game's controls shows when it is recording. Each run is a session of clips of up to
10 seconds, each starting with the previous clip's last pose, so a run replays as one; a
restart or Reset starts the next session. Death (a fall out of the level, or health
running out) closes the alive-only clip and session immediately, **before its terminal
physics step is sampled**. The [death sequence](runtime-plugins.md#death-sequence), its
teleport and the placement pose record nothing. A fresh session begins on the first
subsequent live step, without copying the old session's last pose. A clip also ends when the
handle length changes, or the level or game settings stop being that saved version. Clips shorter than a
second, or in which the character moved less than 0.5 m and the hammer head less than 3 m, are
dropped.

Recording waits while the level or the game settings have changes no save has numbered yet:
the project saves them a moment after you stop editing, as its next level version. Without a
server project nothing is recorded. Clips upload as they end, to
`POST /api/projects/{id}/level/versions/{version}/phantoms`, and the project keeps them in
`phantoms/<course>/` beside its files.

**Watching them.** **Workshop / Level / Replays** lists the open project's versions that have
recordings, newest first, each marked *plays as now* or *other layout or physics* against the
version the page holds, and each version's runs, newest first. **Play** downloads the run's clips
and plays them in order as one phantom over the current level, at 0.5× to 4× speed; **Position**
moves through the run, and **Follow** keeps the camera on the phantom until you move the view
yourself. A dropped clip shows as a jump. Playback keeps its own time, since the game is paused
in the Level tab, and leaving the tab pauses it.

## Bundled recordings

A game build bundles the recordings of its [course](#courses), its level's layout with its
physics, from a folder of recordings by course:

- a `GAME_PROJECT` folder's own `phantoms/` folder;
- or **`GAME_PHANTOM_RECORDINGS`**, a folder holding `<course>/*.phantom` files; set it empty to
  bundle none;
- publishing from the Workshop bundles the project's.

The build reads the folder once, so a running `npm run dev:game` takes new recordings when it
restarts. Every recording is validated and a file that is not one fails the build, naming it.
Recordings are grouped by the 10 m height band their character's path is centred in; each band
keeps up to 32, chosen by their SHA-256 so the choice spreads across sessions and stays the
same from build to build. Each band becomes one **pack**, a content file named by its SHA-256
like every other, and the content manifest lists the packs with the area their recordings
cover. The release loads a pack the first time the player comes within 25 m of that area,
through the same [content access](content-delivery.md) as everything else, and keeps it.

## Turning on a backend

```sh
GAME_PROJECT=projects/my-game GAME_PHANTOMS_URL=https://api.example.com/phantoms/ npm run build:game
```

`GAME_PHANTOMS_URL` says where recordings go and come from. Like `GAME_CONTENT_URL`, it is an
HTTP(S) URL or a path relative to the page, ending in `/`, without credentials, query or
fragment. Publishing from the Workshop ignores it: a studio preview has no phantom service, and
replays only the project's bundled recordings.

To try phantoms locally, point it at a path on the local server:

```sh
GAME_PHANTOMS_URL=phantoms/ npm run dev:game
```

The development and preview servers answer phantom requests at that path themselves, with the
[reference store](#the-reference-store). Play for 15 to 40 seconds in one browser, then open the
game in another browser or a private window: a player is never sent their own recordings.

## What a release does

**Recording.** Only a release with a backend records. After a random 5 to 30 seconds of play,
the release records the next 10
seconds, hands the recording to the backend, then waits another 30 to 90 seconds. A restart,
or any death, discards the recording in progress before the terminal sample, and the
next one starts 3 to 10 seconds of live play later. Dying steps, the teleport and the
placement pose are never sampled. A recording
in which the character moved less than 0.5 m and the hammer head less than 3 m is not sent, and
neither is one the format cannot hold, such as an endless fall past its ±4096 m range.
Recording runs on eligible live physics steps, so pauses and death neither record nor
count toward a wait. Both recorders receive `Game.observeSteps({ step, interrupt })`:
`step` only after a non-terminal, non-placement step, and `interrupt` at death entry.
Placement checks remain the discontinuity guard for ordinary resets and rig changes.

**Playback.** When play starts, and every 20 seconds while none are waiting, the release asks
each source, its bundled packs and its backend, for up to 6 recordings near the player. It
plays up to 3 at once, 1 to 6 seconds
apart, where they were recorded. Each fades in over half a second and out over 0.8 seconds, and
playback follows the game's time, so pausing the game pauses its phantoms. A waiting recording
the player has left behind, one whose path stays more than 25 m away, is dropped.

**Drawing.** Phantoms draw through the runtime point
[`LOOKS.phantoms`](runtime-plugins.md#phantom-looks), in the Workshop's replay viewer, studio
previews and releases alike. Engine-owned `PhantomPlayback` chooses the figures, advances
recordings, samples poses, fades them and provides the replay viewer's held pose; a
`PhantomLook` only draws the reused `PhantomFigureFrame` slots and the game's current rig, default
hammer head and jar. `DEFAULT_PHANTOM_LOOK` creates the pooled translucent white `PhantomView`, with
shared geometry, sliding grips and allocation-free arm IK. A game replaces or wraps its drawing without
changing recording, timing or its backend. It draws only while at least one figure shows,
in the actors pass over the course.

The release validates every recording it receives, whoever sent it. Anything invalid is
skipped. A source that fails, a backend or a pack that will not load, is retried at growing
intervals up to 5 minutes, with one warning
in the browser console starting `Phantoms:`. The game plays on: nothing a service does, including
throwing, answering with garbage or streaming without end, stops it. The reference client reads
at most one batch's worth of an answer.

## What a recording holds

A recording is the rig's pose at keyframes:

| Value | Meaning |
| --- | --- |
| `x`, `y` | The character's centre, in metres |
| `pot` | The pot's tilt, in radians |
| `angle` | The shaft's angle, from the handle's butt to the hammer head, unwrapped so it can turn past ±π |
| `along`, `across` | The hammer head's centre from the shoulder hinge, along and across the shaft, in metres |

Playback draws the hammer head at the recorded offset and the handle a handle's length behind
it along the shaft. It interpolates every value linearly between keyframes.

**Arms and hands are not recorded.** The default phantom look takes the default grips on its
handle, and its arms reach them with the same grip placement and arm IK the game uses for its
own character, so they are exact for the recorded tool and cost no space. Its figures are the
default character's silhouette, whatever character the recorded player used; a game's
`LOOKS.phantoms` supplies its own drawing.

The head is recorded by its offset rather than rebuilt from the hinge angle and extension
because the handle gives under impacts. Rebuilding it from the joints misses by up to 10 cm
when the hammer is pressed against rock.

**Accuracy and size.** The recorder keeps a keyframe only where a straight line between
keyframes would stray: every physics step is reproduced within **1.5 cm**. That covers:

- the character's centre;
- the hammer head;
- the pot's rim;
- the handle's far end, turned about the head.

Values are stored to the millimetre and to 1/4096 radian. The handle's own stretch under hard
impacts, up to about 2 cm, is not reproduced.

Measured on real physics, 10 seconds take:

| Motion | Size | Keyframes |
| --- | --- | --- |
| Frantic, never-ending swings | 3.4 to 3.5 KB | 347 to 361 |
| Steady circles and sweeps | 1.5 to 2.1 KB | 152 to 205 |
| Slow mouse circles in a browser | 0.8 KB | 86 |
| Standing still | About 200 bytes | 27 |

## Format

Recordings are binary. Numbers are unsigned LEB128 varints, at most five bytes and without
padding. Signed values are zigzag-encoded first: 0, -1, 1, -2… become 0, 1, 2, 3….

| Field | Encoding |
| --- | --- |
| Version | One byte: `1` |
| Handle length | Varint, millimetres, 750 to 3000 |
| Keyframe count | Varint, 2 to 2401 |
| First keyframe | Six signed varints: `x`, `y`, `pot`, `angle`, `along`, `across` |
| Each later keyframe | A varint: ticks since the previous keyframe, 1 to 240; then six signed varints, each value's change |

Time counts ticks of 1/240 second, one physics step. `x`, `y`, `along` and `across` are
millimetres; `pot` and `angle` are 1/4096 radian. A valid recording:

- starts at tick 0 and lasts 1 to 10 seconds;
- is at most 32 KB with nothing after its last keyframe;
- keeps `x` and `y` within ±4096 m, `pot` within ±0.5 rad, `along` within -0.5 to 5.5 m and
  `across` within ±1 m.

The head and butt of a pose:

```text
shoulder = (x, y + 0.67)
head     = shoulder + along·(cos angle, sin angle) + across·(−sin angle, cos angle)
butt     = head − handleLength·(cos angle, sin angle)
```

A **batch**, a service's answer, is a varint count of 0 to 16, then each recording as a varint
length and its bytes. A **pack**, a release's bundled recordings, is laid out the same way with
0 to 64 recordings.

### Courses

Recordings belong to a **course**, which the build and the project server compute: the SHA-256,
in lowercase hex, of the level's **play layout** and the game's **physics**
(`src/phantom-course.ts`). They hold only what moves the player. The layout, without object IDs
and in a fixed order, uses **course format 8**:

- each terrain object's collision as mirrored, position, size, angle, illusion and surface;
- each enemy's species, position, facing, patrol distance and speed;
- each bonfire's position;
- each projectile trap's firing mode, position, angle, shot interval, first shot, projectile speed
  and damage;
- each swinging axe's pivot, length, swing period, swing offset and damage;
- each liquid pool's liquid, position, width and height;
- each platform's position, `ride` boarding behaviour, travel, width, height, speed and surface;
- each trigger whose events launch the player, fire a trap or move a platform: its region,
  position, activation and those actions, with each target's entry in place of its ID and
  each `move-platform` action's `to` destination (`toggle`, `start` or `end`);
- the start's position, angle and reach.

The physics: every physics setting but control sensitivity, so the masses, motors, downswing
boosts, response, friction, damping, bounciness, handle compliance, health, hurt/respawn
invulnerability, trap hurt-box dimensions and knockback, hammer damage and its full-damage
speed, enemy health, armor, masses,
acceleration, sight, dive speed, arrow speed and damage, and bumps, and liquids, and the hammer rig's
handle length, maximum extension, minimum reach, default head and jar outline. A model-library hammer's
own head is a cosmetic's and is left out: recordings made with any hammer share the course,
and phantom looks receive the game's current default head rather than the recorded player's.

All death settings, including `death.wait`, and death timing, HUD text/fade and
`DEATH_POSE` presentation are excluded: recordings never include dying. These settings
shape only the death sequence, not the alive play a phantom records.
The character figure and corpse are excluded too: physics builds the corpse from
its own rig state and the profile's numeric proportions, never the renderer's
filters or artwork. Corpse and tool fixtures cannot contact enemies, enemy/trap
anchors are frozen at entry, and the dying jar cannot trigger illusions. The
figure and corpse therefore do not steer persistent level state in a continuing
run. The released head can still block transient projectile rays.

Decorations, labels, colours, depth, which mesh draws a collision, trigger events other than
launches, trap bursts and platform moves, control sensitivity and the cursor settings are
left out. A recording replays only where its course holds, so editing those details, or
swapping a mesh for one that collides alike, keeps a level's recordings. Changing the play
layout above—terrain, enemies, bonfires, traps, pools, platforms, those triggers or the
start—or a physics setting that counts starts a new course with none. Recordings made under
a physics setting you go back to count again.

`src/phantom-format.ts` implements all of this. It imports no DOM or three.js, and its imports
carry extensions, so a JavaScript backend can validate recordings with `decodePhantom`, which
accepts anything and throws `PhantomError` unless the result is a playable track.

## The protocol

A release whose plugins supply no [phantom service](#the-games-own-backend) speaks the
reference protocol under the phantom URL:

| Request | Body | Answer |
| --- | --- | --- |
| `POST {url}{course}` | One recording, `application/octet-stream` | Any 2xx once handled |
| `GET {url}{course}?x={x}&y={y}&limit={n}` | None | A batch, `application/octet-stream` |

`x` and `y` are where the player's character is, in metres, and `limit` is the most recordings
wanted, 1 to 16. Requests carry cookies to the page's own origin only.

**The backend decides everything**, including:

- which recordings to keep;
- who may send them, and how often;
- which to send, and to whom;
- how long they last.

A good answer is a random choice of other players' recordings whose path passes near the
point; `isPhantomNear(bounds, x, y)` in the format module applies the 25 m the reference store
uses. Recordings are anonymous motion only. They carry no identity, and the release sends none:
a backend that wants players' identities takes them from its own session, like
[content grants](content-delivery.md).

## The game's own backend

A plugin's [release facet](release-plugins.md) may carry phantoms its own way. It extends the
current service with `wrap(PHANTOMS, base => ...)`, or replaces it with the game's own
authorization or transport through the same `PhantomService` contract, `submit` and `nearby`.
The release SDK exports that contract, `PhantomQuery` and the lightweight `PhantomServiceError`,
not the gated reference client. [Phantom backend](release-plugins.md#phantom-backend) shows how.
A non-null resolved service requires a release with a phantom URL or bundled recordings; a
non-null result without either stops the release with an error, while `null` remains valid.

## The reference store

`server/phantom-store.ts` answers the reference protocol for the development and preview
servers, and shows what a backend does. It:

- validates every recording;
- keeps the newest 500 per course, for up to 16 courses;
- takes one recording per player every 20 seconds;
- sends a random choice of other players' recordings that pass within 25 m of the point.

Players are anonymous there: each browser gets a random `HttpOnly` cookie, which only tells a
player's own recordings apart. The store keeps everything in memory, forgets it on restart and
trusts any browser. It is for development, not production.

## Cost

**Recording** costs 1.5 to 3.5 µs per physics step and allocates nothing per step.

**Playback** costs only while phantoms play. With three phantoms on the full Ashen Ascent course:

- updating them takes 0.05 ms a frame;
- each phantom draws 12 meshes;
- all phantoms share one set of geometry.

**The network** carries, with a backend, one small `POST` per 40 to 120 seconds of play, and
at most one `GET` every 20 seconds. Bundled packs, at most about 32 recordings each, load once
each, as the player reaches their height.

**The Workshop** records with the same per-step capture and uploads one clip, typically 1 to
4 KB, per 10 seconds of play.
