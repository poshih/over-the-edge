import type { Object3D } from 'three';
import type { ProjectileBlock } from './hazards';
import { HitBursts } from './hit-bursts';
import { PluginError, slotPoint } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import type { SceneFrame } from './scene-layer';

/**
 * What shows where a projectile strikes the hammer head, held or released. Its root draws in the marks pass, over
 * the characters and their arms and under the tool, so every material must ignore depth (depthTest: false).
 */
export interface BlockEffects {
  readonly root: Object3D;
  // Called after the frame's physics steps, before drawing. The hit is borrowed: copy what is kept.
  block(hit: Readonly<ProjectileBlock>): void;
  // Each drawn frame from a block until it returns false: true while anything still shows. The frame is borrowed
  // and reused; allocate nothing. Bursts stay where they struck; a rewound frame.time at restart ends them.
  update(frame: SceneFrame): boolean;
  dispose(): void;
}

export type BlockEffectsFactory = () => BlockEffects;

function effectsFactory(value: unknown): BlockEffectsFactory {
  if (typeof value !== 'function') throw new TypeError('Block effects must be a factory.');
  return value as BlockEffectsFactory;
}

export const BLOCK_EFFECTS = slotPoint('scene.block-effects', 'runtime', effectsFactory);

class EngineBlockEffects implements BlockEffects {
  private readonly bursts = new HitBursts();
  readonly root = this.bursts.root;

  block(hit: Readonly<ProjectileBlock>): void {
    this.bursts.block(hit);
  }

  update(frame: SceneFrame): boolean {
    // Unlike hurt effects, this point has no placement clear to sample the restarted clock before its next hit.
    return this.bursts.update(frame, 'keep-pending');
  }

  dispose(): void {
    this.bursts.dispose();
  }
}

export const DEFAULT_BLOCK_EFFECTS: BlockEffectsFactory = () => new EngineBlockEffects();

export function createBlockEffects(plugins: RuntimePlugins): BlockEffects {
  const factory = plugins.slot(BLOCK_EFFECTS, DEFAULT_BLOCK_EFFECTS);
  const plugin = plugins.owner(BLOCK_EFFECTS);
  let effects: unknown;
  try { effects = factory(); } catch (error) {
    throw new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed creating "${BLOCK_EFFECTS.id}".`, plugin, BLOCK_EFFECTS.id, { cause: error });
  }
  const root: unknown = typeof effects === 'object' && effects !== null ? Reflect.get(effects, 'root') : undefined;
  if (typeof root !== 'object' || root === null || Reflect.get(root, 'isObject3D') !== true ||
    typeof Reflect.get(effects as object, 'block') !== 'function' || typeof Reflect.get(effects as object, 'update') !== 'function' ||
    typeof Reflect.get(effects as object, 'dispose') !== 'function') {
    throw new PluginError('invalid-contribution',
      `Plugin "${plugin ?? 'engine'}": block effects must return a three.js root, block(hit), update(frame) and dispose().`,
      plugin, BLOCK_EFFECTS.id);
  }
  return effects as BlockEffects;
}
