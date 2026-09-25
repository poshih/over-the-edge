import { ART_LIMITS, artRecord } from './art-types';
import { ModelError } from './model-data';
import { validateContainer } from './visual-model';
import { modelImagePixels } from './model-images';

export function validateCourseModel(data: ArrayBuffer): { pixels: number } {
  validateContainer(data);
  const header = new DataView(data);
  const document = artRecord(JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, header.getUint32(12, true)))), 'Course GLB');
  if (!Array.isArray(document.meshes) || document.meshes.length === 0 || !Array.isArray(document.nodes) ||
    !Array.isArray(document.accessors)) throw new ModelError('The course GLB is missing meshes, nodes, or accessors.');
  if ((Array.isArray(document.skins) && document.skins.length > 0) ||
    (Array.isArray(document.animations) && document.animations.length > 0) ||
    (Array.isArray(document.extensionsUsed) && document.extensionsUsed.includes('EXT_mesh_gpu_instancing'))) {
    throw new ModelError('Course artwork must be static: no skins, animations, or nested GPU instances.');
  }
  const accessors = document.accessors;
  const meshUses = new Map<number, number>();
  for (const entry of document.nodes) {
    const node = artRecord(entry, 'GLB node');
    if (node.mesh === undefined) continue;
    if (typeof node.mesh !== 'number' || !Number.isInteger(node.mesh) || node.mesh < 0 || node.mesh >= document.meshes.length) {
      throw new ModelError('The course GLB has an invalid mesh reference.');
    }
    meshUses.set(node.mesh, (meshUses.get(node.mesh) ?? 0) + 1);
  }
  let meshes = 0, triangles = 0;
  document.meshes.forEach((entry, index) => {
    const mesh = artRecord(entry, 'GLB mesh');
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length === 0) throw new ModelError('The course GLB has an empty mesh.');
    const uses = meshUses.get(index) ?? 1;
    for (const entry of mesh.primitives) {
      const primitive = artRecord(entry, 'GLB primitive');
      if ((primitive.mode !== undefined && primitive.mode !== 4) ||
        (Array.isArray(primitive.targets) && primitive.targets.length > 0)) {
        throw new ModelError('Course artwork needs static triangle meshes without morph targets.');
      }
      const attributes = artRecord(primitive.attributes, 'GLB attributes');
      const accessorIndex = primitive.indices ?? attributes.POSITION;
      if (typeof accessorIndex !== 'number' || !Number.isInteger(accessorIndex) || accessorIndex < 0 || accessorIndex >= accessors.length) {
        throw new ModelError('The course GLB has an invalid triangle accessor.');
      }
      const accessor = artRecord(accessors[accessorIndex], 'GLB accessor');
      if (typeof accessor.count !== 'number' || !Number.isInteger(accessor.count) || accessor.count <= 0 || accessor.count % 3 !== 0) {
        throw new ModelError('The course GLB has an invalid triangle count.');
      }
      meshes += uses;
      triangles += accessor.count / 3 * uses;
    }
  });
  if (meshes > ART_LIMITS.meshes || triangles > ART_LIMITS.triangles) {
    throw new ModelError('Course artwork exceeds 16 meshes or 50,000 triangles. Optimize the GLB before sharing it.');
  }
  return { pixels: modelImagePixels(data, document) };
}
