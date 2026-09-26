// Character-profile fields added in sprite schema 8: imported models, the avatar bone map,
// the one-model hammer and shading. DOM-free, so builds and Node tools share the validator.
import { MODEL_LIMITS } from './model-data.ts';
import { decodeBase64, encodeBase64, number, record, SpriteError, text } from './sprite-fields.ts';

// Left and right are screen sides: the character faces the camera, so a rig's anatomical right
// arm drives the left-* joints.
export const AVATAR_JOINT_IDS = [
  'body', 'head', 'left-upper-arm', 'left-forearm', 'left-hand', 'right-upper-arm', 'right-forearm', 'right-hand',
] as const;
export type AvatarJointId = (typeof AVATAR_JOINT_IDS)[number];
export type AvatarBoneMap = Readonly<Record<AvatarJointId, string>>;
export type PartialAvatarBoneMap = Readonly<Partial<Record<AvatarJointId, string>>>;

// Each mapped joint's nearest mapped ancestor; body has none.
export const AVATAR_JOINT_PARENTS: Readonly<Record<AvatarJointId, AvatarJointId | null>> = Object.freeze({
  body: null,
  head: 'body',
  'left-upper-arm': 'body',
  'left-forearm': 'left-upper-arm',
  'left-hand': 'left-forearm',
  'right-upper-arm': 'body',
  'right-forearm': 'right-upper-arm',
  'right-hand': 'right-forearm',
});

export interface CharacterModel {
  readonly id: string;
  readonly name: string;
  readonly source: string;
}

export interface AvatarModelProfile {
  readonly model: string;
  readonly boneMap: AvatarBoneMap;
}

// A rigid prop that replaces the hammer or the pot; each role names its own model.
export interface PropModelProfile {
  readonly model: string;
}
export type HammerModelProfile = PropModelProfile;
export type PotModelProfile = PropModelProfile;
export const PROP_MODEL_ROLES = ['hammer', 'pot'] as const;
export type PropModelRole = (typeof PROP_MODEL_ROLES)[number];

export const SHADING_MODES = ['pbr', 'cel'] as const;
export type ShadingMode = (typeof SHADING_MODES)[number];

export interface CelOutline {
  readonly color: string;
  readonly width: number;
}

// Cel settings are kept while PBR is selected, so the two looks can be compared losslessly.
export interface CharacterShading {
  readonly mode: ShadingMode;
  readonly bands: number;
  readonly outline: CelOutline | null;
}

// Every field is absent from documents that do not use it, keeping them byte-identical.
export interface CharacterAssets {
  readonly models?: readonly CharacterModel[];
  readonly avatar?: AvatarModelProfile;
  readonly hammer?: HammerModelProfile;
  readonly pot?: PotModelProfile;
  readonly shading?: CharacterShading;
}

export const CHARACTER_ASSET_FIELDS = ['models', 'avatar', 'hammer', 'pot', 'shading'] as const;

export const SHADING_LIMITS = {
  bands: { min: 2, max: 8, step: 1 },
  outlineWidth: { min: 0.002, max: 0.1, step: 0.001 },
} as const;

export const DEFAULT_CEL_OUTLINE: CelOutline = Object.freeze({ color: '#1f2428', width: 0.02 });
export const DEFAULT_CHARACTER_SHADING: CharacterShading = Object.freeze({
  mode: 'pbr', bands: 3, outline: DEFAULT_CEL_OUTLINE,
});

const MODEL_PREFIX = 'data:model/gltf-binary;base64,';
const MODEL_ENCODED_BYTES = MODEL_PREFIX.length + Math.ceil(MODEL_LIMITS.bytes / 3) * 4;

// One model per role: avatar, hammer and pot.
const MODEL_ROLES = 3;

export const CHARACTER_MODEL_LIMITS = {
  models: MODEL_ROLES,
  bytes: MODEL_LIMITS.bytes,
  encodedBytes: MODEL_ROLES * MODEL_ENCODED_BYTES,
  id: 80,
  name: 120,
  jointName: 120,
} as const;

export const AVATAR_MODEL_ID = 'avatar';
export const HAMMER_MODEL_ID = 'hammer';
export const POT_MODEL_ID = 'pot';

