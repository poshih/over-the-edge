// The avatar-rig kernel: a trusted-host seam for imported skinned avatars. A driver names a
// strategy and carries bounded JSON config; the registry looks the strategy up, fits the model's
// binds, and hands the strategy a prepared rig for its two frame phases. The same registry holds the
// motion kinds an avatar's `motion` names (src/avatar-motion.ts). No silent fallback: an unknown
// driver or kind, or an invalid config, is a typed error, never the standard rig or a skipped motion.
import { isAvatarDriverId, STANDARD_AVATAR_DRIVER } from './avatar-driver';
import type { RigJson } from './avatar-driver';
import { AvatarMotionError } from './avatar-motion';
import type { AvatarMotionKind } from './avatar-motion';
import { prepareAvatarMotions } from './avatar-motion-prepare';
import type { AvatarMotionSettings, PreparedAvatarMotions, RunningAvatarMotions } from './avatar-motion-prepare';
import { resolveAvatarJoints } from './character-model-inspect';
import type { CharacterModelReport, ResolvedAvatarJoints } from './character-model-inspect';
import type { AvatarModelSettings } from './character-profile';
import { SpriteError } from './sprite-fields';
import { ARM_SIDES } from './character';
import { composeArmJoints, fitAvatarRig } from './avatar-rig-math';
import { keyedPoint } from './plugins/kernel';
import type {
  AvatarRigBinds, AvatarRigFrameContext, AvatarRigFramePlan, AvatarRigPose, AvatarRigPoseContext,
} from './avatar-rig-math';

export { STANDARD_AVATAR_DRIVER, validateAvatarDriver } from './avatar-driver';
export type { AvatarDriver, RigJson } from './avatar-driver';
export { AVATAR_MOTION_ERROR_CODES, AVATAR_MOTION_ERROR_KIND, AVATAR_MOTION_LIMITS, AVATAR_MOTION_MAX_STEPS,
  AVATAR_MOTION_STEP_SECONDS, AvatarMotionError, HAIR_MOTION_ID } from './avatar-motion';
export type {
  AvatarMotion, AvatarMotionEntry, AvatarMotionFrame, AvatarMotionJoint, AvatarMotionKind, AvatarMotionModel, AvatarMotionSkeleton,
} from './avatar-motion';
export type { AvatarMotionSettings, PreparedAvatarMotion, PreparedAvatarMotions, RunningAvatarMotions } from './avatar-motion-prepare';
export { bindArmNormal, composeArmJoints, composeLimbJoints, createArmSolutions, createFramePlan, createPose,
  fitAvatarRig, handFrame, limbFrame, projectGripShoulder, SHOULDER_CENTER, SHOULDER_SPAN } from './avatar-rig-math';
export type {
  AvatarRigArmBind, AvatarRigArmPose, AvatarRigArmSolution, AvatarRigBinds, AvatarRigFrameContext,
  AvatarRigFramePlan, AvatarRigHandTrack, AvatarRigPose, AvatarRigPoseContext,
} from './avatar-rig-math';

const AVATAR_RIG_ERROR_CODES = [
  'unknown-strategy', 'invalid-config', 'invalid-strategy',
] as const;
export type AvatarRigErrorCode = typeof AVATAR_RIG_ERROR_CODES[number];

// A portable tag for a typed refusal across Vite's separate Node module-runner class identity.
export const AVATAR_RIG_ERROR_KIND = 'avatar-rig-error';

// Typed failures for avatar rig lookup, preparation and config; registration uses PluginError.
export class AvatarRigError extends SpriteError {
  readonly kind = AVATAR_RIG_ERROR_KIND;
  readonly code: AvatarRigErrorCode;

  constructor(code: AvatarRigErrorCode, message: string) {
    super(message);
    this.name = 'AvatarRigError';
    this.code = code;
  }
}

function isAvatarRigErrorCode(value: unknown): value is AvatarRigErrorCode {
  return typeof value === 'string' && (AVATAR_RIG_ERROR_CODES as readonly string[]).includes(value);
}

// A strategy refusal may cross the Vite Node module runner as a separate copy of AvatarRigError, so
// its portable `kind` tag identifies exactly that typed error and is rebuilt as the host's class.
// Anything else is a programmer error and propagates untouched; `message` is never matched on.
function normalizeStrategyError(error: unknown): unknown {
  if (error instanceof AvatarRigError) return error;
  if (typeof error === 'object' && error !== null && Reflect.get(error, 'kind') === AVATAR_RIG_ERROR_KIND) {
    const code = Reflect.get(error, 'code');
    if (isAvatarRigErrorCode(code)) {
      const message = Reflect.get(error, 'message');
      if (typeof message === 'string') return new AvatarRigError(code, message);
    }
  }
  return error;
}

