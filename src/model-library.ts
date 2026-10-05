// A project's model library: extra avatar, hammer and pot models a release can swap to, each part
// on its own. An avatar entry carries everything that depends on its model's proportions. DOM-free,
// so project validation, the project server, the Workshop and builds share one definition.
import { AVATAR_JOINT_IDS, CHARACTER_MODEL_LIMITS, NO_AVATAR_HAIR, validateAvatarBoneMap, validateAvatarHair } from './character-profile';
import type { AvatarBoneMap, AvatarHair, AvatarModelSettings, PartialAvatarBoneMap } from './character-profile';
import { STANDARD_AVATAR_DRIVER, validateAvatarDriver } from './avatar-driver';
import type { AvatarDriver } from './avatar-driver';
import type { AvatarRigRegistry } from './avatar-rig';
import { NO_AVATAR_MOTION, validateAvatarMotion } from './avatar-motion-data';
import type { AvatarMotionEntry } from './avatar-motion-data';
import type { CharacterArms } from './character-arms';
import { DEFAULT_ARM_FORWARD_DISTANCE } from './character-depth';
import { inspectCharacterModel, suggestAvatarBoneMap } from './character-model-inspect';
import type { CharacterModelReport } from './character-model-inspect';
import { DEFAULT_GRIPS } from './grips';
import type { Grips } from './grips';
import { HammerHeadError, validateHammerHead } from './hammer-head';
import type { HammerHead } from './hammer-head';
import { exactRecord, ProjectError, textValue } from './project-fields';
import { validateArmForwardDistance, validateArms, validateGrips } from './sprite-data';

export const PART_ROLES = ['avatar', 'hammer', 'pot'] as const;
export type PartRole = (typeof PART_ROLES)[number];

// Which library model each part uses, as the game's backend stores it; null is the profile's own.
export interface ModelSelection {
  readonly avatar: string | null;
  readonly hammer: string | null;
  readonly pot: string | null;
}

// A request to the game's backend to use a library model, or the profile's own (null), for one part.
export interface ModelSelectionRequest {
  readonly role: PartRole;
  readonly id: string | null;
}

export const EMPTY_SELECTION: ModelSelection = Object.freeze({ avatar: null, hammer: null, pot: null });

export const MODEL_LIBRARY_LIMITS = {
  entries: 32,
  id: 64,
  name: CHARACTER_MODEL_LIMITS.name,
} as const;

export interface LibraryEntry {
  readonly id: string;
  readonly name: string;
}

// What an avatar model's proportions size: its bone map, driver, hair and motions, bound to its joints, and its grips,
// arm lengths and arm forward distance.
export interface LibraryAvatarSettings {
  readonly boneMap: AvatarBoneMap;
  readonly driver: AvatarDriver;
  readonly hair: AvatarHair;
  readonly motion: readonly AvatarMotionEntry[];
  readonly armForwardDistance: number;
  readonly grips: Grips;
  readonly arms: CharacterArms | null;
}

// The hold settings a new avatar may take from another character; its model-bound settings are its own.
export type AvatarHoldSettings = Omit<LibraryAvatarSettings, keyof AvatarModelSettings>;

export interface LibraryAvatarEntry extends LibraryEntry, LibraryAvatarSettings {}

// A hammer cosmetic: its head's collision outline replaces the game's default head while the hammer is shown.
export interface LibraryHammerEntry extends LibraryEntry {
  readonly head: HammerHead;
}

export interface ModelLibrary {
  readonly avatar: readonly LibraryAvatarEntry[];
  readonly hammer: readonly LibraryHammerEntry[];
  readonly pot: readonly LibraryEntry[];
}

export const EMPTY_MODEL_LIBRARY: ModelLibrary = Object.freeze({
  avatar: Object.freeze([]), hammer: Object.freeze([]), pot: Object.freeze([]),
});

const ENTRY_KEYS = ['id', 'name'] as const;
const AVATAR_KEYS = [...ENTRY_KEYS, 'boneMap', 'driver', 'hair', 'motion', 'armForwardDistance', 'grips', 'arms'] as const;
const HAMMER_KEYS = [...ENTRY_KEYS, 'head'] as const;
// Each part's entry fields, which every format that lists library entries shares.
export const LIBRARY_ENTRY_KEYS: Readonly<Record<PartRole, readonly string[]>> = Object.freeze({
  avatar: AVATAR_KEYS, hammer: HAMMER_KEYS, pot: ENTRY_KEYS,
});
const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isPartRole(value: unknown): value is PartRole {
  return typeof value === 'string' && (PART_ROLES as readonly string[]).includes(value);
}

export function libraryModelId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new ProjectError(`Library model IDs use 1-${MODEL_LIBRARY_LIMITS.id} lowercase letters, digits and inner hyphens, for example hero-hooded.`);
  }
  return value;
}

