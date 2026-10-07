// Spring-bone hair: one implementation for sprite skeletons (SkeletonPose) and imported skinned avatars
// (SkinnedAvatarView). A chain is a run of particles pinned at its root, with world-space Verlet inertia, a pull
// toward the pose its bones would take rigidly (its target), fixed segment lengths and circle colliders, stepped at a
// fixed rate in the game's X-Y plane. Hair never drives IK, gameplay or physics.
//
// Each frame the caller writes every chain's targets (and lengths, where they change) and every collider's centre,
// advances the solver and reads the particles back. solve(time) runs the solver on its own MotionClock: simulation
// freezes while time stands still, catches up at most MOTION_MAX_STEPS fixed steps, and restarts from the targets on a
// placement interrupt() or after a long gap. An imported avatar's hair instead takes the steps of the clock its
// view shares with the avatar's other motions, through advance(). Pauses and tab hiding settle interpolation; only
// explicit placements rewind presentation time, and placements also restart hair, with elapsed time clamped at zero.
// DOM-free and allocation-free per frame.
import { MotionClock, MOTION_STEP_SECONDS } from './motion-clock.ts';

// Parameter ranges, shared by every hair format's validation.
export const HAIR_PARAMETER_LIMITS = Object.freeze({
  stiffness: Object.freeze({ min: 0, max: 1 }),
  damping: Object.freeze({ min: 0, max: 1 }),
  gravity: Object.freeze({ min: -50, max: 50 }),
  radius: Object.freeze({ min: 0, max: 1 }),
});

export interface HairParameters {
  // Pull toward the target on every constraint pass, 0 (none) to 1.
  readonly stiffness: number;
  // Share of the velocity lost on every fixed step, 0 to 1.
  readonly damping: number;
  // Downward acceleration in world units per second squared; negative floats upward.
  readonly gravity: number;
  // Each particle's collision radius in world units.
  readonly radius: number;
}

const HAIR_CONSTRAINT_ITERATIONS = 8;
const HAIR_STIFFNESS_FACTOR = 0.35;
const HAIR_COLLISION_SLOP = 1e-6;
// Targets and colliders that move less than this leave a frozen chain alone.
const HAIR_MOVE_TOLERANCE = 1e-6;
const DISTANCE_EPSILON = 1e-8;
const SEGMENT_EPSILON = 1e-6;

// One chain's particles: the root, each joint after it and the tip; `segments` = particles - 1.
export class HairChainState {
  readonly parameters: HairParameters;
  // Rest length of each segment, root first. Callers whose chains change shape write them before solve().
  readonly lengths: Float64Array;
  readonly targetX: Float64Array;
  readonly targetY: Float64Array;
  readonly currentX: Float64Array;
  readonly currentY: Float64Array;
  readonly previousX: Float64Array;
  readonly previousY: Float64Array;
  readonly solvedTargetX: Float64Array;
  readonly solvedTargetY: Float64Array;
  initialized = false;

  constructor(parameters: HairParameters, segments: number) {
    if (!Number.isInteger(segments) || segments < 1) throw new RangeError('A hair chain needs at least one segment.');
    this.parameters = parameters;
    this.lengths = new Float64Array(segments);
    const particles = segments + 1;
    this.targetX = new Float64Array(particles);
    this.targetY = new Float64Array(particles);
    this.currentX = new Float64Array(particles);
    this.currentY = new Float64Array(particles);
    this.previousX = new Float64Array(particles);
    this.previousY = new Float64Array(particles);
    this.solvedTargetX = new Float64Array(particles);
    this.solvedTargetY = new Float64Array(particles);
  }
}

export class HairSolver {
  readonly chains: readonly HairChainState[];
  // Collider centres in world units, written by the caller before every solve().
  readonly colliderX: Float64Array;
  readonly colliderY: Float64Array;
  private readonly colliderRadius: Float64Array;
  private readonly solvedColliderX: Float64Array;
  private readonly solvedColliderY: Float64Array;
  // The clock solve() runs on.
  private readonly clock = new MotionClock();
  private readonly tipCandidate = { x: 0, y: 0, penetration: 0, distance: 0 };

