// The saved run a release's main menu continues, kept in the browser: one for the site, of the course it was played on,
// so a release whose play layout or physics changed starts afresh. See docs/release-plugins.md#saved-runs.
import type { RunRecord } from './game';
import { TRIGGER_LIMITS } from './level';
import { MAX_RIG_REACH } from './rig';

const STORAGE_KEY = 'over-the-edge:play:run';
const RUN_KEYS = ['course', 'savedAt', 'spawn', 'height', 'bestHeight', 'bonfire', 'elapsed', 'timerRunning', 'consumed'] as const;

// What a menu shows of the saved run.
export interface SavedRun {
  // Where the player stood and the best height the run reached, in metres, as the HUD reads height.
  readonly height: number;
  readonly bestHeight: number;
  // The run timer, in seconds, and whether a Stop timer event had stopped it, as at a summit.
  readonly elapsed: number;
  readonly finished: boolean;
  // When the run was saved, in milliseconds since the epoch.
  readonly savedAt: number;
}

export interface StoredRun {
  readonly run: RunRecord;
  readonly summary: SavedRun;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key)) ? record : null;
}

function finite(value: unknown, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function strings(value: unknown, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every((item) => typeof item === 'string');
}

// `run`, saved at `savedAt`, with what a menu shows of it.
export function storedRun(run: RunRecord, savedAt: number): StoredRun {
  return Object.freeze({
    run,
    summary: Object.freeze({
      height: run.height, bestHeight: run.bestHeight, elapsed: run.elapsed, finished: !run.timerRunning, savedAt,
    }),
  });
}

function parse(value: unknown, course: string): StoredRun | null {
  const record = exact(value, RUN_KEYS);
  if (record === null || record.course !== course) return null;
  const spawn = exact(record.spawn, ['position', 'angle', 'reach']);
  const position = spawn === null ? null : exact(spawn.position, ['x', 'y']);
  if (spawn === null || position === null) return null;
  const { x, y } = position;
  const { angle, reach } = spawn;
  const { savedAt, height, bestHeight, bonfire, elapsed, timerRunning, consumed } = record;
  if (!finite(x) || !finite(y) || !finite(angle, -Math.PI, Math.PI) || !finite(reach, 0, MAX_RIG_REACH) ||
    !finite(savedAt, 0) || !finite(height, 0) || !finite(bestHeight, 0) || !finite(elapsed, 0) ||
    typeof timerRunning !== 'boolean' || !(bonfire === null || typeof bonfire === 'string') ||
    !strings(consumed, TRIGGER_LIMITS.objects)) {
    return null;
  }
  return storedRun(Object.freeze({
    spawn: Object.freeze({ position: Object.freeze({ x, y }), angle, reach }),
    height, bestHeight, bonfire, elapsed, timerRunning, consumed: Object.freeze([...consumed]),
  }), savedAt);
}

// The course's saved run in this browser, or null when it keeps none: storage is unavailable, the run is of another
// course, or what it holds is not a run.
export function readSavedRun(course: string): StoredRun | null {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text === null ? null : parse(JSON.parse(text), course);
  } catch (error) {
    if (error instanceof DOMException || error instanceof SyntaxError) return null;
    throw error;
  }
}

// Keeps `stored` as the course's saved run, in place of any other. Throws the storage's DOMException when the browser
// keeps nothing.
export function writeSavedRun(course: string, stored: StoredRun): void {
  const { run, summary } = stored;
  const { position, angle, reach } = run.spawn;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    course, savedAt: summary.savedAt, spawn: { position: { x: position.x, y: position.y }, angle, reach },
    height: run.height, bestHeight: run.bestHeight, bonfire: run.bonfire, elapsed: run.elapsed,
    timerRunning: run.timerRunning, consumed: run.consumed,
  }));
}

// Forgets the saved run, when the browser keeps one.
export function clearSavedRun(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}
