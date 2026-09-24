import {
  DIRECTIONAL_LIMITS, DirectionalError, validateDirectionalPresentation,
  validateDirectionalReferences as validatePresentationReferences,
} from './directional-data.ts';
import type { DirectionalPresentation } from './directional-data.ts';
import { FACING_DIRECTIONS, SKELETON_LIMITS, SkeletonError, validateDirection, validateSkeleton, validateSkin } from './skeleton-data.ts';
import type { FacingDirection, SkeletonDefinition, SpriteSkin } from './skeleton-data.ts';
import { ARM_FORWARD_DISTANCE_LIMITS, DEFAULT_ARM_FORWARD_DISTANCE } from './character-depth.ts';

export const CHARACTER_RIGGING_TYPES = ['sprite-2d', 'model-3d', 'avatar-3d'] as const;
export type CharacterRiggingType = (typeof CHARACTER_RIGGING_TYPES)[number];
export const DEFAULT_CHARACTER_RIGGING_TYPE: CharacterRiggingType = 'model-3d';

export interface SpriteOffset {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SpriteImage {
  readonly id: string;
  readonly name: string;
  readonly source: string;
}

export interface SpriteLayer {
  readonly id: string;
  readonly name: string;
  readonly anchor: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly offset: SpriteOffset;
  readonly rotation: number;
  readonly bone: string | null;
  readonly directions: readonly FacingDirection[];
  readonly skin: SpriteSkin | null;
  readonly tileLength: number | null;
}

export interface CharacterPresentation {
  readonly characterRiggingType: CharacterRiggingType;
  readonly armForwardDistance: number;
}

export interface SpriteDocument extends CharacterPresentation {
  readonly schemaVersion: 6;
  readonly images: readonly SpriteImage[];
  readonly layers: readonly SpriteLayer[];
  readonly skeleton: SkeletonDefinition | null;
  // null preserves legacy fixed-sector facing without presentation rotation.
  readonly presentation: DirectionalPresentation | null;
}

export const SPRITE_LIMITS = {
  layers: DIRECTIONAL_LIMITS.layers,
  images: 128,
  id: 80,
  name: 120,
  imageBytes: 8 * 1024 * 1024,
  documentBytes: 24 * 1024 * 1024,
  textureEdge: 4096,
  decodedPixels: 16 * 1024 * 1024,
  minimumSize: 0.01,
  size: 16,
  offset: 16,
  rotation: 180,
  fetchMilliseconds: 30_000,
} as const;

export const DEFAULT_SPRITE_RIGGING = Object.freeze({
  bone: null,
  directions: Object.freeze([...FACING_DIRECTIONS]),
  skin: null,
  tileLength: null,
});

export const SPRITE_FIELDS = [
  { key: 'width', label: 'Sprite width', min: SPRITE_LIMITS.minimumSize, max: SPRITE_LIMITS.size, step: 0.01, unit: 'local' },
  { key: 'height', label: 'Sprite height', min: SPRITE_LIMITS.minimumSize, max: SPRITE_LIMITS.size, step: 0.01, unit: 'local' },
  { key: 'x', label: 'Sprite offset X', min: -SPRITE_LIMITS.offset, max: SPRITE_LIMITS.offset, step: 0.01, unit: 'local' },
  { key: 'y', label: 'Sprite offset Y', min: -SPRITE_LIMITS.offset, max: SPRITE_LIMITS.offset, step: 0.01, unit: 'local' },
  { key: 'z', label: 'Sprite depth', min: -SPRITE_LIMITS.offset, max: SPRITE_LIMITS.offset, step: 0.01, unit: 'local' },
  { key: 'rotation', label: 'Sprite rotation', min: -SPRITE_LIMITS.rotation, max: SPRITE_LIMITS.rotation, step: 1, unit: 'deg' },
] as const;

export const EMPTY_SPRITES: SpriteDocument = Object.freeze({
  schemaVersion: 6, characterRiggingType: DEFAULT_CHARACTER_RIGGING_TYPE,
  armForwardDistance: DEFAULT_ARM_FORWARD_DISTANCE,
  images: Object.freeze([]), layers: Object.freeze([]), skeleton: null, presentation: null,
});

export class SpriteError extends Error {}

export function validateArmForwardDistance(value: unknown): number {
  return number(value, ARM_FORWARD_DISTANCE_LIMITS.min, ARM_FORWARD_DISTANCE_LIMITS.max, 'Arm forward distance');
}

export function validateCharacterRiggingType(value: unknown, layerCount: number): CharacterRiggingType {
  for (const type of CHARACTER_RIGGING_TYPES) {
    if (value !== type) continue;
    if (type === 'sprite-2d' && layerCount === 0) {
      throw new SpriteError('A 2D sprite character needs artwork. Load the complete example or import a profile first; switch to Mesh parts or Avatar before deleting its last layer.');
    }
    return type;
  }
  throw new SpriteError('Choose a character type: sprite-2d, model-3d, or avatar-3d.');
}

const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const imageJsonBytes = new WeakMap<readonly SpriteImage[], number>();

export function validateSpriteBudget(document: SpriteDocument): void {
  const encoder = new TextEncoder();
  let images = imageJsonBytes.get(document.images);
  if (images === undefined) {
    images = encoder.encode(JSON.stringify(document.images)).byteLength;
    if (Object.isFrozen(document.images) && document.images.every(Object.isFrozen)) imageJsonBytes.set(document.images, images);
  }
  const metadata = encoder.encode(JSON.stringify({ ...document, images: [] })).byteLength;
  if (metadata + images - 2 > SPRITE_LIMITS.documentBytes) {
    throw new SpriteError('The sprite document exceeds its file-size budget.');
  }
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new SpriteError(`${label} must contain exactly ${keys.join(', ')}.`);
  }
  return Object.fromEntries(keys.map(key => [key, Reflect.get(value, key)]));
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SpriteError(`${label} must be nonempty text of at most ${maximum} characters.`);
  }
  return value.trim();
}

