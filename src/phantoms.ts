// Phantoms in a release: now and then the player's movement is recorded for the game's backend, and
// other players' recordings from near the player replay as ghosts. Only the backend decides what it
// keeps and sends; the release validates what it receives. See docs/phantoms.md.
import type { Game } from './game';
import { decodePhantom, isPhantomNear } from './phantom-format';
import type { PhantomTrack } from './phantom-format';
import { PhantomRecorder } from './phantom-recorder';
import { httpPhantoms } from './phantom-service';
import type { PhantomService } from './phantom-service';
import { PHANTOM_LOOK, PhantomView } from './phantom-view';
import { PHYSICS } from './config';
import type { RigPose } from './simulation';

// Seconds of play, except where noted.
export const PHANTOM_PLAYBACK = {
  // Recordings asked for at a time.
  batch: 6,
  // Between asks, and at most while the backend keeps failing.
  interval: 20,
  maxRetry: 300,
  // Between one phantom starting and the next.
  stagger: { min: 1, max: 6 },
} as const;

// What a build with phantoms (GAME_PHANTOMS_URL) gives its release.
export interface PhantomBuild {
  // GAME_PHANTOMS_URL as configured, maybe relative to the page.
  readonly url: string;
  // The level's SHA-256: recordings replay only on the level they were made on.
  readonly course: string;
  readonly start: typeof startPhantoms;
}

export interface Phantoms {
  dispose(): void;
}

function steps(seconds: number): number {
  return Math.max(1, Math.round(seconds / PHYSICS.dt));
}

/**
 * Records and replays phantoms for a running game, through the game's own service or, without one,
 * the reference protocol at `url`. Everything runs on the game's steps, so pauses hold it too.
 */
export function startPhantoms(options: {
  readonly game: Game;
  readonly course: string;
  // An absolute URL, used when there is no service.
  readonly url: string;
  readonly service: PhantomService | null;
  readonly random?: () => number;
}): Phantoms {
  const { game, course } = options;
  const service = options.service ?? httpPhantoms(options.url);
  const random = options.random ?? Math.random;
  const lifecycle = new AbortController();
  const view = new PhantomView();
  game.view.addLayer(view);
  const waiting: PhantomTrack[] = [];
  const pose: RigPose = { x: 0, y: 0, pot: 0, tipX: 0, tipY: 0, buttX: 0, buttY: 0 };
  let asking = false;
  let untilAsk = 0;
  let untilStart = 0;
  let failures = 0;

  const failed = (what: string, error: unknown): void => {
    if (!lifecycle.signal.aborted) console.warn(`Phantoms: ${what}`, error);
  };
  // The service is the game's; whatever it throws, synchronously or not, becomes a rejection handled
  // here, never an error in the game's step, which would stop the game.
  const submit = async (recording: Uint8Array<ArrayBuffer>): Promise<void> => {
    await service.submit(course, recording, lifecycle.signal);
  };
  const recorder = new PhantomRecorder({
    random,
    onRecording: (recording) => {
      submit(recording).catch((error: unknown) => failed('a recording was not stored.', error));
    },
  });
  // Never rejects: a failing service is asked again later, and anything it sends that is not a valid
  // recording is skipped.
  const ask = async (): Promise<void> => {
    asking = true;
    try {
      const recordings = await service.nearby(course, { x: pose.x, y: pose.y, limit: PHANTOM_PLAYBACK.batch }, lifecycle.signal);
      let invalid = 0;
      let reason: unknown;
      for (const recording of recordings.slice(0, PHANTOM_PLAYBACK.batch)) {
        try {
          waiting.push(decodePhantom(recording));
        } catch (error) {
          invalid++;
          reason ??= error;
        }
      }
      if (invalid > 0) failed(`the service sent ${invalid} invalid recording${invalid === 1 ? '' : 's'}.`, reason);
      failures = 0;
      untilAsk = steps(PHANTOM_PLAYBACK.interval);
    } catch (error) {
      failures++;
      untilAsk = steps(Math.min(PHANTOM_PLAYBACK.interval * 2 ** failures, PHANTOM_PLAYBACK.maxRetry));
      if (failures === 1) failed('the service could not be reached.', error);
    } finally {
      asking = false;
    }
  };
  // The next waiting recording near the player starts; those the player has left behind are dropped.
  const startNext = (): void => {
    while (waiting.length > 0) {
      const track = waiting.shift()!;
      if (!isPhantomNear(track.bounds, pose.x, pose.y)) continue;
      view.play(track);
      const { min, max } = PHANTOM_PLAYBACK.stagger;
      untilStart = steps(min + (max - min) * random());
      return;
    }
  };
  const unobserve = game.observeSteps(() => {
    const { simulation } = game;
    simulation.rigPose(pose);
    recorder.step(simulation.time, pose, simulation.rigGeometry.handleLength);
    untilAsk--;
    untilStart--;
    if (untilAsk <= 0 && !asking && waiting.length === 0) void ask();
    if (untilStart <= 0 && waiting.length > 0 && view.playing < PHANTOM_LOOK.figures) startNext();
  });
  return {
    dispose() {
      lifecycle.abort(new DOMException('The game closed.', 'AbortError'));
      unobserve();
      view.clear();
    },
  };
}
