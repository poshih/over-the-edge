// The checks a GLB of the course artwork passes, by what it is: a static course mesh, which terrain places and decoration
// models draw (src/course-art-model.ts), or a skinned, animated enemy model (src/enemy-motion.ts), within the character
// model limits. Both count their images toward the course artwork's texture budget.
import { artRecord } from './art-types';
import { validateCourseModel } from './course-art-model';
import type { ModelArt } from './enemy-art-data';
import { bakeEnemyClips, bakeEnemyMotion, readEnemyModel } from './enemy-motion';
import type { EnemyClipMotion } from './enemy-motion-data';
import type { EnemySpecies } from './enemy-types';
import { MODEL_LIMITS, ModelError } from './model-data';
import { modelImagePixels } from './model-images';
import { validateContainer } from './visual-model';

export type ArtAssetUse = 'course' | 'enemy' | 'any';

// An enemy model's clips, with their lengths in seconds, and every clip's root motion by clip name.
export interface EnemyBake {
  readonly clips: readonly { readonly name: string; readonly duration: number }[];
  readonly motion: Readonly<Record<string, EnemyClipMotion>>;
}

function glbDocument(data: ArrayBuffer, label: string): Record<string, unknown> {
  const header = new DataView(data);
  return artRecord(JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, header.getUint32(12, true)))), label);
}

// The clips of an enemy model that passes its checks, and the decoded pixels of its textures.
function inspectEnemyModel(data: ArrayBuffer): { readonly clips: EnemyBake['clips']; readonly pixels: number } {
  validateContainer(data);
  const { clips } = readEnemyModel(data);
  const document = glbDocument(data, 'Enemy model GLB');
  const meshes = Array.isArray(document.meshes) ? document.meshes : [];
  const accessors = Array.isArray(document.accessors) ? document.accessors : [];
  // Each node drawing a mesh draws each of its primitives once.
  let drawn = 0;
  let triangles = 0;
  for (const entry of Array.isArray(document.nodes) ? document.nodes : []) {
    const node = artRecord(entry, 'GLB node');
    if (node.mesh === undefined) continue;
    if (typeof node.mesh !== 'number' || !Number.isInteger(node.mesh) || node.mesh < 0 || node.mesh >= meshes.length) {
      throw new ModelError('The enemy model has an invalid mesh reference.');
    }
    const mesh = artRecord(meshes[node.mesh], 'GLB mesh');
    for (const part of Array.isArray(mesh.primitives) ? mesh.primitives : []) {
      const primitive = artRecord(part, 'GLB primitive');
      if (primitive.mode !== undefined && primitive.mode !== 4) throw new ModelError('Enemy models need triangle meshes.');
      const attributes = artRecord(primitive.attributes, 'GLB attributes');
      const at = primitive.indices ?? attributes.POSITION;
      const accessor = typeof at === 'number' && Number.isInteger(at) && at >= 0 && at < accessors.length
        ? artRecord(accessors[at], 'GLB accessor') : null;
      if (accessor === null || typeof accessor.count !== 'number' || !Number.isInteger(accessor.count) || accessor.count % 3 !== 0) {
        throw new ModelError('The enemy model has an invalid triangle accessor.');
      }
      drawn++;
      triangles += accessor.count / 3;
    }
  }
  if (drawn > MODEL_LIMITS.meshes || triangles > MODEL_LIMITS.triangles) {
    throw new ModelError(`Enemy models draw at most ${MODEL_LIMITS.meshes} meshes and ${MODEL_LIMITS.triangles.toLocaleString('en-US')} triangles.`);
  }
  return { clips, pixels: modelImagePixels(data, document) };
}

export function validateEnemyModelAsset(data: ArrayBuffer): { pixels: number } {
  return { pixels: inspectEnemyModel(data).pixels };
}

// What choosing an enemy model's clips needs from its GLB, once it passes an enemy model's checks.
export function enemyModelBake(data: ArrayBuffer): EnemyBake {
  return Object.freeze({ clips: inspectEnemyModel(data).clips, motion: bakeEnemyClips(data) });
}

// Throws unless the motion `species`' model entry stores is what its clips travel in its GLB, `data`.
export function checkEnemyModelMotion(data: ArrayBuffer, entry: ModelArt, species: EnemySpecies): void {
  if (JSON.stringify(bakeEnemyMotion(data, entry.clips)) !== JSON.stringify(entry.motion)) {
    throw new ModelError(`The ${species} model's motion no longer matches its clips. Choose its clips again in the Workshop.`);
  }
}

/**
 * Checks a GLB for `use`: an enemy model's checks, or a course mesh's, or, for a GLB nothing uses yet, whichever its
 * skins and clips say it is.
 */
export function validateArtAsset(data: ArrayBuffer, use: ArtAssetUse): { pixels: number } {
  if (use === 'enemy') return validateEnemyModelAsset(data);
  if (use === 'course') return validateCourseModel(data);
  validateContainer(data);
  const document = glbDocument(data, 'Course artwork GLB');
  const animated = (Array.isArray(document.skins) && document.skins.length > 0) ||
    (Array.isArray(document.animations) && document.animations.length > 0);
  return animated ? validateEnemyModelAsset(data) : validateCourseModel(data);
}
