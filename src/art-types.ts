export const ART_LIMITS = {
  assets: 64,
  bytes: 20 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  packageBytes: 96 * 1024 * 1024,
  triangles: 50_000,
  meshes: 16,
  texturePixels: 32 * 1024 * 1024,
  decorationModels: 128,
} as const;

export class ArtError extends Error {}
// How a release draws its course: its meshes, or every terrain object as its collision outline extruded.
export type ArtMode = 'shapes' | 'meshes';
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
