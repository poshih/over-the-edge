import {
  DIRECTIONAL_LIMITS, DirectionalError, validateDirectionalPresentation,
  validateDirectionalReferences as validatePresentationReferences,
} from './directional-data.ts';
import type { DirectionalPresentation } from './directional-data.ts';
import { FACING_DIRECTIONS, SKELETON_LIMITS, SkeletonError, validateDirection, validateSkeleton, validateSkin } from './skeleton-data.ts';
import type { FacingDirection, SkeletonDefinition, SpriteSkin } from './skeleton-data.ts';
import { ARM_FORWARD_DISTANCE_LIMITS, DEFAULT_ARM_FORWARD_DISTANCE } from './character-depth.ts';
import {
  CHARACTER_ASSET_FIELDS, CHARACTER_MODEL_LIMITS, checkEmbeddedModel, hasCharacterAssets,
  validateCharacterAssets,
} from './character-profile.ts';
import type { CharacterAssets, CharacterModel } from './character-profile.ts';
import { number, record, SpriteError, text } from './sprite-fields.ts';

export { SpriteError };

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

// Frame i faces startAngle + i * 360 / images.length degrees (right 0, up 90, counterclockwise).
// Hysteresis widens the shown frame's sector by that many degrees on each side; 0 disables it.
export interface SpriteFlipbook {
  readonly images: readonly string[];
  readonly startAngle: number;
  readonly hysteresis: number;
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
  // Absent for single-image layers, so their saved form is unchanged.
  readonly flipbook?: SpriteFlipbook;
}

export interface CharacterPresentation extends CharacterAssets {
  readonly characterRiggingType: CharacterRiggingType;
  readonly armForwardDistance: number;
}

// Schema 9 is written only when a pot model is present, schema 8 only when other character models
// or shading are, schema 7 only when a layer has a flipbook; other documents stay schema 6.
export type SpriteSchemaVersion = 6 | 7 | 8 | 9;

