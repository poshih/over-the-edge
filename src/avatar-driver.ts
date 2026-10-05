// Serializable avatar-driver selection and the bounded JSON configuration strategies and motions take. Strategy and
// motion code is trusted host code, never content code.
import { boundedJson, sameJson } from './bounded-json.ts';
import type { JsonValue } from './bounded-json.ts';
import { record, SpriteError } from './sprite-fields.ts';
import { isNamespacedId, isPluginId } from './plugins/ids.ts';

export type RigJson = JsonValue;
export interface AvatarDriver {
  readonly id: string;
  readonly config: RigJson;
}

export const AVATAR_DRIVER_LIMITS = Object.freeze({ depth: 8, values: 512, bytes: 16 * 1024 });
export const STANDARD_AVATAR_DRIVER: AvatarDriver = Object.freeze({ id: 'standard', config: null });

export function isAvatarDriverId(value: unknown): value is string {
  return isPluginId(value) || isNamespacedId(value);
}

// Copies and freezes a bounded JSON value: strategy and motion configuration is data, never executable objects. It
// fits AVATAR_DRIVER_LIMITS' depth, value count and bytes; `label` names it in refusals.
export function boundedRigJson(value: unknown, label: string): RigJson {
  return boundedJson(value, AVATAR_DRIVER_LIMITS, label, (message) => new SpriteError(message));
}

export function validateAvatarDriver(value: unknown): AvatarDriver {
  const data = record(value, ['id', 'config'], 'Avatar driver');
  if (!isAvatarDriverId(data.id)) {
    throw new SpriteError('Avatar driver IDs name a built-in or "<plugin>/<name>", each part using 1-64 lowercase letters, digits and hyphens, starting with a letter.');
  }
  return Object.freeze({ id: data.id, config: boundedRigJson(data.config, 'Avatar driver configuration') });
}

// Validated configuration keys have canonical order, so equal configurations serialize equally.
export const sameRigJson: (left: RigJson, right: RigJson) => boolean = sameJson;

export function sameAvatarDriver(left: AvatarDriver, right: AvatarDriver): boolean {
  return left === right || (left.id === right.id && sameRigJson(left.config, right.config));
}
