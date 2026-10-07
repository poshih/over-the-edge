import { HUD } from '../hud-readouts';
import { CHARACTER_CHOICE } from '../character-choice';
import { LOOKS } from '../object-looks';
import { CAMERA } from '../camera-director';
import { BACKDROP } from '../backdrop';
import { AIM_MARKS } from '../aim-marks';
import { HURT_EFFECTS } from '../hurt-effects';
import { BLOCK_EFFECTS } from '../block-effects';
import { DEATH_POSE } from '../death-pose';
import { DEATH_SCREEN } from '../death-screen';
import { SCENE_LAYERS } from '../scene-layer';
import { AUDIO } from '../game-audio';
import { MESSAGES } from '../event-presenter';
import { EVENTS } from '../game-events';
import { INPUT_BINDINGS, INPUT_DEVICES } from '../input';
import { attributed, call1, checkFacetEntries, Composition, PluginError } from './kernel';
import type { Attributed, Contribution, KeyedPoint, ListPoint, SlotPoint } from './kernel';

export interface RuntimeHost {
  readonly plugin: string;
  readonly signal: AbortSignal;
  notice(message: string, kind?: 'info' | 'error'): void;
}
export interface RuntimeFacet {
  start(host: RuntimeHost): readonly Contribution[];
}

export function defineRuntime<T extends RuntimeFacet>(facet: T): T { return facet; }

export const RUNTIME = Object.freeze([
  ...Object.values(HUD), CHARACTER_CHOICE, ...Object.values(LOOKS),
  CAMERA, BACKDROP, AIM_MARKS, HURT_EFFECTS, BLOCK_EFFECTS, DEATH_POSE, SCENE_LAYERS, AUDIO, ...Object.values(MESSAGES), DEATH_SCREEN,
  EVENTS, INPUT_BINDINGS, INPUT_DEVICES,
]);

function checkRuntime(value: unknown, plugin: string): RuntimeFacet {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof Reflect.get(value, 'start') !== 'function') {
    throw new PluginError('invalid-facet', `Plugin "${plugin}" must default-export a runtime facet with start(host).`, plugin);
  }
  return value as RuntimeFacet;
}

/** One Game's runtime extensions. Owners dispose consumers first, then this session's signals in reverse order. */
export class RuntimePlugins {
  private readonly composition: Composition;
  private readonly controllers: readonly AbortController[];

  private constructor(composition: Composition, controllers: readonly AbortController[]) {
    this.composition = composition;
    this.controllers = controllers;
  }

  static start(value: unknown, options: Pick<RuntimeHost, 'notice'>): RuntimePlugins {
    const entries = checkFacetEntries(value, checkRuntime);
    const controllers: AbortController[] = [];
    try {
      const plugins = entries.map(({ id, facet }) => {
        const controller = new AbortController();
        controllers.push(controller);
        const host: RuntimeHost = Object.freeze({ plugin: id, signal: controller.signal, notice: options.notice });
        const contributions = call1(attributed(id, null, facet), 'start', host);
        return { plugin: id, contributions };
      });
      return new RuntimePlugins(new Composition('runtime', RUNTIME, plugins), controllers);
    } catch (error) {
      for (let index = controllers.length - 1; index >= 0; index--) controllers[index]!.abort();
      throw error;
    }
  }

  slot<T>(point: SlotPoint<T>, base: T): Attributed<T> { return this.composition.slot(point, base); }
  keyed<T extends { readonly id: string }>(point: KeyedPoint<T>, builtIns: readonly T[]): ReadonlyMap<string, T> {
    return this.composition.keyed(point, builtIns);
  }
  list<T>(point: ListPoint<T>): readonly Attributed<T>[] { return this.composition.list(point); }

  dispose(): void {
    for (let index = this.controllers.length - 1; index >= 0; index--) this.controllers[index]!.abort();
  }
}
