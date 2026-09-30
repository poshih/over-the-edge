// Serializable avatar-driver selection. Strategy code is trusted host code, never content code.
import { record, SpriteError } from './sprite-fields';

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

// Copies and freezes a bounded JSON value; a driver receives data, not executable objects.
export function validateAvatarDriver(value: unknown): AvatarDriver {
  const data = record(value, ['id', 'config'], 'Avatar driver');
  if (!isAvatarDriverId(data.id)) throw new SpriteError(`Avatar driver IDs use 1-${AVATAR_DRIVER_LIMITS.id} lowercase letters, numbers and hyphens, starting with a letter.`);
  const id = data.id;
  const encoder = new TextEncoder();
  let values = 0;
  let textBytes = 0;
  const accountText = (item: string): void => {
    if (item.length > AVATAR_DRIVER_LIMITS.bytes ||
      (textBytes += encoder.encode(JSON.stringify(item)).byteLength) > AVATAR_DRIVER_LIMITS.bytes) {
      throw new SpriteError('Avatar driver configuration exceeds its byte budget.');
    }
  };
  const visit = (item: unknown, depth: number): RigJson => {
    if (++values > AVATAR_DRIVER_LIMITS.values || depth > AVATAR_DRIVER_LIMITS.depth) {
      throw new SpriteError('Avatar driver configuration exceeds its structure budget.');
    }
    if (typeof item === 'string') { accountText(item); return item; }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (item.length > AVATAR_DRIVER_LIMITS.values - values) throw new SpriteError('Avatar driver configuration exceeds its structure budget.');
      return Object.freeze(Array.from(item, child => visit(child, depth + 1)));
    }
    if (typeof item !== 'object' || item === null || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new SpriteError('Avatar driver configuration must contain only finite JSON data.');
    }
    const keys = Object.keys(item);
    if (keys.length > AVATAR_DRIVER_LIMITS.values - values) throw new SpriteError('Avatar driver configuration exceeds its structure budget.');
    return Object.freeze(Object.fromEntries(keys.sort().map(key => {
      accountText(key);
      return [key, visit((item as Record<string, unknown>)[key], depth + 1)];
    })));
  };
  const config = visit(data.config, 0);
  if (encoder.encode(JSON.stringify(config)).byteLength > AVATAR_DRIVER_LIMITS.bytes) {
    throw new SpriteError('Avatar driver configuration exceeds its byte budget.');
  }
  return Object.freeze({ id, config });
}

export function sameAvatarDriver(left: AvatarDriver, right: AvatarDriver): boolean {
  // Validated configuration keys have canonical order; comparisons occur on content changes, not frames.
  return left === right || (left.id === right.id && JSON.stringify(left.config) === JSON.stringify(right.config));
}
