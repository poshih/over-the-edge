import type { HurtCause } from './hazards';
import { listPoint, PluginError } from './plugins/kernel';

/**
 * Gameplay notifications, delivered in source order after the frame's physics steps, looks and audio.
 * Events are read-only, borrowed objects: the engine reuses them. Read during event(), never retain an event.
 * Copy individual values into the observer's own state if they are needed later.
 */
export type GameEvent =
  // A hit took health and the player survived it: what dealt it, and the health left.
  | { readonly type: 'hurt'; readonly health: number; readonly max: number; readonly cause: Readonly<HurtCause> }
  // Health death sequence entry: what dealt the killing hit.
  | { readonly type: 'death'; readonly cause: Readonly<HurtCause> }
  // Fall sequence entry, taking precedence when health also runs out in that step.
  | { readonly type: 'fall' }
  // Placement after the death/fall wait; null when the reset path returns to the attempt's start.
  | { readonly type: 'respawn'; readonly bonfire: string | null }
  // A new attempt, including Reset, a rebuilt rig or a replacement level; not a checkpoint return.
  | { readonly type: 'restart' }
  // A bonfire other than the current checkpoint becomes the checkpoint, including a previously lit one.
  | { readonly type: 'bonfire'; readonly id: string }
  | { readonly type: 'enemy-hit'; readonly id: string }
  | { readonly type: 'enemy-defeat'; readonly id: string }
  // Normalized 0..1 strength; impacts are limited at the source to one per 70 ms.
  | { readonly type: 'impact'; readonly strength: number }
  | { readonly type: 'launch' }
  | { readonly type: 'finish' }
  // An authored play-sound action, not a cue preview.
  | { readonly type: 'sound'; readonly source: string; readonly volume: number };

export interface GameObserver {
  // Synchronous; promise-like results are errors. Borrow the event only for this call.
  event(event: GameEvent): void;
  dispose?(): void;
}

export type GameObserverFactory = () => GameObserver;
export const GAME_OBSERVER_LIMITS = Object.freeze({ observers: 32 });

export const EVENTS = listPoint('game.events', 'runtime', GAME_OBSERVER_LIMITS.observers, (value: unknown): GameObserverFactory => {
  if (typeof value !== 'function') throw new TypeError('A game observer must be a factory.');
  return value as GameObserverFactory;
});

export function checkGameObserver(value: unknown, plugin: string): GameObserver {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    typeof Reflect.get(value, 'event') !== 'function' ||
    Reflect.get(value, 'dispose') !== undefined && typeof Reflect.get(value, 'dispose') !== 'function') {
    throw new PluginError('invalid-contribution',
      `Plugin "${plugin}": "${EVENTS.id}" must return event(event) and, when given, dispose().`, plugin, EVENTS.id);
  }
  return value as GameObserver;
}
