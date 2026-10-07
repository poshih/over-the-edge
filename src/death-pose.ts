import type { DeathFrame } from './death-sequence';
import { apply2, invalidResult, slotPoint } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import { copyRotation, createDeathPose, interpolateDeathPose, validDeathPose, validHeadFacing } from './player-pose';
import type { DeathPose, ReadonlyDeathPose, Rotation3 } from './player-pose';
import type { CharacterRiggingType } from './sprite-data';
import { ARM_SIDES } from './character';

export type { DeathArmPose, DeathPose, ReadonlyDeathArmPose, ReadonlyDeathPose, Rotation3, Transform2 } from './player-pose';

export interface DeathPoseInput extends DeathFrame {
  readonly character: CharacterRiggingType;
  readonly captured: ReadonlyDeathPose;
  readonly physical: ReadonlyDeathPose;
  readonly headFacing: Readonly<Rotation3>;
}
export interface DeathAppearance extends DeathPose {
  headFacing: Rotation3;
  spriteBrightness: number;
}
export interface ReadonlyDeathAppearance extends ReadonlyDeathPose {
  readonly headFacing: Readonly<Rotation3>;
  readonly spriteBrightness: number;
}
export type DeathPoseWriter = (frame: DeathPoseInput, out: DeathAppearance) => void;

function poseWriter(value: unknown): DeathPoseWriter {
  if (typeof value !== 'function') throw new TypeError('A death pose must be a numeric pose writer.');
  return value as DeathPoseWriter;
}
export const DEATH_POSE = slotPoint('scene.death-pose', 'runtime', poseWriter);

export const DEFAULT_DEATH_POSE: DeathPoseWriter = (frame, out) => {
  const progress = frame.reducedMotion ? 1 : frame.poseProgress;
  const weight = progress * progress * (3 - 2 * progress);
  interpolateDeathPose(out, frame.captured, frame.physical, weight);
  copyRotation(out.headFacing, frame.headFacing);
  out.spriteBrightness = 1 - 0.55 * weight;
};

export function createDeathAppearance(): DeathAppearance {
  return { ...createDeathPose(), headFacing: { x: 0, y: 0, z: 0, w: 1 }, spriteBrightness: 1 };
}
function invalidate(out: DeathAppearance): void {
  out.torso.x = out.torso.y = out.torso.angle = out.head.x = out.head.y = out.head.angle = NaN;
  for (const side of ARM_SIDES) {
    const arm = out.arms[side];
    arm.shoulder.x = arm.shoulder.y = arm.elbow.x = arm.elbow.y = arm.hand.x = arm.hand.y = arm.hand.angle = NaN;
  }
  out.headFacing.x = out.headFacing.y = out.headFacing.z = out.headFacing.w = out.spriteBrightness = NaN;
}
export function createDeathPoseWriter(plugins: RuntimePlugins): DeathPoseWriter {
  const writer = plugins.slot(DEATH_POSE, DEFAULT_DEATH_POSE);
  return (frame, out) => {
    invalidate(out);
    apply2(writer, 'write', frame, out);
    if (!validDeathPose(out) || !validHeadFacing(out.headFacing) ||
      !Number.isFinite(out.spriteBrightness) || out.spriteBrightness < 0 || out.spriteBrightness > 1) {
      throw invalidResult(writer, 'must write every finite transform, a unit headFacing quaternion and spriteBrightness within 0–1');
    }
  };
}
