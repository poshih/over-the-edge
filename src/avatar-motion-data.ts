// An imported avatar's game-registered secondary motions as profiles and model settings carry them: entries naming a
// motion kind by ID, each with bounded JSON configuration that only the kind interprets, against the model, when the
// avatar loads. DOM-free and three-free, so the profile format loads anywhere.
import { boundedRigJson, isAvatarDriverId, sameRigJson } from './avatar-driver.ts';
import type { RigJson } from './avatar-driver.ts';
import { record, SpriteError } from './sprite-fields.ts';

export interface AvatarMotionEntry {
  // The registered motion kind; an avatar runs each kind at most once.
  readonly id: string;
  readonly config: RigJson;
}

// The built-in hair's motion ID: hair is configured as `avatar.hair`; plugin kinds use "<plugin>/<name>".
export const HAIR_MOTION_ID = 'hair';

export const AVATAR_MOTION_LIMITS = Object.freeze({
  motions: 16,
  // Joints an avatar's motions claim together, hair aside; each motion's per-frame cost is bounded by its claims.
  claims: 64,
});

export const NO_AVATAR_MOTION: readonly AvatarMotionEntry[] = Object.freeze([]);

// The entries' own consistency; whether a registered kind accepts each configuration for the model is checked when
// the avatar is prepared (AvatarRigRegistry.prepare).
export function validateAvatarMotion(value: unknown): readonly AvatarMotionEntry[] {
  if (!Array.isArray(value) || value.length > AVATAR_MOTION_LIMITS.motions) {
    throw new SpriteError(`The avatar's motion lists at most ${AVATAR_MOTION_LIMITS.motions} motions.`);
  }
  if (value.length === 0) return NO_AVATAR_MOTION;
  const ids = new Set<string>();
  return Object.freeze(value.map((item: unknown): AvatarMotionEntry => {
    const entry = record(item, ['id', 'config'], 'An avatar motion');
    if (!isAvatarDriverId(entry.id)) {
      throw new SpriteError('An avatar motion names a built-in or "<plugin>/<name>", each part using 1-64 lowercase letters, digits and hyphens, starting with a letter.');
    }
    if (entry.id === HAIR_MOTION_ID) throw new SpriteError('Hair chains belong in the avatar\'s hair, not its motion list.');
    if (ids.has(entry.id)) throw new SpriteError(`The avatar lists motion "${entry.id}" twice; each kind runs at most once.`);
    ids.add(entry.id);
    return Object.freeze({ id: entry.id, config: boundedRigJson(entry.config, `Avatar motion "${entry.id}" configuration`) });
  }));
}

export function sameAvatarMotion(left: readonly AvatarMotionEntry[], right: readonly AvatarMotionEntry[]): boolean {
  return left === right || left.length === right.length &&
    left.every((entry, index) => entry.id === right[index]!.id && sameRigJson(entry.config, right[index]!.config));
}
