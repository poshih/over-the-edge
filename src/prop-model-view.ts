import { Group, Mesh } from 'three';
import type { Material, Matrix4 } from 'three';
import type { LoadedCharacterModel } from './character-model-types';

/**
 * A rigid prop model, such as the one-model hammer or the pot, bound to a physical frame without
 * stretching. The model's own origin and axes follow the documented convention for its role; the
 * physical rig is unchanged. Per frame it copies one matrix.
 */
export class PropModelView {
  readonly root = new Group();
  readonly model: LoadedCharacterModel;
  private readonly statistics: { meshes: number; materials: number };
  private writes = 0;

  constructor(model: LoadedCharacterModel, name: string) {
    this.model = model;
    this.root.name = name;
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

  update(frame: Matrix4): void {
    this.root.matrix.copy(frame);
    this.root.matrixWorldNeedsUpdate = true;
    this.writes++;
  }

  inspect() {
    // Types of the materials drawn now, which shading may have swapped; diagnostic only.
    const drawn = new Set<string>();
    this.model.scene.traverse((object) => {
      if (!(object instanceof Mesh) || object.userData.characterOutline === true) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) drawn.add(material.type);
    });
    return {
      name: this.model.name,
      ...this.statistics,
      triangles: this.model.triangles,
      bounds: { min: this.model.bounds.min.toArray(), max: this.model.bounds.max.toArray() },
      transform: this.root.matrixWorld.toArray(),
      visible: this.root.visible && this.root.parent !== null,
      materialTypes: [...drawn].sort(),
      matrixWrites: this.writes,
    };
  }

  dispose(): void {
    this.root.removeFromParent();
    this.model.scene.removeFromParent();
  }
}
