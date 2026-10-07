import type { Object3D } from 'three';
import type { Point } from './config';
import type { EnemyPose } from './enemy-types';
import { call0, createInstance, instanceContract, listPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import type { RigGeometry } from './rig';
import type { PartPose } from './simulation';
import type { DeathPlayerFrame, LivePlayerFrame } from './player-pose';
import type { ReadonlyDeathAppearance } from './death-pose';

export interface SceneDeathPlayerFrame extends DeathPlayerFrame {
  readonly presented: ReadonlyDeathAppearance;
}
export type ScenePlayerFrame = LivePlayerFrame | SceneDeathPlayerFrame;

// A read-only view of the simulation at the drawn time, not a character's temporary presentation preview.
// This object is reused and its members are borrowed: read during update(), never keep a previous-frame snapshot
// by retaining their references.
export interface SceneFrame {
  // Simulation seconds; a restart rewinds them to 0.
  readonly time: number;
  readonly parts: readonly Readonly<PartPose>[];
  readonly player: ScenePlayerFrame;
  readonly cursor: Readonly<Point>;
  readonly enemies: readonly EnemyPose[];
  readonly rig: RigGeometry;
}

export const SCENE_PASSES = Object.freeze(['course', 'actors', 'marks'] as const);
export type ScenePass = (typeof SCENE_PASSES)[number];

export interface SceneLayer {
  // Root, pass and methods stay the same for the layer's lifetime.
  readonly root: Object3D;
  // Course with the terrain; actors over it with the characters; marks over the characters and their arms,
  // under the tool. Marks' materials ignore depth (depthTest: false), leaving the arms/tool depth alone.
  readonly pass: ScenePass;
  // Only layers with update() run each drawn frame. Allocate nothing and draw only what changed.
  update?(frame: SceneFrame): void;
  // Called after the root is detached, when the layer is removed or its Game is disposed.
  dispose?(): void;
}

export type SceneLayerFactory = () => SceneLayer;
export const SCENE_LAYER_LIMITS = Object.freeze({ layers: 32 });

function layerFactory(value: unknown): SceneLayerFactory {
  if (typeof value !== 'function') throw new TypeError('A scene layer must be a factory.');
  return value as SceneLayerFactory;
}

export const SCENE_LAYERS = listPoint('scene.layers', 'runtime', SCENE_LAYER_LIMITS.layers, layerFactory);

export const SCENE_LAYER_CONTRACT = instanceContract({
  returns: 'a three.js root, a course, actors or marks pass and, when given, update(frame) and dispose()',
  methods: [],
  optional: ['update', 'dispose'],
  root: true,
  passes: SCENE_PASSES,
});

// An empty list is the engine default. Factories run once per Game, in the manifest's order.
export function createSceneLayers(plugins: RuntimePlugins): readonly Attributed<SceneLayer>[] {
  const layers: Attributed<SceneLayer>[] = [];
  try {
    for (const factory of plugins.list(SCENE_LAYERS)) {
      layers.push(createInstance(SCENE_LAYER_CONTRACT, factory, factory.value));
    }
    return layers;
  } catch (error) {
    for (let index = layers.length - 1; index >= 0; index--) {
      const layer = layers[index]!;
      if (layer.value.dispose !== undefined) call0(layer, 'dispose');
    }
    throw error;
  }
}
