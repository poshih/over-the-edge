import { createInstance, instanceContract, slotPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';

export interface FatalDisplay {
  show(message: string): void;
  dispose?(): void;
}

export type FatalDisplayFactory = (element: HTMLElement) => FatalDisplay;

// Release-shell chrome, kept across load attempts and Games. Other environments use the engine's writer.
export const FATAL = slotPoint('release.fatal', 'release', (value: unknown): FatalDisplayFactory => {
  if (typeof value !== 'function') throw new TypeError('A fatal display must be a factory.');
  return value as FatalDisplayFactory;
});

export const DEFAULT_FATAL: FatalDisplayFactory = (element) => ({
  show(message): void {
    element.hidden = false;
    element.textContent = message;
  },
});

const FATAL_DISPLAY_CONTRACT = instanceContract({
  returns: 'show(message) and, when given, dispose()',
  methods: ['show'],
  optional: ['dispose'],
});

export function createFatalDisplay(factory: Attributed<FatalDisplayFactory>, element: HTMLElement): Attributed<FatalDisplay> {
  const create = factory.value;
  return createInstance(FATAL_DISPLAY_CONTRACT, factory, () => create(element));
}
