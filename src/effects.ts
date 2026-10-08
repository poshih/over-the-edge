import type { Object3D } from 'three';
import { Disposal } from './disposal';
import { EnemyHealthBars } from './enemy-health-bars';
import { HitBursts } from './hit-bursts';
import { LavaFire } from './lava-fire';
import { momentRoutes, validMomentFilter } from './moments';
import type { Moment, MomentType } from './moments';
import { call0, call1, createInstance, instanceContract, invalidResult, listPoint, slotPoint } from './plugins/kernel';
import type { CheckedInstance } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import type { SceneFrame } from './scene-frame';
import { SCENE_PASSES } from './scene-layer';
import type { ScenePass } from './scene-layer';

export interface MomentEffect {
  readonly root: Object3D;
  readonly pass: ScenePass;
  // Fixed for its lifetime; absent means every type. Marks materials must ignore depth.
  readonly moments?: readonly MomentType[];
  // In journal order, current placement only. Borrow the moment and nested cause only for this call.
  moment(moment: Moment): void;
  // Each drawn frame after a moment, until false. As drawn, including previews; borrow the frame and allocate nothing.
  update(frame: SceneFrame): boolean;
  // After the root is detached.
  dispose(): void;
}

export type MomentEffectFactory = () => MomentEffect;
export const EFFECT_LIMITS = Object.freeze({ extras: 32 });

function effectFactory(value: unknown): MomentEffectFactory {
  if (typeof value !== 'function') throw new TypeError('A moment effect must be a factory.');
  return value as MomentEffectFactory;
}

export const EFFECTS = Object.freeze({
  strikes: slotPoint('effects.strikes', 'runtime', effectFactory),
  lava: slotPoint('effects.lava', 'runtime', effectFactory),
  enemyHealth: slotPoint('effects.enemy-health', 'runtime', effectFactory),
  extras: listPoint('effects.extras', 'runtime', EFFECT_LIMITS.extras, effectFactory),
});

export const DEFAULT_EFFECTS: Readonly<{
  readonly strikes: MomentEffectFactory; readonly lava: MomentEffectFactory; readonly enemyHealth: MomentEffectFactory;
}> = Object.freeze({
  strikes: () => new HitBursts(),
  lava: () => new LavaFire(),
  enemyHealth: () => new EnemyHealthBars(),
});

const EFFECT_CONTRACT = instanceContract({
  returns: 'a three.js root, a course, actors or marks pass, a valid optional moments filter, moment(moment), update(frame) and dispose()',
  methods: ['moment', 'update', 'dispose'],
  root: true,
  passes: SCENE_PASSES,
  capture: ['moments'],
  check: value => validMomentFilter(Reflect.get(value, 'moments')),
});

interface Receiver { readonly effect: CheckedInstance<MomentEffect>; readonly index: number }

export class SceneEffects {
  readonly all: readonly CheckedInstance<MomentEffect>[];
  private readonly routes: Readonly<Record<MomentType, readonly Receiver[]>>;
  private readonly flags: Uint8Array;
  private readonly updating: Int32Array;
  private updatingCount = 0;
  private shown: number;
  private disposed = false;

  constructor(plugins: RuntimePlugins, placement: number) {
    this.shown = placement;
    const created: CheckedInstance<MomentEffect>[] = [];
    try {
      const strikes = plugins.slot(EFFECTS.strikes, DEFAULT_EFFECTS.strikes);
      created.push(createInstance(EFFECT_CONTRACT, strikes, strikes.value));
      const lava = plugins.slot(EFFECTS.lava, DEFAULT_EFFECTS.lava);
      created.push(createInstance(EFFECT_CONTRACT, lava, lava.value));
      const enemyHealth = plugins.slot(EFFECTS.enemyHealth, DEFAULT_EFFECTS.enemyHealth);
      created.push(createInstance(EFFECT_CONTRACT, enemyHealth, enemyHealth.value));
      for (const factory of plugins.list(EFFECTS.extras)) {
        created.push(createInstance(EFFECT_CONTRACT, factory, factory.value));
      }
      this.all = Object.freeze(created);
      this.routes = momentRoutes(created.map((effect, index) => ({ effect, index })), ({ effect }) => effect.captured.moments);
      this.flags = new Uint8Array(created.length);
      this.updating = new Int32Array(created.length);
    } catch (error) {
      const disposal = new Disposal();
      disposal.run(() => { throw error; });
      for (let index = created.length - 1; index >= 0; index--) {
        const effect = created[index]!;
        disposal.run(() => effect.value.root.removeFromParent());
        disposal.run(() => call0(effect, 'dispose'));
      }
      disposal.finish();
      throw error;
    }
  }

  get placement(): number { return this.shown; }
  get active(): boolean { return this.updatingCount > 0; }
  takes(type: MomentType): boolean { return this.routes[type].length > 0; }

  moment(moment: Moment, placement: number): void {
    if (this.disposed || moment.placement !== placement) return;
    if (moment.type === 'placed') {
      if (this.shown === moment.placement) return;
      this.shown = moment.placement;
    }
    const receivers = this.routes[moment.type];
    for (let at = 0; at < receivers.length; at++) {
      const receiver = receivers[at]!;
      call1(receiver.effect, 'moment', moment);
      if (this.disposed) return;
      if (this.flags[receiver.index] !== 0) continue;
      this.flags[receiver.index] = 1;
      // Keep update order in slot/manifest order without scanning inactive effects each drawn frame.
      let index = this.updatingCount++;
      while (index > 0 && this.updating[index - 1]! > receiver.index) {
        this.updating[index] = this.updating[index - 1]!;
        index--;
      }
      this.updating[index] = receiver.index;
    }
  }

  update(frame: SceneFrame): void {
    if (this.disposed) return;
    let remaining = 0;
    for (let at = 0; at < this.updatingCount; at++) {
      const index = this.updating[at]!;
      const effect = this.all[index]!;
      const active = call1(effect, 'update', frame);
      if (typeof active !== 'boolean') throw invalidResult(effect, 'update(frame) must return a boolean');
      if (this.disposed) return;
      if (active) this.updating[remaining++] = index;
      else this.flags[index] = 0;
    }
    this.updatingCount = remaining;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.updatingCount = 0;
    this.flags.fill(0);
    const disposal = new Disposal();
    for (let index = this.all.length - 1; index >= 0; index--) {
      const effect = this.all[index]!;
      disposal.run(() => effect.value.root.removeFromParent());
      disposal.run(() => call0(effect, 'dispose'));
    }
    disposal.finish();
  }
}