export const CHARACTER_MODEL_ERROR_CODES = [
  'invalid-model', 'model-limits', 'no-skin', 'unexpected-skin', 'invalid-skin',
  'missing-joint', 'unknown-joint', 'duplicate-joint', 'ambiguous-joint', 'broken-chain', 'crossed-arms',
  'degenerate-rig', 'too-many-influences', 'unnormalized-weights',
] as const;
export type CharacterModelErrorCode = (typeof CHARACTER_MODEL_ERROR_CODES)[number];

// Typed failures for imported character models and bone maps; callers branch on `code`.
export class CharacterModelError extends SpriteError {
  readonly code: CharacterModelErrorCode;
  // Avatar joint IDs or GLB joint names involved in the failure.
  readonly joints: readonly string[];

  constructor(code: CharacterModelErrorCode, message: string, options: { joints?: readonly string[]; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CharacterModelError';
    this.code = code;
    this.joints = Object.freeze([...options.joints ?? []]);
  }
}

export function isAvatarJoint(value: unknown): value is AvatarJointId {
  return typeof value === 'string' && (AVATAR_JOINT_IDS as readonly string[]).includes(value);
}

function modelSource(value: unknown): string {
  if (typeof value !== 'string') throw new SpriteError('A character model requires a GLB source.');
  if (value.startsWith(MODEL_PREFIX)) {
    if (value.length > MODEL_ENCODED_BYTES) {
      throw new CharacterModelError('model-limits', `Character models must be at most ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
    }
    return value;
  }
  if (value.length > 2048 || value.includes('\\') || value !== value.trim()) {
    throw new SpriteError('Use an embedded GLB, public HTTP(S) URL, or /site-relative model path.');
  }
  let url: URL;
  try {
    url = new URL(value, 'https://sprite.invalid');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new SpriteError('The character model URL is invalid.');
  }
  const absolute = /^https?:\/\//i.test(value);
  const local = value.startsWith('/') && !value.startsWith('//') && url.origin === 'https://sprite.invalid';
  if ((!absolute && !local) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new SpriteError('Use a public HTTP(S) URL without credentials or a /site-relative model path.');
  }
  return value;
}

// Decodes an embedded GLB source; null for URL sources.
export function embeddedModel(source: string): Uint8Array<ArrayBuffer> | null {
  if (!source.startsWith(MODEL_PREFIX)) return null;
  const encoded = source.slice(MODEL_PREFIX.length);
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new CharacterModelError('invalid-model', 'The embedded character GLB encoding is invalid.');
  }
  if (encoded.length > MODEL_ENCODED_BYTES - MODEL_PREFIX.length) {
    throw new CharacterModelError('model-limits', `Character models must be at most ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
  }
  const bytes = decodeBase64(encoded);
  if (bytes.byteLength > MODEL_LIMITS.bytes) {
    throw new CharacterModelError('model-limits', `Character models must be at most ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
  }
  return bytes;
}

export function encodeModel(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MODEL_LIMITS.bytes) {
    throw new CharacterModelError('model-limits', `Choose a GLB file no larger than ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
  }
  return MODEL_PREFIX + encodeBase64(bytes);
}

// Checks an embedded GLB's encoding and container header without decoding the whole model.
export function checkEmbeddedModel(model: CharacterModel): void {
  if (!model.source.startsWith(MODEL_PREFIX)) return;
  const encoded = model.source.slice(MODEL_PREFIX.length);
  if (encoded.length < 28 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new CharacterModelError('invalid-model', `Character model "${model.name}" has an invalid embedded GLB encoding.`);
  }
  const bytes = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (bytes > MODEL_LIMITS.bytes) {
    throw new CharacterModelError('model-limits', `Character models must be at most ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
  }
  const header = decodeBase64(encoded.slice(0, 16));
  const view = new DataView(header.buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes) {
    throw new CharacterModelError('invalid-model', `Character model "${model.name}" is not a valid binary glTF 2.0 (.glb) file.`);
  }
}

export function validateCharacterModels(value: unknown): readonly CharacterModel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHARACTER_MODEL_LIMITS.models) {
    throw new SpriteError(`A character profile lists 1-${CHARACTER_MODEL_LIMITS.models} models when it has any.`);
  }
  const ids = new Set<string>();
  let bytes = 0;
  return Object.freeze(value.map((entry: unknown): CharacterModel => {
    const model = record(entry, ['id', 'name', 'source'], 'A character model');
    const id = text(model.id, CHARACTER_MODEL_LIMITS.id, 'Character model ID');
    if (ids.has(id)) throw new SpriteError(`Duplicate character model ID: ${id}.`);
    ids.add(id);
    const source = modelSource(model.source);
    bytes += source.length;
    if (bytes > CHARACTER_MODEL_LIMITS.encodedBytes) throw new SpriteError('Character models exceed their size budget.');
    return Object.freeze({ id, name: text(model.name, CHARACTER_MODEL_LIMITS.name, 'Character model name'), source });
  }));
}

function jointName(value: unknown, joint: AvatarJointId): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > CHARACTER_MODEL_LIMITS.jointName ||
    /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SpriteError(`The ${joint} bone must name a GLB joint of 1-${CHARACTER_MODEL_LIMITS.jointName} characters.`);
  }
  return value;
}

// Checks a partial map's own consistency; resolveAvatarJoints() checks it against a model.
export function validatePartialBoneMap(value: unknown): PartialAvatarBoneMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SpriteError('The avatar bone map must map avatar joints to GLB joint names.');
  }
  for (const key of Object.keys(value)) {
    if (!isAvatarJoint(key)) throw new SpriteError(`Unknown avatar joint "${key}". Use ${AVATAR_JOINT_IDS.join(', ')}.`);
  }
  const map: Partial<Record<AvatarJointId, string>> = {};
  const owners = new Map<string, AvatarJointId>();
  for (const id of AVATAR_JOINT_IDS) {
    const entry: unknown = Reflect.get(value, id);
    if (entry === undefined || entry === null) continue;
    const name = jointName(entry, id);
    const previous = owners.get(name);
    if (previous !== undefined) {
      throw new CharacterModelError('duplicate-joint',
        `The ${previous} and ${id} bones both map to GLB joint "${name}". Each avatar joint needs its own GLB joint.`,
        { joints: [previous, id] });
    }
    owners.set(name, id);
    map[id] = name;
  }
  return Object.freeze(map);
}

export function missingAvatarJoints(map: PartialAvatarBoneMap): readonly AvatarJointId[] {
  return AVATAR_JOINT_IDS.filter(id => map[id] === undefined);
}

export function validateAvatarBoneMap(value: unknown): AvatarBoneMap {
  const map = validatePartialBoneMap(value);
  const missing = missingAvatarJoints(map);
  if (missing.length > 0) {
    throw new CharacterModelError('missing-joint',
      `The bone map has no GLB joint for ${missing.join(', ')}. Map all eight avatar joints.`, { joints: missing });
  }
  return map as AvatarBoneMap;
}

export function validateAvatarModelProfile(value: unknown): AvatarModelProfile {
  const avatar = record(value, ['model', 'boneMap'], 'The avatar model');
  return Object.freeze({
    model: text(avatar.model, CHARACTER_MODEL_LIMITS.id, 'Avatar model ID'),
    boneMap: validateAvatarBoneMap(avatar.boneMap),
  });
}

export function validatePropModelProfile(value: unknown, role: PropModelRole): PropModelProfile {
  const prop = record(value, ['model'], `The ${role} model`);
  return Object.freeze({ model: text(prop.model, CHARACTER_MODEL_LIMITS.id, `${role[0]!.toUpperCase()}${role.slice(1)} model ID`) });
}

export function validateCelOutline(value: unknown): CelOutline {
  const outline = record(value, ['color', 'width'], 'The cel outline');
  if (typeof outline.color !== 'string' || !/^#[0-9a-f]{6}$/.test(outline.color)) {
    throw new SpriteError('The outline colour must be a lowercase #rrggbb value.');
  }
  const { min, max } = SHADING_LIMITS.outlineWidth;
  return Object.freeze({ color: outline.color, width: number(outline.width, min, max, 'Outline width') });
}

export function validateCharacterShading(value: unknown): CharacterShading {
  const shading = record(value, ['mode', 'bands', 'outline'], 'Character shading');
  const mode = SHADING_MODES.find(candidate => candidate === shading.mode);
  if (mode === undefined) throw new SpriteError('Choose pbr or cel character shading.');
  const { min, max } = SHADING_LIMITS.bands;
  const bands = number(shading.bands, min, max, 'Cel band count');
  if (!Number.isInteger(bands)) throw new SpriteError('The cel band count must be a whole number.');
  const outline = shading.outline === null ? null : validateCelOutline(shading.outline);
  return Object.freeze({ mode, bands, outline });
}

export function sameShading(left: CharacterShading, right: CharacterShading): boolean {
  return left === right || left.mode === right.mode && left.bands === right.bands &&
    (left.outline === right.outline || left.outline !== null && right.outline !== null &&
      left.outline.color === right.outline.color && left.outline.width === right.outline.width);
}

export function sameBoneMap(left: PartialAvatarBoneMap, right: PartialAvatarBoneMap): boolean {
  return left === right || AVATAR_JOINT_IDS.every(id => left[id] === right[id]);
}

export function hasCharacterAssets(assets: CharacterAssets): boolean {
  return CHARACTER_ASSET_FIELDS.some(key => assets[key] !== undefined);
}

// Copies only the fields that are present, so absent fields never serialize.
export function characterAssets(value: CharacterAssets): CharacterAssets {
  const result: { -readonly [K in keyof CharacterAssets]: CharacterAssets[K] } = {};
  if (value.models !== undefined) result.models = value.models;
  if (value.avatar !== undefined) result.avatar = value.avatar;
  if (value.hammer !== undefined) result.hammer = value.hammer;
  if (value.pot !== undefined) result.pot = value.pot;
  if (value.shading !== undefined) result.shading = value.shading;
  return result;
}

function sameProp(left: PropModelProfile | undefined, right: PropModelProfile | undefined): boolean {
  return left === right || left !== undefined && right !== undefined && left.model === right.model;
}

export function sameCharacterAssets(left: CharacterAssets, right: CharacterAssets): boolean {
  const sameModels = left.models === right.models || left.models !== undefined && right.models !== undefined &&
    left.models.length === right.models.length && left.models.every((model, index) => {
      const other = right.models![index]!;
      return model === other || model.id === other.id && model.name === other.name && model.source === other.source;
    });
  return sameModels &&
    (left.avatar === right.avatar || left.avatar !== undefined && right.avatar !== undefined &&
      left.avatar.model === right.avatar.model && sameBoneMap(left.avatar.boneMap, right.avatar.boneMap)) &&
    sameProp(left.hammer, right.hammer) && sameProp(left.pot, right.pot) &&
    (left.shading === right.shading || left.shading !== undefined && right.shading !== undefined &&
      sameShading(left.shading, right.shading));
}

export function characterModel(assets: CharacterAssets, id: string): CharacterModel {
  const model = assets.models?.find(candidate => candidate.id === id);
  if (model === undefined) throw new SpriteError(`The profile references missing character model "${id}".`);
  return model;
}

export function validateCharacterAssets(value: {
  readonly models?: unknown;
  readonly avatar?: unknown;
  readonly hammer?: unknown;
  readonly pot?: unknown;
  readonly shading?: unknown;
}): CharacterAssets {
  const models = value.models === undefined ? undefined : validateCharacterModels(value.models);
  const avatar = value.avatar === undefined ? undefined : validateAvatarModelProfile(value.avatar);
  const hammer = value.hammer === undefined ? undefined : validatePropModelProfile(value.hammer, 'hammer');
  const pot = value.pot === undefined ? undefined : validatePropModelProfile(value.pot, 'pot');
  const validated = value.shading === undefined ? undefined : validateCharacterShading(value.shading);
  // The default look is the absent field, as in schema 6 and 7 documents.
  const shading = validated === undefined || sameShading(validated, DEFAULT_CHARACTER_SHADING) ? undefined : validated;
  const ids = new Set(models?.map(model => model.id));
  const used = new Set<string>();
  for (const [label, profile] of [['avatar', avatar], ['hammer', hammer], ['pot', pot]] as const) {
    if (profile === undefined) continue;
    if (!ids.has(profile.model)) throw new SpriteError(`The ${label} references missing character model "${profile.model}".`);
    // Each role binds and shades its own scene, so roles never share a model.
    if (used.has(profile.model)) throw new SpriteError('The avatar, hammer and pot need separate character models.');
    used.add(profile.model);
  }
  if (models !== undefined && models.some(model => !used.has(model.id))) {
    throw new SpriteError('Remove character models that no avatar, hammer or pot uses.');
  }
  return characterAssets({ models, avatar, hammer, pot, shading });
}
