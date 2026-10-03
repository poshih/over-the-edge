// Prepares an imported avatar's motions: the built-in hair, then each motion its settings list, every one bound to the
// model through the kind's own validation and the engine's claim rules. Pure: no scene, material or renderer is
// touched, so builds, the project server and the Workshop run exactly the checks a loading avatar does.
import { Matrix4 } from 'three';
import { sameRigJson } from './avatar-driver';
import { AVATAR_JOINT_IDS, CharacterModelError, sameAvatarHair } from './character-profile';
import type { AvatarJointId, AvatarModelSettings } from './character-profile';
import { resolveAvatarHair } from './character-model-inspect';
import type { CharacterModelReport, ResolvedAvatarHair, ResolvedAvatarJoints } from './character-model-inspect';
import type { AvatarRigBinds } from './avatar-rig-math';
import { AVATAR_MOTION_LIMITS, HAIR_MOTION_ID } from './avatar-motion-data';
import { AvatarMotionError, motionRefusal } from './avatar-motion';
import type { AvatarMotion, AvatarMotionJoint, AvatarMotionKind, AvatarMotionModel } from './avatar-motion';
import { HairMotion } from './skinned-hair';

// A motion bound to one avatar, and the joints it claimed, copied when it was prepared.
export interface PreparedAvatarMotion {
  // The kind's ID, or "hair" for the built-in hair.
  readonly id: string;
  readonly motion: AvatarMotion;
  readonly claims: readonly number[];
}

// An avatar's motions in the order they run: hair first, when it has chains, then its settings' motions. Their
// claims are disjoint and never nest, so the order cannot change a result.
export interface PreparedAvatarMotions {
  readonly model: AvatarMotionModel;
  readonly motions: readonly PreparedAvatarMotion[];
}

// The hair and motion settings motions are prepared from.
export type AvatarMotionSettings = Pick<AvatarModelSettings, 'hair' | 'motion'>;

// Motions running on the same fitted model, and the settings they were prepared from.
export interface RunningAvatarMotions {
  readonly settings: AvatarMotionSettings;
  readonly motions: PreparedAvatarMotions;
}

// The facts a kind binds to: each skin joint's name, nearest joint ancestor and avatar-space bind, the mapped joints
// and hair's joints. `jointOf` maps a node to its skin joint's index.
function motionModel(report: CharacterModelReport, resolved: ResolvedAvatarJoints, binds: AvatarRigBinds,
  hair: ResolvedAvatarHair, jointOf: ReadonlyMap<number, number>): AvatarMotionModel {
  const parentJoint = (node: number): number | null => {
    for (let parent = report.parents[node] ?? null; parent !== null; parent = report.parents[parent] ?? null) {
      const joint = jointOf.get(parent);
      if (joint !== undefined) return joint;
    }
    return null;
  };
  const joints = report.joints.map((joint): AvatarMotionJoint => Object.freeze({
    name: joint.name, parent: parentJoint(joint.node),
    bind: new Matrix4().multiplyMatrices(binds.fit, new Matrix4().fromArray(joint.bind)),
  }));
  const mapped = Object.fromEntries(AVATAR_JOINT_IDS.map(id => [id, jointOf.get(resolved.nodes[id])!])) as Record<AvatarJointId, number>;
  const hairJoints = new Set(hair.chains.flatMap(chain => chain.nodes.map(node => jointOf.get(node)!)));
  return Object.freeze({ joints: Object.freeze(joints), mapped: Object.freeze(mapped), hair: hairJoints });
}

// A kind's motion must be an object with an update() and a list of distinct skin-joint indices.
function claimsOf(motion: unknown, id: string, joints: readonly AvatarMotionJoint[]): readonly number[] {
  if (typeof motion !== 'object' || motion === null || typeof Reflect.get(motion, 'update') !== 'function') {
    throw new AvatarMotionError('invalid-motion', `Avatar motion "${id}" must synchronously prepare a motion with an update() function.`, id);
  }
  const claims: unknown = Reflect.get(motion, 'claims');
  if (!Array.isArray(claims)) throw new AvatarMotionError('invalid-motion', `Avatar motion "${id}" must list the joints it claims.`, id);
  const seen = new Set<number>();
  for (const claim of claims) {
    if (!Number.isInteger(claim) || claim < 0 || claim >= joints.length) {
      throw new AvatarMotionError('invalid-motion', `Avatar motion "${id}" claims ${String(claim)}, which is not a skin joint's index.`, id);
    }
    if (seen.has(claim)) throw new AvatarMotionError('invalid-motion', `Avatar motion "${id}" claims "${joints[claim]!.name}" twice.`, id);
    seen.add(claim);
  }
  return Object.freeze([...seen]);
}

function owner(id: string): string {
  return id === HAIR_MOTION_ID ? 'the hair' : `motion "${id}"`;
}

