import { ART_LIMITS, ArtError, artId, artName, artRecord } from './art-types';
import type { ArtResource } from './art-types';
import { validateDecorationArt } from './decoration-art';
import type { DecorationArt } from './decoration-art';
import { terrainAssets, validateLevel } from './level';
import type { LevelDefinition } from './level';

export interface CoursePackage {
  readonly format: 'over-the-edge-course';
  readonly schemaVersion: 3;
  readonly level: LevelDefinition;
  readonly assets: readonly ArtResource[];
  // The assets that draw decoration models, in place of the built-in models of the same IDs.
  readonly decorations: DecorationArt;
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
  if (data.format !== 'over-the-edge-course' || data.schemaVersion !== 3 ||
    !Array.isArray(data.assets) || data.assets.length > ART_LIMITS.assets) throw new ArtError('Unsupported course package.');
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
  for (const asset of terrainAssets(level)) {
    if (!ids.has(asset)) throw new ArtError(`The package's level places mesh ${asset}, which it does not contain.`);
  }
  return Object.freeze({
    format: 'over-the-edge-course', schemaVersion: 3, level,
    assets: Object.freeze(assets), decorations: validateDecorationArt(data.decorations, ids),
  });
}
