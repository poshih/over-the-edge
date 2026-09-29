// The reference phantom store: it keeps recordings in memory and answers the protocol httpPhantoms
// speaks. Game development and preview servers run it; a game's own backend stands in for it with its
// own storage, identity and limits, and can validate recordings with src/phantom-format.ts.
// See docs/phantoms.md.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodePhantom, encodePhantomBatch, isPhantomCourse, isPhantomNear, PHANTOM_LIMITS, PhantomError } from '../src/phantom-format';
import type { PhantomBounds, PhantomTrack } from '../src/phantom-format';
import { HttpError, mediaTypeOf, readBody, sendError } from './http';

export const PHANTOM_STORE = {
  // Recordings kept per course, the oldest going first; courses kept, the least recently used going first.
  recordings: 500,
  courses: 16,
  // Seconds between recordings from one player.
  interval: 20,
  // Players remembered for that interval; past this many, the longest-quiet are forgotten early.
  players: 4096,
} as const;
const PLAYER_COOKIE = 'phantom-player';

interface Stored {
  readonly bytes: Uint8Array;
  readonly bounds: PhantomBounds;
  readonly player: string;
}

export class PhantomStore {
  private readonly courses = new Map<string, Stored[]>();
  private readonly submissions = new Map<string, number>();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: { readonly now?: () => number; readonly random?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  // Keeps a player's recording; refuses one that is invalid or comes too soon after their last.
  submit(course: string, bytes: Uint8Array, player: string): void {
    const track = this.validate(course, bytes);
    const now = this.now();
    const last = this.submissions.get(player);
    if (last !== undefined && now - last < PHANTOM_STORE.interval * 1000) {
      throw new HttpError(429, 'too-many-phantoms', `A player sends at most one recording every ${PHANTOM_STORE.interval} seconds.`);
    }
    this.submissions.delete(player);
    this.submissions.set(player, now);
    if (this.submissions.size > PHANTOM_STORE.players) this.submissions.delete(this.submissions.keys().next().value!);
    const recordings = this.course(course, true)!;
    recordings.push({ bytes: bytes.slice(), bounds: track.bounds, player });
    if (recordings.length > PHANTOM_STORE.recordings) recordings.shift();
  }

  // Up to `limit` recordings near the point, chosen at random from other players'.
  nearby(course: string, x: number, y: number, limit: number, player: string): Uint8Array[] {
    const candidates = (this.course(course, false) ?? []).filter((stored) => stored.player !== player && isPhantomNear(stored.bounds, x, y));
    const chosen: Uint8Array[] = [];
    for (let index = 0; index < candidates.length && chosen.length < limit; index++) {
      const pick = index + Math.floor(this.random() * (candidates.length - index));
      [candidates[index], candidates[pick]] = [candidates[pick]!, candidates[index]!];
      chosen.push(candidates[index]!.bytes);
    }
    return chosen;
  }

  private validate(course: string, bytes: Uint8Array): PhantomTrack {
    if (!isPhantomCourse(course)) throw new HttpError(404, 'unknown-course', 'A phantom course is a lowercase hex SHA-256.');
    try {
      return decodePhantom(bytes);
    } catch (error) {
      if (!(error instanceof PhantomError)) throw error;
      throw new HttpError(400, 'invalid-phantom', error.message);
    }
  }

  // A course's recordings, now the most recently used.
  private course(course: string, create: boolean): Stored[] | undefined {
    const recordings = this.courses.get(course) ?? (create ? [] : undefined);
    if (recordings === undefined) return undefined;
    this.courses.delete(course);
    this.courses.set(course, recordings);
    if (this.courses.size > PHANTOM_STORE.courses) this.courses.delete(this.courses.keys().next().value!);
    return recordings;
  }
}

function cookie(request: IncomingMessage, name: string): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function queryNumber(url: URL, name: string, limit: number): number {
  const text = url.searchParams.get(name);
  const value = text === null || text.trim() === '' ? Number.NaN : Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > limit) throw new HttpError(400, 'invalid-query', `${name} must be a number within ±${limit}.`);
  return value;
}

async function answer(store: PhantomStore, request: IncomingMessage, response: ServerResponse, url: URL,
  course: string, player: string): Promise<void> {
  if (!isPhantomCourse(course)) throw new HttpError(404, 'unknown-course', 'Phantoms are kept per course: a lowercase hex SHA-256.');
  if (request.method === 'POST') {
    if (mediaTypeOf(request) !== 'application/octet-stream') {
      throw new HttpError(415, 'unsupported-media-type', 'Send recordings as application/octet-stream.');
    }
    store.submit(course, new Uint8Array(await readBody(request, PHANTOM_LIMITS.bytes)), player);
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  if (request.method === 'GET') {
    const x = queryNumber(url, 'x', PHANTOM_LIMITS.coordinate);
    const y = queryNumber(url, 'y', PHANTOM_LIMITS.coordinate);
    const limit = queryNumber(url, 'limit', PHANTOM_LIMITS.batch);
    if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, 'invalid-query', `limit must be 1 to ${PHANTOM_LIMITS.batch}.`);
    const body = encodePhantomBatch(store.nearby(course, x, y, limit, player));
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(body.byteLength),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
    return;
  }
  response.setHeader('Allow', 'GET, POST');
  throw new HttpError(405, 'method-not-allowed', 'Recordings are sent with POST and asked for with GET.');
}

/**
 * Answers the reference protocol for requests under `prefix`, a path ending in /. Each browser gets an
 * anonymous player cookie, so the store leaves a player's own recordings out of what it sends them.
 */
export function phantomMiddleware(store: PhantomStore, prefix: string) {
  return (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void): void => {
    const url = new URL(request.url ?? '/', 'http://phantoms.invalid');
    if (!url.pathname.startsWith(prefix)) {
      next();
      return;
    }
    let player = cookie(request, PLAYER_COOKIE);
    if (player === null || !/^[0-9a-f]{32}$/.test(player)) {
      player = randomBytes(16).toString('hex');
      response.setHeader('Set-Cookie', `${PLAYER_COOKIE}=${player}; Path=${prefix}; HttpOnly; SameSite=Strict`);
    }
    answer(store, request, response, url, url.pathname.slice(prefix.length), player).catch((error: unknown) => {
      if (error instanceof HttpError) sendError(response, error);
      else next(error);
    });
  };
}
