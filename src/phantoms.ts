// Phantoms in a release: other players' movement replays as ghosts near the player. The recordings
// come from the release itself, which bundles those its project recorded, and from the game's
// backend, which also receives the player's own now and then. Only the backend decides what it keeps
// and sends; the release validates what it receives. See docs/phantoms.md.
import type { ContentPhantomPack } from './content';
import type { ContentLoader } from './content-ref';
import type { Game } from './game';
import { decodePhantom, decodePhantomPack, isPhantomNear } from './phantom-format';
import type { PhantomTrack } from './phantom-format';
import { PhantomRecorder } from './phantom-recorder';
import type { PhantomService } from './phantom-service';
import { PHANTOM_LOOK, PhantomView } from './phantom-view';
import { PHYSICS } from './config';
import type { RigPose } from './simulation';

// Seconds of play, except where noted.
export const PHANTOM_PLAYBACK = {
  // Recordings asked for at a time, from each source.
  batch: 6,
  // Between asks, and at most while a source keeps failing.
  interval: 20,
  maxRetry: 300,
  // Between one phantom starting and the next.
  stagger: { min: 1, max: 6 },
} as const;

// What a build with phantoms (GAME_PHANTOMS_URL, bundled recordings, or both) gives its release.
export interface PhantomBuild {
  // GAME_PHANTOMS_URL as configured, maybe relative to the page; null without a backend.
  readonly url: string | null;
  // The SHA-256 of the level's play layout and physics: recordings replay only where everything that moves the player
  // is as it was when they were made.
  readonly course: string;
  readonly start: typeof startPhantoms;
}

export interface Phantoms {
  dispose(): void;
}

function steps(seconds: number): number {
  return Math.max(1, Math.round(seconds / PHYSICS.dt));
}

// Picks up to `limit` of `items` at random, reordering them.
function pick<T>(items: T[], limit: number, random: () => number): T[] {
  const count = Math.min(limit, items.length);
  for (let index = 0; index < count; index++) {
    const other = index + Math.floor(random() * (items.length - index));
    [items[index], items[other]] = [items[other]!, items[index]!];
  }
  return items.slice(0, count);
}

/**
 * The release's bundled recordings: each pack loads through the release's content the first time
 * the player comes near it, and stays.
 */
class PhantomPacks {
  private readonly packs: readonly ContentPhantomPack[];
  private readonly content: ContentLoader;
  private readonly signal: AbortSignal;
  private readonly loaded = new Map<ContentPhantomPack, Promise<PhantomTrack[]>>();
  private readonly onInvalid: (count: number, reason: unknown) => void;

  constructor(options: {
    packs: readonly ContentPhantomPack[]; content: ContentLoader; signal: AbortSignal; onInvalid: (count: number, reason: unknown) => void;
  }) {
    this.packs = options.packs;
    this.content = options.content;
    this.signal = options.signal;
    this.onInvalid = options.onInvalid;
  }

  async nearby(x: number, y: number, limit: number, random: () => number): Promise<PhantomTrack[]> {
    const packs = this.packs.filter((pack) => isPhantomNear(pack.bounds, x, y));
    const tracks = (await Promise.all(packs.map((pack) => this.load(pack)))).flat();
    return pick(tracks.filter((track) => isPhantomNear(track.bounds, x, y)), limit, random);
  }

  private load(pack: ContentPhantomPack): Promise<PhantomTrack[]> {
    let loading = this.loaded.get(pack);
    if (loading === undefined) {
      loading = this.content(pack.source, this.signal).then((bytes) => {
        const tracks: PhantomTrack[] = [];
        let invalid = 0;
        let reason: unknown;
        for (const recording of decodePhantomPack(bytes)) {
          try {
            tracks.push(decodePhantom(recording));
          } catch (error) {
            invalid++;
            reason ??= error;
          }
        }
        if (invalid > 0) this.onInvalid(invalid, reason);
        return tracks;
      });
      // A pack that failed to load is tried again at the next ask.
      loading.catch(() => { this.loaded.delete(pack); });
      this.loaded.set(pack, loading);
    }
    return loading;
  }
}

