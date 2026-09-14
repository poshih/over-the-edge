export interface Point {
  x: number;
  y: number;
}

export type PracticeId = 'start' | 'ledge' | 'pogo' | 'vault';

export interface Tuning {
  hingeTorque: number;
  sliderForce: number;
  angleGain: number;
  angleDamping: number;
  extensionGain: number;
  extensionDamping: number;
  angularSpeed: number;
  linearSpeed: number;
  playerMass: number;
  hammerMass: number;
  shaftMass: number;
  hingeCarrierMass: number;
  sliderCarriageMass: number;
  bodyDamping: number;
  gripFriction: number;
  handleFrequency: number;
  handleDamping: number;
  mouseSensitivity: number;
  cursorRelaxation: number;
}

export const DEFAULT_TUNING: Readonly<Tuning> = Object.freeze({
  hingeTorque: 420,
  sliderForce: 850,
  angleGain: 14,
  angleDamping: 0.12,
  extensionGain: 18,
  extensionDamping: 0.12,
  angularSpeed: 12,
  linearSpeed: 7,
  playerMass: 12,
  hammerMass: 1.8,
  shaftMass: 0.66,
  hingeCarrierMass: 0.5,
  sliderCarriageMass: 0.5,
  bodyDamping: 0.12,
  gripFriction: 2.5,
  handleFrequency: 0,
  handleDamping: 0.9,
  mouseSensitivity: 1,
  cursorRelaxation: 8,
});

interface TuningField {
  key: keyof Tuning;
  label: string;
  group: 'Mass & recoil' | 'Motors' | 'Response' | 'Materials' | 'Input';
  min: number;
  max: number;
  step: number;
  unit: string;
  description: string;
}

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
  { key: 'cursorRelaxation', label: 'Cursor settling', group: 'Input', min: 0, max: 24, step: 0.5, unit: '/s', description: 'At low input speed, a head touching terrain can settle its contact target. Free-space aiming is never relaxed.' },
];

export class TuningError extends Error {}

export function validateTuning(value: unknown): Tuning {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TuningError('A tuning profile must contain a settings object.');
  }
  if (Object.keys(value).length !== TUNING_FIELDS.length) {
    throw new TuningError('The tuning profile contains missing or unknown settings.');
  }
  const result = { ...DEFAULT_TUNING };
  for (const field of TUNING_FIELDS) {
    const candidate: unknown = Reflect.get(value, field.key);
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) ||
      candidate < field.min || candidate > field.max) {
      throw new TuningError(`${field.label} must be between ${field.min} and ${field.max}.`);
    }
    result[field.key] = candidate;
  }
  return result;
}

export const PHYSICS = {
  dt: 1 / 240,
  gravity: 9.81,
  velocityIterations: 64,
  positionIterations: 20,
  maxFrameSteps: 12,
  terrainCategory: 1,
  playerCategory: 2,
  toolCategory: 4,
  terrainFriction: 3,
  potFriction: 0.45,
  rootMassFraction: 0.25,
  guideInertiaPerMass: 0.07,
  aimEpsilon: 0.000001,
  pointerSpeedResponse: 12,
  cursorSettlingSpeed: 1.2,
} as const;

const POT_BOTTOM = -0.48;
const HANDLE_SEGMENTS = 3;
const SEGMENT_LENGTH = 0.5;
const HANDLE_LENGTH = HANDLE_SEGMENTS * SEGMENT_LENGTH;
const MAX_EXTENSION = 1.15;

export const RIG = {
  shoulder: { x: 0, y: 0.67 },
  potBottom: POT_BOTTOM,
  potAngleLimit: 0.26,
  handleSegments: HANDLE_SEGMENTS,
  segmentLength: SEGMENT_LENGTH,
  handleLength: HANDLE_LENGTH,
  handleHalfWidth: 0.045,
  minExtension: -HANDLE_LENGTH,
  maxExtension: MAX_EXTENSION,
  maxReach: HANDLE_LENGTH + MAX_EXTENSION,
  potVertices: [
    { x: -0.2, y: POT_BOTTOM }, { x: 0.2, y: POT_BOTTOM },
    { x: 0.44, y: -0.29 }, { x: 0.5, y: 0.12 },
    { x: 0.43, y: 0.32 }, { x: -0.43, y: 0.32 },
    { x: -0.5, y: 0.12 }, { x: -0.44, y: -0.29 },
  ],
  headVertices: [
    { x: -0.1, y: -0.23 }, { x: -0.06, y: -0.29 },
    { x: 0.06, y: -0.29 }, { x: 0.1, y: -0.23 },
    { x: 0.1, y: 0.23 }, { x: 0.06, y: 0.29 },
    { x: -0.06, y: 0.29 }, { x: -0.1, y: 0.23 },
  ],
} as const;

export interface HudState {
  height: number;
  bestHeight: number;
  elapsed: number;
  paused: boolean;
  pointerLocked: boolean;
  inputMode: InputMode;
  debug: boolean;
  practice: PracticeId;
  contacts: number;
  hingeLoad: number;
  sliderLoad: number;
  summit: boolean;
}

export type UiAction = 'play' | 'reset' | 'pause' | 'debug' | 'recenter';
export type InputMode = 'mouse' | 'touch';
export interface UiActionOptions {
  inputMode?: InputMode;
}
export interface WorkshopState {
  open: boolean;
  compact: boolean;
}

export interface UiOptions {
  mount: HTMLElement;
  initialTuning: Readonly<Tuning>;
  initialInputMode: InputMode;
  onAction: (action: UiAction, options?: UiActionOptions) => void;
  onWorkshopChange: (state: WorkshopState) => void;
  onPractice: (practice: PracticeId) => void;
  onTuningChange: (tuning: Tuning) => void;
}

export interface GameUi {
  appearanceMount: HTMLElement;
  closeWorkshop: () => void;
  update: (state: HudState) => void;
  setTuning: (tuning: Readonly<Tuning>) => void;
  notice: (message: string, kind: 'info' | 'error') => void;
  dispose: () => void;
}
