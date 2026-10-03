// Validates the Workshop's controls for motion kinds (AvatarMotionControls), the editor-only `controls` export of a
// game's avatar rig module. Data only, checked once when the Workshop starts, in Node and again in the browser;
// releases never import it.
import { AvatarMotionError } from './avatar-motion';
import type {
  AvatarMotionControl, AvatarMotionControls, AvatarMotionListControl, AvatarMotionNumberControl, AvatarMotionPath,
} from './avatar-motion';

export const AVATAR_MOTION_CONTROL_LIMITS = Object.freeze({ controls: 64, label: 80, unit: 16, path: 8, key: 64 });

export const NO_AVATAR_MOTION_CONTROLS: AvatarMotionControls = Object.freeze({});

function fail(message: string, motion: string | null = null): never {
  throw new AvatarMotionError('invalid-controls', message, motion);
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
  if (!Array.isArray(data.controls) || data.controls.length === 0) fail('A motion control list needs its controls.', motion);
  return Object.freeze({
    list: path(data.list, 'A control list\'s list', motion),
    title: text(data.title, AVATAR_MOTION_CONTROL_LIMITS.key, 'A control list\'s title field', motion),
    controls: Object.freeze(data.controls.map(control => numberControl(control, motion))),
  });
}

// A module's controls, or none when it exports none. Each key names a registered motion kind (`kinds`); each control is
// a number, or a list's numbers when it names a `list`.
export function validateAvatarMotionControls(value: unknown, kinds: readonly string[]): AvatarMotionControls {
  if (value === undefined) return NO_AVATAR_MOTION_CONTROLS;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('An avatar rig module\'s controls export maps motion kind IDs to their controls.');
  }
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([id, controls]) => {
    if (!kinds.includes(id)) fail(`Controls are given for "${id}", which is not a registered motion kind.`, id);
    if (!Array.isArray(controls)) fail(`Motion kind "${id}"'s controls must be a list.`, id);
    let count = 0;
    const validated = controls.map((control: unknown): AvatarMotionControl => {
      const result = typeof control === 'object' && control !== null && Object.hasOwn(control, 'list')
        ? listControl(control, id) : numberControl(control, id);
      count += 'list' in result ? result.controls.length : 1;
      if (count > AVATAR_MOTION_CONTROL_LIMITS.controls) fail(`Motion kind "${id}" describes at most ${AVATAR_MOTION_CONTROL_LIMITS.controls} controls.`, id);
      return result;
    });
    return [id, Object.freeze(validated)];
  })));
}
