import type { Object3D } from 'three';
import type { Point } from './config';
import type { EnemyPose } from './enemy-types';
import { listPoint, PluginError } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import type { RigGeometry } from './rig';
import type { PartPose } from './simulation';

// A read-only view of the simulation at the drawn time, not a character's temporary presentation preview.
// This object is reused and its members are borrowed: read during update(), never keep a previous-frame snapshot
// by retaining their references.
export interface SceneFrame {
  // Simulation seconds; a restart rewinds them to 0.
  readonly time: number;
  readonly parts: readonly Readonly<PartPose>[];
  readonly cursor: Readonly<Point>;
  readonly enemies: readonly EnemyPose[];
  readonly rig: RigGeometry;
}

export interface SceneLayer {
  // Root, pass and methods stay the same for the layer's lifetime.
  readonly root: Object3D;
  // Course with the terrain; actors over it with the characters; marks over the characters and their arms,
  // under the tool. Marks' materials ignore depth (depthTest: false), leaving the arms/tool depth alone.
  readonly pass: 'course' | 'actors' | 'marks';
  // Only layers with update() run each drawn frame. Allocate nothing and draw only what changed.
  update?(frame: SceneFrame): void;
  // Called after the root is detached, when the layer is removed or its Game is disposed.
  dispose?(): void;
}

export type SceneLayerFactory = () => SceneLayer;
export const SCENE_LAYER_LIMITS = Object.freeze({ layers: 32 });
const PASSES: readonly SceneLayer['pass'][] = ['course', 'actors', 'marks'];

function layerFactory(value: unknown): SceneLayerFactory {
  if (typeof value !== 'function') throw new TypeError('A scene layer must be a factory.');
  return value as SceneLayerFactory;
}

export const SCENE_LAYERS = listPoint('scene.layers', 'runtime', SCENE_LAYER_LIMITS.layers, layerFactory);

// Runtime layers and Workshop overlays share this check and contract.
export function checkSceneLayer(value: unknown, refusal: {
  readonly plugin: string | null;
  readonly code: 'invalid-contribution' | 'invalid-plugin';
  readonly point: string | null;
  readonly label: string;
}): SceneLayer {
  const root: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'root') : undefined;
  if (typeof root !== 'object' || root === null || Reflect.get(root, 'isObject3D') !== true ||
    !PASSES.includes(Reflect.get(value as object, 'pass') as SceneLayer['pass']) ||
    Reflect.get(value as object, 'update') !== undefined && typeof Reflect.get(value as object, 'update') !== 'function' ||
    Reflect.get(value as object, 'dispose') !== undefined && typeof Reflect.get(value as object, 'dispose') !== 'function') {
    throw new PluginError(refusal.code,
      `Plugin "${refusal.plugin ?? 'engine'}": ${refusal.label} must return a three.js root, a course, actors or marks pass and, when given, update(frame) and dispose().`,
      refusal.plugin, refusal.point);
  }
  return value as SceneLayer;
}

// An empty list is the engine default. Factories run once per Game, in the manifest's order.
export function createSceneLayers(plugins: RuntimePlugins): readonly SceneLayer[] {
  const layers: SceneLayer[] = [];
  try {
    for (const { plugin, value: factory } of plugins.list(SCENE_LAYERS)) {
      let layer: unknown;
      try { layer = factory(); } catch (error) {
        throw new PluginError('plugin-failed', `Plugin "${plugin}" failed creating "${SCENE_LAYERS.id}".`, plugin, SCENE_LAYERS.id, { cause: error });
      }
      layers.push(checkSceneLayer(layer, {
        plugin, code: 'invalid-contribution', point: SCENE_LAYERS.id, label: 'a scene layer',
      }));
    }
    return layers;
  } catch (error) {
    for (let index = layers.length - 1; index >= 0; index--) layers[index]!.dispose?.();
    throw error;
  }
}