function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SpriteError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

export function inspectPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 33 || bytes.byteLength > SPRITE_LIMITS.imageBytes ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new SpriteError(`Choose a PNG image no larger than ${SPRITE_LIMITS.imageBytes / 1024 ** 2} MiB.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) {
    throw new SpriteError('The PNG must begin with its image header.');
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || Math.max(width, height) > SPRITE_LIMITS.textureEdge) {
    throw new SpriteError(`Sprite dimensions must be 1-${SPRITE_LIMITS.textureEdge} pixels.`);
  }
  return { width, height };
}

export function embeddedPng(source: string): Uint8Array<ArrayBuffer> | null {
  if (!source.startsWith(PNG_PREFIX)) return null;
  const encoded = source.slice(PNG_PREFIX.length);
  if (encoded.length === 0 || encoded.length % 4 !== 0 ||
    encoded.length > Math.ceil(SPRITE_LIMITS.imageBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new SpriteError('The embedded PNG encoding is invalid or exceeds the image limit.');
  }
  const decoded = atob(encoded);
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  inspectPng(bytes);
  return bytes;
}

export function encodePng(bytes: Uint8Array): string {
  inspectPng(bytes);
  const chunkSize = 8192;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return PNG_PREFIX + btoa(binary);
}

function imageSource(value: unknown): string {
  if (typeof value !== 'string') throw new SpriteError('A sprite image requires a PNG source.');
  if (value.startsWith(PNG_PREFIX)) return value;
  if (value.length > 2048 || value.includes('\\') || value !== value.trim()) {
    throw new SpriteError('Use an embedded PNG, public HTTP(S) URL, or /site-relative image path.');
  }
  let url: URL;
  try {
    url = new URL(value, 'https://sprite.invalid');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new SpriteError('The sprite image URL is invalid.');
  }
  const absolute = /^https?:\/\//i.test(value);
  const local = value.startsWith('/') && !value.startsWith('//') && url.origin === 'https://sprite.invalid';
  if ((!absolute && !local) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new SpriteError('Use a public HTTP(S) URL without credentials or a /site-relative image path.');
  }
  return value;
}

export function validateSpriteLayer(value: unknown): SpriteLayer {
  const layer = record(value, ['id', 'name', 'anchor', 'image', 'width', 'height', 'offset', 'rotation',
    'bone', 'directions', 'skin', 'tileLength'], 'A sprite layer');
  const offset = record(layer.offset, ['x', 'y', 'z'], 'A sprite offset');
  let skin: SpriteSkin | null;
  let directions: FacingDirection[];
  try {
    skin = layer.skin === null ? null : validateSkin(layer.skin);
    if (!Array.isArray(layer.directions) || layer.directions.length === 0 || layer.directions.length > FACING_DIRECTIONS.length) {
      throw new SpriteError('Choose 1-8 visible directions for each sprite layer.');
    }
    directions = layer.directions.map(validateDirection);
  } catch (error) {
    if (error instanceof SkeletonError) throw new SpriteError(error.message, { cause: error });
    throw error;
  }
  if (new Set(directions).size !== directions.length) throw new SpriteError('A sprite direction must not be repeated.');
  const bone = layer.bone === null ? null : text(layer.bone, SPRITE_LIMITS.id, 'Attachment bone');
  const tileLength = layer.tileLength === null ? null :
    number(layer.tileLength, SPRITE_LIMITS.minimumSize, SPRITE_LIMITS.size, 'Shaft tile length');
  if (skin !== null && (bone !== null || tileLength !== null)) {
    throw new SpriteError('A weighted mesh binds in skeleton space, not to a single bone or tiled shaft.');
  }
  return Object.freeze({
    id: text(layer.id, SPRITE_LIMITS.id, 'Sprite ID'),
    name: text(layer.name, SPRITE_LIMITS.name, 'Sprite name'),
    anchor: text(layer.anchor, SPRITE_LIMITS.id, 'Sprite anchor'),
    image: text(layer.image, SPRITE_LIMITS.id, 'Sprite image ID'),
    width: number(layer.width, SPRITE_LIMITS.minimumSize, SPRITE_LIMITS.size, 'Sprite width'),
    height: number(layer.height, SPRITE_LIMITS.minimumSize, SPRITE_LIMITS.size, 'Sprite height'),
    offset: Object.freeze({
      x: number(offset.x, -SPRITE_LIMITS.offset, SPRITE_LIMITS.offset, 'Sprite offset X'),
      y: number(offset.y, -SPRITE_LIMITS.offset, SPRITE_LIMITS.offset, 'Sprite offset Y'),
      z: number(offset.z, -SPRITE_LIMITS.offset, SPRITE_LIMITS.offset, 'Sprite depth'),
    }),
    rotation: number(layer.rotation, -SPRITE_LIMITS.rotation, SPRITE_LIMITS.rotation, 'Sprite rotation'),
    bone, directions: Object.freeze(directions), skin, tileLength,
  });
}

function migrateSpriteLayer(value: unknown, version: number): unknown {
  if (version >= 5) return value;
  const keys = ['id', 'name', 'anchor', 'image', 'width', 'height', 'offset', 'rotation', 'underlay'];
  if (version >= 2) keys.push('bone', 'directions', 'skin', 'tileLength');
  const old = record(value, keys, 'A legacy sprite layer');
  if (old.underlay !== 'replace' && old.underlay !== 'overlay') {
    throw new SpriteError('A legacy sprite underlay must be replace or overlay.');
  }
  delete old.underlay;
  return version === 1 ? { ...old, ...DEFAULT_SPRITE_RIGGING } : old;
}

function migrateCharacterType(value: unknown, version: number, layerCount: number): CharacterRiggingType {
  if (version < 4 || version === 4 && value === 'hybrid') {
    return layerCount > 0 ? 'sprite-2d' : 'model-3d';
  }
  if (version === 4 && value !== 'sprite-2d' && value !== 'model-3d') {
    throw new SpriteError('Schema-4 character type must be model-3d, sprite-2d, or hybrid.');
  }
  return validateCharacterRiggingType(value, layerCount);
}

export function spriteMigrationNotice(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const version: unknown = Reflect.get(value, 'schemaVersion');
  const removedHybrid = version === 1 || version === 2 || version === 3 ||
    version === 4 && Reflect.get(value, 'characterRiggingType') === 'hybrid';
  if (!removedHybrid) return null;
  return 'This older profile used Hybrid rendering. It now uses pure 2D when sprite layers exist, otherwise Mesh parts. ' +
    'Missing sprite artwork no longer reveals 3D parts. The original save or file is unchanged; Save writes the new format.';
}

// The loader validates image bytes as it acquires them, without decoding cached sources again.
export function validateSpriteMetadata(value: unknown): SpriteDocument {
  const version = typeof value === 'object' && value !== null ? Reflect.get(value, 'schemaVersion') : undefined;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6) {
    throw new SpriteError('Sprite documents require schema version 1, 2, 3, 4, 5 or 6.');
  }
  const legacy = version === 1;
  const fields = ['schemaVersion', 'images', 'layers'];
  if (version >= 2) fields.push('skeleton');
  if (version >= 3) fields.push('presentation');
  if (version >= 4) fields.push('characterRiggingType');
  if (version >= 6) fields.push('armForwardDistance');
  const document = record(value, fields, 'A sprite document');
  if (!Array.isArray(document.images) || !Array.isArray(document.layers) ||
    document.images.length > SPRITE_LIMITS.images || document.layers.length > SPRITE_LIMITS.layers) {
    throw new SpriteError(`Sprite documents allow at most ${SPRITE_LIMITS.images} images and ${SPRITE_LIMITS.layers} layers.`);
  }
  const imageIds = new Set<string>();
  let bytes = 0;
  const images = document.images.map((value: unknown): SpriteImage => {
    const image = record(value, ['id', 'name', 'source'], 'A sprite image');
    const id = text(image.id, SPRITE_LIMITS.id, 'Sprite image ID');
    if (imageIds.has(id)) throw new SpriteError(`Duplicate sprite image ID: ${id}.`);
    imageIds.add(id);
    const source = imageSource(image.source);
    bytes += source.length;
    return Object.freeze({ id, name: text(image.name, SPRITE_LIMITS.name, 'Sprite image name'), source });
  });
  if (bytes > SPRITE_LIMITS.documentBytes) {
    throw new SpriteError('The sprite document exceeds its file-size budget.');
  }
  const layerIds = new Set<string>();
  const usedImages = new Set<string>();
  const layers = document.layers.map((value: unknown) => {
    const layer = validateSpriteLayer(migrateSpriteLayer(value, version));
    if (layerIds.has(layer.id)) throw new SpriteError(`Duplicate sprite layer ID: ${layer.id}.`);
    if (!imageIds.has(layer.image)) throw new SpriteError(`Sprite ${layer.id} references a missing image.`);
    layerIds.add(layer.id);
    usedImages.add(layer.image);
    return layer;
  });
  if (usedImages.size !== imageIds.size) throw new SpriteError('Remove images that are not used by any sprite layer.');
  let skeleton: SkeletonDefinition | null;
  let presentation: DirectionalPresentation | null;
  try {
    skeleton = legacy || document.skeleton === null ? null : validateSkeleton(document.skeleton);
    presentation = version < 3 || document.presentation === null ? null : validateDirectionalPresentation(document.presentation);
  } catch (error) {
    if (error instanceof SkeletonError || error instanceof DirectionalError) throw new SpriteError(error.message, { cause: error });
    throw error;
  }
  validateSpriteRigging(layers, skeleton);
  validateDirectionalReferences(presentation, layers, skeleton);
  const characterRiggingType = migrateCharacterType(document.characterRiggingType, version, layers.length);
  const armForwardDistance = version >= 6
    ? validateArmForwardDistance(document.armForwardDistance) : DEFAULT_ARM_FORWARD_DISTANCE;
  const result: SpriteDocument = Object.freeze({
    schemaVersion: 6, characterRiggingType, armForwardDistance,
    images: Object.freeze(images), layers: Object.freeze(layers), skeleton, presentation,
  });
  validateSpriteBudget(result);
  return result;
}

export function validateSpriteDocument(value: unknown): SpriteDocument {
  const document = validateSpriteMetadata(value);
  const sources = new Set<string>();
  let pixels = 0;
  for (const image of document.images) {
    if (sources.has(image.source)) continue;
    sources.add(image.source);
    const png = embeddedPng(image.source);
    if (png === null) continue;
    const size = inspectPng(png);
    pixels += size.width * size.height;
    if (pixels > SPRITE_LIMITS.decodedPixels) {
      throw new SpriteError('The sprite document exceeds its image-memory budget.');
    }
  }
  return document;
}

export function validateSpriteRigging(layers: readonly SpriteLayer[], skeleton: SkeletonDefinition | null): void {
  const bones = new Set(skeleton?.bones.map(bone => bone.id));
  let vertices = 0;
  for (const layer of layers) {
    if (layer.bone !== null && !bones.has(layer.bone)) throw new SpriteError(`Sprite "${layer.name}" references a missing bone.`);
    if (layer.skin !== null) {
      vertices += layer.skin.weights.length;
      for (const weights of layer.skin.weights) for (const weight of weights) {
        if (!bones.has(weight.bone)) throw new SpriteError(`Sprite "${layer.name}" has a missing weight bone "${weight.bone}".`);
      }
    }
  }
  if (vertices > SKELETON_LIMITS.vertices) throw new SpriteError(`Weighted sprites exceed the ${SKELETON_LIMITS.vertices}-vertex budget.`);
}

export function validateDirectionalReferences(
  presentation: DirectionalPresentation | null,
  layers: readonly SpriteLayer[],
  skeleton: SkeletonDefinition | null,
): void {
  try {
    validatePresentationReferences(presentation, layers, skeleton);
  } catch (error) {
    if (error instanceof DirectionalError) throw new SpriteError(error.message, { cause: error });
    throw error;
  }
}

export function validateSpriteAnchors(document: SpriteDocument, anchors: Iterable<string>, targets?: Iterable<string>): void {
  validateCharacterRiggingType(document.characterRiggingType, document.layers.length);
  validateArmForwardDistance(document.armForwardDistance);
  const available = new Set(anchors);
  for (const layer of document.layers) {
    if (!available.has(layer.anchor)) throw new SpriteError(`Sprite ${layer.id} references unknown anchor "${layer.anchor}".`);
  }
  if (document.skeleton !== null) {
    if (!available.has(document.skeleton.anchor)) throw new SpriteError(`Unknown skeleton anchor "${document.skeleton.anchor}".`);
    const ports = new Set(targets === undefined ? available : targets);
    for (const ik of document.skeleton.ik) {
      if (!ports.has(ik.target)) throw new SpriteError(`Unknown IK target "${ik.target}".`);
    }
  }
  if (document.presentation !== null && !available.has(document.presentation.pivot.anchor)) {
    throw new SpriteError(`Unknown directional pivot anchor "${document.presentation.pivot.anchor}".`);
  }
  validateDirectionalReferences(document.presentation, document.layers, document.skeleton);
}

export function parseSpriteDocument(
  serialized: string,
  options: { onMigration?: (message: string) => void } = {},
): SpriteDocument {
  if (serialized.length > SPRITE_LIMITS.documentBytes ||
    new TextEncoder().encode(serialized).byteLength > SPRITE_LIMITS.documentBytes) {
    throw new SpriteError('The sprite document exceeds its file-size budget.');
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SpriteError('The sprite document is not valid JSON.');
  }
  const document = validateSpriteDocument(value);
  const migration = spriteMigrationNotice(value);
  if (migration !== null) options.onMigration?.(migration);
  return document;
}
