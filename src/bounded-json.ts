// Bounded JSON copies for configuration and data that trusted code interprets but the engine only stores: avatar rig
// and motion configuration, and Workshop plugins' project data. A copy is frozen, its object keys sorted so equal
// values serialize equally, and it fits its limits on depth, value count and bytes. No imports beyond .ts files, so the
// profile format loads anywhere.

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface JsonLimits {
  // Nesting below the root value.
  readonly depth: number;
  // Values counted over the whole document, containers included.
  readonly values: number;
  // UTF-8 bytes of the serialized document, and of all its strings and keys together.
  readonly bytes: number;
}

// Copies and freezes `value`, refusing with `refuse(message)` when it is not finite JSON data within `limits`. `label`
// names it in messages, for example "Avatar driver configuration".
export function boundedJson(value: unknown, limits: JsonLimits, label: string, refuse: (message: string) => Error): JsonValue {
  const encoder = new TextEncoder();
  let values = 0;
  let textBytes = 0;
  const accountText = (item: string): void => {
    if (item.length > limits.bytes || (textBytes += encoder.encode(JSON.stringify(item)).byteLength) > limits.bytes) {
      throw refuse(`${label} exceeds its byte budget.`);
    }
  };
  const visit = (item: unknown, depth: number): JsonValue => {
    if (++values > limits.values || depth > limits.depth) throw refuse(`${label} exceeds its structure budget.`);
    if (typeof item === 'string') { accountText(item); return item; }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (item.length > limits.values - values) throw refuse(`${label} exceeds its structure budget.`);
      return Object.freeze(Array.from(item, child => visit(child, depth + 1)));
    }
    if (typeof item !== 'object' || item === null || Object.getPrototypeOf(item) !== Object.prototype) {
      throw refuse(`${label} must contain only finite JSON data.`);
    }
    const keys = Object.keys(item);
    if (keys.length > limits.values - values) throw refuse(`${label} exceeds its structure budget.`);
    return Object.freeze(Object.fromEntries(keys.sort().map(key => {
      accountText(key);
      return [key, visit((item as Record<string, unknown>)[key], depth + 1)];
    })));
  };
  const json = visit(value, 0);
  if (encoder.encode(JSON.stringify(json)).byteLength > limits.bytes) throw refuse(`${label} exceeds its byte budget.`);
  return json;
}

// Whether two bounded copies hold the same value; their keys are sorted, so their text is canonical. Comparisons happen
// when content changes, not every frame.
export function sameJson(left: JsonValue, right: JsonValue): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}