export interface SpriteDocument extends CharacterPresentation {
  readonly schemaVersion: SpriteSchemaVersion;
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

export const FLIPBOOK_LIMITS = {
  minimumFrames: 2,
  maximumFrames: SPRITE_LIMITS.images,
  angle: 360,
} as const;

const FLIPBOOK_SCHEMA_VERSION = 7;
const CHARACTER_SCHEMA_VERSION = 8;
const POT_SCHEMA_VERSION = 9;

// Largest accepted profile file: the sprite budget plus two embedded character models.
export const SPRITE_FILE_BYTES = SPRITE_LIMITS.documentBytes + CHARACTER_MODEL_LIMITS.encodedBytes;

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

export function spriteSchemaVersion(layers: readonly SpriteLayer[], character: CharacterAssets = {}): SpriteSchemaVersion {
  if (character.pot !== undefined) return POT_SCHEMA_VERSION;
  if (hasCharacterAssets(character)) return CHARACTER_SCHEMA_VERSION;
  return layers.some(layer => layer.flipbook !== undefined) ? FLIPBOOK_SCHEMA_VERSION : 6;
}

// Every image a layer can display: its flipbook frames, otherwise its single image.
export function spriteLayerImages(layer: SpriteLayer): readonly string[] {
  return layer.flipbook?.images ?? [layer.image];
}

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
  // Embedded character models have their own budget, so they cannot crowd out sprite artwork.
  const { models, ...sprites } = document;
  const metadata = encoder.encode(JSON.stringify({ ...sprites, images: [] })).byteLength;
  if (metadata + images - 2 > SPRITE_LIMITS.documentBytes) {
    throw new SpriteError('The sprite document exceeds its file-size budget.');
  }
  if ((models ?? []).reduce((total, model) => total + model.source.length, 0) > CHARACTER_MODEL_LIMITS.encodedBytes) {
    throw new SpriteError('Character models exceed their size budget.');
  }
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

const LAYER_FIELDS = ['id', 'name', 'anchor', 'image', 'width', 'height', 'offset', 'rotation',
  'bone', 'directions', 'skin', 'tileLength'] as const;

function validateFlipbook(
  value: unknown,
  layer: { image: string; directions: readonly FacingDirection[]; skin: SpriteSkin | null; tileLength: number | null },
): SpriteFlipbook {
  const flipbook = record(value, ['images', 'startAngle', 'hysteresis'], 'A sprite flipbook');
  if (!Array.isArray(flipbook.images) || flipbook.images.length < FLIPBOOK_LIMITS.minimumFrames ||
    flipbook.images.length > FLIPBOOK_LIMITS.maximumFrames) {
    throw new SpriteError(`A flipbook needs ${FLIPBOOK_LIMITS.minimumFrames}-${FLIPBOOK_LIMITS.maximumFrames} frame image IDs.`);
  }
  const images = flipbook.images.map((id: unknown, index) => text(id, SPRITE_LIMITS.id, `Flipbook frame ${index} image ID`));
  const seen = new Set<string>();
  for (const id of images) {
    if (seen.has(id)) throw new SpriteError(`Flipbook frame image "${id}" is repeated; each frame needs its own image ID.`);
    seen.add(id);
  }
  if (images[0] !== layer.image) {
    throw new SpriteError(`A flipbook layer's image must be its first frame ("${images[0]}").`);
  }
  const startAngle = flipbook.startAngle;
  if (typeof startAngle !== 'number' || !Number.isFinite(startAngle) || startAngle < 0 || startAngle >= FLIPBOOK_LIMITS.angle) {
    throw new SpriteError(`Flipbook start angle must be at least 0 and less than ${FLIPBOOK_LIMITS.angle} degrees.`);
  }
  // Below half the spacing, aiming exactly at a frame's angle always shows that frame.
  const halfSpacing = FLIPBOOK_LIMITS.angle / images.length / 2;
  const hysteresis = flipbook.hysteresis;
  if (typeof hysteresis !== 'number' || !Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis >= halfSpacing) {
    throw new SpriteError(`Flipbook hysteresis must be at least 0 and less than ${halfSpacing} degrees, half of its frame spacing.`);
  }
  if (layer.directions.length !== FACING_DIRECTIONS.length) {
    throw new SpriteError('A flipbook layer must be visible in all eight directions; its frames already follow aim.');
  }
  if (layer.skin !== null || layer.tileLength !== null) {
    throw new SpriteError('A flipbook layer cannot also be a weighted mesh or tiled shaft.');
  }
  return Object.freeze({ images: Object.freeze(images), startAngle, hysteresis });
}

export function validateSpriteLayer(value: unknown): SpriteLayer {
  const hasFlipbook = typeof value === 'object' && value !== null && Object.hasOwn(value, 'flipbook');
  const layer = record(value, hasFlipbook ? [...LAYER_FIELDS, 'flipbook'] : LAYER_FIELDS, 'A sprite layer');
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
  const result: SpriteLayer = {
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
  };
  // In-memory callers may pass flipbook: undefined; it normalizes to the absent single-image form.
  if (layer.flipbook === undefined) return Object.freeze(result);
  return Object.freeze({ ...result, flipbook: validateFlipbook(layer.flipbook, result) });
}

function migrateSpriteLayer(value: unknown, version: number): unknown {
  if (version < FLIPBOOK_SCHEMA_VERSION && typeof value === 'object' && value !== null && Object.hasOwn(value, 'flipbook')) {
    throw new SpriteError(`Flipbook layers require sprite schema version ${FLIPBOOK_SCHEMA_VERSION}.`);
  }
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
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 &&
    version !== FLIPBOOK_SCHEMA_VERSION && version !== CHARACTER_SCHEMA_VERSION && version !== POT_SCHEMA_VERSION) {
    throw new SpriteError('Sprite documents require schema version 1, 2, 3, 4, 5, 6, 7, 8 or 9.');
  }
  const legacy = version === 1;
  const fields = ['schemaVersion', 'images', 'layers'];
  if (version >= 2) fields.push('skeleton');
  if (version >= 3) fields.push('presentation');
  if (version >= 4) fields.push('characterRiggingType');
  if (version >= 6) fields.push('armForwardDistance');
  const assetFields = CHARACTER_ASSET_FIELDS.filter(key => Object.hasOwn(value as object, key));
  if (assetFields.length > 0 && version < CHARACTER_SCHEMA_VERSION) {
    throw new SpriteError(`Character models and shading require sprite schema version ${CHARACTER_SCHEMA_VERSION}.`);
  }
  if (assetFields.includes('pot') && version < POT_SCHEMA_VERSION) {
    throw new SpriteError(`A pot model requires sprite schema version ${POT_SCHEMA_VERSION}.`);
  }
  fields.push(...assetFields);
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
    for (const frame of layer.flipbook?.images ?? []) {
      if (!imageIds.has(frame)) throw new SpriteError(`Sprite ${layer.id} flipbook references missing image "${frame}".`);
    }
    layerIds.add(layer.id);
    for (const image of spriteLayerImages(layer)) usedImages.add(image);
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
  const character = validateCharacterAssets(document);
  const result: SpriteDocument = Object.freeze({
    schemaVersion: spriteSchemaVersion(layers, character), characterRiggingType, armForwardDistance,
    images: Object.freeze(images), layers: Object.freeze(layers), skeleton, presentation, ...character,
  });
  validateSpriteBudget(result);
  return result;
}