function callStrategy<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    throw normalizeStrategyError(error);
  }
}

/**
 * A prepared rig for one avatar. The engine owns the frame-plan and pose scratch and passes it in:
 * the live-only phase 1 writes the frame plan before grips are placed and arms solved, phase 2 reads the plan the
 * arms followed from the context and writes the pose. That is the plan phase 1 wrote, or, when the
 * profile rotates a hand, the engine's copy of it turned about that hand's grip; the written plan is
 * never rewritten. A strategy holds no frame state between calls. Pure numeric: a strategy never
 * sees a scene, material or renderer object. Released hands bypass phase 1 and arrive in phase 2
 * as presented corpse joints with forearm-aligned directions and no wrist offsets. Only phase 2 has an attachment,
 * either gripped or released; neither context carries presentation-source flags.
 */
export interface AvatarFramePlanner {
  writeFramePlan(context: AvatarRigFrameContext, out: AvatarRigFramePlan): void;
}

export interface AvatarRig extends AvatarFramePlanner {
  writePose(context: AvatarRigPoseContext, out: AvatarRigPose): void;
}

// The unbound standard plan also serves offline authoring before a GLB exists. It holds no scratch.
export const STANDARD_AVATAR_FRAME_PLANNER: AvatarFramePlanner = Object.freeze({
  writeFramePlan(context: AvatarRigFrameContext, out: AvatarRigFramePlan): void {
    for (const side of ARM_SIDES) {
      out[side].offset.set(0, 0, 0);
      out[side].shaft.copy(context.shaftAxis);
      out[side].forward.copy(context.forward);
    }
  },
});

/**
 * A host-provided rig variant. `prepare` validates its configuration once and builds the per-avatar
 * rig from immutable fitted binds before any scene/presentation change. Refusals throw AvatarRigError;
 * programmer errors propagate unchanged. No scene, material or renderer access is provided.
 * Per-avatar frame state lives in the scratch the host passes to the rig.
 */
export interface AvatarRigStrategy {
  readonly id: string;
  prepare(config: RigJson, binds: AvatarRigBinds): AvatarRig;
}

// The standard rig: the built-in avatar's zero-offset plan and forearm-aligned hand behaviour.
class StandardAvatarRig implements AvatarRig {
  private readonly binds: AvatarRigBinds;

  constructor(binds: AvatarRigBinds) {
    this.binds = binds;
  }

  writeFramePlan(context: AvatarRigFrameContext, out: AvatarRigFramePlan): void {
    STANDARD_AVATAR_FRAME_PLANNER.writeFramePlan(context, out);
  }

  writePose(context: AvatarRigPoseContext, out: AvatarRigPose): void {
    for (const side of ARM_SIDES) {
      const solution = context.arms[side];
      composeArmJoints(this.binds.arms[side], solution.shoulder, solution.elbow, solution.wrist,
        solution.normal, context.plan[side].shaft, context.plan[side].forward, out[side]);
    }
  }
}

export const STANDARD_AVATAR_RIG_STRATEGY: AvatarRigStrategy = Object.freeze({
  id: STANDARD_AVATAR_DRIVER.id,
  prepare(config: RigJson, binds: AvatarRigBinds): AvatarRig {
    if (config !== null) {
      throw new AvatarRigError('invalid-config', 'The standard avatar rig takes no configuration; use a null driver config.');
    }
    return new StandardAvatarRig(binds);
  },
});

// A fitted model plus the strategy instance and the motions bound to it, resolved together.
export interface PreparedAvatarRig {
  readonly binds: AvatarRigBinds;
  readonly rig: AvatarRig;
  readonly resolved: ResolvedAvatarJoints;
  readonly motions: PreparedAvatarMotions;
}

// The kernel attributes registration refusals to their plugin and point.
function validateStrategy(value: unknown): AvatarRigStrategy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('An avatar rig strategy must be an object.');
  const id = Reflect.get(value, 'id');
  if (!isAvatarDriverId(id)) {
    throw new TypeError('An avatar rig strategy needs a built-in or "<plugin>/<name>" ID.');
  }
  if (typeof Reflect.get(value, 'prepare') !== 'function') {
    throw new TypeError(`Avatar rig strategy "${id}" has no prepare() function.`);
  }
  return value as AvatarRigStrategy;
}

