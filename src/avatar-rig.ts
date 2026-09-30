// The avatar-rig kernel: a trusted-host strategy seam for imported skinned avatars. A driver names
// a strategy and carries bounded JSON config; the registry looks the strategy up, fits the model's
// binds, and hands the strategy a prepared rig for its two frame phases. No silent fallback: an
// unknown driver or an invalid config is a typed error, never the standard rig.
import { isAvatarDriverId, STANDARD_AVATAR_DRIVER } from './avatar-driver';
import type { AvatarDriver, RigJson } from './avatar-driver';
import { resolveAvatarJoints } from './character-model-inspect';
import type { CharacterModelReport, ResolvedAvatarJoints } from './character-model-inspect';
import type { AvatarBoneMap } from './character-profile';
import { SpriteError } from './sprite-fields';
import { ARM_SIDES } from './character';
import { composeArmJoints, fitAvatarRig } from './avatar-rig-math';
import type {
  AvatarRigBinds, AvatarRigFrameContext, AvatarRigFramePlan, AvatarRigPose, AvatarRigPoseContext,
} from './avatar-rig-math';

export { STANDARD_AVATAR_DRIVER, validateAvatarDriver } from './avatar-driver';
export type { AvatarDriver, RigJson } from './avatar-driver';
export { bindArmNormal, composeArmJoints, composeLimbJoints, createArmSolutions, createFramePlan, createPose,
  fitAvatarRig, handFrame, limbFrame, projectGripShoulder, SHOULDER_CENTER, SHOULDER_SPAN } from './avatar-rig-math';
export type {
  AvatarRigArmBind, AvatarRigArmPose, AvatarRigArmSolution, AvatarRigBinds, AvatarRigFrameContext,
  AvatarRigFramePlan, AvatarRigHandTrack, AvatarRigPose, AvatarRigPoseContext,
} from './avatar-rig-math';

// The module contract version a host understands. A module from another API version is rejected.
export const AVATAR_RIG_API_VERSION = 1;

const AVATAR_RIG_ERROR_CODES = [
  'duplicate-strategy', 'unknown-strategy', 'missing-standard', 'api-version', 'invalid-config', 'invalid-strategy',
] as const;
export type AvatarRigErrorCode = typeof AVATAR_RIG_ERROR_CODES[number];

// A portable tag for a typed refusal across Vite's separate Node module-runner class identity.
export const AVATAR_RIG_ERROR_KIND = 'avatar-rig-error';

// Typed failures for avatar rig registration, lookup and config; callers branch on `code`.
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
 * phase 1 writes the frame plan before grips are placed and arms solved, phase 2 reads the plan the
 * arms followed from the context and writes the pose. That is the plan phase 1 wrote, or, when the
 * profile rotates a hand, the engine's copy of it turned about that hand's grip; the written plan is
 * never rewritten. A strategy holds no frame state between calls. Pure numeric: a strategy never
 * sees a scene, material or renderer object.
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

// A host's rig module: the strategies it adds to the standard one, at a known API version.
export interface AvatarRigModule {
  readonly apiVersion: 1;
  readonly strategies: readonly AvatarRigStrategy[];
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

const STANDARD_AVATAR_RIG_STRATEGY: AvatarRigStrategy = Object.freeze({
  id: STANDARD_AVATAR_DRIVER.id,
  prepare(config: RigJson, binds: AvatarRigBinds): AvatarRig {
    if (config !== null) {
      throw new AvatarRigError('invalid-config', 'The standard avatar rig takes no configuration; use a null driver config.');
    }
    return new StandardAvatarRig(binds);
  },
});

// A fitted model plus the strategy instance bound to it, resolved together.
export interface PreparedAvatarRig {
  readonly binds: AvatarRigBinds;
  readonly rig: AvatarRig;
  readonly resolved: ResolvedAvatarJoints;
}

// A module lists a bounded set of trusted strategies, each with a driver-style ID.
export const AVATAR_RIG_LIMITS = Object.freeze({ strategies: 64 });

// Rejects a malformed strategy descriptor at registration, so a bad module fails as a typed boundary
// error instead of a TypeError in the middle of a frame. Strategies are trusted JS, not content.
function validateStrategy(value: unknown, index: number): AvatarRigStrategy {
  if (typeof value !== 'object' || value === null) {
    throw new AvatarRigError('invalid-strategy', `Avatar rig strategy ${index} must be an object.`);
  }
  const id = Reflect.get(value, 'id');
  if (!isAvatarDriverId(id)) {
    throw new AvatarRigError('invalid-strategy',
      `Avatar rig strategy ${index} needs an ID of lowercase letters, numbers and hyphens, starting with a letter.`);
  }
  if (typeof Reflect.get(value, 'prepare') !== 'function') {
    throw new AvatarRigError('invalid-strategy', `Avatar rig strategy "${id}" has no prepare() function.`);
  }
  return value as AvatarRigStrategy;
}

/**
 * The registered rig strategies, keyed by driver ID. Construct through createAvatarRigRegistry()
 * so the standard strategy is always present; the constructor rejects a malformed or oversized module,
 * duplicate IDs and a missing standard strategy.
 */
export class AvatarRigRegistry {
  private readonly strategies: ReadonlyMap<string, AvatarRigStrategy>;
  private readonly identifiers: readonly string[];

