import type { SpriteDocument } from './sprite-data.ts';

const jsonBytes = new WeakMap<object, number>();

function stringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x20) bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    else if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xe000) {
      const next = value.charCodeAt(index + 1);
      if (code < 0xdc00 && next >= 0xdc00 && next < 0xe000) {
        bytes += 4;
        index++;
      } else bytes += 6;
    } else bytes += 3;
  }
  return bytes;
}

function valueBytes(value: unknown, ancestors: Set<object>): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return stringBytes(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'object') return containerBytes(value, ancestors);
  throw new Error('The sprite document must contain only JSON data.');
}

function immutableChild(parent: object, key: string | number, child: unknown): boolean {
  const property = Object.getOwnPropertyDescriptor(parent, key);
  return property !== undefined && Object.hasOwn(property, 'value') &&
    (child === null || typeof child !== 'object' || jsonBytes.has(child));
}

function containerBytes(value: object, ancestors: Set<object>, omitModels = false): number {
  const cached = omitModels ? undefined : jsonBytes.get(value);
  if (cached !== undefined) return cached;
  if (ancestors.has(value)) throw new Error('The sprite document must not contain cyclic data.');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('The sprite document must contain only JSON data.');
  }
  ancestors.add(value);
  let bytes = 2;
  let immutable = !omitModels && Object.isFrozen(value);
  try {
    if (array) {
      for (let index = 0; index < value.length; index++) {
        const child: unknown = value[index];
        if (index !== 0) bytes++;
        bytes += valueBytes(child, ancestors);
        immutable = immutable && immutableChild(value, index, child);
      }
    } else {
      let properties = 0;
      for (const key of Object.keys(value)) {
        if (omitModels && key === 'models') continue;
        const child: unknown = Reflect.get(value, key);
        if (child !== undefined) {
          if (properties++ !== 0) bytes++;
          bytes += stringBytes(key) + 1 + valueBytes(child, ancestors);
        }
        immutable = immutable && immutableChild(value, key, child);
      }
    }
  } finally {
    ancestors.delete(value);
  }
  // A frozen container with mutable descendants still needs recounting.
  if (immutable && !omitModels) jsonBytes.set(value, bytes);
  return bytes;
}

// UTF-8 JSON size of validated sprite data; embedded models have a separate budget.
export function spriteDocumentBytes(document: SpriteDocument): number {
  return containerBytes(document, new Set(), true);
}
