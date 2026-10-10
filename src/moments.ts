import type { EnemySpecies } from './enemy-types';
import type { HurtCause } from './hazards';

export const MOMENT_TYPES = Object.freeze([
  'hurt', 'block', 'impact', 'death', 'fall', 'placed', 'bonfire', 'enemy-hit', 'enemy-defeat', 'launch', 'finish', 'sound',
] as const);
export type MomentType = (typeof MOMENT_TYPES)[number];

export interface MomentStamp {
  readonly placement: number;
  // Run seconds at the end of the step, or when the Game raised it. A new run rewinds to 0.
  readonly time: number;
}

export interface HurtMoment extends MomentStamp {
  readonly type: 'hurt';
  readonly cause: Readonly<HurtCause>;
  // Remaining health, including 0 for the killing hit.
  readonly health: number;
  readonly max: number;
}

export interface BlockMoment extends MomentStamp {
  readonly type: 'block';
  // The level object that fired the blocked projectile: a projectile trap or an archer.
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly directionX: number;
  readonly directionY: number;
  readonly normalX: number;
  readonly normalY: number;
}

export interface ImpactMoment extends MomentStamp {
  readonly type: 'impact';
  readonly x: number;
  readonly y: number;
  // The struck surface's outward unit normal, toward the head.
  readonly normalX: number;
  readonly normalY: number;
  readonly speed: number;
  readonly strength: number;
}

export interface DeathMoment extends MomentStamp { readonly type: 'death'; readonly cause: Readonly<HurtCause> }
export interface FallMoment extends MomentStamp { readonly type: 'fall' }
export interface PlacedMoment extends MomentStamp {
  readonly type: 'placed';
  // A checkpoint return continues the run; null starts a new run from its spawn.
  readonly bonfire: string | null;
}
// The player reached the bonfire `id`, its base at (x, y), and lit it: the player is healed to full, every enemy is back
// home at full health, and a death returns there.
export interface BonfireMoment extends MomentStamp {
  readonly type: 'bonfire'; readonly id: string; readonly x: number; readonly y: number;
}
// An enemy's hits and defeats name it, its species and its centre. The hammer's strike gives where the head struck,
// `strikeX` and `strikeY`, and the contact's unit normal there, `normalX` and `normalY`, toward the head; a fall's is
// the centre, with a zero normal. `damage` is the hit points it lost, `health` what is left and `max` its maximum.
export interface EnemyHitMoment extends MomentStamp {
  readonly type: 'enemy-hit'; readonly id: string; readonly species: EnemySpecies; readonly x: number; readonly y: number;
  readonly strikeX: number; readonly strikeY: number; readonly normalX: number; readonly normalY: number;
  readonly damage: number; readonly health: number; readonly max: number;
}
export interface EnemyDefeatMoment extends MomentStamp {
  readonly type: 'enemy-defeat'; readonly id: string; readonly species: EnemySpecies; readonly x: number; readonly y: number;
  readonly by: 'hammer' | 'fall'; readonly strikeX: number; readonly strikeY: number; readonly normalX: number;
  readonly normalY: number; readonly damage: number; readonly max: number;
}
export interface LaunchMoment extends MomentStamp { readonly type: 'launch' }
export interface FinishMoment extends MomentStamp { readonly type: 'finish' }
export interface SoundMoment extends MomentStamp { readonly type: 'sound'; readonly source: string; readonly volume: number }

export type Moment = HurtMoment | BlockMoment | ImpactMoment | DeathMoment | FallMoment | PlacedMoment | BonfireMoment
  | EnemyHitMoment | EnemyDefeatMoment | LaunchMoment | FinishMoment | SoundMoment;
export type MomentOf<T extends MomentType> = Extract<Moment, { readonly type: T }>;
export type TerminalMoment = DeathMoment | FallMoment;

export const IMPACTS = Object.freeze({ minimumSpeed: 1, fullSpeed: 8, interval: 0.07 });

export function impactStrength(speed: number): number {
  return Math.min(1, Math.max(0, (speed - IMPACTS.minimumSpeed) / (IMPACTS.fullSpeed - IMPACTS.minimumSpeed)));
}

function isMomentType(value: unknown): value is MomentType {
  return typeof value === 'string' && MOMENT_TYPES.includes(value as MomentType);
}

export function validMomentFilter(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    if (!isMomentType(value[index]) || value.indexOf(value[index]) !== index) return false;
  }
  return true;
}

// Built once, retaining consumer order. An absent filter takes every type.
export function momentRoutes<T>(consumers: readonly T[], filter: (consumer: T) => readonly MomentType[] | undefined):
  Readonly<Record<MomentType, readonly T[]>> {
  const routes = Object.fromEntries(MOMENT_TYPES.map(type => [type, [] as T[]])) as Record<MomentType, T[]>;
  for (let index = 0; index < consumers.length; index++) {
    const consumer = consumers[index]!;
    const types = filter(consumer) ?? MOMENT_TYPES;
    for (let type = 0; type < types.length; type++) routes[types[type]!].push(consumer);
  }
  for (let index = 0; index < MOMENT_TYPES.length; index++) Object.freeze(routes[MOMENT_TYPES[index]!]);
  return Object.freeze(routes);
}