/**
 * Replays phantoms for a running game from the release's bundled recordings and its backend: the
 * service resolved by the release plugin session. With a backend, the player's
 * movement is recorded for it too. Everything runs on the game's steps, so pauses hold it too.
 */
export function startPhantoms(options: {
  readonly game: Game;
  readonly course: string;
  readonly service: PhantomService | null;
  readonly packs: readonly ContentPhantomPack[];
  readonly content: ContentLoader;
  readonly random?: () => number;
}): Phantoms {
  const { game, course } = options;
  const service = options.service;
  const random = options.random ?? Math.random;
  const lifecycle = new AbortController();
  const view = new PhantomView();
  game.view.addLayer(view);
  const waiting: PhantomTrack[] = [];
  const pose: RigPose = { x: 0, y: 0, pot: 0, tipX: 0, tipY: 0, buttX: 0, buttY: 0 };
  let untilStart = 0;

  const failed = (what: string, error: unknown): void => {
    if (!lifecycle.signal.aborted) console.warn(`Phantoms: ${what}`, error);
  };
  const invalid = (source: string) => (count: number, reason: unknown): void => {
    failed(`${source} sent ${count} invalid recording${count === 1 ? '' : 's'}.`, reason);
  };
  // Asks one source for recordings near the player whenever none are waiting, and again after an
  // interval, or later while it keeps failing. Never rejects.
  const source = (name: string, nearby: (x: number, y: number) => Promise<PhantomTrack[]>) => {
    let asking = false;
    let untilAsk = 0;
    let failures = 0;
    return (): void => {
      untilAsk--;
      if (untilAsk > 0 || asking || waiting.length > 0) return;
      asking = true;
      nearby(pose.x, pose.y).then((tracks) => {
        waiting.push(...tracks);
        failures = 0;
        untilAsk = steps(PHANTOM_PLAYBACK.interval);
      }, (error: unknown) => {
        failures++;
        untilAsk = steps(Math.min(PHANTOM_PLAYBACK.interval * 2 ** failures, PHANTOM_PLAYBACK.maxRetry));
        if (failures === 1) failed(`${name} could not be reached.`, error);
      }).finally(() => { asking = false; });
    };
  };
  const sources: (() => void)[] = [];
  if (options.packs.length > 0) {
    const packs = new PhantomPacks({ packs: options.packs, content: options.content, signal: lifecycle.signal, onInvalid: invalid('the release') });
    sources.push(source('the release\'s recordings', (x, y) => packs.nearby(x, y, PHANTOM_PLAYBACK.batch, random)));
  }
  let recorder: PhantomRecorder | null = null;
  if (service !== null) {
    const backend = service;
    // The service is the game's; whatever it throws, synchronously or not, becomes a rejection handled
    // here, never an error in the game's step, which would stop the game.
    const submit = async (recording: Uint8Array<ArrayBuffer>): Promise<void> => {
      await backend.submit(course, recording, lifecycle.signal);
    };
    recorder = new PhantomRecorder({
      random,
      onRecording: (recording) => {
        submit(recording).catch((error: unknown) => failed('a recording was not stored.', error));
      },
    });
    const report = invalid('the service');
    sources.push(source('the service', async (x, y) => {
      const recordings = await backend.nearby(course, { x, y, limit: PHANTOM_PLAYBACK.batch }, lifecycle.signal);
      const tracks: PhantomTrack[] = [];
      let rejected = 0;
      let reason: unknown;
      for (const recording of recordings.slice(0, PHANTOM_PLAYBACK.batch)) {
        try {
          tracks.push(decodePhantom(recording));
        } catch (error) {
          rejected++;
          reason ??= error;
        }
      }
      if (rejected > 0) report(rejected, reason);
      return tracks;
    }));
  }
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
    recorder?.step(simulation.placement, pose, simulation.rigGeometry.handleLength);
    for (const ask of sources) ask();
    untilStart--;
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
