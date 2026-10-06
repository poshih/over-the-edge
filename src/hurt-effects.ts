import type { Object3D } from 'three';
import type { HurtCause } from './hazards';
import { LavaFire } from './lava-fire';
import { PluginError, slotPoint } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import type { SceneFrame } from './scene-layer';

/**
 * What shows on the character when something hurts it, by what did: the engine sets it alight in lava, and a game can
 * draw its own effect for each cause. Its root draws in the marks pass, over the characters and their arms and under
 * the tool, so every material must ignore depth (depthTest: false).
 */
export interface HurtEffects {
  readonly root: Object3D;
  // A hit took health, the killing one when `fatal`: what dealt it. Called after the frame's physics steps, before the
  // frame is drawn. The cause is borrowed: copy what is kept.
  hurt(cause: Readonly<HurtCause>, fatal: boolean): void;
  // The player was placed anew, at a restart or back at a bonfire: effects that follow the character end.
  clear(): void;
  // Each drawn frame from a hurt or a clear until it returns false: true while something still shows. The frame is
  // borrowed and reused; allocate nothing.
  update(frame: SceneFrame): boolean;
  dispose(): void;
}

export type HurtEffectsFactory = () => HurtEffects;

function effectsFactory(value: unknown): HurtEffectsFactory {
  if (typeof value !== 'function') throw new TypeError('Hurt effects must be a factory.');
  return value as HurtEffectsFactory;
}

export const HURT_EFFECTS = slotPoint('scene.hurt-effects', 'runtime', effectsFactory);

// The engine's: flames over the character while lava burns it. Other hits show nothing more.
export const DEFAULT_HURT_EFFECTS: HurtEffectsFactory = () => new LavaFire();

export function createHurtEffects(plugins: RuntimePlugins): HurtEffects {
  const factory = plugins.slot(HURT_EFFECTS, DEFAULT_HURT_EFFECTS);
  const plugin = plugins.owner(HURT_EFFECTS);
  let effects: unknown;
  try { effects = factory(); } catch (error) {
    throw new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed creating "${HURT_EFFECTS.id}".`, plugin, HURT_EFFECTS.id, { cause: error });
  }
  const root: unknown = typeof effects === 'object' && effects !== null ? Reflect.get(effects, 'root') : undefined;
  if (typeof root !== 'object' || root === null || Reflect.get(root, 'isObject3D') !== true ||
    typeof Reflect.get(effects as object, 'hurt') !== 'function' || typeof Reflect.get(effects as object, 'clear') !== 'function' ||
    typeof Reflect.get(effects as object, 'update') !== 'function' || typeof Reflect.get(effects as object, 'dispose') !== 'function') {
    throw new PluginError('invalid-contribution',
      `Plugin "${plugin ?? 'engine'}": hurt effects must return a three.js root, hurt(cause, fatal), clear(), update(frame) and dispose().`,
      plugin, HURT_EFFECTS.id);
  }
  return effects as HurtEffects;
}
