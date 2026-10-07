// The avatar-motion SDK: secondary motion a game registers for its imported skinned avatars, such as tails, ears,
// flaps or dangling accessories, without editing the engine. Kinds live in a plugin's kinds facet
// (docs/kinds-plugins.md) beside its rig strategies; a profile's `avatar.motion` names a kind by ID
// with configuration only that kind interprets. When an avatar loads, the kind validates its configuration against
// read-only facts about the model and claims the unmapped skin joints it will move. Every frame, after the mapped
// joints are posed, the engine hands each motion its clock, its placement, the mapped joints and each claim's rest
// frame, and turns the frames it writes into bone matrices. The built-in hair runs through the same interface.
// Motion is presentation only: it never sees physics, gameplay or the scene graph.
import type { Matrix4 } from 'three';
import type { RigJson } from './avatar-driver';
import type { AvatarJointId } from './character-profile';
import { SpriteError } from './sprite-fields';

export { MOTION_MAX_STEPS as AVATAR_MOTION_MAX_STEPS, MOTION_STEP_SECONDS as AVATAR_MOTION_STEP_SECONDS } from './motion-clock';
export { AVATAR_MOTION_LIMITS, HAIR_MOTION_ID } from './avatar-motion-data';
export type { AvatarMotionEntry } from './avatar-motion-data';
export type { RigJson } from './avatar-driver';

// The engine's refusal codes. A kind refuses its configuration with codes of its own.
export const AVATAR_MOTION_ERROR_CODES = ['unknown-kind', 'invalid-motion'] as const;
export type AvatarMotionEngineErrorCode = typeof AVATAR_MOTION_ERROR_CODES[number];

// A portable tag for a typed refusal across Vite's separate Node module-runner class identity.
export const AVATAR_MOTION_ERROR_KIND = 'avatar-motion-error';
const ERROR_CODE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * A typed motion refusal; callers branch on `code`, never the message. A kind throws it for a configuration it
 * refuses, with a code of its own (lowercase letters, numbers and hyphens); the engine raises the codes above for
 * lookup and content contract faults. `motion` is the kind the refusal concerns: the engine sets it on a
 * kind's own refusals.
 */
export class AvatarMotionError extends SpriteError {
  readonly kind = AVATAR_MOTION_ERROR_KIND;
  readonly code: string;
  readonly motion: string | null;

  constructor(code: string, message: string, motion: string | null = null) {
    super(message);
    if (!ERROR_CODE.test(code)) throw new TypeError(`Avatar motion error codes use lowercase letters, numbers and hyphens, not "${code}".`);
    this.name = 'AvatarMotionError';
    this.code = code;
    this.motion = motion;
  }
}

// A kind's refusal may cross the Vite Node module runner as a separate copy of AvatarMotionError, so its portable tag
// identifies it, and it is rebuilt as the host's class naming the kind. Anything else is a programmer error and
// propagates untouched.
export function motionRefusal(error: unknown, motion: string): unknown {
  if (typeof error !== 'object' || error === null || Reflect.get(error, 'kind') !== AVATAR_MOTION_ERROR_KIND) return error;
  const code = Reflect.get(error, 'code');
  const message = Reflect.get(error, 'message');
  if (typeof code !== 'string' || !ERROR_CODE.test(code) || typeof message !== 'string') return error;
  return new AvatarMotionError(code, `Avatar motion "${motion}": ${message}`, motion);
}

// One skin joint of the model, in the order its skin lists them; claims and parents are indices into that list.
export interface AvatarMotionJoint {
  readonly name: string;
  // The nearest ancestor that is a skin joint, or null.
  readonly parent: number | null;
  // Its bind frame in the fitted avatar space: metres, +Y up, the model facing +Z, the shoulders 0.74 m above the
  // player root.
  readonly bind: Readonly<Matrix4>;
}

// Read-only facts about the model a motion binds to.
export interface AvatarMotionModel {
  readonly joints: readonly AvatarMotionJoint[];
  // The skin joint the bone map drives for each avatar joint.
  readonly mapped: Readonly<Record<AvatarJointId, number>>;
  // The skin joints the built-in hair simulates.
  readonly hair: ReadonlySet<number>;
}

// The mapped joints' frames in avatar space, at bind and as the rig posed them this frame.
export interface AvatarMotionSkeleton {
  readonly bind: Readonly<Record<AvatarJointId, Readonly<Matrix4>>>;
  readonly current: Readonly<Record<AvatarJointId, Readonly<Matrix4>>>;
}

/**
 * One frame of a motion. The engine owns every matrix and reuses this object, so a motion keeps no reference to it
 * between frames.
 */
export interface AvatarMotionFrame {
  // Start from rest, taking no steps: the avatar is new, the player was explicitly placed, or it was not simulated
  // for longer than the catch-up limit. Pauses and tab hiding settle interpolation; only explicit placements rewind
  // presentation time, and placements also restart hair and motions, with elapsed time clamped at zero.
  readonly reset: boolean;
  // Fixed steps to advance: 0 when reset or while time stands still, at most AVATAR_MOTION_MAX_STEPS.
  readonly steps: number;
  readonly stepSeconds: number;
  // Where avatar space sits in the world, including the upper body's waist lean.
  readonly body: Readonly<Matrix4>;
  // The pot's frame in the world: its origin at the jar's bottom-centre, +Y up.
  readonly pot: Readonly<Matrix4>;
  readonly mapped: AvatarMotionSkeleton;
  // Each claimed joint's frame this frame, in avatar space, if it followed its nearest mapped joint rigidly, as
  // unmapped joints do; in claim order.
  readonly rest: readonly Readonly<Matrix4>[];
  // Where the motion writes each claimed joint's frame this frame, in avatar space, in claim order. Joints below a
  // claimed joint follow it rigidly.
  readonly out: readonly Matrix4[];
}

// A motion prepared for one avatar. `update` runs every frame and must not allocate.
export interface AvatarMotion {
  // The unmapped skin joints it moves, by index. Claims are disjoint from hair's and every other motion's, and never
  // carry a mapped joint or nest with another motion's joints.
  readonly claims: readonly number[];
  update(frame: AvatarMotionFrame): void;
}

/**
 * A host-provided kind of secondary motion. `prepare` validates its configuration against the model, refusing with
 * AvatarMotionError, and returns the motion for one avatar; it runs before any scene change. Trusted code, not content.
 */
export interface AvatarMotionKind {
  readonly id: string;
  prepare(config: RigJson, model: AvatarMotionModel): AvatarMotion;
}