// A readable ID suggestion for a file name, e.g. "Hooded Hero.glb" -> "hooded-hero".
export function libraryIdForName(name: string): string {
  const id = name.replace(/\.glb$/i, '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, MODEL_LIBRARY_LIMITS.id).replace(/-+$/, '');
  return id.length === 0 ? 'model' : id;
}

// The project file holding a library entry's GLB.
export function libraryModelFile(role: PartRole, id: string): string {
  return `models/${role}/${libraryModelId(id)}.glb`;
}

export function validateAvatarSettings(value: Record<string, unknown>): LibraryAvatarSettings {
  const boneMap = validateAvatarBoneMap(value.boneMap);
  return Object.freeze({
    boneMap,
    driver: validateAvatarDriver(value.driver),
    hair: validateAvatarHair(value.hair, boneMap),
    motion: validateAvatarMotion(value.motion),
    armForwardDistance: validateArmForwardDistance(value.armForwardDistance),
    grips: validateGrips(value.grips),
    arms: validateArms(value.arms),
  });
}

// The settings fields a library avatar contributes, copied as one list so release caches and the
// editor never drift from the profile schema.
export function libraryAvatarSettings(entry: LibraryAvatarSettings): LibraryAvatarSettings {
  return Object.freeze({
    boneMap: entry.boneMap,
    driver: entry.driver,
    hair: entry.hair,
    motion: entry.motion,
    armForwardDistance: entry.armForwardDistance,
    grips: entry.grips,
    arms: entry.arms,
  });
}

function validateEntries<T extends LibraryEntry>(value: unknown, role: PartRole, entry: (data: Record<string, unknown>) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > MODEL_LIBRARY_LIMITS.entries) {
    throw new ProjectError(`The ${role} library lists at most ${MODEL_LIBRARY_LIMITS.entries} models.`);
  }
  const ids = new Set<string>();
  return Object.freeze(value.map((item: unknown) => {
    const data = exactRecord(item, LIBRARY_ENTRY_KEYS[role], `A library ${role}`);
    const result = entry(data);
    if (ids.has(result.id)) throw new ProjectError(`The ${role} library lists "${result.id}" twice.`);
    ids.add(result.id);
    return result;
  }));
}

function entryBase(data: Record<string, unknown>): LibraryEntry {
  return { id: libraryModelId(data.id), name: textValue(data.name, 1, MODEL_LIBRARY_LIMITS.name, 'Library model name') };
}

// A library hammer's head outline.
export function libraryHammerHead(value: unknown): HammerHead {
  try {
    return validateHammerHead(value);
  } catch (error) {
    if (!(error instanceof HammerHeadError)) throw error;
    throw new ProjectError(`A library hammer's head: ${error.message}`);
  }
}

export function validateModelLibrary(value: unknown): ModelLibrary {
  const library = exactRecord(value, PART_ROLES, 'The model library');
  return Object.freeze({
    avatar: validateEntries(library.avatar, 'avatar', (data) => Object.freeze({ ...entryBase(data), ...validateAvatarSettings(data) })),
    hammer: validateEntries(library.hammer, 'hammer', (data) => Object.freeze({ ...entryBase(data), head: libraryHammerHead(data.head) })),
    pot: validateEntries(library.pot, 'pot', (data) => Object.freeze(entryBase(data))),
  });
}

export function libraryEntries(library: ModelLibrary): { role: PartRole; entry: LibraryEntry | LibraryAvatarEntry }[] {
  return PART_ROLES.flatMap((role) => library[role].map((entry) => ({ role, entry })));
}

function entryLabel(role: PartRole, entry: LibraryEntry): string {
  return `Library ${role} "${entry.name}" (${entry.id})`;
}

// The model settings of an avatar known only by its bone map: the standard driver, no hair and no motions.
export function mappedAvatarModel(boneMap: AvatarBoneMap): AvatarModelSettings {
  return Object.freeze({ boneMap, driver: STANDARD_AVATAR_DRIVER, hair: NO_AVATAR_HAIR, motion: NO_AVATAR_MOTION });
}

// Checks an avatar's model settings against its GLB's report as releases and loads do, with the full pure preparation:
// the bone map resolves against its skin, the driver prepares for this exact model, the hair's chains name its skin
// joints, and each motion's kind accepts its configuration and claims joints the engine allows.
export function checkAvatarModelSettings(report: CharacterModelReport, settings: AvatarModelSettings,
  registry: AvatarRigRegistry): void {
  registry.prepare(report, settings);
}

// Checks a library GLB exactly as release builds and loads do: MODEL_LIMITS, the typed character
// model checks, the part's conventions, and an avatar's bone map against its skin.
export function checkLibraryModel(
  role: PartRole,
  entry: LibraryEntry | LibraryAvatarEntry,
  bytes: Uint8Array,
  registry: AvatarRigRegistry,
): void {
  try {
    const report = inspectCharacterModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, role);
    if (role === 'avatar') checkAvatarModelSettings(report, entry as LibraryAvatarEntry, registry);
  } catch (error) {
    if (error instanceof Error) error.message = `${entryLabel(role, entry)}: ${error.message}`;
    throw error;
  }
}

export function checkModelLibrary(
  library: ModelLibrary,
  bytes: (path: string) => Uint8Array,
  registry: AvatarRigRegistry,
): void {
  for (const { role, entry } of libraryEntries(library)) checkLibraryModel(role, entry, bytes(libraryModelFile(role, entry.id)), registry);
}

// A new avatar entry for an imported GLB: its mapped joints, when every joint resolves, standard
// rig strategy, no hair or motions, and hold settings taken from `settings`, typically the open character's.
export function newAvatarEntry(bytes: Uint8Array, entry: LibraryEntry, settings: AvatarHoldSettings, registry: AvatarRigRegistry): LibraryAvatarEntry {
  const report = inspectCharacterModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'avatar');
  const suggested: PartialAvatarBoneMap = suggestAvatarBoneMap(report);
  const boneMap = validateAvatarBoneMap(Object.fromEntries(AVATAR_JOINT_IDS.map((joint) => [joint, suggested[joint] ?? null])));
  const avatar: LibraryAvatarEntry = Object.freeze({ ...entry, ...mappedAvatarModel(boneMap), ...settings });
  checkLibraryModel('avatar', avatar, bytes, registry);
  return avatar;
}

export const DEFAULT_AVATAR_SETTINGS: AvatarHoldSettings = Object.freeze({
  armForwardDistance: DEFAULT_ARM_FORWARD_DISTANCE, grips: DEFAULT_GRIPS, arms: null,
});
