import { DEFAULT_TUNING } from './config';
import type { Tuning } from './config';
import { HammerHeadError, validateHammerHead } from './hammer-head';
import { DEFAULT_RIG_SETTINGS, MAX_RIG_REACH, MIN_SLIDER_TRAVEL, minReachLimit, RIG_LIMITS, rigGeometry } from './rig';
import type { RigLength, RigSettings } from './rig';

export interface CursorSettings {
  // The farthest from the shoulder hinge the hammer aims; at most the rig's reach.
  readonly maxTargetRadius: number;
  // How far the cursor moves around the hammer's target before the hammer follows.
  readonly deadZone: number;
}

export interface GameSettings {
  readonly schemaVersion: 9;
  readonly physics: Readonly<Tuning>;
  readonly rig: Readonly<RigSettings>;
  readonly cursor: Readonly<CursorSettings>;
}

export const GAME_SETTINGS_LIMITS = { fileBytes: 64 * 1024 } as const;
export const DEFAULT_CURSOR_SETTINGS: Readonly<CursorSettings> = Object.freeze({
  maxTargetRadius: rigGeometry(DEFAULT_RIG_SETTINGS).maxReach,
  // About the hammer head's half-width, so small, unsteady input leaves the hammer where it is.
  deadZone: 0.1,
});
export const DEFAULT_GAME_SETTINGS: GameSettings = Object.freeze({
  schemaVersion: 9, physics: DEFAULT_TUNING, rig: DEFAULT_RIG_SETTINGS, cursor: DEFAULT_CURSOR_SETTINGS,
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
  group: 'Mass & recoil' | 'Motors' | 'Downswing' | 'Response' | 'Materials' | 'Input' | 'Health' | 'Liquids';
  // Whether the setting takes whole numbers only.
  whole?: true;
}

type RigField = NumericSetting & { key: RigLength };
type CursorField = NumericSetting & { key: keyof CursorSettings };

export const RIG_FIELDS: readonly RigField[] = [
  { key: 'handleLength', label: 'Handle length', ...RIG_LIMITS.handleLength, step: 0.05, unit: 'm', description: 'From the butt to the centre of the head. Fully retracted, the head stops at the minimum reach from the shoulder hinge, so with none the butt travels this far behind it. Changing it rebuilds the player and restarts the run.' },
  { key: 'maxExtension', label: 'Maximum extension', ...RIG_LIMITS.maxExtension, step: 0.05, unit: 'm', description: 'How far the butt can slide past the shoulder hinge. The reach is the handle length plus this. Changing it rebuilds the player and restarts the run.' },
  { key: 'minReach', label: 'Minimum reach', ...RIG_LIMITS.minReach, step: 0.05, unit: 'm', description: `How close the head can come to the shoulder hinge, up to ${MIN_SLIDER_TRAVEL * 100} cm short of the reach: fully retracted, it stops this far out, and aiming nearer only turns the hammer. 0 lets the head reach the hinge. Changing it rebuilds the player and restarts the run.` },
];

// The radius is also capped at the rig's reach, which validateGameSettings checks.
export const CURSOR_FIELDS: readonly CursorField[] = [
  { key: 'maxTargetRadius', label: 'Maximum target radius', min: 0.25, max: MAX_RIG_REACH, step: 0.05, unit: 'm', description: 'Maximum distance from the shoulder hinge the hammer pivots on to the point the hammer aims at, up to the rig\'s reach (handle length plus maximum extension). Aiming moves this offset; character movement carries it along.' },
  { key: 'deadZone', label: 'Dead zone', min: 0, max: 0.5, step: 0.01, unit: 'm', description: 'How far the cursor can move around the point the hammer aims at before the hammer follows. Beyond it, the cursor drags that point along, so the cursor reaches this far past the maximum target radius; motion beyond that is discarded. Zero makes the hammer follow every movement.' },
];

// The jar's and each terrain surface's friction coefficient.
const FRICTION_LIMITS = { min: 0.05, max: 10, step: 0.05, unit: '' } as const;

export const TUNING_FIELDS: readonly TuningField[] = [
  { key: 'hammerMass', label: 'Hammer head mass', group: 'Mass & recoil', min: 0.5, max: 4, step: 0.1, unit: 'kg', description: 'Lower head mass reduces swing recoil; higher mass increases momentum and motor load.' },
  { key: 'playerMass', label: 'Player mass', group: 'Mass & recoil', min: 6, max: 24, step: 0.5, unit: 'kg', description: 'Character mass shared by the root and pot, excluding hinge and tool components. A heavier player recoils less but is harder to lift.' },
  { key: 'angularSpeed', label: 'Rotation speed cap', group: 'Mass & recoil', min: 2, max: 18, step: 0.5, unit: 'rad/s', description: 'Lower this limit to soften fast swing kicks. It caps the hinge velocity target.' },
  { key: 'shaftMass', label: 'Shaft mass (total)', group: 'Mass & recoil', min: 0.15, max: 3, step: 0.01, unit: 'kg', description: 'Total mass of the non-colliding shaft, evenly distributed along its length. Lower values reduce recoil.' },
  { key: 'hingeCarrierMass', label: 'Hinge carrier mass', group: 'Mass & recoil', min: 0.1, max: 2, step: 0.05, unit: 'kg', description: 'Hinge component mass carried at the shoulder, with matching rotor inertia on the driven tool. Its rotational inertia scales with its mass.' },
  { key: 'sliderCarriageMass', label: 'Slider carriage mass', group: 'Mass & recoil', min: 0.1, max: 2, step: 0.05, unit: 'kg', description: 'Carriage mass at the handle butt, part of the single tool body when rigid. Lower values reduce extension recoil.' },
  { key: 'hingeTorque', label: 'Hinge strength', group: 'Motors', min: 80, max: 1000, step: 10, unit: 'N m', description: 'Maximum rotational effort. This is not the requested motor speed.' },
  { key: 'sliderForce', label: 'Slider strength', group: 'Motors', min: 150, max: 2000, step: 25, unit: 'N', description: 'Maximum extension effort, including support against gravity.' },
  { key: 'linearSpeed', label: 'Extension speed cap', group: 'Motors', min: 1, max: 12, step: 0.5, unit: 'm/s', description: 'Upper bound on the slider velocity target.' },
  { key: 'hingeDownswingBoost', label: 'Hinge downswing boost', group: 'Downswing', min: 1, max: 3, step: 0.05, unit: 'x', description: 'Multiplies the hinge strength while input moves the hammer\'s target down and the hinge speeds the head up downward: fully for a head swung straight down, less the more sideways it swings. Holds without input keep the tuned strength. 1 turns the boost off.' },
  { key: 'sliderDownswingBoost', label: 'Slider downswing boost', group: 'Downswing', min: 1, max: 3, step: 0.05, unit: 'x', description: 'Multiplies the slider strength while input moves the hammer\'s target down and the slider speeds the head up downward, extending a hammer that points down or retracting one that points up: fully straight down, less the more sideways. 1 turns the boost off.' },
  { key: 'angleGain', label: 'Rotation response', group: 'Response', min: 2, max: 30, step: 0.5, unit: '/s', description: 'Angular position error becomes requested hinge speed.' },
  { key: 'angleDamping', label: 'Rotation damping', group: 'Response', min: 0, max: 0.8, step: 0.02, unit: '', description: 'Measured hinge speed opposes the angular command.' },
  { key: 'extensionGain', label: 'Extension response', group: 'Response', min: 2, max: 35, step: 0.5, unit: '/s', description: 'Error along the handle becomes requested slider speed.' },
  { key: 'extensionDamping', label: 'Extension damping', group: 'Response', min: 0, max: 0.8, step: 0.02, unit: '', description: 'Measured slider speed opposes the extension command.' },
  { key: 'bodyDamping', label: 'Body damping', group: 'Materials', min: 0, max: 1, step: 0.02, unit: '/s', description: 'Passive linear and angular drag on moving bodies.' },
  { key: 'gripFriction', label: 'Hammer friction', group: 'Materials', min: 0.2, max: 10, step: 0.05, unit: '', description: 'Contact friction on the hammer head, not an artificial grip. The shaft does not collide.' },
  { key: 'potFriction', label: 'Jar friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction on the pot, the jar: how well it rests on slopes and how much it scrapes as it slides. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'rockFriction', label: 'Rock friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction of terrain with the Rock surface, the default. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'woodFriction', label: 'Wood friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction of terrain with the Wood surface. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'metalFriction', label: 'Metal friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction of terrain with the Metal surface. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'iceFriction', label: 'Ice friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction of terrain with the Ice surface. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'rubberFriction', label: 'Rubber friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction of terrain with the Rubber surface. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'potBounciness', label: 'Jar bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much the pot, the jar, bounces off what it hits: 0% stops dead and 100% bounces back as fast as it came. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'hammerBounciness', label: 'Hammer bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much the hammer head bounces off what it hits: 0% stops dead and 100% bounces back as fast as it came. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'rockBounciness', label: 'Rock bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much terrain with the Rock surface, the default, bounces what hits it. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'woodBounciness', label: 'Wood bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much terrain with the Wood surface bounces what hits it. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'metalBounciness', label: 'Metal bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much terrain with the Metal surface bounces what hits it. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'iceBounciness', label: 'Ice bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much terrain with the Ice surface bounces what hits it. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'rubberBounciness', label: 'Rubber bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much terrain with the Rubber surface bounces what hits it. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'handleFrequency', label: 'Handle compliance', group: 'Materials', min: 0, max: 30, step: 1, unit: 'Hz', description: 'Zero uses one rigid tool body. Positive values enable rotational spring compliance. Crossing zero rebuilds the rig and restarts the run.' },
  { key: 'handleDamping', label: 'Handle damping', group: 'Materials', min: 0.1, max: 1, step: 0.05, unit: '', description: 'Damping ratio of compliant handle welds; only active above zero Hz.' },
  { key: 'mouseSensitivity', label: 'Control sensitivity', group: 'Input', min: 0.3, max: 2.5, step: 0.05, unit: 'x', description: 'Relative pointer movement. Touch uses the same CSS-pixel gain in either orientation; mouse follows the scene scale.' },
  { key: 'health', label: 'Health', group: 'Health', min: 1, max: 20, step: 1, unit: '', whole: true, description: 'Damage the character takes before dying. Enemies deal 1 a bump, traps their own damage and lava its damage each second; each hit leaves the character unharmed for a second. A death, like a fall out of the level, brings the player back at the bonfire reached last, or restarts the run when none was. Shown only in levels with enemies, traps or lava.' },
  { key: 'lavaBuoyancy', label: 'Lava buoyancy', group: 'Liquids', min: 0, max: 300, step: 5, unit: '%', description: 'How much of the player\'s weight lava holds up with the pot all under its surface: above 100% the player floats with part of the pot out, below it sinks. Only the pot floats: lava slows the hammer but does not hold it up.' },
  { key: 'lavaDrag', label: 'Lava drag', group: 'Liquids', min: 0, max: 20, step: 0.1, unit: '/s', description: 'How thick lava is: with the pot all under its surface the player slows at this rate, losing 63% of its speed in 1/rate seconds. The hammer meets it too, so swinging it through lava rows the player along.' },
  { key: 'lavaDamage', label: 'Lava damage', group: 'Liquids', min: 1, max: 20, step: 1, unit: '/s', whole: true, description: 'Damage lava deals the character while the pot is in it: on touching it, then each second it stays. The hammer does not burn.' },
  { key: 'swampBuoyancy', label: 'Swamp buoyancy', group: 'Liquids', min: 0, max: 300, step: 5, unit: '%', description: 'How much of the player\'s weight swamp holds up with the pot all under its surface: below 100% the player sinks through it, as slowly as its drag allows. Only the pot floats.' },
  { key: 'swampDrag', label: 'Swamp drag', group: 'Liquids', min: 0, max: 20, step: 0.1, unit: '/s', description: 'How thick swamp is: with the pot all under its surface the player slows at this rate, and the hammer drags through it too. Swamp does no damage; a thick one holds the player back.' },
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

function validateTuning(value: unknown): Tuning {
  settingsFields(value, TUNING_FIELDS.map((field) => field.key), 'Physics tuning');
  const result = { ...DEFAULT_TUNING };
  for (const field of TUNING_FIELDS) {
    result[field.key] = settingNumber(value[field.key], field);
    if (field.whole && !Number.isInteger(result[field.key])) throw new GameSettingsError(`${field.label} must be a whole number.`);
  }
  return Object.freeze(result);
}

function validateRig(value: unknown): RigSettings {
  settingsFields(value, [...RIG_FIELDS.map((field) => field.key), 'head'], 'Hammer rig');
  const result = { ...DEFAULT_RIG_SETTINGS };
  for (const field of RIG_FIELDS) {
    result[field.key] = settingNumber(value[field.key], field);
  }
  try {
    result.head = validateHammerHead(value.head);
  } catch (error) {
    if (!(error instanceof HammerHeadError)) throw error;
    throw new GameSettingsError(`The hammer head: ${error.message}`);
  }
  const limit = minReachLimit(result);
  if (result.minReach > limit) {
    throw new GameSettingsError(`Minimum reach must be at most ${Number(limit.toFixed(3))} m, ${MIN_SLIDER_TRAVEL * 100} cm short of the hammer's ` +
      `${Number(rigGeometry(result).maxReach.toFixed(3))} m reach, so the slider can still move.`);
  }
  return Object.freeze(result);
}

// A new rig keeps a full-reach target radius at the full reach and caps a smaller one at the new reach; the minimum
// reach is capped where the slider can still move.
export function withRig(settings: Readonly<GameSettings>, rig: Readonly<RigSettings>): GameSettings {
  const previousReach = rigGeometry(settings.rig).maxReach;
  const reach = rigGeometry(rig).maxReach;
  const fullReach = settings.cursor.maxTargetRadius >= previousReach;
  return {
    ...settings, rig: { ...rig, minReach: Math.min(rig.minReach, minReachLimit(rig)) },
    cursor: { ...settings.cursor, maxTargetRadius: fullReach ? reach : Math.min(settings.cursor.maxTargetRadius, reach) },
  };
}

export function validateGameSettings(value: unknown): GameSettings {
  settingsFields(value, ['schemaVersion', 'physics', 'rig', 'cursor'], 'Game settings profile');
  if (value.schemaVersion !== 9) throw new GameSettingsError('Game settings require schema version 9.');
  const rig = validateRig(value.rig);
  settingsFields(value.cursor, CURSOR_FIELDS.map((field) => field.key), 'Cursor settings');
  const cursor = { ...DEFAULT_CURSOR_SETTINGS };
  for (const field of CURSOR_FIELDS) cursor[field.key] = settingNumber(value.cursor[field.key], field);
  const reach = rigGeometry(rig).maxReach;
  if (cursor.maxTargetRadius > reach) {
    throw new GameSettingsError(`Maximum target radius must not exceed the hammer's ${Number(reach.toFixed(3))} m reach.`);
  }
  return Object.freeze({ schemaVersion: 9, physics: validateTuning(value.physics), rig, cursor: Object.freeze(cursor) });
}
