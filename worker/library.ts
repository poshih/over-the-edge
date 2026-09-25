import { ART_LIMITS, artId, artName, validateArtVariant } from '../src/art-types';
import type { ArtAsset, ArtCatalog, ArtVariant } from '../src/art-types';
import { validateCourseModel } from '../src/course-art-model';
import { modelAssetId } from '../src/model-data';
import type { ArtEnvironment } from './environment';
import { HttpError } from './environment';

export async function saveAsset(data: ArrayBuffer, name: string, owner: string, env: ArtEnvironment): Promise<ArtAsset> {
  validateCourseModel(data);
  const id = await modelAssetId(data);
  const existing = await env.ART_DB.prepare('SELECT id, name, bytes, owner, created_at AS createdAt FROM art_assets WHERE id = ?')
    .bind(id).first<ArtAsset>();
  if (existing) return existing;
  const createdAt = Date.now();
  await env.ART_FILES.put(`assets/${id}.glb`, data, { httpMetadata: { contentType: 'model/gltf-binary' } });
  await env.ART_DB.prepare(`INSERT OR IGNORE INTO art_assets (id, name, bytes, owner, created_at)
    SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM art_assets) < ?`)
    .bind(id, artName(name), data.byteLength, owner, createdAt, ART_LIMITS.catalog).run();
  const asset = await env.ART_DB.prepare('SELECT id, name, bytes, owner, created_at AS createdAt FROM art_assets WHERE id = ?')
    .bind(id).first<ArtAsset>();
  if (!asset) {
    await env.ART_FILES.delete(`assets/${id}.glb`);
    throw new HttpError(409, 'The shared library is full. Ask the host to archive assets before adding more.');
  }
  return asset;
}

export async function catalog(env: ArtEnvironment): Promise<ArtCatalog> {
  const [assets, variants] = await Promise.all([
    env.ART_DB.prepare('SELECT id, name, bytes, owner, created_at AS createdAt FROM art_assets ORDER BY created_at DESC').all<ArtAsset>(),
    env.ART_DB.prepare('SELECT id, name, prefab, parts, owner FROM art_variants ORDER BY created_at DESC')
      .all<Omit<ArtVariant, 'parts'> & { parts: string }>(),
  ]);
  return { assets: assets.results, variants: variants.results.map((variant) => validateArtVariant({
    ...variant, parts: JSON.parse(variant.parts),
  })) };
}

export async function saveVariant(value: unknown, owner: string, env: ArtEnvironment): Promise<ArtVariant> {
  const variant = validateArtVariant(value);
  if (variant.owner !== owner) throw new HttpError(403, 'Publish variants using your own editor identity.');
  for (const part of variant.parts) {
    if (!await env.ART_DB.prepare('SELECT id FROM art_assets WHERE id = ?').bind(artId(part.assetId)).first()) {
      throw new HttpError(400, 'A prefab variant references an asset that is not in the shared library.');
    }
  }
  await env.ART_DB.prepare(`INSERT OR IGNORE INTO art_variants (id, name, prefab, parts, owner, created_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM art_variants) < ?`)
    .bind(variant.id, variant.name, variant.prefab, JSON.stringify(variant.parts), owner, Date.now(), ART_LIMITS.catalog).run();
  const stored = await env.ART_DB.prepare('SELECT owner, name, prefab, parts FROM art_variants WHERE id = ?')
    .bind(variant.id).first<{ owner: string; name: string; prefab: string; parts: string }>();
  if (!stored) throw new HttpError(409, 'The shared prefab variant library is full.');
  if (stored.owner !== owner || stored.name !== variant.name || stored.prefab !== variant.prefab ||
    stored.parts !== JSON.stringify(variant.parts)) throw new HttpError(409, 'That variant ID is already used. Publish a new variant instead.');
  return variant;
}
