# Phantoms

A release can record short stretches of each player's movement, keep them with the game's
backend, and replay other players' recordings as translucent white **phantoms** that climb
beside the player. Phantoms are drawn only: they never collide, block or touch anything.

Phantoms are off unless a release is built with **`GAME_PHANTOMS_URL`**, and a release built
without it contains no phantom code.

## Turning phantoms on

```sh
GAME_PROJECT=projects/my-game GAME_PHANTOMS_URL=https://api.example.com/phantoms/ npm run build:game
```

`GAME_PHANTOMS_URL` says where recordings go and come from. Like `GAME_CONTENT_URL`, it is an
HTTP(S) URL or a path relative to the page, ending in `/`, without credentials, query or
fragment. Publishing from the Workshop ignores it: a studio preview has no phantom service.

To try phantoms locally, point it at a path on the local server:

```sh
GAME_PHANTOMS_URL=phantoms/ npm run dev:game
```

The development and preview servers answer phantom requests at that path themselves, with the
[reference store](#the-reference-store). Play for 15 to 40 seconds in one browser, then open the
game in another browser or a private window: a player is never sent their own recordings.

## What a release does

**Recording.** After a random 5 to 30 seconds of play, the release records the next 10
seconds, hands the recording to the backend, then waits another 30 to 90 seconds. A restart
discards the recording in progress, and the next one starts 3 to 10 seconds later. A recording
in which the character moved less than 0.5 m and the hammer head less than 3 m is not sent, and
neither is one the format cannot hold, such as an endless fall past its ±4096 m range.
Recording runs on the game's time, so pauses neither record nor count toward a wait.

**Playback.** When play starts, and every 20 seconds while none are waiting, the release asks
the backend for up to 6 recordings near the player. It plays up to 3 at once, 1 to 6 seconds
apart, where they were recorded. Each fades in over half a second and out over 0.8 seconds, and
playback follows the game's time, so pausing the game pauses its phantoms. A waiting recording
the player has left behind, one whose path stays more than 25 m away, is dropped.

The release validates every recording it receives, whoever sent it. Anything invalid is
skipped. A backend that fails is retried at growing intervals up to 5 minutes, with one warning
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

**Arms and hands are not recorded.** A phantom takes the default grips on its handle, and its
arms reach them with the same grip placement and arm IK the game uses for its own character, so
they are exact for the recorded tool and cost no space. Every phantom is the default character's
silhouette, whatever character the recorded player used.

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
length and its bytes.

**Courses.** Recordings belong to a **course**: the SHA-256 of the level definition's JSON, in
lowercase hex, which the build computes. A recording replays only on the level it was made on,
so changing the level starts a new course with no phantoms.

`src/phantom-format.ts` implements all of this. It imports no DOM or three.js, and its imports
carry extensions, so a JavaScript backend can validate recordings with `decodePhantom`, which
accepts anything and throws `PhantomError` unless the result is a playable track.

## The protocol

A release without a [module service](#the-games-own-backend) speaks the reference protocol
under the phantom URL:

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

A game's [module](content-delivery.md#protected-games-the-games-module) may carry phantoms its
own way: `ReleaseModule.phantoms` replaces the reference client. `ReleaseHost.phantomsUrl` is the
build's phantom URL, absolute, or `null` without phantoms.

```ts
import { httpPhantoms } from '../../src/release-module';
import type { ReleaseHost, ReleaseModule } from '../../src/release-module';

export async function start(host: ReleaseHost): Promise<ReleaseModule> {
  const session = await signIn(host.mount);
  return {
    // The reference protocol with the game's own authorization.
    phantoms: host.phantomsUrl === null ? undefined : httpPhantoms(host.phantomsUrl, {
      headers: async () => ({ Authorization: `Bearer ${await session.token()}` }),
    }),
  };
}
```

`httpPhantoms(url, { credentials, headers })` is the reference client. `credentials: 'include'`
sends cookies to another origin, which then needs CORS with credentials. A module can instead
implement `PhantomService` itself, over any transport:

- `submit(course, recording, signal)` hands over one recording;
- `nearby(course, { x, y, limit }, signal)` resolves to recordings in the phantom format.

A module that supplies phantoms to a release built without `GAME_PHANTOMS_URL` stops the
release with an error.

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

**The network** carries one small `POST` per 40 to 120 seconds of play, and at most one `GET`
every 20 seconds.