  constructor(chains: readonly { readonly parameters: HairParameters; readonly segments: number }[], colliderRadii: readonly number[]) {
    this.chains = Object.freeze(chains.map(chain => new HairChainState(chain.parameters, chain.segments)));
    this.colliderRadius = Float64Array.from(colliderRadii);
    this.colliderX = new Float64Array(colliderRadii.length);
    this.colliderY = new Float64Array(colliderRadii.length);
    this.solvedColliderX = new Float64Array(colliderRadii.length);
    this.solvedColliderY = new Float64Array(colliderRadii.length);
  }

  // The hair was not simulated for a while (its pose was shown unconstrained): restart from the targets next time.
  interrupt(): void {
    this.clock.interrupt();
  }

  // Continues exactly where `source`, a solver built from the same chains and colliders, left off.
  copyFrom(source: HairSolver): void {
    if (source.chains.length !== this.chains.length || source.colliderRadius.length !== this.colliderRadius.length) {
      throw new RangeError('Hair state can only be copied between solvers of the same chains and colliders.');
    }
    this.clock.copyFrom(source.clock);
    this.colliderX.set(source.colliderX);
    this.colliderY.set(source.colliderY);
    this.solvedColliderX.set(source.solvedColliderX);
    this.solvedColliderY.set(source.solvedColliderY);
    for (let index = 0; index < this.chains.length; index++) {
      const chain = this.chains[index];
      const from = source.chains[index];
      if (from.lengths.length !== chain.lengths.length) throw new RangeError('Hair state can only be copied between equal chains.');
      chain.lengths.set(from.lengths);
      chain.targetX.set(from.targetX); chain.targetY.set(from.targetY);
      chain.currentX.set(from.currentX); chain.currentY.set(from.currentY);
      chain.previousX.set(from.previousX); chain.previousY.set(from.previousY);
      chain.solvedTargetX.set(from.solvedTargetX); chain.solvedTargetY.set(from.solvedTargetY);
      chain.initialized = from.initialized;
    }
  }

  // Advances the solver on its own clock to `time`, in simulation seconds.
  solve(time: number): void {
    this.clock.advance(time);
    this.advance(this.clock.reset, this.clock.steps);
  }

  // Restarts from the targets, or takes `steps` fixed steps; with none, the chains only follow moved targets and
  // colliders. A chain that never ran restarts either way.
  advance(reset: boolean, steps: number): void {
    let fresh = reset;
    if (!fresh) for (const chain of this.chains) {
      if (!chain.initialized) { fresh = true; break; }
    }
    if (fresh) {
      for (const chain of this.chains) {
        this.resetChain(chain);
        this.constrain(chain, 'kinematic');
        chain.previousX.set(chain.currentX);
        chain.previousY.set(chain.currentY);
      }
    } else if (steps === 0) {
      let collidersChanged = false;
      for (let index = 0; index < this.colliderX.length; index += 1) {
        if (Math.abs(this.colliderX[index] - this.solvedColliderX[index]) > HAIR_MOVE_TOLERANCE ||
          Math.abs(this.colliderY[index] - this.solvedColliderY[index]) > HAIR_MOVE_TOLERANCE) collidersChanged = true;
      }
      for (const chain of this.chains) {
        if (collidersChanged || this.targetsChanged(chain)) this.constrain(chain, 'kinematic');
      }
    } else {
      for (let step = 0; step < steps; step += 1) {
        for (const chain of this.chains) {
          this.integrate(chain, MOTION_STEP_SECONDS);
          this.constrain(chain, 'dynamic');
        }
      }
    }
    for (const chain of this.chains) {
      chain.solvedTargetX.set(chain.targetX);
      chain.solvedTargetY.set(chain.targetY);
    }
    this.solvedColliderX.set(this.colliderX);
    this.solvedColliderY.set(this.colliderY);
  }

  private resetChain(chain: HairChainState): void {
    chain.currentX.set(chain.targetX); chain.currentY.set(chain.targetY);
    chain.previousX.set(chain.targetX); chain.previousY.set(chain.targetY);
    chain.solvedTargetX.set(chain.targetX); chain.solvedTargetY.set(chain.targetY);
    chain.initialized = true;
  }