// Engine-internal: the SDK exposes only the read-only moments.
type MomentSlots = { [T in MomentType]: { -readonly [K in keyof MomentOf<T>]: MomentOf<T>[K] } };
type MomentSlot<T extends MomentType> = MomentSlots[T];
type MutableCause = { -readonly [K in keyof HurtCause]: HurtCause[K] };

function noCause(): MutableCause {
  return { source: 'enemy', id: '', x: 0, y: 0, pushX: 0, pushY: 0 };
}

export function copyCause(target: Readonly<HurtCause>, source: Readonly<HurtCause>): void {
  const out = target as MutableCause;
  out.source = source.source;
  out.id = source.id;
  out.x = source.x;
  out.y = source.y;
  out.pushX = source.pushX;
  out.pushY = source.pushY;
}

const MOMENT_SEEDS: { readonly [T in MomentType]: () => MomentSlot<T> } = {
  hurt: () => ({ type: 'hurt', placement: 0, time: 0, cause: noCause(), health: 0, max: 0 }),
  block: () => ({ type: 'block', placement: 0, time: 0, id: '', x: 0, y: 0, directionX: 0, directionY: 0, normalX: 0, normalY: 0 }),
  impact: () => ({ type: 'impact', placement: 0, time: 0, x: 0, y: 0, normalX: 0, normalY: 0, speed: 0, strength: 0 }),
  death: () => ({ type: 'death', placement: 0, time: 0, cause: noCause() }),
  fall: () => ({ type: 'fall', placement: 0, time: 0 }),
  placed: () => ({ type: 'placed', placement: 0, time: 0, bonfire: null }),
  bonfire: () => ({ type: 'bonfire', placement: 0, time: 0, id: '', x: 0, y: 0 }),
  'enemy-hit': () => ({
    type: 'enemy-hit', placement: 0, time: 0, id: '', species: 'bird', x: 0, y: 0, strikeX: 0, strikeY: 0, normalX: 0,
    normalY: 0, damage: 0, health: 0, max: 0,
  }),
  'enemy-defeat': () => ({
    type: 'enemy-defeat', placement: 0, time: 0, id: '', species: 'bird', x: 0, y: 0, by: 'hammer', strikeX: 0, strikeY: 0,
    normalX: 0, normalY: 0, damage: 0, max: 0,
  }),
  launch: () => ({ type: 'launch', placement: 0, time: 0 }),
  finish: () => ({ type: 'finish', placement: 0, time: 0 }),
  sound: () => ({ type: 'sound', placement: 0, time: 0, source: '', volume: 0 }),
};

export interface MomentWriter {
  // Plain data only, including inside physics callbacks. The caller writes every other field immediately.
  append<T extends MomentType>(type: T, placement: number, time: number): MomentSlot<T>;
}

interface MomentBatch { readonly moments: readonly Moment[]; readonly count: number }

class MomentBuffer implements MomentBatch {
  readonly moments: Moment[] = [];
  count = 0;
  private readonly pools = Object.fromEntries(MOMENT_TYPES.map(type => [type, [] as Moment[]])) as {
    [T in MomentType]: MomentSlot<T>[];
  };
  private readonly used = Object.fromEntries(MOMENT_TYPES.map(type => [type, 0])) as Record<MomentType, number>;

  append<T extends MomentType>(type: T, placement: number, time: number): MomentSlot<T> {
    const pool = this.pools[type];
    const index = this.used[type]++;
    let moment = pool[index];
    if (moment === undefined) pool[index] = moment = MOMENT_SEEDS[type]();
    moment.placement = placement;
    moment.time = time;
    this.moments[this.count++] = moment;
    return moment;
  }

  clear(): void {
    this.count = 0;
    for (let index = 0; index < MOMENT_TYPES.length; index++) this.used[MOMENT_TYPES[index]!] = 0;
  }
}

export class MomentJournal implements MomentWriter {
  private waiting = new MomentBuffer();
  private spare = new MomentBuffer();
  private delivering: MomentBuffer | null = null;
  private readonly discard = Object.fromEntries(MOMENT_TYPES.map(type => [type, MOMENT_SEEDS[type]()])) as {
    [T in MomentType]: MomentSlot<T>;
  };
  private closed = false;

  append<T extends MomentType>(type: T, placement: number, time: number): MomentSlot<T> {
    if (!this.closed) return this.waiting.append(type, placement, time);
    const moment = this.discard[type];
    moment.placement = placement;
    moment.time = time;
    return moment;
  }

  take(): MomentBatch | null {
    if (this.delivering !== null) throw new Error('Cannot drain a moment journal while its batch is being delivered.');
    if (this.closed || this.waiting.count === 0) return null;
    const batch = this.waiting;
    this.waiting = this.spare;
    this.spare = batch;
    this.delivering = batch;
    return batch;
  }

  release(batch: MomentBatch): void {
    if (this.closed) return;
    if (this.delivering === null || this.delivering !== batch) throw new Error('Cannot release a foreign moment batch.');
    this.delivering.clear();
    this.delivering = null;
  }

  pendingPlacement(placement: number): Readonly<PlacedMoment> | null {
    for (let index = this.waiting.count - 1; index >= 0; index--) {
      const moment = this.waiting.moments[index]!;
      if (moment.type === 'placed' && moment.placement === placement) return moment;
    }
    return null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waiting.clear();
    this.spare.clear();
    this.delivering = null;
  }
}