  constructor(strategies: readonly AvatarRigStrategy[]) {
    if (strategies.length > AVATAR_RIG_LIMITS.strategies) {
      throw new AvatarRigError('invalid-strategy',
        `An avatar rig registry holds at most ${AVATAR_RIG_LIMITS.strategies} strategies.`);
    }
    const map = new Map<string, AvatarRigStrategy>();
    for (let index = 0; index < strategies.length; index++) {
      const strategy = validateStrategy(strategies[index], index);
      if (map.has(strategy.id)) {
        throw new AvatarRigError('duplicate-strategy', `Two avatar rig strategies share the ID "${strategy.id}".`);
      }
      map.set(strategy.id, strategy);
    }
    if (!map.has(STANDARD_AVATAR_DRIVER.id)) {
      throw new AvatarRigError('missing-standard',
        `An avatar rig registry must include the standard "${STANDARD_AVATAR_DRIVER.id}" strategy.`);
    }
    this.strategies = map;
    this.identifiers = Object.freeze([...map.keys()]);
  }

  get ids(): readonly string[] {
    return this.identifiers;
  }

  has(id: string): boolean {
    return this.strategies.has(id);
  }

  strategy(id: string): AvatarRigStrategy {
    const strategy = this.strategies.get(id);
    if (strategy === undefined) {
      throw new AvatarRigError('unknown-strategy',
        `No avatar rig strategy is registered for driver "${id}". Register one with createAvatarRigRegistry().`);
    }
    return strategy;
  }

  // Validates the driver, fits the model's binds, and prepares the strategy's per-avatar rig. All
  // preparation is pure; no scene, material or renderer is touched. A strategy's typed refusal is
  // normalized to this module's AvatarRigError across the Vite module-runner boundary.
  prepare(report: CharacterModelReport, boneMap: AvatarBoneMap, driver: AvatarDriver): PreparedAvatarRig {
    const strategy = this.strategy(driver.id);
    const resolved = resolveAvatarJoints(report, boneMap);
    const binds = fitAvatarRig(report, boneMap);
    const rig = callStrategy(() => strategy.prepare(driver.config, binds));
    if (typeof rig !== 'object' || rig === null || typeof rig.writeFramePlan !== 'function' || typeof rig.writePose !== 'function') {
      throw new AvatarRigError('invalid-strategy', `Avatar rig "${driver.id}" must synchronously prepare a frame planner and pose writer.`);
    }
    return { binds, rig, resolved };
  }
}

// A registry from a host module; the standard strategy is always present, and a module cannot shadow it.
export function createAvatarRigRegistry(module: AvatarRigModule): AvatarRigRegistry {
  if (typeof module !== 'object' || module === null) {
    throw new AvatarRigError('api-version', 'An avatar rig module must default-export its API version and strategies.');
  }
  if ((module.apiVersion as number) !== AVATAR_RIG_API_VERSION) {
    throw new AvatarRigError('api-version',
      `This host supports avatar rig module API version ${AVATAR_RIG_API_VERSION}; the module declares ${String(module.apiVersion)}.`);
  }
  if (!Array.isArray(module.strategies)) throw new AvatarRigError('api-version', 'An avatar rig module must list its strategies.');
  if (module.strategies.length > AVATAR_RIG_LIMITS.strategies - 1) {
    throw new AvatarRigError('invalid-strategy',
      `An avatar rig module adds at most ${AVATAR_RIG_LIMITS.strategies - 1} strategies.`);
  }
  return new AvatarRigRegistry([STANDARD_AVATAR_RIG_STRATEGY, ...module.strategies]);
}

// An unconfigured host deliberately supports only standard content; a bad configured module is not this case.
export const DEFAULT_AVATAR_RIGS = new AvatarRigRegistry([STANDARD_AVATAR_RIG_STRATEGY]);

// Validates a driver, bone map and rig config against a registry without keeping a prepared rig, for
// authoring tools that check a model before it is committed. Full pure preparation runs here, so a
// strategy's binding- or hash-dependent refusal is caught before the profile is committed.
export function checkAvatarRig(report: CharacterModelReport, boneMap: AvatarBoneMap, driver: AvatarDriver,
  registry: AvatarRigRegistry = DEFAULT_AVATAR_RIGS): void {
  registry.prepare(report, boneMap, driver);
}
