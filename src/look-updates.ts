import type { BurningBonfire } from './bonfires';
import type { EnemyEvent } from './enemy-types';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// State changes are separate from the moment journal: enemy envelopes are pooled, and bonfire/switch state coalesces.
// The simulation supplies immutable enemy snapshots and burning bonfires.
export class LookUpdates {
  readonly enemies: EnemyEvent[] = [];
  enemyCount = 0;
  burning: readonly BurningBonfire[] | null = null;
  switches: readonly string[] | null = null;
  private readonly resets: Mutable<Extract<EnemyEvent, { readonly type: 'reset' }>>[] = [];
  private readonly upserts: Mutable<Extract<EnemyEvent, { readonly type: 'upsert' }>>[] = [];
  private readonly removes: Mutable<Extract<EnemyEvent, { readonly type: 'remove' }>>[] = [];
  private resetCount = 0;
  private upsertCount = 0;
  private removeCount = 0;

  get pending(): boolean {
    return this.enemyCount > 0 || this.burning !== null || this.switches !== null;
  }

  enemy(event: EnemyEvent): void {
    if (event.type === 'reset') {
      const index = this.resetCount++;
      let staged = this.resets[index];
      if (staged === undefined) this.resets[index] = staged = { type: 'reset', poses: event.poses };
      else staged.poses = event.poses;
      this.enemies[this.enemyCount++] = staged;
    } else if (event.type === 'upsert') {
      const index = this.upsertCount++;
      let staged = this.upserts[index];
      if (staged === undefined) this.upserts[index] = staged = { type: 'upsert', pose: event.pose };
      else staged.pose = event.pose;
      this.enemies[this.enemyCount++] = staged;
    } else {
      const index = this.removeCount++;
      let staged = this.removes[index];
      if (staged === undefined) this.removes[index] = staged = { type: 'remove', id: event.id };
      else staged.id = event.id;
      this.enemies[this.enemyCount++] = staged;
    }
  }

  clear(): void {
    this.enemyCount = 0;
    this.burning = this.switches = null;
    this.resetCount = this.upsertCount = this.removeCount = 0;
  }
}