// The engine's claim rules: a claimed joint is not mapped, belongs to one motion, does not carry a mapped joint, and
// neither carries nor hangs below another motion's joint. Hair's own rules (resolveAvatarHair) already hold.
function checkClaims(model: AvatarMotionModel, motions: readonly PreparedAvatarMotion[]): void {
  const mapped = new Set(Object.values(model.mapped));
  const owners = new Map<number, string>();
  let claimed = 0;
  for (const { id, claims } of motions) {
    if (id !== HAIR_MOTION_ID) claimed += claims.length;
    for (const claim of claims) {
      const name = model.joints[claim]!.name;
      if (mapped.has(claim)) {
        throw new CharacterModelError('mapped-claim', `Avatar motion "${id}" claims "${name}", which the bone map drives.`, { joints: [name] });
      }
      const other = owners.get(claim);
      if (other !== undefined) {
        throw new CharacterModelError('shared-claim', `Avatar motion "${id}" claims "${name}", which ${owner(other)} already moves.`, { joints: [name] });
      }
      owners.set(claim, id);
    }
  }
  if (claimed > AVATAR_MOTION_LIMITS.claims) {
    throw new CharacterModelError('claim-limits',
      `The avatar's motions claim ${claimed} joints; together they move at most ${AVATAR_MOTION_LIMITS.claims}.`);
  }
  for (const [claim, id] of owners) {
    for (let parent = model.joints[claim]!.parent; parent !== null; parent = model.joints[parent]!.parent) {
      const other = owners.get(parent);
      if (other === undefined || other === id) continue;
      const name = model.joints[claim]!.name;
      const above = model.joints[parent]!.name;
      throw new CharacterModelError('nested-claim', `"${name}", which ${owner(id)} moves, hangs below "${above}", which ${owner(other)} moves; `
        + 'motions never nest.', { joints: [name, above] });
    }
  }
  for (const id of AVATAR_JOINT_IDS) {
    for (let parent = model.joints[model.mapped[id]]!.parent; parent !== null; parent = model.joints[parent]!.parent) {
      const other = owners.get(parent);
      // Hair that carries a mapped joint is hair's broken-chain.
      if (other === undefined || other === HAIR_MOTION_ID) continue;
      const above = model.joints[parent]!.name;
      throw new CharacterModelError('nested-claim', `The ${id} joint hangs below "${above}", which motion "${other}" moves; `
        + 'a motion moves joints the bone map does not carry.', { joints: [id, above] });
    }
  }
}

/**
 * Binds an avatar's motions to its model. The hair resolves against the skin; each entry's kind validates its
 * configuration against the model's facts and claims the joints it moves. An unregistered kind, a refusal, a malformed
 * motion or a claim the engine refuses throws a typed error and is never skipped. `kind` looks a kind up, refusing an
 * unknown one. Without hair or entries no motion runs, and the avatar costs nothing more per frame. With the same hair
 * as `running`, motions prepared on the same fitted model, unchanged motions are kept, state and all, so editing one
 * motion leaves the others moving.
 */
export function prepareAvatarMotions(report: CharacterModelReport, resolved: ResolvedAvatarJoints, binds: AvatarRigBinds,
  settings: AvatarMotionSettings, kind: (id: string) => AvatarMotionKind, running?: RunningAvatarMotions): PreparedAvatarMotions {
  const kept = running !== undefined && sameAvatarHair(running.settings.hair, settings.hair) ? running : undefined;
  const motions: PreparedAvatarMotion[] = [];
  let model: AvatarMotionModel;
  if (kept !== undefined) {
    model = kept.motions.model;
    const hair = kept.motions.motions.find(motion => motion.id === HAIR_MOTION_ID);
    if (hair !== undefined) motions.push(hair);
  } else {
    const hair = resolveAvatarHair(report, resolved, settings.hair);
    const jointOf = new Map(report.joints.map((joint, index) => [joint.node, index] as const));
    model = motionModel(report, resolved, binds, hair, jointOf);
    if (hair.chains.length > 0) {
      const motion = new HairMotion(hair, model, hair.chains.map(chain => chain.nodes.map(node => jointOf.get(node)!)));
      motions.push(Object.freeze({ id: HAIR_MOTION_ID, motion, claims: motion.claims }));
    }
  }
  for (const entry of settings.motion) {
    const before = kept?.settings.motion.find(other => other.id === entry.id);
    const same = before !== undefined && sameRigJson(before.config, entry.config)
      ? kept!.motions.motions.find(motion => motion.id === entry.id) : undefined;
    if (same !== undefined) {
      motions.push(same);
      continue;
    }
    const prepare = kind(entry.id);
    let motion: AvatarMotion;
    try {
      motion = prepare.prepare(entry.config, model);
    } catch (error) {
      throw motionRefusal(error, entry.id);
    }
    motions.push(Object.freeze({ id: entry.id, motion, claims: claimsOf(motion, entry.id, model.joints) }));
  }
  checkClaims(model, motions);
  return Object.freeze({ model, motions: Object.freeze(motions) });
}
