import type { Point } from './config';

export const ENEMY_SPECIES = ['bird', 'hollow-soldier'] as const;
export type EnemySpecies = (typeof ENEMY_SPECIES)[number];
export const ENEMY_FACINGS = ['left', 'right'] as const;
export type EnemyFacing = (typeof ENEMY_FACINGS)[number];
export const ENEMY_DIRECTION = { left: -1, right: 1 } as const;

export const ENEMY_LIMITS = { objects: 64 } as const;
export const ENEMY_FIELDS = {
  patrolDistance: { label: 'Patrol radius', min: 0, max: 20, step: 0.5 },
  speed: { label: 'Patrol speed', min: 0, max: 4, step: 0.1 },
} as const;

export const ENEMY_SPECS = {
  bird: {
    label: 'Bird', width: 1.2, height: 0.8,
    collider: { type: 'circle', radius: 0.26 },
    mass: 0.55, health: 1, acceleration: 22, speed: 1.4, patrolDistance: 3,
  },
  'hollow-soldier': {
    label: 'Hollow soldier', width: 1, height: 1.4,
    collider: { type: 'box', halfWidth: 0.26, halfHeight: 0.7 },
    mass: 3, health: 2, acceleration: 28, speed: 0.8, patrolDistance: 2,
  },
} as const;

export const ENEMY_BEHAVIOR = {
  wakeDistance: 18, sleepDistance: 26, queryMovement: 0.75, decisionSeconds: 0.12,
  hitSpeed: 0.8, hitSeconds: 0.25, hurtSeconds: 0.18, deathSeconds: 0.45,
  bumpSeconds: 0.7, bumpSpeed: 3, bumpLift: 1.4,
  patrolTolerance: 0.15, ledgeAhead: 0.3, ledgeDepth: 0.55, probeRise: 0.2, minimumWallNormal: 0.5,
  birdSight: 6, birdWindupSeconds: 0.5, birdDiveSeconds: 1,
  birdRecoverSeconds: 1.6, birdDiveSpeed: 5, birdReturnSpeed: 2.8,
  birdReturnTolerance: 0.3, birdHeightGain: 2,
  fallenDistance: 30, movingSpeed: 0.08,
} as const;

export type EnemyPhase = 'patrol' | 'windup' | 'dive' | 'recover' | 'hurt' | 'dead';

export interface EnemyPose extends Readonly<Point> {
  readonly id: string;
  readonly species: EnemySpecies;
  readonly facing: EnemyFacing;
  readonly phase: EnemyPhase;
  readonly changedAt: number;
  readonly moving: boolean;
}

export type EnemyEvent =
  | { readonly type: 'reset'; readonly poses: readonly EnemyPose[] }
  | { readonly type: 'upsert'; readonly pose: EnemyPose }
  | { readonly type: 'remove'; readonly id: string };

export function enemyBounds(object: Readonly<Point> & { readonly species: EnemySpecies }) {
  const spec = ENEMY_SPECS[object.species];
  return {
    minX: object.x - spec.width / 2, maxX: object.x + spec.width / 2,
    minY: object.y - spec.height / 2, maxY: object.y + spec.height / 2,
  };
}
