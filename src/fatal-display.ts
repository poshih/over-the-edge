import { PluginError, slotPoint } from './plugins/kernel';

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

export function createFatalDisplay(factory: FatalDisplayFactory, element: HTMLElement, plugin: string | null): FatalDisplay {
  try {
    const display: unknown = factory(element);
    if (typeof display !== 'object' || display === null || Array.isArray(display) ||
      typeof Reflect.get(display, 'show') !== 'function' ||
      Reflect.get(display, 'dispose') !== undefined && typeof Reflect.get(display, 'dispose') !== 'function') {
      throw new PluginError('invalid-contribution',
        `Plugin "${plugin ?? 'engine'}": "${FATAL.id}" must return show(message) and, when given, dispose().`, plugin, FATAL.id);
    }
    return display as FatalDisplay;
  } catch (error) {
    if (error instanceof PluginError && error.plugin === plugin && error.point === FATAL.id) throw error;
    throw new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed creating "${FATAL.id}".`,
      plugin, FATAL.id, { cause: error });
  }
}
