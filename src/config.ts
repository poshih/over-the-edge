export interface Point {
  x: number;
  y: number;
}

// The hammer starts along `angle` with its head `reach` metres from the shoulder hinge.
export interface PlayerSpawn {
  position: Point;
  angle: number;
  reach: number;
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
  // Strength multipliers while input swings the hammer down and each motor speeds the head up downward.
  hingeDownswingBoost: number;
  sliderDownswingBoost: number;
  playerMass: number;
  hammerMass: number;
  shaftMass: number;
  hingeCarrierMass: number;
  sliderCarriageMass: number;
  bodyDamping: number;
  gripFriction: number;
  // Bounciness, in percent: the pot's, the hammer head's and each terrain surface's (src/surfaces.ts).
  potBounciness: number;
  hammerBounciness: number;
  rockBounciness: number;
  woodBounciness: number;
  metalBounciness: number;
  iceBounciness: number;
  rubberBounciness: number;
  handleFrequency: number;
  handleDamping: number;
  mouseSensitivity: number;
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
  hingeDownswingBoost: 1.3,
  sliderDownswingBoost: 1.3,
  playerMass: 12,
  hammerMass: 1.8,
  shaftMass: 0.66,
  hingeCarrierMass: 0.5,
  sliderCarriageMass: 0.5,
  bodyDamping: 0.12,
  gripFriction: 2.5,
  potBounciness: 10,
  hammerBounciness: 0,
  rockBounciness: 10,
  woodBounciness: 20,
  metalBounciness: 30,
  iceBounciness: 5,
  rubberBounciness: 80,
  handleFrequency: 0,
  handleDamping: 0.9,
  mouseSensitivity: 1,
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
  enemyCategory: 8,
  terrainFriction: 3,
  potFriction: 0.45,
  rootMassFraction: 0.25,
  guideInertiaPerMass: 0.07,
  aimEpsilon: 0.000001,
} as const;

const POT_BOTTOM = -0.48;

// The fixed player geometry. The handle length and slide range are game settings (see rig.ts).
export const RIG = {
  shoulder: { x: 0, y: 0.67 },
  potBottom: POT_BOTTOM,
  potAngleLimit: 0.26,
  handleSegments: 3,
  handleHalfWidth: 0.045,
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
