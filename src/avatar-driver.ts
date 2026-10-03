// Serializable avatar-driver selection and the bounded JSON configuration strategies and motions take. Strategy and
// motion code is trusted host code, never content code.
import { record, SpriteError } from './sprite-fields.ts';

export type RigJson = null | boolean | number | string | readonly RigJson[] | { readonly [key: string]: RigJson };
export interface AvatarDriver {
  readonly id: string;
  readonly config: RigJson;
}

export const AVATAR_DRIVER_LIMITS = Object.freeze({ id: 64, depth: 8, values: 512, bytes: 16 * 1024 });
export const STANDARD_AVATAR_DRIVER: AvatarDriver = Object.freeze({ id: 'standard', config: null });
const DRIVER_ID = /^[a-z][a-z0-9-]*$/;

export function isAvatarDriverId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= AVATAR_DRIVER_LIMITS.id && DRIVER_ID.test(value);
}

// Copies and freezes a bounded JSON value: strategy and motion configuration is data, never executable objects. It
// fits AVATAR_DRIVER_LIMITS' depth, value count and bytes; `label` names it in refusals.
export function boundedRigJson(value: unknown, label: string): RigJson {
  const encoder = new TextEncoder();
  let values = 0;
  let textBytes = 0;
  const accountText = (item: string): void => {
    if (item.length > AVATAR_DRIVER_LIMITS.bytes ||
      (textBytes += encoder.encode(JSON.stringify(item)).byteLength) > AVATAR_DRIVER_LIMITS.bytes) {
      throw new SpriteError(`${label} exceeds its byte budget.`);
    }
  };
  const visit = (item: unknown, depth: number): RigJson => {
    if (++values > AVATAR_DRIVER_LIMITS.values || depth > AVATAR_DRIVER_LIMITS.depth) {
      throw new SpriteError(`${label} exceeds its structure budget.`);
    }
    if (typeof item === 'string') { accountText(item); return item; }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (item.length > AVATAR_DRIVER_LIMITS.values - values) throw new SpriteError(`${label} exceeds its structure budget.`);
      return Object.freeze(Array.from(item, child => visit(child, depth + 1)));
    }
    if (typeof item !== 'object' || item === null || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new SpriteError(`${label} must contain only finite JSON data.`);
    }
    const keys = Object.keys(item);
    if (keys.length > AVATAR_DRIVER_LIMITS.values - values) throw new SpriteError(`${label} exceeds its structure budget.`);
    return Object.freeze(Object.fromEntries(keys.sort().map(key => {
      accountText(key);
      return [key, visit((item as Record<string, unknown>)[key], depth + 1)];
    })));
  };
  const json = visit(value, 0);
  if (encoder.encode(JSON.stringify(json)).byteLength > AVATAR_DRIVER_LIMITS.bytes) {
    throw new SpriteError(`${label} exceeds its byte budget.`);
  }
  return json;
}

export function validateAvatarDriver(value: unknown): AvatarDriver {
  const data = record(value, ['id', 'config'], 'Avatar driver');
  if (!isAvatarDriverId(data.id)) throw new SpriteError(`Avatar driver IDs use 1-${AVATAR_DRIVER_LIMITS.id} lowercase letters, numbers and hyphens, starting with a letter.`);
  return Object.freeze({ id: data.id, config: boundedRigJson(data.config, 'Avatar driver configuration') });
}

// Validated configuration keys have canonical order, so equal configurations serialize equally. Comparisons occur on
// content changes, not frames.
export function sameRigJson(left: RigJson, right: RigJson): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function sameAvatarDriver(left: AvatarDriver, right: AvatarDriver): boolean {
  return left === right || (left.id === right.id && sameRigJson(left.config, right.config));
}
