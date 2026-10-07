import { CanvasTexture, Line, Mesh, Sprite } from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';
import { Disposal } from './disposal';

export function disposeResources(...roots: Object3D[]): void {
  const disposal = new Disposal();
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<CanvasTexture>();
  for (const root of roots) disposal.run(() => root.traverse((object) => {
    if (object instanceof Mesh || object instanceof Line || object instanceof Sprite) {
      if ('geometry' in object) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        if ('map' in material && material.map instanceof CanvasTexture) textures.add(material.map);
      }
    }
  }));
  for (const geometry of geometries) disposal.run(() => geometry.dispose());
  for (const material of materials) disposal.run(() => material.dispose());
  for (const texture of textures) disposal.run(() => texture.dispose());
  disposal.finish();
}
