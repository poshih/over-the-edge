export const ART_LIMITS = {
  assets: 64,
  catalog: 500,
  parts: 128,
  bytes: 20 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  packageBytes: 96 * 1024 * 1024,
  triangles: 50_000,
  meshes: 16,
  texturePixels: 32 * 1024 * 1024,
  prompt: 1024,
} as const;

export class ArtError extends Error {}
export type ArtMode = 'shapes' | 'meshes';
export type ArtMirror = 'none' | 'x' | 'diagonal';
export interface TerrainArt {
  readonly assetId: string;
  readonly mirror: ArtMirror;
}
export interface ArtAsset {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly createdAt: number;
  readonly owner: string;
}
export interface ArtVariant {
  readonly id: string;
  readonly name: string;
  readonly prefab: string;
  readonly parts: readonly { readonly index: number; readonly assetId: string }[];
  readonly owner: string;
}
export interface ArtCatalog {
  readonly assets: readonly ArtAsset[];
  readonly variants: readonly ArtVariant[];
}
export interface ArtResource {
  readonly id: string;
  readonly name: string;
  readonly source: string;
}

export function artRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ArtError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function artId(value: unknown): string {
  if (typeof value !== 'string' || !/^asset-[a-f0-9]{64}$/.test(value)) throw new ArtError('Invalid artwork asset ID.');
  return value;
}

export function artName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new ArtError('Asset and variant names need 1-80 characters.');
  return value.trim();
}

export function validateTerrainArt(value: unknown): TerrainArt {
  const data = artRecord(value, 'Terrain artwork');
  if (Object.keys(data).length !== 2 || (data.mirror !== 'none' && data.mirror !== 'x' && data.mirror !== 'diagonal')) {
    throw new ArtError('Terrain artwork needs an asset ID and a supported mirror transform.');
  }
  return Object.freeze({ assetId: artId(data.assetId), mirror: data.mirror });
}

export function validateArtVariant(value: unknown): ArtVariant {
  const data = artRecord(value, 'Prefab artwork variant');
  if (typeof data.id !== 'string' || !/^variant-[a-f0-9-]{36}$/.test(data.id) ||
    typeof data.prefab !== 'string' || !/^[a-z0-9-]{1,32}$/.test(data.prefab) ||
    typeof data.owner !== 'string' || !data.owner || data.owner.length > 256 ||
    !Array.isArray(data.parts) || data.parts.length === 0 || data.parts.length > ART_LIMITS.parts) {
    throw new ArtError('Invalid prefab artwork variant.');
  }
  const parts = data.parts.map((entry) => {
    const part = artRecord(entry, 'Prefab artwork part');
    if (typeof part.index !== 'number' || !Number.isInteger(part.index) || part.index < 0 || part.index >= ART_LIMITS.parts) {
      throw new ArtError('Invalid prefab artwork part index.');
    }
    return Object.freeze({ index: part.index, assetId: artId(part.assetId) });
  });
  if (new Set(parts.map((part) => part.index)).size !== parts.length) throw new ArtError('A prefab part may only have one asset.');
  return Object.freeze({ id: data.id, name: artName(data.name), prefab: data.prefab, parts: Object.freeze(parts), owner: data.owner });
}

export function validateArtCatalog(value: unknown): ArtCatalog {
  const data = artRecord(value, 'Shared artwork catalog');
  if (!Array.isArray(data.assets) || data.assets.length > ART_LIMITS.catalog ||
    !Array.isArray(data.variants) || data.variants.length > ART_LIMITS.catalog) {
    throw new ArtError('The shared artwork catalog exceeds its supported size.');
  }
  const assets = data.assets.map((entry): ArtAsset => {
    const asset = artRecord(entry, 'Shared asset');
    if (typeof asset.bytes !== 'number' || !Number.isInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > ART_LIMITS.bytes ||
      typeof asset.createdAt !== 'number' || !Number.isFinite(asset.createdAt) ||
      typeof asset.owner !== 'string' || !asset.owner || asset.owner.length > 256) throw new ArtError('Invalid shared asset metadata.');
    return Object.freeze({
      id: artId(asset.id), name: artName(asset.name), bytes: asset.bytes, createdAt: asset.createdAt, owner: asset.owner,
    });
  });
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) throw new ArtError('Duplicate shared asset IDs.');
  const variants = data.variants.map(validateArtVariant);
  const ids = new Set(assets.map((asset) => asset.id));
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length ||
    variants.some((variant) => variant.parts.some((part) => !ids.has(part.assetId)))) {
    throw new ArtError('A shared variant has duplicate IDs or missing assets.');
  }
  return Object.freeze({ assets: Object.freeze(assets), variants: Object.freeze(variants) });
}
