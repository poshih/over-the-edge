export interface Point {
  x: number;
  y: number;
}

export interface PlayerSpawn {
  position: Point;
  angle: number;
  extension: number;
}

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

export type UiAction = 'play' | 'reset' | 'pause' | 'recenter';
export type InputMode = 'mouse' | 'touch';
export interface UiActionOptions {
  inputMode?: InputMode;
}
