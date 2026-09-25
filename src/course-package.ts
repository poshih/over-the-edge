import { ART_LIMITS, ArtError, artId, artName, artRecord, validateArtVariant } from './art-types';
import type { ArtMode, ArtResource, ArtVariant } from './art-types';
import { validateLevel } from './level';
import type { LevelDefinition } from './level';

export interface CoursePackage {
  readonly format: 'over-the-edge-course';
  readonly schemaVersion: 1;
  readonly mode: ArtMode;
  readonly level: LevelDefinition;
  readonly assets: readonly ArtResource[];
  readonly variants: readonly ArtVariant[];
}

export function isCoursePackage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'format') === 'over-the-edge-course';
}

export function embeddedGlb(source: string): Uint8Array<ArrayBuffer> {
  const prefix = 'data:model/gltf-binary;base64,';
  if (!source.startsWith(prefix)) throw new ArtError('Course packages require embedded GLBs, not remote URLs.');
  const data = source.slice(prefix.length);
  if (data.length === 0 || data.length % 4 !== 0 || data.length > Math.ceil(ART_LIMITS.bytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new ArtError('Invalid or oversized embedded GLB.');
  }
  const binary = atob(data);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function validateCoursePackage(value: unknown): CoursePackage {
  const data = artRecord(value, 'Course package');
  if (data.format !== 'over-the-edge-course' || data.schemaVersion !== 1 ||
    (data.mode !== 'shapes' && data.mode !== 'meshes') ||
    !Array.isArray(data.assets) || data.assets.length > ART_LIMITS.assets ||
    !Array.isArray(data.variants) || data.variants.length > ART_LIMITS.catalog) throw new ArtError('Unsupported course package.');
  let bytes = 0;
  const assets = data.assets.map((entry): ArtResource => {
    const asset = artRecord(entry, 'Packaged asset');
    if (typeof asset.source !== 'string') throw new ArtError('Missing packaged GLB.');
    bytes += embeddedGlb(asset.source).byteLength;
    if (bytes > ART_LIMITS.totalBytes) throw new ArtError('Course artwork exceeds the 64 MiB budget.');
    return Object.freeze({ id: artId(asset.id), name: artName(asset.name), source: asset.source });
  });
  const ids = new Set(assets.map((asset) => asset.id));
  if (ids.size !== assets.length) throw new ArtError('Duplicate packaged assets.');
  const level = validateLevel(data.level);
  for (const object of level.objects) {
    if (object.kind === 'terrain' && object.art !== undefined && !ids.has(object.art.assetId)) {
      throw new ArtError(`Artwork for terrain "${object.id}" is missing from this package.`);
    }
  }
  const variants = data.variants.map(validateArtVariant);
  if (variants.some((variant) => variant.parts.some((part) => !ids.has(part.assetId)))) {
    throw new ArtError('A packaged prefab variant references missing artwork.');
  }
  return Object.freeze({
    format: 'over-the-edge-course', schemaVersion: 1, mode: data.mode, level,
    assets: Object.freeze(assets), variants: Object.freeze(variants),
  });
}
