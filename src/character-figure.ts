import { ARM_SIDES, DEFAULT_ARM_IK } from './character';
import type { ArmIkSettings, ArmSide } from './character';
import { RIG } from './config';
import type { Point } from './config';
import type { ArmLengths } from './character-arms';
import { DEFAULT_GRIPS, GRIP_LIMITS } from './grips';
import type { Grips } from './grips';
import { DEFAULT_ARM_CHAINS, PLAYER_FIGURE } from './player-figure-data';
import type { ArmChains } from './player-figure-data';
import type { DeathArmPose, DeathPose } from './player-pose';
import { WAIST_LEAN_LIMITS, waistLeanTarget } from './waist-lean';

export interface FigureArm {
  readonly shoulder: Readonly<Point>;
  readonly upper: number;
  readonly forearm: number;
  readonly pole: Readonly<Point>;
}
export interface CharacterFigure {
  readonly waistLean: number;
  readonly neck: Readonly<Point>;
  readonly arms: Readonly<Record<ArmSide, FigureArm>>;
  readonly grips: Readonly<Record<ArmSide, number>>;
}
export interface CharacterFigureSource {
  readonly waistLean: number;
  readonly grips: Readonly<Pick<Grips, 'left' | 'right'>>;
  readonly chains: ArmChains;
  readonly reach: Readonly<Record<ArmSide, ArmLengths | null>>;
  readonly neck: Readonly<Point>;
  readonly armIk: Readonly<ArmIkSettings>;
}

export const CORPSE_WAIST: Readonly<Point> = Object.freeze({ x: 0, y: Math.max(...RIG.potVertices.map(point => point.y)) });
export const HEAD_RISE = PLAYER_FIGURE.helmet.y - PLAYER_FIGURE.neck.y;

export class CharacterFigureError extends Error {
  readonly code = 'invalid-figure';

  constructor(message: string) {
    super(message); this.name = 'CharacterFigureError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CharacterFigureError(`${label} must be a record.`);
  }
  return value as Record<string, unknown>;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CharacterFigureError(`${label} must be finite.`);
  return value;
}
function point(value: unknown, label: string): Readonly<Point> {
  const source = record(value, label);
  return Object.freeze({ x: finite(source.x, `${label} X`), y: finite(source.y, `${label} Y`) });
}
function positive(value: unknown, label: string): number {
  const length = finite(value, label);
  if (length <= 0) throw new CharacterFigureError(`${label} must be positive.`);
  return length;
}
function bounded(value: unknown, limits: { readonly min: number; readonly max: number }, label: string): number {
  const number = finite(value, label);
  if (number < limits.min || number > limits.max) {
    throw new CharacterFigureError(`${label} must be within ${limits.min}–${limits.max}.`);
  }
  return number;
}

export function validateCharacterFigure(value: unknown): CharacterFigure {
  const source = record(value, 'Character figure');
  const arms = record(source.arms, 'Figure arms'), grips = record(source.grips, 'Figure grips');
  const arm = (side: ArmSide): FigureArm => {
    const input = record(arms[side], `${side} figure arm`);
    return Object.freeze({
      shoulder: point(input.shoulder, `${side} shoulder`),
      upper: positive(input.upper, `${side} upper arm length`),
      forearm: positive(input.forearm, `${side} forearm length`),
      pole: point(input.pole, `${side} arm pole`),
    });
  };
  return Object.freeze({
    waistLean: bounded(source.waistLean, WAIST_LEAN_LIMITS, 'Figure waist lean'),
    neck: point(source.neck, 'Figure neck'),
    arms: Object.freeze({ left: arm('left'), right: arm('right') }),
    grips: Object.freeze({
      left: bounded(grips.left, GRIP_LIMITS, 'Left figure grip'),
      right: bounded(grips.right, GRIP_LIMITS, 'Right figure grip'),
    }),
  });
}

export function resolveCharacterFigure(source: Readonly<CharacterFigureSource>): CharacterFigure {
  const arm = (side: ArmSide): FigureArm => {
    const chain = source.chains[side], lengths = source.reach[side] ?? chain;
    return {
      shoulder: { x: chain.shoulder[0], y: chain.shoulder[1] },
      upper: lengths.upper, forearm: lengths.forearm,
      pole: side === 'left' ? { x: source.armIk.leftHintX, y: source.armIk.leftHintY }
        : { x: source.armIk.rightHintX, y: source.armIk.rightHintY },
    };
  };
  return validateCharacterFigure({
    waistLean: source.waistLean, neck: source.neck,
    arms: { left: arm('left'), right: arm('right') }, grips: source.grips,
  });
}

