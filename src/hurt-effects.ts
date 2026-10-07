import { Group } from 'three';
import type { Object3D } from 'three';
import type { HurtCause } from './hazards';
import { HitBursts } from './hit-bursts';
import { LavaFire } from './lava-fire';
import { createInstance, instanceContract, slotPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
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

// The engine's: flames over the character while lava burns it, and a burst where a blade or a projectile strikes it.
// Enemy bumps show nothing more.
class EngineHurtEffects implements HurtEffects {
  readonly root = new Group();
  private readonly fire = new LavaFire();
  private readonly bursts = new HitBursts();

  constructor() {
    this.root.add(this.fire.root, this.bursts.root);
  }

  hurt(cause: Readonly<HurtCause>, fatal: boolean): void {
    this.fire.hurt(cause, fatal);
    this.bursts.hurt(cause);
  }

  clear(): void {
    this.fire.clear();
    this.bursts.clear();
  }

  update(frame: SceneFrame): boolean {
    const burning = this.fire.update(frame);
    const striking = this.bursts.update(frame);
    return burning || striking;
  }

  dispose(): void {
    this.fire.dispose();
    this.bursts.dispose();
  }
}

export const DEFAULT_HURT_EFFECTS: HurtEffectsFactory = () => new EngineHurtEffects();

const HURT_EFFECTS_CONTRACT = instanceContract({
  returns: 'a three.js root, hurt(cause, fatal), clear(), update(frame) and dispose()',
  methods: ['hurt', 'clear', 'update', 'dispose'],
  root: true,
});

export function createHurtEffects(plugins: RuntimePlugins): Attributed<HurtEffects> {
  const factory = plugins.slot(HURT_EFFECTS, DEFAULT_HURT_EFFECTS);
  return createInstance(HURT_EFFECTS_CONTRACT, factory, factory.value);
}
