import type { Moment, MomentType } from './moments';
import { validMomentFilter } from './moments';
import { instanceContract, listPoint } from './plugins/kernel';

export interface GameObserver {
  // Fixed for its lifetime; absent means every type.
  readonly moments?: readonly MomentType[];
  // Synchronous. The moment and its nested cause are borrowed for this call only.
  moment(moment: Moment): void;
  dispose?(): void;
}

export type GameObserverFactory = () => GameObserver;
export const GAME_OBSERVER_LIMITS = Object.freeze({ observers: 32 });

export const OBSERVERS = listPoint('game.observers', 'runtime', GAME_OBSERVER_LIMITS.observers, (value: unknown): GameObserverFactory => {
  if (typeof value !== 'function') throw new TypeError('A game observer must be a factory.');
  return value as GameObserverFactory;
});

export const OBSERVER_CONTRACT = instanceContract({
  returns: 'moment(moment), a valid optional moments filter and, when given, dispose()',
  methods: ['moment'],
  optional: ['dispose'],
  capture: ['moments'],
  check: value => validMomentFilter(Reflect.get(value, 'moments')),
});