// Rejects a malformed motion kind at registration, as validateStrategy does a strategy.
function validateMotionKind(value: unknown): AvatarMotionKind {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('An avatar motion kind must be an object.');
  const id = Reflect.get(value, 'id');
  if (!isAvatarDriverId(id)) {
    throw new TypeError('An avatar motion kind needs a "<plugin>/<name>" ID.');
  }
  if (typeof Reflect.get(value, 'prepare') !== 'function') {
    throw new TypeError(`Avatar motion kind "${id}" has no prepare() function.`);
  }
  return value as AvatarMotionKind;
}

export const AVATAR_RIGS = keyedPoint('avatar.rigs', 'kinds', 64, validateStrategy);
export const AVATAR_MOTIONS = keyedPoint('avatar.motions', 'kinds', 64, validateMotionKind);

/** The maps validated and composed by Kinds, including the engine's standard strategy. */
export class AvatarRigRegistry {
  private readonly strategies: ReadonlyMap<string, AvatarRigStrategy>;
  private readonly identifiers: readonly string[];
  private readonly kinds: ReadonlyMap<string, AvatarMotionKind>;
  private readonly kindIdentifiers: readonly string[];

  constructor(strategies: ReadonlyMap<string, AvatarRigStrategy>, motions: ReadonlyMap<string, AvatarMotionKind>) {
    this.strategies = strategies;
    this.identifiers = Object.freeze([...strategies.keys()]);
    this.kinds = motions;
    this.kindIdentifiers = Object.freeze([...motions.keys()]);
  }

  get ids(): readonly string[] {
    return this.identifiers;
  }

  // The registered motion kinds' IDs; the built-in hair is not among them.
  get motionIds(): readonly string[] {
    return this.kindIdentifiers;
  }

  motion(id: string): AvatarMotionKind {
    const kind = this.kinds.get(id);
    if (kind === undefined) {
      throw new AvatarMotionError('unknown-kind',
        `No avatar motion kind is registered as "${id}". Add AVATAR_MOTIONS in a kinds facet under "<plugin>/<name>" (docs/kinds-plugins.md).`, id);
    }
    return kind;
  }

  has(id: string): boolean {
    return this.strategies.has(id);
  }

  strategy(id: string): AvatarRigStrategy {
    const strategy = this.strategies.get(id);
    if (strategy === undefined) {
      throw new AvatarRigError('unknown-strategy',
        `No avatar rig strategy is registered for driver "${id}". Add AVATAR_RIGS in a kinds facet under "<plugin>/<name>" (docs/kinds-plugins.md).`);
    }
    return strategy;
  }

  // Validates the driver, fits the model's binds, prepares the strategy's per-avatar rig, then the
  // avatar's hair and motions. All preparation is pure; no scene, material or renderer is touched. A
  // strategy's or kind's typed refusal is normalized to the host's error class across the Vite
  // module-runner boundary.
  prepare(report: CharacterModelReport, settings: AvatarModelSettings): PreparedAvatarRig {
    const { boneMap, driver } = settings;
    const strategy = this.strategy(driver.id);
    const resolved = resolveAvatarJoints(report, boneMap);
    const binds = fitAvatarRig(report, boneMap);
    const rig = callStrategy(() => strategy.prepare(driver.config, binds));
    if (typeof rig !== 'object' || rig === null || typeof rig.writeFramePlan !== 'function' || typeof rig.writePose !== 'function') {
      throw new AvatarRigError('invalid-strategy', `Avatar rig "${driver.id}" must synchronously prepare a frame planner and pose writer.`);
    }
    return { binds, rig, resolved, motions: this.prepareMotions(report, resolved, binds, settings) };
  }

  // The avatar's hair and motions alone, for a model already fitted with the settings' bone map: a
  // change to them alone replaces the motions without rebuilding the avatar, keeping those of
  // `running`, the motions it runs, that did not change.
  prepareMotions(report: CharacterModelReport, resolved: ResolvedAvatarJoints, binds: AvatarRigBinds,
    settings: AvatarMotionSettings, running?: RunningAvatarMotions): PreparedAvatarMotions {
    return prepareAvatarMotions(report, resolved, binds, settings, (id) => this.motion(id), running);
  }
}
