import type { Object3D } from 'three';
import type { ProjectileBlock } from './hazards';
import { HitBursts } from './hit-bursts';
import { createInstance, instanceContract, slotPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
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

const BLOCK_EFFECTS_CONTRACT = instanceContract({
  returns: 'a three.js root, block(hit), update(frame) and dispose()',
  methods: ['block', 'update', 'dispose'],
  root: true,
});

export function createBlockEffects(plugins: RuntimePlugins): Attributed<BlockEffects> {
  const factory = plugins.slot(BLOCK_EFFECTS, DEFAULT_BLOCK_EFFECTS);
  return createInstance(BLOCK_EFFECTS_CONTRACT, factory, factory.value);
}
