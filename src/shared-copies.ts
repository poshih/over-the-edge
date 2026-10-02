import { validateArmIk } from './appearance-profile';
import { GAME_SETTINGS_LIMITS, validateGameSettings } from './game-settings';
import { ProjectError, validateProjectCharacter } from './project';
import { SPRITE_FILE_BYTES } from './sprite-data';

/**
 * Copies a Workshop shares with everyone who opens it: character profiles, game settings and arm IK profiles. Each
 * kind is a folder of the repository named like the kind, holding one JSON file per copy, named by the copy:
 * characters/quiet-climber.json. The project server lists, stores and deletes them. Levels are not shared copies: a
 * project keeps its level's versions (docs/projects.md).
 */
export const SHARED_KINDS = ['characters', 'game-settings', 'arm-ik'] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];

export interface SharedFormat {
  readonly maxBytes: number;
  // Character profiles, mostly embedded files, are stored compact; the rest indented, so they diff well.
  readonly indent: boolean;
  // Checks a copy as the project section of its kind is checked, and returns it as stored.
  readonly validate: (value: unknown) => unknown;
}

export const SHARED_FORMATS: Readonly<Record<SharedKind, SharedFormat>> = {
  characters: { maxBytes: SPRITE_FILE_BYTES, indent: false, validate: validateProjectCharacter },
  'game-settings': { maxBytes: GAME_SETTINGS_LIMITS.fileBytes, indent: true, validate: validateGameSettings },
  // Six coordinates; the limit only bounds a request.
  'arm-ik': { maxBytes: 64 * 1024, indent: true, validate: validateArmIk },
};

export const SHARED_EXTENSION = '.json';
export const SHARED_NAME_LIMIT = 64;
const SHARED_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// A copy as the project server lists it.
export interface SharedCopySummary {
  readonly name: string;
  readonly bytes: number;
  readonly updatedAt: string;
}

export function isSharedKind(value: string): value is SharedKind {
  return (SHARED_KINDS as readonly string[]).includes(value);
}

export function isSharedName(value: string): boolean {
  return SHARED_NAME.test(value);
}

// A copy's name, which is also its file name without the extension.
export function validateSharedName(value: unknown): string {
  if (typeof value !== 'string' || !isSharedName(value)) {
    throw new ProjectError(`Names on the server use 1-${SHARED_NAME_LIMIT} lowercase letters, digits and inner hyphens, for example quiet-ascent.`);
  }
  return value;
}

// A copy's file as stored: indented or compact, as its kind is.
export function sharedText(kind: SharedKind, value: unknown): string {
  return `${JSON.stringify(value, null, SHARED_FORMATS[kind].indent ? 2 : undefined)}\n`;
}
