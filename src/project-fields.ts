// Declarative field specs shared by project sections (theme, HUD, ...), their editor controls and
// the project API manual, so limits and labels have one source of truth.

export class ProjectError extends Error {
  // API section or project file the failure belongs to, when known.
  readonly section: string | null;

  constructor(message: string, options: { section?: string | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProjectError';
    this.section = options.section ?? null;
  }
}

interface FieldBase {
  // Dot-separated location inside the section value, e.g. "fog.near".
  readonly path: string;
  readonly label: string;
  readonly description?: string;
}

export type FieldSpec =
  | (FieldBase & { readonly kind: 'color' })
  | (FieldBase & { readonly kind: 'boolean' })
  | (FieldBase & { readonly kind: 'text'; readonly minLength: number; readonly maxLength: number })
  | (FieldBase & {
    readonly kind: 'number'; readonly min: number; readonly max: number; readonly step: number;
    readonly unit: string; readonly integer?: boolean;
  });

export function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProjectError(`${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new ProjectError(`${label} must contain exactly ${keys.join(', ')}${
      missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}${unknown.length > 0 ? `; unknown ${unknown.join(', ')}` : ''}.`);
  }
  return value as Record<string, unknown>;
}

export function colorValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/.test(value)) throw new ProjectError(`${label} must be a lowercase #rrggbb colour.`);
  return value;
}

export function numberValue(value: unknown, min: number, max: number, label: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ProjectError(`${label} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`);
  }
  return value;
}

export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ProjectError(`${label} must be true or false.`);
  return value;
}

export function textValue(value: unknown, minLength: number, maxLength: number, label: string): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new ProjectError(`${label} must be single-line text.`);
  }
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length < minLength || length > maxLength) throw new ProjectError(`${label} must contain ${minLength}-${maxLength} characters.`);
  return trimmed;
}

function fieldValue(field: FieldSpec, value: unknown): unknown {
  switch (field.kind) {
    case 'color': return colorValue(value, field.label);
    case 'boolean': return booleanValue(value, field.label);
    case 'text': return textValue(value, field.minLength, field.maxLength, field.label);
    case 'number': return numberValue(value, field.min, field.max, field.label, field.integer === true);
  }
}

function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) freezeDeep(entry);
    Object.freeze(value);
  }
  return value;
}

// Validates a nested section against its fields: every group has exactly its fields' keys.
export function validateFields<T>(value: unknown, fields: readonly FieldSpec[], label: string): T {
  const walk = (input: unknown, prefix: string, name: string): Record<string, unknown> => {
    const members = new Map<string, FieldSpec | null>();
    for (const field of fields) {
      if (!field.path.startsWith(prefix)) continue;
      const [key, ...rest] = field.path.slice(prefix.length).split('.');
      members.set(key!, rest.length === 0 ? field : null);
    }
    const data = exactRecord(input, [...members.keys()], name);
    const result: Record<string, unknown> = {};
    for (const [key, field] of members) {
      result[key] = field === null ? walk(data[key], `${prefix}${key}.`, `${name} ${key}`) : fieldValue(field, data[key]);
    }
    return result;
  };
  return freezeDeep(walk(value, '', label)) as T;
}

export function readField(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

// Copy of `value` with one nested field replaced; untouched groups are shared.
export function writeField<T>(value: T, path: string, next: unknown): T {
  const [key, ...rest] = path.split('.');
  const record = value as Record<string, unknown>;
  return { ...record, [key!]: rest.length === 0 ? next : writeField(record[key!], rest.join('.'), next) } as T;
}

// JSON merge patch (RFC 7386) where objects merge recursively and anything else replaces. Unlike
// RFC 7386, null sets a field to null: sections have fixed keys, so a patch never deletes one.
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const result: Record<string, unknown> = typeof target === 'object' && target !== null && !Array.isArray(target)
    ? { ...target as Record<string, unknown> } : {};
  for (const [key, value] of Object.entries(patch)) result[key] = mergePatch(result[key], value);
  return result;
}
