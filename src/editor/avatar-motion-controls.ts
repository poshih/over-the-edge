// The Workshop-only point for motion controls (docs/workshop-plugins.md). Validated in the browser at load and HMR.
import { keyedPoint } from '../plugins/kernel';

export type AvatarMotionPath = readonly (string | number)[];
export interface AvatarMotionNumberControl {
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
  readonly path: AvatarMotionPath;
}
export interface AvatarMotionListControl {
  readonly list: AvatarMotionPath;
  readonly title: string;
  readonly controls: readonly AvatarMotionNumberControl[];
}
export type AvatarMotionControl = AvatarMotionNumberControl | AvatarMotionListControl;
export interface AvatarMotionControlSet {
  readonly id: string;
  readonly controls: readonly AvatarMotionControl[];
}
export type AvatarMotionControls = ReadonlyMap<string, AvatarMotionControlSet>;

export const AVATAR_MOTION_CONTROL_LIMITS = Object.freeze({ controls: 64, label: 80, unit: 16, path: 8, key: 64 });

function fail(message: string, motion: string): never {
  throw new TypeError(`Motion "${motion}": ${message}`);
}

function fields(value: unknown, keys: readonly string[], label: string, motion: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    fail(`${label} needs exactly ${keys.join(', ')}.`, motion);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, label: string, motion: string, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && value.length === 0)) {
    fail(`${label} must be ${empty ? 'at most' : '1 to'} ${max} characters.`, motion);
  }
  return value;
}

function path(value: unknown, label: string, motion: string): AvatarMotionPath {
  const { path: depth, key } = AVATAR_MOTION_CONTROL_LIMITS;
  if (!Array.isArray(value) || value.length === 0 || value.length > depth ||
    !value.every(step => typeof step === 'string' && step.length > 0 && step.length <= key || Number.isInteger(step) && step >= 0)) {
    fail(`${label} must be 1 to ${depth} object keys and array indices.`, motion);
  }
  return Object.freeze([...value as (string | number)[]]);
}

function numberControl(value: unknown, motion: string): AvatarMotionNumberControl {
  const data = fields(value, ['label', 'unit', 'min', 'max', 'step', 'default', 'path'], 'A motion control', motion);
  const label = text(data.label, AVATAR_MOTION_CONTROL_LIMITS.label, 'A motion control\'s label', motion);
  const { min, max, step } = data;
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    fail(`Control "${label}" needs a finite min below its max.`, motion);
  }
  if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0 || step > max - min) {
    fail(`Control "${label}" needs a positive step no larger than its range.`, motion);
  }
  if (typeof data.default !== 'number' || !Number.isFinite(data.default) || data.default < min || data.default > max) {
    fail(`Control "${label}" needs a default within its range.`, motion);
  }
  return Object.freeze({
    label, unit: text(data.unit, AVATAR_MOTION_CONTROL_LIMITS.unit, `Control "${label}"'s unit`, motion, true),
    min, max, step, default: data.default, path: path(data.path, `Control "${label}"'s path`, motion),
  });
}

function listControl(value: unknown, motion: string): AvatarMotionListControl {
  const data = fields(value, ['list', 'title', 'controls'], 'A motion control list', motion);
  if (!Array.isArray(data.controls) || data.controls.length === 0 || data.controls.length > AVATAR_MOTION_CONTROL_LIMITS.controls) {
    fail(`A motion control list needs 1-${AVATAR_MOTION_CONTROL_LIMITS.controls} controls.`, motion);
  }
  return Object.freeze({
    list: path(data.list, 'A control list\'s list', motion),
    title: text(data.title, AVATAR_MOTION_CONTROL_LIMITS.key, 'A control list\'s title field', motion),
    controls: Object.freeze(data.controls.map(control => numberControl(control, motion))),
  });
}

function checkControls(value: unknown): AvatarMotionControlSet {
  const data = fields(value, ['id', 'controls'], 'A motion control set', 'unknown');
  if (typeof data.id !== 'string') fail('A control set needs its motion kind ID.', 'unknown');
  const id = data.id;
  if (!Array.isArray(data.controls) || data.controls.length > AVATAR_MOTION_CONTROL_LIMITS.controls) {
    fail(`Controls must be a list of at most ${AVATAR_MOTION_CONTROL_LIMITS.controls} controls.`, id);
  }
  let count = 0;
  const controls = data.controls.map((control: unknown): AvatarMotionControl => {
    const result = typeof control === 'object' && control !== null && Object.hasOwn(control, 'list')
      ? listControl(control, id) : numberControl(control, id);
    count += 'list' in result ? result.controls.length : 1;
    if (count > AVATAR_MOTION_CONTROL_LIMITS.controls) fail(`Describe at most ${AVATAR_MOTION_CONTROL_LIMITS.controls} controls.`, id);
    return result;
  });
  return Object.freeze({ id, controls: Object.freeze(controls) });
}

export const AVATAR_MOTION_CONTROLS = keyedPoint('avatar.motion-controls', 'workshop', 64, checkControls);
