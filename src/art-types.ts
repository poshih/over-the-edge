export const ART_LIMITS = {
  assets: 64,
  bytes: 20 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  packageBytes: 96 * 1024 * 1024,
  triangles: 50_000,
  meshes: 16,
  texturePixels: 32 * 1024 * 1024,
} as const;

export class ArtError extends Error {}
export type ArtMode = 'shapes' | 'meshes';
export type ArtMirror = 'none' | 'x' | 'diagonal';
export interface TerrainArt {
  readonly assetId: string;
  readonly mirror: ArtMirror;
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
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new ArtError('Asset names need 1-80 characters.');
  return value.trim();
}

export function validateTerrainArt(value: unknown): TerrainArt {
  const data = artRecord(value, 'Terrain artwork');
  if (Object.keys(data).length !== 2 || (data.mirror !== 'none' && data.mirror !== 'x' && data.mirror !== 'diagonal')) {
    throw new ArtError('Terrain artwork needs an asset ID and a supported mirror transform.');
  }
  return Object.freeze({ assetId: artId(data.assetId), mirror: data.mirror });
}
