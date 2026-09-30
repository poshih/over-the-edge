// A project's model library: extra avatar, hammer and pot models a release can swap to, each part
// on its own. An avatar entry carries everything that depends on its model's proportions. DOM-free,
// so project validation, the project server, the Workshop and builds share one definition.
import { AVATAR_JOINT_IDS, CHARACTER_MODEL_LIMITS, validateAvatarBoneMap } from './character-profile';
import type { AvatarBoneMap, PartialAvatarBoneMap } from './character-profile';
import { STANDARD_AVATAR_DRIVER, validateAvatarDriver } from './avatar-driver';
import type { AvatarDriver } from './avatar-driver';
import { checkAvatarRig, DEFAULT_AVATAR_RIGS } from './avatar-rig';
import type { AvatarRigRegistry } from './avatar-rig';
import type { CharacterArms } from './character-arms';
import { DEFAULT_ARM_FORWARD_DISTANCE } from './character-depth';
import { inspectCharacterModel, suggestAvatarBoneMap } from './character-model-inspect';
import { DEFAULT_GRIPS } from './grips';
import type { Grips } from './grips';
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
  totalBytes: 64 * 1024 * 1024,
} as const;

export interface LibraryEntry {
  readonly id: string;
  readonly name: string;
}

// What an avatar model's proportions size: its bone map, driver, grips, arm lengths and arm forward distance.
export interface LibraryAvatarSettings {
  readonly boneMap: AvatarBoneMap;
  readonly driver: AvatarDriver;
  readonly armForwardDistance: number;
  readonly grips: Grips;
  readonly arms: CharacterArms | null;
}

export interface LibraryAvatarEntry extends LibraryEntry, LibraryAvatarSettings {}

export interface ModelLibrary {
  readonly avatar: readonly LibraryAvatarEntry[];
  readonly hammer: readonly LibraryEntry[];
  readonly pot: readonly LibraryEntry[];
}

export const EMPTY_MODEL_LIBRARY: ModelLibrary = Object.freeze({
  avatar: Object.freeze([]), hammer: Object.freeze([]), pot: Object.freeze([]),
});

const ENTRY_KEYS = ['id', 'name'] as const;
const AVATAR_KEYS = [...ENTRY_KEYS, 'boneMap', 'driver', 'armForwardDistance', 'grips', 'arms'] as const;
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
  return Object.freeze({
    boneMap: validateAvatarBoneMap(value.boneMap),
    driver: validateAvatarDriver(value.driver),
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
    const data = exactRecord(item, role === 'avatar' ? AVATAR_KEYS : ENTRY_KEYS, `A library ${role}`);
    const result = entry(data);
    if (ids.has(result.id)) throw new ProjectError(`The ${role} library lists "${result.id}" twice.`);
    ids.add(result.id);
    return result;
  }));
}

function entryBase(data: Record<string, unknown>): LibraryEntry {
  return { id: libraryModelId(data.id), name: textValue(data.name, 1, MODEL_LIBRARY_LIMITS.name, 'Library model name') };
}

export function validateModelLibrary(value: unknown): ModelLibrary {
  const library = exactRecord(value, PART_ROLES, 'The model library');
  return Object.freeze({
    avatar: validateEntries(library.avatar, 'avatar', (data) => Object.freeze({ ...entryBase(data), ...validateAvatarSettings(data) })),
    hammer: validateEntries(library.hammer, 'hammer', (data) => Object.freeze(entryBase(data))),
    pot: validateEntries(library.pot, 'pot', (data) => Object.freeze(entryBase(data))),
  });
}

export function libraryEntries(library: ModelLibrary): { role: PartRole; entry: LibraryEntry | LibraryAvatarEntry }[] {
  return PART_ROLES.flatMap((role) => library[role].map((entry) => ({ role, entry })));
}

function entryLabel(role: PartRole, entry: LibraryEntry): string {
  return `Library ${role} "${entry.name}" (${entry.id})`;
}

// Checks a library GLB exactly as release builds and loads do: MODEL_LIMITS, the typed character
// model checks, the part's conventions, and an avatar's bone map against its skin.
export function checkLibraryModel(
  role: PartRole,
  entry: LibraryEntry | LibraryAvatarEntry,
  bytes: Uint8Array,
  registry: AvatarRigRegistry = DEFAULT_AVATAR_RIGS,
): void {
  try {
    const report = inspectCharacterModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, role);
    if (role === 'avatar') {
      const avatar = entry as LibraryAvatarEntry;
      checkAvatarRig(report, avatar.boneMap, avatar.driver, registry);
    }
  } catch (error) {
    if (error instanceof Error) error.message = `${entryLabel(role, entry)}: ${error.message}`;
    throw error;
  }
}

export function checkModelLibrary(
  library: ModelLibrary,
  bytes: (path: string) => Uint8Array,
  registry: AvatarRigRegistry = DEFAULT_AVATAR_RIGS,
): void {
  for (const { role, entry } of libraryEntries(library)) checkLibraryModel(role, entry, bytes(libraryModelFile(role, entry.id)), registry);
}

// A new avatar entry for an imported GLB: its mapped joints, when every joint resolves, standard
// rig strategy, and settings taken from `settings`, typically the open character's.
export function newAvatarEntry(bytes: Uint8Array, entry: LibraryEntry, settings: Omit<LibraryAvatarSettings, 'boneMap' | 'driver'>): LibraryAvatarEntry {
  const report = inspectCharacterModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'avatar');
  const suggested: PartialAvatarBoneMap = suggestAvatarBoneMap(report);
  const boneMap = validateAvatarBoneMap(Object.fromEntries(AVATAR_JOINT_IDS.map((joint) => [joint, suggested[joint] ?? null])));
  const avatar: LibraryAvatarEntry = Object.freeze({ ...entry, boneMap, driver: STANDARD_AVATAR_DRIVER, ...settings });
  checkLibraryModel('avatar', avatar, bytes);
  return avatar;
}

export const DEFAULT_AVATAR_SETTINGS: Omit<LibraryAvatarSettings, 'boneMap' | 'driver'> = Object.freeze({
  armForwardDistance: DEFAULT_ARM_FORWARD_DISTANCE, grips: DEFAULT_GRIPS, arms: null,
});
