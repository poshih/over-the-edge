import { DEFAULT_TUNING, RIG } from './config';
import type { Tuning } from './config';

export interface CursorSettings {
  readonly maxRadius: number;
}

export interface GameSettings {
  readonly schemaVersion: 2;
  readonly physics: Readonly<Tuning>;
  readonly cursor: Readonly<CursorSettings>;
}

export const GAME_SETTINGS_LIMITS = { fileBytes: 64 * 1024 } as const;
// Profiles saved before aiming was measured from the hinge allowed radii up to 10 m.
const LEGACY_MAX_RADIUS = 10;
export const DEFAULT_CURSOR_SETTINGS: Readonly<CursorSettings> = Object.freeze({
  maxRadius: RIG.maxReach,
});
export const DEFAULT_GAME_SETTINGS: GameSettings = Object.freeze({
  schemaVersion: 2, physics: DEFAULT_TUNING, cursor: DEFAULT_CURSOR_SETTINGS,
});

interface NumericSetting {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  description: string;
}

interface TuningField extends NumericSetting {
  key: keyof Tuning;
  group: 'Mass & recoil' | 'Motors' | 'Response' | 'Materials' | 'Input';
}

type CursorField = NumericSetting & { key: keyof CursorSettings };

export const CURSOR_FIELDS: readonly CursorField[] = [
  { key: 'maxRadius', label: 'Maximum target radius', min: 0.25, max: RIG.maxReach, step: 0.05, unit: 'm', description: 'Maximum distance from the shoulder hinge the hammer pivots on, up to its 2.65 m reach. Aiming moves this offset; character movement carries it along. Motion beyond the radius is discarded.' },
];

export const TUNING_FIELDS: readonly TuningField[] = [
  { key: 'hammerMass', label: 'Hammer head mass', group: 'Mass & recoil', min: 0.5, max: 4, step: 0.1, unit: 'kg', description: 'Lower head mass reduces swing recoil; higher mass increases momentum and motor load.' },
  { key: 'playerMass', label: 'Player mass', group: 'Mass & recoil', min: 6, max: 24, step: 0.5, unit: 'kg', description: 'Combined root and pot mass. A heavier player recoils less but is harder to lift.' },
  { key: 'angularSpeed', label: 'Rotation speed cap', group: 'Mass & recoil', min: 2, max: 18, step: 0.5, unit: 'rad/s', description: 'Lower this limit to soften fast swing kicks. It caps the hinge velocity target.' },
  { key: 'shaftMass', label: 'Shaft mass (total)', group: 'Mass & recoil', min: 0.15, max: 3, step: 0.01, unit: 'kg', description: 'Total mass shared evenly by the three non-colliding handle segments. Lower values reduce recoil.' },
  { key: 'hingeCarrierMass', label: 'Hinge carrier mass', group: 'Mass & recoil', min: 0.1, max: 2, step: 0.05, unit: 'kg', description: 'Mass of the invisible rotating guide body. Its rotational inertia scales with its mass.' },
  { key: 'sliderCarriageMass', label: 'Slider carriage mass', group: 'Mass & recoil', min: 0.1, max: 2, step: 0.05, unit: 'kg', description: 'Mass of the invisible sliding guide body. Lower values reduce extension recoil.' },
  { key: 'hingeTorque', label: 'Hinge strength', group: 'Motors', min: 80, max: 1000, step: 10, unit: 'N m', description: 'Maximum rotational effort. This is not the requested motor speed.' },
  { key: 'sliderForce', label: 'Slider strength', group: 'Motors', min: 150, max: 2000, step: 25, unit: 'N', description: 'Maximum extension effort, including support against gravity.' },
  { key: 'linearSpeed', label: 'Extension speed cap', group: 'Motors', min: 1, max: 12, step: 0.5, unit: 'm/s', description: 'Upper bound on the slider velocity target.' },
  { key: 'angleGain', label: 'Rotation response', group: 'Response', min: 2, max: 30, step: 0.5, unit: '/s', description: 'Angular position error becomes requested hinge speed.' },
  { key: 'angleDamping', label: 'Rotation damping', group: 'Response', min: 0, max: 0.8, step: 0.02, unit: '', description: 'Measured hinge speed opposes the angular command.' },
  { key: 'extensionGain', label: 'Extension response', group: 'Response', min: 2, max: 35, step: 0.5, unit: '/s', description: 'Error along the handle becomes requested slider speed.' },
  { key: 'extensionDamping', label: 'Extension damping', group: 'Response', min: 0, max: 0.8, step: 0.02, unit: '', description: 'Measured slider speed opposes the extension command.' },
  { key: 'bodyDamping', label: 'Body damping', group: 'Materials', min: 0, max: 1, step: 0.02, unit: '/s', description: 'Passive linear and angular drag on moving bodies.' },
  { key: 'gripFriction', label: 'Hammer friction', group: 'Materials', min: 0.2, max: 10, step: 0.05, unit: '', description: 'Contact friction on the hammer head, not an artificial grip. The shaft does not collide.' },
  { key: 'handleFrequency', label: 'Handle compliance', group: 'Materials', min: 0, max: 30, step: 1, unit: 'Hz', description: 'Zero uses rigid welds. Positive values enable rotational spring compliance.' },
  { key: 'handleDamping', label: 'Handle damping', group: 'Materials', min: 0.1, max: 1, step: 0.05, unit: '', description: 'Damping ratio of compliant handle welds; only active above zero Hz.' },
  { key: 'mouseSensitivity', label: 'Control sensitivity', group: 'Input', min: 0.3, max: 2.5, step: 0.05, unit: 'x', description: 'Relative pointer movement. Touch uses the same CSS-pixel gain in either orientation; mouse follows the scene scale.' },
];