export function sameCharacterFigure(a: Readonly<CharacterFigure>, b: Readonly<CharacterFigure>): boolean {
  if (a.waistLean !== b.waistLean || a.neck.x !== b.neck.x || a.neck.y !== b.neck.y) return false;
  for (const side of ARM_SIDES) {
    const left = a.arms[side], right = b.arms[side];
    if (a.grips[side] !== b.grips[side] || left.upper !== right.upper || left.forearm !== right.forearm ||
      left.shoulder.x !== right.shoulder.x || left.shoulder.y !== right.shoulder.y ||
      left.pole.x !== right.pole.x || left.pole.y !== right.pole.y) return false;
  }
  return true;
}

export const DEFAULT_CHARACTER_FIGURE: CharacterFigure = resolveCharacterFigure({
  waistLean: 0, neck: { x: 0, y: PLAYER_FIGURE.neck.y }, grips: DEFAULT_GRIPS,
  chains: DEFAULT_ARM_CHAINS, reach: { left: null, right: null }, armIk: DEFAULT_ARM_IK,
});

export interface CorpseReading {
  readonly root: Readonly<Point>;
  readonly butt: Readonly<Point>;
  readonly head: Readonly<Point>;
  readonly headMargin: number;
}

function solvePlanarArm(shoulder: Readonly<Point>, target: Readonly<Point>, upper: number, forearm: number,
  pole: Readonly<Point>, down: Readonly<Point>, out: DeathArmPose): void {
  const dx = target.x - shoulder.x, dy = target.y - shoulder.y, distance = Math.hypot(dx, dy);
  const nx = distance < 1e-9 ? down.x : dx / distance;
  const ny = distance < 1e-9 ? down.y : dy / distance;
  const reach = Math.min(Math.max(distance, Math.abs(upper - forearm)), upper + forearm);
  const along = reach < 1e-9 ? 0 : (upper * upper - forearm * forearm + reach * reach) / (2 * reach);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  const sign = nx * (pole.y - shoulder.y) - ny * (pole.x - shoulder.x) < 0 ? -1 : 1;
  out.shoulder.x = shoulder.x; out.shoulder.y = shoulder.y;
  out.elbow.x = shoulder.x + nx * along - sign * ny * height;
  out.elbow.y = shoulder.y + ny * along + sign * nx * height;
  out.hand.x = shoulder.x + nx * reach; out.hand.y = shoulder.y + ny * reach;
  out.hand.angle = Math.atan2(out.hand.y - out.elbow.y, out.hand.x - out.elbow.x);
}

// Death entry is synchronous and calls no presentation or plugin code.
const pole: Point = { x: 0, y: 0 };
const target: Point = { x: 0, y: 0 };
const down: Point = { x: 0, y: 0 };

export function writeCorpseEntry(figure: Readonly<CharacterFigure>, reading: Readonly<CorpseReading>, out: DeathPose): void {
  const dx = reading.head.x - reading.butt.x, dy = reading.head.y - reading.butt.y;
  const shaftAngle = Math.atan2(dy, dx), length = Math.hypot(dx, dy);
  const lean = waistLeanTarget(shaftAngle, figure.waistLean), cos = Math.cos(lean), sin = Math.sin(lean);
  const waist = CORPSE_WAIST, torso = out.torso;
  torso.x = reading.root.x + waist.x - cos * waist.x + sin * waist.y;
  torso.y = reading.root.y + waist.y - sin * waist.x - cos * waist.y;
  torso.angle = lean;
  out.head.x = torso.x + cos * figure.neck.x - sin * (figure.neck.y + HEAD_RISE);
  out.head.y = torso.y + sin * figure.neck.x + cos * (figure.neck.y + HEAD_RISE);
  out.head.angle = lean;
  down.x = sin; down.y = -cos;
  const shaftCos = Math.cos(shaftAngle), shaftSin = Math.sin(shaftAngle);
  const farthest = Math.max(0, length - reading.headMargin);
  for (const side of ARM_SIDES) {
    const arm = figure.arms[side], pose = out.arms[side];
    pose.shoulder.x = torso.x + cos * arm.shoulder.x - sin * arm.shoulder.y;
    pose.shoulder.y = torso.y + sin * arm.shoulder.x + cos * arm.shoulder.y;
    pole.x = torso.x + cos * arm.pole.x - sin * arm.pole.y;
    pole.y = torso.y + sin * arm.pole.x + cos * arm.pole.y;
    const grip = Math.min(figure.grips[side], farthest);
    target.x = reading.butt.x + grip * shaftCos; target.y = reading.butt.y + grip * shaftSin;
    solvePlanarArm(pose.shoulder, target, arm.upper, arm.forearm, pole, down, pose);
  }
}
