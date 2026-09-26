// Shared by the sprite document and character-profile validators without an import cycle.
export class SpriteError extends Error {}

export function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new SpriteError(`${label} must contain exactly ${keys.join(', ')}.`);
  }
  return Object.fromEntries(keys.map(key => [key, Reflect.get(value, key)]));
}

export function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SpriteError(`${label} must be nonempty text of at most ${maximum} characters.`);
  }
  return value.trim();
}

export function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SpriteError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

export function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(encoded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