  private targetsChanged(chain: HairChainState): boolean {
    for (let index = 0; index < chain.targetX.length; index += 1) {
      if (Math.abs(chain.targetX[index] - chain.solvedTargetX[index]) > HAIR_MOVE_TOLERANCE ||
        Math.abs(chain.targetY[index] - chain.solvedTargetY[index]) > HAIR_MOVE_TOLERANCE) {
        return true;
      }
    }
    return false;
  }

  private integrate(chain: HairChainState, dt: number): void {
    const drag = Math.min(Math.max(1 - chain.parameters.damping, 0), 1);
    const gravity = chain.parameters.gravity * dt * dt;
    chain.currentX[0] = chain.targetX[0];
    chain.currentY[0] = chain.targetY[0];
    chain.previousX[0] = chain.targetX[0];
    chain.previousY[0] = chain.targetY[0];
    for (let index = 1; index < chain.currentX.length; index += 1) {
      const currentX = chain.currentX[index];
      const currentY = chain.currentY[index];
      const velocityX = (currentX - chain.previousX[index]) * drag;
      const velocityY = (currentY - chain.previousY[index]) * drag;
      chain.previousX[index] = currentX;
      chain.previousY[index] = currentY;
      chain.currentX[index] = currentX + velocityX;
      chain.currentY[index] = currentY + velocityY - gravity;
    }
  }

  private constrain(chain: HairChainState, mode: 'dynamic' | 'kinematic'): void {
    const { stiffness } = chain.parameters;
    for (let iteration = 0; iteration < HAIR_CONSTRAINT_ITERATIONS; iteration += 1) {
      chain.currentX[0] = chain.targetX[0];
      chain.currentY[0] = chain.targetY[0];
      if (mode === 'dynamic' && stiffness > 0) {
        const follow = stiffness * HAIR_STIFFNESS_FACTOR;
        for (let index = 1; index < chain.currentX.length; index += 1) {
          chain.currentX[index] += (chain.targetX[index] - chain.currentX[index]) * follow;
          chain.currentY[index] += (chain.targetY[index] - chain.currentY[index]) * follow;
        }
      }
      for (let index = 0; index < chain.lengths.length; index += 1) this.enforceDistance(chain, index);
      for (let particle = 1; particle < chain.currentX.length; particle += 1) this.enforceCollisions(chain, particle);
      chain.currentX[0] = chain.targetX[0];
      chain.currentY[0] = chain.targetY[0];
    }
    // Callers draw exact segment lengths, so each tip must match its collision particle.
    for (let index = 0; index < chain.lengths.length; index += 1) this.projectTip(chain, index);
  }

  // Segment `index`'s direction where its particles coincide: its target's, or +X where that is degenerate too.
  private fallbackX(chain: HairChainState, index: number): number {
    const dx = chain.targetX[index + 1] - chain.targetX[index], dy = chain.targetY[index + 1] - chain.targetY[index];
    const length = Math.hypot(dx, dy);
    return length > SEGMENT_EPSILON ? dx / length : 1;
  }

  private fallbackY(chain: HairChainState, index: number): number {
    const dx = chain.targetX[index + 1] - chain.targetX[index], dy = chain.targetY[index + 1] - chain.targetY[index];
    const length = Math.hypot(dx, dy);
    return length > SEGMENT_EPSILON ? dy / length : 0;
  }

  private enforceDistance(chain: HairChainState, left: number): void {
    const right = left + 1;
    const length = chain.lengths[left];
    const dx = chain.currentX[right] - chain.currentX[left];
    const dy = chain.currentY[right] - chain.currentY[left];
    const distance = Math.hypot(dx, dy);
    const correctionX = (distance > SEGMENT_EPSILON ? dx / distance : this.fallbackX(chain, left)) * (distance - length);
    const correctionY = (distance > SEGMENT_EPSILON ? dy / distance : this.fallbackY(chain, left)) * (distance - length);
    if (left === 0) {
      chain.currentX[right] -= correctionX;
      chain.currentY[right] -= correctionY;
      return;
    }
    chain.currentX[left] += correctionX * 0.5;
    chain.currentY[left] += correctionY * 0.5;
    chain.currentX[right] -= correctionX * 0.5;
    chain.currentY[right] -= correctionY * 0.5;
  }

