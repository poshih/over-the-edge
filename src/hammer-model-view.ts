import { Group, Mesh } from 'three';
import type { Material, Matrix4 } from 'three';
import type { LoadedCharacterModel } from './character-model-types';

/**
 * A one-model hammer bound rigidly to the physical tool frame: origin at the butt of the handle,
 * handle along +X, in metres. It replaces the stretched shaft and separate head without changing
 * the physical rig; per frame it copies one matrix.
 */
export class HammerModelView {
  readonly root = new Group();
  readonly model: LoadedCharacterModel;
  private readonly statistics: { meshes: number; materials: number };
  private writes = 0;

  constructor(model: LoadedCharacterModel) {
    this.model = model;
    this.root.name = 'one-model-hammer';
    this.root.matrixAutoUpdate = false;
    model.scene.removeFromParent();
    this.root.add(model.scene);
    let meshes = 0;
    const materials = new Set<Material>();
    model.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      meshes++;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    this.statistics = { meshes, materials: materials.size };
  }

  update(toolFrame: Matrix4): void {
    this.root.matrix.copy(toolFrame);
    this.root.matrixWorldNeedsUpdate = true;
    this.writes++;
  }

  inspect() {
    return {
      name: this.model.name,
      ...this.statistics,
      triangles: this.model.triangles,
      bounds: { min: this.model.bounds.min.toArray(), max: this.model.bounds.max.toArray() },
      transform: this.root.matrixWorld.toArray(),
      visible: this.root.visible && this.root.parent !== null,
      matrixWrites: this.writes,
    };
  }

  dispose(): void {
    this.root.removeFromParent();
    this.model.scene.removeFromParent();
  }
}