const checkedModels = new WeakSet<CharacterModel>();

// Checks embedded GLB headers once per frozen model; skins and bone maps are checked by the loader.
function validateEmbeddedModels(models: readonly CharacterModel[]): void {
  for (const model of models) {
    if (checkedModels.has(model)) continue;
    checkEmbeddedModel(model);
    if (Object.isFrozen(model)) checkedModels.add(model);
  }
}

export function validateSpriteDocument(value: unknown): SpriteDocument {
  const document = validateSpriteMetadata(value);
  validateEmbeddedModels(document.models ?? []);
  const sizes = new Map<string, { width: number; height: number } | null>();
  let pixels = 0;
  for (const image of document.images) {
    if (sizes.has(image.source)) continue;
    const png = embeddedPng(image.source);
    const size = png === null ? null : inspectPng(png);
    sizes.set(image.source, size);
    if (size === null) continue;
    pixels += size.width * size.height;
    if (pixels > SPRITE_LIMITS.decodedPixels) {
      throw new SpriteError('The sprite document exceeds its image-memory budget.');
    }
  }
  if (document.schemaVersion >= FLIPBOOK_SCHEMA_VERSION) {
    // URL frames are compared after download, by the loader.
    const sources = new Map(document.images.map(image => [image.id, image.source]));
    for (const layer of document.layers) {
      if (layer.flipbook === undefined) continue;
      let first: { id: string; width: number; height: number } | null = null;
      for (const id of layer.flipbook.images) {
        const size = sizes.get(sources.get(id)!) ?? null;
        if (size === null) continue;
        if (first === null) first = { id, ...size };
        else if (size.width !== first.width || size.height !== first.height) {
          throw new SpriteError(flipbookSizeMessage(layer.name, { id, ...size }, first));
        }
      }
    }
  }
  return document;
}

export function flipbookSizeMessage(
  layer: string,
  frame: { id: string; width: number; height: number },
  reference: { id: string; width: number; height: number },
): string {
  return `Flipbook "${layer}" frames must share identical pixel dimensions: "${frame.id}" is ` +
    `${frame.width}x${frame.height}, but "${reference.id}" is ${reference.width}x${reference.height}.`;
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

// UTF-8 byte length, counted without allocating an encoded copy of a large profile.
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00 && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next < 0xe000) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function parseSpriteDocument(
  serialized: string,
  options: { onMigration?: (message: string) => void } = {},
): SpriteDocument {
  if (serialized.length > SPRITE_FILE_BYTES || utf8Bytes(serialized) > SPRITE_FILE_BYTES) {
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