  private collisionPenetration(chain: HairChainState, x: number, y: number): number {
    let penetration = 0;
    for (let index = 0; index < this.colliderX.length; index += 1) {
      const distance = Math.hypot(x - this.colliderX[index], y - this.colliderY[index]);
      penetration += Math.max(0, this.colliderRadius[index] + chain.parameters.radius + HAIR_COLLISION_SLOP - distance);
    }
    return penetration;
  }

  private projectTip(chain: HairChainState, index: number): void {
    const x = chain.currentX[index], y = chain.currentY[index];
    const dx = chain.currentX[index + 1] - x, dy = chain.currentY[index + 1] - y;
    const distance = Math.hypot(dx, dy), length = chain.lengths[index];
    const desiredX = x + length * (distance > SEGMENT_EPSILON ? dx / distance : this.fallbackX(chain, index));
    const desiredY = y + length * (distance > SEGMENT_EPSILON ? dy / distance : this.fallbackY(chain, index));
    const best = this.tipCandidate;
    best.x = desiredX; best.y = desiredY;
    best.penetration = this.collisionPenetration(chain, desiredX, desiredY); best.distance = 0;
    if (best.penetration > DISTANCE_EPSILON) {
      for (let collider = 0; collider < this.colliderX.length; collider += 1) {
        const toX = this.colliderX[collider] - x, toY = this.colliderY[collider] - y;
        const centerDistance = Math.hypot(toX, toY);
        const radius = this.colliderRadius[collider] + chain.parameters.radius + HAIR_COLLISION_SLOP;
        if (centerDistance <= DISTANCE_EPSILON) continue;
        const axisX = toX / centerDistance, axisY = toY / centerDistance;
        const along = (length ** 2 + centerDistance ** 2 - radius ** 2) / (2 * centerDistance);
        if (Math.abs(along) <= length) {
          const across = Math.sqrt(Math.max(0, length ** 2 - along ** 2));
          this.considerTip(chain, x + axisX * along - axisY * across, y + axisY * along + axisX * across, desiredX, desiredY);
          this.considerTip(chain, x + axisX * along + axisY * across, y + axisY * along - axisX * across, desiredX, desiredY);
        }
        this.considerTip(chain, x - axisX * length, y - axisY * length, desiredX, desiredY);
      }
    }
    chain.currentX[index + 1] = best.x;
    chain.currentY[index + 1] = best.y;
  }

  private considerTip(chain: HairChainState, candidateX: number, candidateY: number, desiredX: number, desiredY: number): void {
    const best = this.tipCandidate, penetration = this.collisionPenetration(chain, candidateX, candidateY);
    const separation = (candidateX - desiredX) ** 2 + (candidateY - desiredY) ** 2;
    if (penetration < best.penetration - DISTANCE_EPSILON ||
      Math.abs(penetration - best.penetration) <= DISTANCE_EPSILON && separation < best.distance) {
      best.x = candidateX; best.y = candidateY; best.penetration = penetration; best.distance = separation;
    }
  }
  private enforceCollisions(chain: HairChainState, particle: number): void {
    for (let index = 0; index < this.colliderX.length; index += 1) {
      const minimum = this.colliderRadius[index] + chain.parameters.radius;
      const dx = chain.currentX[particle] - this.colliderX[index];
      const dy = chain.currentY[particle] - this.colliderY[index];
      const distance = Math.hypot(dx, dy);
      if (distance >= minimum) continue;
      if (distance <= SEGMENT_EPSILON) {
        chain.currentX[particle] = this.colliderX[index] + minimum;
        chain.currentY[particle] = this.colliderY[index];
        continue;
      }
      const scale = minimum / distance;
      chain.currentX[particle] = this.colliderX[index] + dx * scale;
      chain.currentY[particle] = this.colliderY[index] + dy * scale;
    }
  }
}
