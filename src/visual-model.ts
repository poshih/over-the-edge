import {
  Box3, Camera, InstancedMesh, Light, Line, LoadingManager, Mesh, Points, SkinnedMesh, Texture, Vector3,
} from 'three';
import type { BufferGeometry, Group, Material, Object3D, Skeleton } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { ModelError as AppearanceError, MODEL_LIMITS } from './model-data';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const EMBEDDED_URI = /^data:(?:image\/(?:png|jpeg|webp|avif)|application\/(?:octet-stream|gltf-buffer));base64,/i;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);
const DECODER_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression', 'KHR_texture_basisu',
]);
const SUPPORTED_REQUIRED_EXTENSIONS = new Set([
  'KHR_materials_unlit', 'KHR_texture_transform', 'KHR_mesh_quantization',
  'KHR_materials_clearcoat', 'KHR_materials_dispersion', 'KHR_materials_sheen',
  'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_ior',
  'KHR_materials_emissive_strength', 'KHR_materials_specular', 'KHR_materials_iridescence',
  'KHR_materials_anisotropy', 'KHR_lights_punctual', 'EXT_mesh_gpu_instancing',
  'EXT_texture_webp', 'EXT_texture_avif',
]);

export function validateContainer(data: ArrayBuffer): void {
  if (data.byteLength < 20 || data.byteLength > MODEL_LIMITS.bytes) {
    throw new AppearanceError('Choose a GLB file no larger than 20 MiB.');
  }
  const header = new DataView(data);
  if (header.getUint32(0, true) !== GLB_MAGIC || header.getUint32(4, true) !== 2 ||
    header.getUint32(8, true) !== data.byteLength) {
    throw new AppearanceError('This is not a valid binary glTF 2.0 (.glb) file.');
  }
  let json: unknown;
  let sawBinary = false;
  let offset = 12;
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) throw new AppearanceError('The GLB chunk header is truncated.');
    const length = header.getUint32(offset, true);
    const type = header.getUint32(offset + 4, true);
    const start = offset + 8;
    if (length % 4 !== 0 || start + length > data.byteLength) {
      throw new AppearanceError('The GLB contains an invalid chunk length.');
    }
    if (offset === 12 && type !== JSON_CHUNK) throw new AppearanceError('The GLB must begin with a JSON chunk.');
    if (type === JSON_CHUNK) {
      if (json !== undefined) throw new AppearanceError('The GLB contains more than one JSON chunk.');
      try {
        json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, start, length)));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new AppearanceError('The GLB model description is not valid JSON.');
      }
    } else if (type === BIN_CHUNK) {
      if (sawBinary) throw new AppearanceError('The GLB contains more than one binary chunk.');
      sawBinary = true;
    }
    offset = start + length;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new AppearanceError('The GLB model description is missing.');
  }
  const asset: unknown = Reflect.get(json, 'asset');
  if (typeof asset !== 'object' || asset === null || Reflect.get(asset, 'version') !== '2.0') {
    throw new AppearanceError('Only glTF 2.0 models are supported.');
  }
  for (const listName of ['buffers', 'images', 'extensionsUsed', 'extensionsRequired', 'nodes']) {
    const list: unknown = Reflect.get(json, listName);
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new AppearanceError(`The GLB ${listName} section is invalid.`);
    if (listName === 'nodes' && list.length > MODEL_LIMITS.nodes) {
      throw new AppearanceError(`Use a model with at most ${MODEL_LIMITS.nodes} nodes.`);
    }
    for (const entry of list) {
      if (listName === 'extensionsUsed' || listName === 'extensionsRequired') {
        if (typeof entry !== 'string') throw new AppearanceError('The GLB extension list is invalid.');
        if (DECODER_EXTENSIONS.has(entry)) {
          throw new AppearanceError('Export an uncompressed GLB: Draco, Meshopt and KTX2 resources are not supported.');
        }
        if (listName === 'extensionsRequired' && !SUPPORTED_REQUIRED_EXTENSIONS.has(entry)) {
          throw new AppearanceError(`This GLB requires an unsupported extension: ${entry}.`);
        }
      } else if (listName === 'buffers' || listName === 'images') {
        if (typeof entry !== 'object' || entry === null) throw new AppearanceError(`The GLB ${listName} entry is invalid.`);
        const uri: unknown = Reflect.get(entry, 'uri');
        if (uri !== undefined && (typeof uri !== 'string' || !EMBEDDED_URI.test(uri))) {
          throw new AppearanceError('Embed all textures and buffers in the GLB. External files and URLs are not allowed.');
        }
        const mime: unknown = Reflect.get(entry, 'mimeType');
        if (listName === 'images' && mime !== undefined && (typeof mime !== 'string' || !IMAGE_TYPES.has(mime))) {
          throw new AppearanceError('Model textures must be PNG, JPEG, WebP or AVIF images.');
        }
      }
    }
  }
}

