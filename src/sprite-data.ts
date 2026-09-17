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
  readonly underlay: 'replace' | 'overlay';
}

export interface SpriteDocument {
  readonly schemaVersion: 1;
  readonly images: readonly SpriteImage[];
  readonly layers: readonly SpriteLayer[];
}

export const SPRITE_LIMITS = {
  layers: 64,
  images: 32,
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

export const SPRITE_FIELDS = [
  { key: 'width', label: 'Sprite width', min: SPRITE_LIMITS.minimumSize, max: SPRITE_LIMITS.size, step: 0.01, unit: 'local' },
  { key: 'height', label: 'Sprite height', min: SPRITE_LIMITS.minimumSize, max: SPRITE_LIMITS.size, step: 0.01, unit: 'local' },
  { key: 'x', label: 'Sprite offset X', min: -SPRITE_LIMITS.offset, max: SPRITE_LIMITS.offset, step: 0.01, unit: 'local' },
  { key: 'y', label: 'Sprite offset Y', min: -SPRITE_LIMITS.offset, max: SPRITE_LIMITS.offset, step: 0.01, unit: 'local' },
  { key: 'z', label: 'Sprite depth', min: -SPRITE_LIMITS.offset, max: SPRITE_LIMITS.offset, step: 0.01, unit: 'local' },
  { key: 'rotation', label: 'Sprite rotation', min: -SPRITE_LIMITS.rotation, max: SPRITE_LIMITS.rotation, step: 1, unit: 'deg' },
] as const;

export const EMPTY_SPRITES: SpriteDocument = Object.freeze({
  schemaVersion: 1, images: Object.freeze([]), layers: Object.freeze([]),
});

export class SpriteError extends Error {}

const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

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
  const layer = record(value, ['id', 'name', 'anchor', 'image', 'width', 'height', 'offset', 'rotation', 'underlay'], 'A sprite layer');
  const offset = record(layer.offset, ['x', 'y', 'z'], 'A sprite offset');
  if (layer.underlay !== 'replace' && layer.underlay !== 'overlay') {
    throw new SpriteError('Sprite underlay must be replace or overlay.');
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
    underlay: layer.underlay,
  });
}

// The loader validates image bytes as it acquires them, without decoding cached sources again.
export function validateSpriteMetadata(value: unknown): SpriteDocument {
  const document = record(value, ['schemaVersion', 'images', 'layers'], 'A sprite document');
  if (document.schemaVersion !== 1 || !Array.isArray(document.images) || !Array.isArray(document.layers) ||
    document.images.length > SPRITE_LIMITS.images || document.layers.length > SPRITE_LIMITS.layers) {
    throw new SpriteError(`Sprite documents use schema 1, at most ${SPRITE_LIMITS.images} images and ${SPRITE_LIMITS.layers} layers.`);
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
    const layer = validateSpriteLayer(value);
    if (layerIds.has(layer.id)) throw new SpriteError(`Duplicate sprite layer ID: ${layer.id}.`);
    if (!imageIds.has(layer.image)) throw new SpriteError(`Sprite ${layer.id} references a missing image.`);
    layerIds.add(layer.id);
    usedImages.add(layer.image);
    return layer;
  });
  if (usedImages.size !== imageIds.size) throw new SpriteError('Remove images that are not used by any sprite layer.');
  const result: SpriteDocument = Object.freeze({ schemaVersion: 1, images: Object.freeze(images), layers: Object.freeze(layers) });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > SPRITE_LIMITS.documentBytes) {
    throw new SpriteError('The sprite document exceeds its file-size budget.');
  }
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

export function validateSpriteAnchors(document: SpriteDocument, anchors: Iterable<string>): void {
  const available = new Set(anchors);
  for (const layer of document.layers) {
    if (!available.has(layer.anchor)) throw new SpriteError(`Sprite ${layer.id} references unknown anchor "${layer.anchor}".`);
  }
}

export function parseSpriteDocument(serialized: string): SpriteDocument {
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
  return validateSpriteDocument(value);
}
