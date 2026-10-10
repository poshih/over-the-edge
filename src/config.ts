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
  // Contact friction coefficients: the hammer head's, the pot's against what it stands on and on its sides, and each
  // terrain surface's (src/surfaces.ts).
  gripFriction: number;
  potFriction: number;
  potSideFriction: number;
  rockFriction: number;
  woodFriction: number;
  metalFriction: number;
  iceFriction: number;
  rubberFriction: number;
  // Bounciness, in percent: the pot's, the hammer head's and each terrain surface's.
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
  // The character's hit points, which every hurt source's damage, also in hit points, takes from.
  health: number;
  hurtInvulnerability: number;
  respawnInvulnerability: number;
  // The player's foot lights a bonfire by coming within its reach. It then burns `bonfireBurnTime` seconds, and once it
  // goes out, coming within reach again lights it again.
  bonfireBurnTime: number;
  // Traps' hurt box around the player's root; height rises from the pot's bottom, depth straddles the obstacle line.
  hurtWidth: number;
  hurtHeight: number;
  hurtDepth: number;
  projectilePush: number;
  projectileLift: number;
  axePush: number;
  axeLift: number;
  // A hammer-head strike hurts an enemy only when it closes faster than the species' armor (m/s). Then it takes
  // `hammerDamage` hit points at `hammerFullSpeed` (m/s) or faster, and proportionally less at slower speeds. Species
  // health, in hit points, applies at reset or spawn; the other enemy rules apply live.
  hammerDamage: number;
  hammerFullSpeed: number;
  birdHealth: number;
  birdArmor: number;
  birdMass: number;
  birdAcceleration: number;
  birdSight: number;
  birdDiveSpeed: number;
  soldierHealth: number;
  soldierArmor: number;
  soldierMass: number;
  soldierAcceleration: number;
  archerHealth: number;
  archerArmor: number;
  archerMass: number;
  archerAcceleration: number;
  archerSight: number;
  // An archer's arrows: the speed they leave the bow at, in m/s, and the damage each deals.
  arrowSpeed: number;
  arrowDamage: number;
  bumpDamage: number;
  bumpSpeed: number;
  bumpLift: number;
  // Each liquid's buoyancy, in percent of the player's weight it holds up with the pot all under its surface, and its
  // drag, the rate it then slows the player at, per second (src/liquids.ts); and the damage lava deals each second.
  lavaBuoyancy: number;
  lavaDrag: number;
  lavaDamage: number;
  swampBuoyancy: number;
  swampDrag: number;
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
  potFriction: 0.45,
  potSideFriction: 0,
  rockFriction: 3,
  woodFriction: 2,
  metalFriction: 1,
  iceFriction: 0.1,
  rubberFriction: 6,
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
  health: 100,
  hurtInvulnerability: 1,
  respawnInvulnerability: 2,
  bonfireBurnTime: 10,
  hurtWidth: 1,
  hurtHeight: 1.58,
  hurtDepth: 0.9,
  projectilePush: 4,
  projectileLift: 1.5,
  axePush: 9,
  axeLift: 4,
  hammerDamage: 100,
  hammerFullSpeed: 8,
  birdHealth: 100,
  birdArmor: 2.5,
  birdMass: 0.55,
  birdAcceleration: 22,
  birdSight: 6,
  birdDiveSpeed: 5,
  soldierHealth: 200,
  soldierArmor: 4,
  soldierMass: 3,
  soldierAcceleration: 28,
  archerHealth: 100,
  archerArmor: 3,
  archerMass: 2.5,
  archerAcceleration: 24,
  archerSight: 14,
  arrowSpeed: 12,
  arrowDamage: 20,
  bumpDamage: 20,
  bumpSpeed: 3,
  bumpLift: 1.4,
  lavaBuoyancy: 160,
  lavaDrag: 3,
  lavaDamage: 20,
  swampBuoyancy: 85,
  swampDrag: 6,
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
  rootMassFraction: 0.25,
  guideInertiaPerMass: 0.07,
  aimEpsilon: 0.000001,
} as const;

// The fixed player geometry. The handle length and slide range, the hammer's head and the jar are game settings
// (see rig.ts).
export const RIG = {
  shoulder: { x: 0, y: 0.67 },
  potAngleLimit: 0.26,
  handleSegments: 3,
  handleHalfWidth: 0.045,
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