function resources(roots: readonly Object3D[]) {
  const geometry = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const skeletons = new Set<Skeleton>();
  for (const root of roots) root.traverse((object) => {
    if (!(object instanceof Mesh || object instanceof Line || object instanceof Points)) return;
    geometry.add(object.geometry);
    if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  return { geometry, materials, textures, skeletons };
}

export interface LoadedVisual {
  scene: Group;
  bounds: Box3;
  triangles: number;
  dispose: () => void;
}

export async function loadVisualModel(blob: Blob): Promise<LoadedVisual> {
  if (blob.size === 0 || blob.size > MODEL_LIMITS.bytes) throw new AppearanceError('Choose a GLB file no larger than 20 MiB.');
  let data: ArrayBuffer;
  try {
    data = await blob.arrayBuffer();
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    throw new AppearanceError('The selected model file could not be read.');
  }
  validateContainer(data);
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const manager = new LoadingManager();
  const objectUrls = new Set<string>();
  manager.setURLModifier((url) => {
    if (url.startsWith(`blob:${location.origin}/`)) {
      objectUrls.add(url);
      return url;
    }
    if (EMBEDDED_URI.test(url)) return url;
    throw new AppearanceError('External model resources are blocked. Use an entirely self-contained GLB.');
  });
  const loader = new GLTFLoader(manager);
  let gltf: GLTF;
  try {
    gltf = await loader.parseAsync(data, '');
  } catch (error) {
    if (error instanceof AppearanceError) throw error;
    throw new AppearanceError(`Could not read this GLB: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const url of objectUrls) URL.revokeObjectURL(url);
  }
  const owned = resources(gltf.scenes);
  let released = false;
  const dispose = (): void => {
    if (released) return;
    released = true;
    gltf.scene.removeFromParent();
    const bitmaps = new Set<ImageBitmap>();
    for (const texture of owned.textures) {
      if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) bitmaps.add(texture.image);
      texture.dispose();
    }
    for (const skeleton of owned.skeletons) skeleton.dispose();
    for (const geometry of owned.geometry) geometry.dispose();
    for (const material of owned.materials) material.dispose();
    for (const bitmap of bitmaps) bitmap.close();
  };
  try {
    const remove: Object3D[] = [];
    let meshes = 0;
    let triangles = 0;
    gltf.scene.traverse((object) => {
      if (object instanceof Light || object instanceof Camera || object instanceof Line || object instanceof Points) remove.push(object);
      if (object instanceof Mesh) {
        meshes++;
        const count = object.geometry.index?.count ?? object.geometry.getAttribute('position')?.count;
        if (count === undefined) throw new AppearanceError('A model mesh is missing its vertex positions.');
        triangles += count / 3 * (object instanceof InstancedMesh ? object.count : 1);
      }
    });
    for (const object of remove) object.removeFromParent();
    if (meshes === 0 || meshes > MODEL_LIMITS.meshes || triangles > MODEL_LIMITS.triangles) {
      throw new AppearanceError(`Use a model with 1-${MODEL_LIMITS.meshes} meshes and at most ${MODEL_LIMITS.triangles.toLocaleString()} triangles.`);
    }
    for (const texture of owned.textures) {
      const image: unknown = texture.image;
      if (typeof image === 'object' && image !== null) {
        const width: unknown = Reflect.get(image, 'width');
        const height: unknown = Reflect.get(image, 'height');
        if (typeof width === 'number' && typeof height === 'number' &&
          Math.max(width, height) > MODEL_LIMITS.textureEdge) {
          throw new AppearanceError(`Texture dimensions must not exceed ${MODEL_LIMITS.textureEdge} pixels.`);
        }
      }
    }
    gltf.scene.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(gltf.scene, true);
    const dimensions = bounds.getSize(new Vector3());
    if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite) ||
      Math.max(dimensions.x, dimensions.y, dimensions.z) < MODEL_LIMITS.minimumSpan ||
      Math.max(dimensions.x, dimensions.y, dimensions.z) > MODEL_LIMITS.maximumSpan) {
      throw new AppearanceError('The model has no finite, visible mesh bounds.');
    }
    return { scene: gltf.scene, bounds, triangles, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