export class GameSettingsError extends Error {}

function settingsFields(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new GameSettingsError(`${label} contains missing or unknown settings.`);
  }
}

function settingNumber(value: unknown, field: Pick<NumericSetting, 'label' | 'min' | 'max'>): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max) {
    throw new GameSettingsError(`${field.label} must be between ${field.min} and ${field.max}.`);
  }
  return value;
}

export function validateTuning(value: unknown): Tuning {
  settingsFields(value, TUNING_FIELDS.map((field) => field.key), 'Physics tuning');
  const result = { ...DEFAULT_TUNING };
  for (const field of TUNING_FIELDS) {
    result[field.key] = settingNumber(value[field.key], field);
  }
  return Object.freeze(result);
}

export function validateGameSettings(value: unknown): GameSettings {
  settingsFields(value, ['schemaVersion', 'physics', 'cursor'], 'Game settings profile');
  if (value.schemaVersion === 1) {
    settingsFields(value.cursor, ['returnToHammer', 'returnRate', 'returnOffsetX', 'returnOffsetY'], 'Retired cursor settings');
    if (typeof value.cursor.returnToHammer !== 'boolean') throw new GameSettingsError('The retired return setting must be a boolean.');
    for (const field of [
      { key: 'returnRate', label: 'Retired return speed', min: 0.5, max: 24 },
      { key: 'returnOffsetX', label: 'Retired return offset X', min: -2.65, max: 2.65 },
      { key: 'returnOffsetY', label: 'Retired return offset Y', min: -2.65, max: 2.65 },
    ]) settingNumber(value.cursor[field.key], field);
    return Object.freeze({ schemaVersion: 2, physics: validateTuning(value.physics), cursor: DEFAULT_CURSOR_SETTINGS });
  }
  if (value.schemaVersion !== 2) throw new GameSettingsError('This game-settings profile version is not supported.');
  settingsFields(value.cursor, CURSOR_FIELDS.map((field) => field.key), 'Cursor settings');
  const cursor = { ...DEFAULT_CURSOR_SETTINGS };
  for (const field of CURSOR_FIELDS) {
    // Older radii beyond the hammer's reach load capped at the reach instead of failing.
    const accepted = field.key === 'maxRadius' ? { ...field, max: LEGACY_MAX_RADIUS } : field;
    cursor[field.key] = Math.min(settingNumber(value.cursor[field.key], accepted), field.max);
  }
  return Object.freeze({ schemaVersion: 2, physics: validateTuning(value.physics), cursor: Object.freeze(cursor) });
}
