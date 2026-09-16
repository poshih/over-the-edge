import type { Point } from './config';

export class LevelError extends Error {}

export function fields(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new LevelError(`${label} contains missing or unknown fields.`);
  }
}

export function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new LevelError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

export function point(value: unknown, range: number, label: string): Readonly<Point> {
  fields(value, ['x', 'y'], label);
  return Object.freeze({
    x: number(value.x, -range, range, `${label} X`),
    y: number(value.y, -range, range, `${label} Y`),
  });
}

export function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new LevelError(`${label} needs 1 to ${limit} characters.`);
  }
  return value;
}
