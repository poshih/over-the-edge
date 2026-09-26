import type { Box3, Group, Object3D } from 'three';
import type { CharacterModel } from './character-profile';
import type { CharacterModelReport, CharacterModelUsage } from './character-model-inspect';

// A validated, parsed character GLB. Views place `scene` but never dispose it; its owner does.
export interface LoadedCharacterModel {
  readonly name: string;
  readonly source: string;
  readonly usage: CharacterModelUsage;
  readonly report: CharacterModelReport;
  readonly scene: Group;
  readonly bounds: Box3;
  readonly triangles: number;
  readonly nodes: ReadonlyMap<number, Object3D>;
  dispose(): void;
}

// Injected by hosts that support imported models, so releases without them omit the GLB loader.
export interface CharacterModelLoader {
  load(model: CharacterModel, usage: CharacterModelUsage, signal: AbortSignal): Promise<LoadedCharacterModel>;
}
