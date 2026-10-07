import type { DeathFrame } from './death-sequence';
import { apply2, invalidResult, slotPoint } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import { copyDeathPose, copyRotation, createDeathPose, validDeathPose, validHeadFacing } from './player-pose';
import type { DeathPose, ReadonlyDeathArmPose, ReadonlyDeathLayout, ReadonlyDeathPose, Rotation3 } from './player-pose';
import type { ArmSide } from './character';
import type { CharacterRiggingType } from './sprite-data';
import { ARM_SIDES } from './character';
import { PLAYER_FIGURE } from './player-figure-data';

export type { DeathArmPose, DeathLayout, DeathPose, ReadonlyDeathArmPose, ReadonlyDeathLayout, ReadonlyDeathPose, Rotation3, Transform2 } from './player-pose';

export interface DeathPoseInput extends DeathFrame {
  readonly character: CharacterRiggingType;
  readonly body: 'ragdoll' | 'rigid';
  readonly attachment: 'released' | 'gripped';
  readonly physical: ReadonlyDeathPose;
  readonly headFacing: Readonly<Rotation3>;
  readonly layout: ReadonlyDeathLayout;
  readonly direction: -1 | 1;
  // Hold mode's grip-driven baseline, evaluated with the default slump. Null for released hands.
  readonly grippedArms: Readonly<Record<ArmSide, ReadonlyDeathArmPose>> | null;
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
  copyDeathPose(out, frame.physical);
  copyRotation(out.headFacing, frame.headFacing);
  if (frame.grippedArms !== null) {
    for (const side of ARM_SIDES) {
      const from = frame.grippedArms[side], to = out.arms[side];
      to.shoulder.x = from.shoulder.x; to.shoulder.y = from.shoulder.y;
      to.elbow.x = from.elbow.x; to.elbow.y = from.elbow.y;
      to.hand.x = from.hand.x; to.hand.y = from.hand.y; to.hand.angle = from.hand.angle;
    }
  }
  const progress = frame.reducedMotion ? 1 : frame.poseProgress;
  const weight = progress * progress * (3 - 2 * progress);
  out.spriteBrightness = 1 - 0.55 * weight;
  if (frame.body === 'ragdoll' || frame.character === 'sprite-2d') return;
  const lean = -frame.direction * 20 * Math.PI / 180 * weight;
  const before = frame.physical.torso, after = out.torso, waist = frame.layout.waist;
  const oldCos = Math.cos(before.angle), oldSin = Math.sin(before.angle);
  const waistX = before.x + oldCos * waist.x - oldSin * waist.y;
  const waistY = before.y + oldSin * waist.x + oldCos * waist.y;
  after.angle += lean;
  const cos = Math.cos(after.angle), sin = Math.sin(after.angle);
  after.x = waistX - cos * waist.x + sin * waist.y;
  after.y = waistY - sin * waist.x - cos * waist.y;
  const turnCos = Math.cos(lean), turnSin = Math.sin(lean);
  const dx = out.head.x - waistX, dy = out.head.y - waistY;
  out.head.x = waistX + turnCos * dx - turnSin * dy;
  out.head.y = waistY + turnSin * dx + turnCos * dy;
  out.head.angle += lean;
  // Local X nod, composed after the captured facial yaw/pitch.
  const half = 35 * Math.PI / 180 * weight / 2, sx = Math.sin(half), cw = Math.cos(half);
  const q = frame.headFacing;
  out.headFacing.x = q.x * cw + q.w * sx;
  out.headFacing.y = q.y * cw + q.z * sx;
  out.headFacing.z = q.z * cw - q.y * sx;
  out.headFacing.w = q.w * cw - q.x * sx;
  const n = out.headFacing, height = PLAYER_FIGURE.helmet.y - PLAYER_FIGURE.neck.y;
  const nodX = 2 * height * (n.x * n.y - n.z * n.w - q.x * q.y + q.z * q.w);
  const nodY = 2 * height * (q.x * q.x + q.z * q.z - n.x * n.x - n.z * n.z);
  out.head.x += cos * nodX - sin * nodY;
  out.head.y += sin * nodX + cos * nodY;
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
