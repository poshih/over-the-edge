import type { EnemyEvent } from './enemy-types';
import type { GameEvent } from './game-events';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type EventType = GameEvent['type'];
type EventOf<T extends EventType> = Mutable<Extract<GameEvent, { readonly type: T }>>;

const EVENT_SEEDS: { readonly [T in EventType]: EventOf<T> } = {
  hurt: { type: 'hurt', health: 0, max: 0 },
  death: { type: 'death' },
  fall: { type: 'fall' },
  respawn: { type: 'respawn', bonfire: null },
  restart: { type: 'restart' },
  bonfire: { type: 'bonfire', id: '' },
  'enemy-hit': { type: 'enemy-hit', id: '' },
  'enemy-defeat': { type: 'enemy-defeat', id: '' },
  impact: { type: 'impact', strength: 0 },
  launch: { type: 'launch' },
  finish: { type: 'finish' },
  sound: { type: 'sound', source: '', volume: 0 },
};
const EVENT_TYPES = Object.keys(EVENT_SEEDS) as EventType[];

/**
 * One reusable batch. Pools and ordered storage retain their high-water capacity, growing only on larger bursts.
 * Enemy poses and lit sets are immutable snapshots supplied by the simulation; only their envelopes are pooled here.
 */
export class GameNotifications {
  readonly events: GameEvent[] = [];
  eventCount = 0;
  readonly enemies: EnemyEvent[] = [];
  enemyCount = 0;
  lit: readonly string[] | null = null;
  private readonly pools: { [T in EventType]: EventOf<T>[] } = {
    hurt: [], death: [], fall: [], respawn: [], restart: [], bonfire: [],
    'enemy-hit': [], 'enemy-defeat': [], impact: [], launch: [], finish: [], sound: [],
  };
  private readonly used: Record<EventType, number> = {
    hurt: 0, death: 0, fall: 0, respawn: 0, restart: 0, bonfire: 0,
    'enemy-hit': 0, 'enemy-defeat': 0, impact: 0, launch: 0, finish: 0, sound: 0,
  };
  private readonly enemyResets: Mutable<Extract<EnemyEvent, { readonly type: 'reset' }>>[] = [];
  private readonly enemyUpserts: Mutable<Extract<EnemyEvent, { readonly type: 'upsert' }>>[] = [];
  private readonly enemyRemoves: Mutable<Extract<EnemyEvent, { readonly type: 'remove' }>>[] = [];
  private resetCount = 0;
  private upsertCount = 0;
  private removeCount = 0;

  get pending(): boolean {
    return this.eventCount > 0 || this.enemyCount > 0 || this.lit !== null;
  }

  event<T extends EventType>(type: T): EventOf<T> {
    const pool = this.pools[type];
    const index = this.used[type]++;
    let event = pool[index];
    if (event === undefined) {
      event = { ...EVENT_SEEDS[type] };
      pool[index] = event;
    }
    this.events[this.eventCount++] = event;
    return event;
  }

  enemy(event: EnemyEvent): void {
    if (event.type === 'reset') {
      const index = this.resetCount++;
      let staged = this.enemyResets[index];
      if (staged === undefined) this.enemyResets[index] = staged = { type: 'reset', poses: event.poses };
      else staged.poses = event.poses;
      this.enemies[this.enemyCount++] = staged;
    } else if (event.type === 'upsert') {
      const index = this.upsertCount++;
      let staged = this.enemyUpserts[index];
      if (staged === undefined) this.enemyUpserts[index] = staged = { type: 'upsert', pose: event.pose };
      else staged.pose = event.pose;
      this.enemies[this.enemyCount++] = staged;
    } else {
      const index = this.removeCount++;
      let staged = this.enemyRemoves[index];
      if (staged === undefined) this.enemyRemoves[index] = staged = { type: 'remove', id: event.id };
      else staged.id = event.id;
      this.enemies[this.enemyCount++] = staged;
    }
  }

  clear(): void {
    this.eventCount = 0;
    this.enemyCount = 0;
    this.lit = null;
    this.resetCount = this.upsertCount = this.removeCount = 0;
    for (const type of EVENT_TYPES) this.used[type] = 0;
  }
}
