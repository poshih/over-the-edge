import { artRecord } from './art-types';
import { forEachModelImage } from './model-images';
import { MODEL_LIMITS, ModelError } from './model-data';
import { validateContainer } from './visual-model';

// Mesh-drawing primitive modes: triangles, strip and fan. Points and lines are dropped on load.
const TRIANGLE_MODES = new Set([4, 5, 6]);

/**
 * Checks an appearance part GLB against the limits the runtime loader enforces (mesh count,
 * triangles and texture size) without decoding it, so tools and servers can reject a model before
 * a release fails to start with it.
 */
export function checkAppearanceModel(data: ArrayBuffer): void {
  validateContainer(data);
  const header = new DataView(data);
  const document = artRecord(JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, header.getUint32(12, true)))), 'Appearance GLB');
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const nodes = list(document.nodes);
  const meshes = list(document.meshes);
  const accessors = list(document.accessors);
  const scenes = list(document.scenes);
  const sceneIndex = document.scene ?? 0;
  if (typeof sceneIndex !== 'number' || !Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= scenes.length) {
    throw new ModelError('The GLB has no default scene to display.');
  }
  const count = (index: unknown): number => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= accessors.length) {
      throw new ModelError('The GLB has an invalid accessor reference.');
    }
    const value = artRecord(accessors[index], 'GLB accessor').count;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new ModelError('The GLB has an invalid accessor count.');
    return value;
  };
  let meshCount = 0;
  let triangles = 0;
  const visited = new Set<number>();
  const visit = (index: unknown): void => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= nodes.length) {
      throw new ModelError('The GLB has an invalid node reference.');
    }
    if (visited.has(index)) return;
    visited.add(index);
    const node = artRecord(nodes[index], 'GLB node');
    if (node.mesh !== undefined) {
      if (typeof node.mesh !== 'number' || !Number.isInteger(node.mesh) || node.mesh < 0 || node.mesh >= meshes.length) {
        throw new ModelError('The GLB has an invalid mesh reference.');
      }
      const extensions = typeof node.extensions === 'object' && node.extensions !== null ? node.extensions as Record<string, unknown> : {};
      const instancing = extensions.EXT_mesh_gpu_instancing;
      let instances = 1;
      if (typeof instancing === 'object' && instancing !== null) {
        const attributes = artRecord(Reflect.get(instancing, 'attributes'), 'GPU instancing attributes');
        const first = Object.values(attributes)[0];
        instances = first === undefined ? 1 : count(first);
      }
      for (const entry of list(artRecord(meshes[node.mesh], 'GLB mesh').primitives)) {
        const primitive = artRecord(entry, 'GLB primitive');
        const mode = primitive.mode ?? 4;
        if (!TRIANGLE_MODES.has(mode as number)) continue;
        const vertices = count(primitive.indices ?? artRecord(primitive.attributes, 'GLB attributes').POSITION);
        meshCount++;
        triangles += (mode === 4 ? vertices / 3 : Math.max(0, vertices - 2)) * instances;
      }
    }
    for (const child of list(node.children)) visit(child);
  };
  for (const root of list(artRecord(scenes[sceneIndex], 'GLB scene').nodes)) visit(root);
  if (meshCount === 0 || meshCount > MODEL_LIMITS.meshes || triangles > MODEL_LIMITS.triangles) {
    throw new ModelError(`Use a model with 1-${MODEL_LIMITS.meshes} meshes and at most ${MODEL_LIMITS.triangles.toLocaleString()} triangles.`);
  }
  forEachModelImage(data, document, 'appearance', (width, height) => {
    if (Math.max(width, height) > MODEL_LIMITS.textureEdge) {
      throw new ModelError(`Texture dimensions must not exceed ${MODEL_LIMITS.textureEdge} pixels.`);
    }
  }, 'skip');
}
