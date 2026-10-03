import { Joint, Settings, Vec2 } from 'planck';
import type { Body, TimeStep, Vec2Value } from 'planck';
import type { Point } from './config';
import { clamp } from './math';

// A polar joint between the fixed-rotation root (A) and the hammer (B). The hammer's local +X axis
// always passes through the root's shoulder; the hammer turns about it under an angular motor and slides
// along it under an axial motor between passive stops. Its butt is bodyB's origin.
//
// Rows, with d = butt - shoulder, a = hammer axis, n = perp(a), rA/rB = COM -> anchor:
//   lateral  C = n.d  J = [-n, -cross(rA, n), n, cross(rB, n) - q]   always an exact equality
//   angular  theta    J = [0, -1, 0, 1]                              motor only, never position-corrected
//   axial    q = a.d  J = [-a, -cross(rA, a), a, cross(rB, a) + C]   motor plus passive stops
// The angular row tracks motor speed. Position projection can rotate bodyB to enforce the line,
// but never imposes a requested aim angle.

export class HammerJointError extends Error {
  constructor(message: string) { super(message); this.name = 'HammerJointError'; }
}

export interface HammerJointOptions {
  bodyA: Body;
  bodyB: Body;
  localAnchorA: Readonly<Point>;
  lowerTranslation: number;
  upperTranslation: number;
  maxMotorTorque: number;
  maxMotorForce: number;
}

// Planck's solver state; read and written only inside this adapter.
interface SolverBody {
  readonly c_position: { readonly c: Vec2; a: number };
  readonly c_velocity: { readonly v: Vec2; w: number };
  readonly m_invMass: number;
  readonly m_invI: number;
  readonly m_sweep: { readonly localCenter: Vec2 };
}

// Relative slack on the active-set feasibility checks; far above rounding in a well-scaled 3x3 solve.
const FEASIBILITY_TOLERANCE = 1e-8;

const ANGULAR_FREE = 0;
const ANGULAR_LOWER = 1;
const ANGULAR_UPPER = 2;
const ANGULAR_STATES = ANGULAR_UPPER + 1;
const AXIAL_MOTOR_FREE = 0;
const AXIAL_MOTOR_LOWER = 1;
const AXIAL_MOTOR_UPPER = 2;
const AXIAL_STOP_LOWER = 3;
const AXIAL_STOP_UPPER = 4;
const AXIAL_STATES = AXIAL_STOP_UPPER + 1;

const ORIGIN = new Vec2(0, 0);

function requireLimit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new HammerJointError(`HammerJoint ${name} must be finite and non-negative, got ${value}.`);
}

function requireMassProperties(a: SolverBody, b: SolverBody): void {
  if (!(a.m_invMass > 0 && Number.isFinite(a.m_invMass)) || a.m_invI !== 0) {
    throw new HammerJointError('HammerJoint bodyA must have positive finite mass and fixed rotation.');
  }
  if (!(b.m_invMass > 0 && Number.isFinite(b.m_invMass) && b.m_invI > 0 && Number.isFinite(b.m_invI))) {
    throw new HammerJointError('HammerJoint bodyB must have positive finite mass and rotational inertia.');
  }
}

// Joint geometry and Jacobian lever arms at one pair of solver positions.
class PolarFrame {
  nx = 0; ny = 0; ax = 0; ay = 0;
  translation = 0; lateral = 0;
  lateralA = 0; lateralB = 0; axialA = 0; axialB = 0;

  measure(cA: Vec2, angleA: number, offsetAx: number, offsetAy: number, cB: Vec2, angleB: number, offsetBx: number, offsetBy: number): void {
    const cosA = Math.cos(angleA), sinA = Math.sin(angleA);
    const cosB = Math.cos(angleB), sinB = Math.sin(angleB);
    const rAx = cosA * offsetAx - sinA * offsetAy, rAy = sinA * offsetAx + cosA * offsetAy;
    const rBx = cosB * offsetBx - sinB * offsetBy, rBy = sinB * offsetBx + cosB * offsetBy;
    const dx = cB.x + rBx - cA.x - rAx, dy = cB.y + rBy - cA.y - rAy;
    this.ax = cosB; this.ay = sinB; this.nx = -sinB; this.ny = cosB;
    this.translation = cosB * dx + sinB * dy;
    this.lateral = cosB * dy - sinB * dx;
    this.lateralA = -(rAx * this.ny - rAy * this.nx);
    this.lateralB = rBx * this.ny - rBy * this.nx - this.translation;
    this.axialA = -(rAx * this.ay - rAy * this.ax);
    this.axialB = rBx * this.ay - rBy * this.ax + this.lateral;
  }
}

export class HammerJoint extends Joint {
  static readonly TYPE = 'hammer-joint';

  private readonly bodyA: Body;
  private readonly bodyB: Body;
  private readonly solverA: SolverBody;
  private readonly solverB: SolverBody;
  private readonly localAnchorA: Vec2;
  private readonly lowerTranslation: number;
  private readonly upperTranslation: number;
  private maxMotorTorque: number;
  private maxMotorForce: number;
  private angularMotorSpeed = 0;
  private linearMotorSpeed = 0;

  // Accumulated impulses: the axial row's net impulse is axialMotor + axialLimit.
  private lateralImpulse = 0;
  private angularImpulse = 0;
  private axialMotorImpulse = 0;
  private axialLimitImpulse = 0;

  // Per-step cache.
  private readonly velocityFrame = new PolarFrame();
  private readonly positionFrame = new PolarFrame();
  private offsetAx = 0; private offsetAy = 0; private offsetBx = 0; private offsetBy = 0;
  private mA = 0; private mB = 0; private iA = 0; private iB = 0;
  private k00 = 0; private k01 = 0; private k02 = 0; private k11 = 0; private k12 = 0; private k22 = 0;
  private inv00 = 0; private inv01 = 0; private inv02 = 0; private inv11 = 0; private inv12 = 0; private inv22 = 0;
  private turn00 = 0; private turn01 = 0; private turn11 = 0;   // inverse of rows {lateral, angular}
  private slide00 = 0; private slide02 = 0; private slide22 = 0; // inverse of rows {lateral, axial}
  private torqueCap = 0;
  private forceCap = 0;
  private lowerSpeed = 0;
  private upperSpeed = 0;

  // The accepted active-set candidate.
  private candidateLateral = 0;
  private candidateAngular = 0;
  private candidateMotor = 0;
  private candidateLimit = 0;

  constructor(options: Readonly<HammerJointOptions>) {
    super({ bodyA: options.bodyA, bodyB: options.bodyB, collideConnected: false });
    const { bodyA, bodyB, localAnchorA, lowerTranslation, upperTranslation } = options;
    if (!bodyA.isDynamic() || !bodyB.isDynamic()) throw new HammerJointError('HammerJoint bodies must both be dynamic.');
    if (!bodyA.isFixedRotation()) throw new HammerJointError('HammerJoint bodyA must have fixed rotation.');
    if (!Number.isFinite(localAnchorA.x) || !Number.isFinite(localAnchorA.y)) throw new HammerJointError('HammerJoint localAnchorA must be finite.');
    if (!Number.isFinite(lowerTranslation) || !Number.isFinite(upperTranslation) || !(lowerTranslation < upperTranslation)) {
      throw new HammerJointError(`HammerJoint needs finite lowerTranslation < upperTranslation, got ${lowerTranslation} and ${upperTranslation}.`);
    }
    requireLimit(options.maxMotorTorque, 'maxMotorTorque');
    requireLimit(options.maxMotorForce, 'maxMotorForce');
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.solverA = bodyA as unknown as SolverBody;
    this.solverB = bodyB as unknown as SolverBody;
    requireMassProperties(this.solverA, this.solverB);
    this.localAnchorA = new Vec2(localAnchorA.x, localAnchorA.y);
    this.lowerTranslation = lowerTranslation;
    this.upperTranslation = upperTranslation;
    this.maxMotorTorque = options.maxMotorTorque;
    this.maxMotorForce = options.maxMotorForce;
  }

  override getType(): string {
    return HammerJoint.TYPE;
  }

  // World angle of bodyB, the hammer's aim.
  getAngle(): number {
    return this.bodyB.getAngle();
  }

  getAngularSpeed(): number {
    return this.bodyB.getAngularVelocity() - this.bodyA.getAngularVelocity();
  }

  // Butt position along the hammer axis, measured from the shoulder.
  getTranslation(): number {
    const xfA = this.bodyA.getTransform(), xfB = this.bodyB.getTransform();
    const dx = xfB.p.x - xfA.p.x - (xfA.q.c * this.localAnchorA.x - xfA.q.s * this.localAnchorA.y);
    const dy = xfB.p.y - xfA.p.y - (xfA.q.s * this.localAnchorA.x + xfA.q.c * this.localAnchorA.y);
    return xfB.q.c * dx + xfB.q.s * dy;
  }

  // Exact time derivative of getTranslation(), including the axis turning with bodyB.
  getLinearSpeed(): number {
    const xfA = this.bodyA.getTransform(), xfB = this.bodyB.getTransform();
    const centerA = this.bodyA.getWorldCenter(), centerB = this.bodyB.getWorldCenter();
    const vA = this.bodyA.getLinearVelocity(), vB = this.bodyB.getLinearVelocity();
    const wA = this.bodyA.getAngularVelocity(), wB = this.bodyB.getAngularVelocity();
    const shoulderX = xfA.p.x + xfA.q.c * this.localAnchorA.x - xfA.q.s * this.localAnchorA.y;
    const shoulderY = xfA.p.y + xfA.q.s * this.localAnchorA.x + xfA.q.c * this.localAnchorA.y;
    const dx = xfB.p.x - shoulderX, dy = xfB.p.y - shoulderY;
    const relativeX = vB.x - wB * (xfB.p.y - centerB.y) - vA.x + wA * (shoulderY - centerA.y);
    const relativeY = vB.y + wB * (xfB.p.x - centerB.x) - vA.y - wA * (shoulderX - centerA.x);
    const ax = xfB.q.c, ay = xfB.q.s;
    return ax * relativeX + ay * relativeY + wB * (ax * dy - ay * dx);
  }

  // Strengths for the next step; the caller supplies any boost.
  setMotorLimits(limits: Readonly<{ torque: number; force: number }>): void {
    requireLimit(limits.torque, 'motor torque');
    requireLimit(limits.force, 'motor force');
    this.maxMotorTorque = limits.torque;
    this.maxMotorForce = limits.force;
  }

  setMotorSpeeds(speeds: Readonly<{ angular: number; linear: number }>): void {
    if (!Number.isFinite(speeds.angular) || !Number.isFinite(speeds.linear)) throw new HammerJointError('HammerJoint motor speeds must be finite.');
    this.angularMotorSpeed = speeds.angular;
    this.linearMotorSpeed = speeds.linear;
    this.bodyA.setAwake(true);
    this.bodyB.setAwake(true);
  }

  // Angular motor effort only.
  getMotorTorque(invDt: number): number {
    return invDt * this.angularImpulse;
  }

  // Axial motor effort only; the passive stops are excluded.
  getMotorForce(invDt: number): number {
    return invDt * this.axialMotorImpulse;
  }

  getAnchorA(): Vec2 {
    return this.bodyA.getWorldPoint(this.localAnchorA);
  }

  getAnchorB(): Vec2 {
    return this.bodyB.getWorldPoint(ORIGIN);
  }

  // Full constraint force on bodyB, applied at anchor B.
  getReactionForce(invDt: number): Vec2 {
    const frame = this.velocityFrame;
    const axial = this.axialMotorImpulse + this.axialLimitImpulse;
    return new Vec2(
      invDt * (this.lateralImpulse * frame.nx + axial * frame.ax),
      invDt * (this.lateralImpulse * frame.ny + axial * frame.ay),
    );
  }

  // Full constraint torque on bodyB about anchor B, complementing getReactionForce().
  getReactionTorque(invDt: number): number {
    const frame = this.velocityFrame;
    const axial = this.axialMotorImpulse + this.axialLimitImpulse;
    return invDt * (this.angularImpulse - frame.translation * this.lateralImpulse + frame.lateral * axial);
  }

  // Both anchors are body-local.
  override shiftOrigin(_newOrigin: Vec2Value): void {}

  _reset(): void {
    throw new HammerJointError('HammerJoint cannot be reset in place; construct a new joint.');
  }

  initVelocityConstraints(step: TimeStep): void {
    const a = this.solverA, b = this.solverB;
    requireMassProperties(a, b);
    this.mA = a.m_invMass; this.mB = b.m_invMass; this.iA = a.m_invI; this.iB = b.m_invI;
    this.offsetAx = this.localAnchorA.x - a.m_sweep.localCenter.x;
    this.offsetAy = this.localAnchorA.y - a.m_sweep.localCenter.y;
    this.offsetBx = -b.m_sweep.localCenter.x;
    this.offsetBy = -b.m_sweep.localCenter.y;
    const f = this.velocityFrame;
    f.measure(a.c_position.c, a.c_position.a, this.offsetAx, this.offsetAy, b.c_position.c, b.c_position.a, this.offsetBx, this.offsetBy);

    const { mA, mB, iA, iB } = this;
    const k00 = this.k00 = mA + mB + iA * f.lateralA * f.lateralA + iB * f.lateralB * f.lateralB;
    const k01 = this.k01 = -iA * f.lateralA + iB * f.lateralB;
    const k02 = this.k02 = iA * f.lateralA * f.axialA + iB * f.lateralB * f.axialB;
    const k11 = this.k11 = iA + iB;
    const k12 = this.k12 = -iA * f.axialA + iB * f.axialB;
    const k22 = this.k22 = mA + mB + iA * f.axialA * f.axialA + iB * f.axialB * f.axialB;
    const c00 = k11 * k22 - k12 * k12, c01 = k02 * k12 - k01 * k22, c02 = k01 * k12 - k02 * k11;
    const det = k00 * c00 + k01 * c01 + k02 * c02;
    const turnDet = k00 * k11 - k01 * k01;
    const slideDet = k00 * k22 - k02 * k02;
    if (!(det > 0 && turnDet > 0 && slideDet > 0 && Number.isFinite(det))) {
      throw new HammerJointError(`HammerJoint effective mass is not positive definite (det ${det}).`);
    }
    this.inv00 = c00 / det; this.inv01 = c01 / det; this.inv02 = c02 / det;
    this.inv11 = slideDet / det;
    this.inv12 = (k01 * k02 - k00 * k12) / det;
    this.inv22 = turnDet / det;
    this.turn00 = k11 / turnDet; this.turn01 = -k01 / turnDet; this.turn11 = k00 / turnDet;
    this.slide00 = k22 / slideDet; this.slide02 = -k02 / slideDet; this.slide22 = k00 / slideDet;

    this.torqueCap = step.dt * this.maxMotorTorque;
    this.forceCap = step.dt * this.maxMotorForce;
    // Predictive stops: the axial speed may close the remaining gap to each stop this step, never open it.
    this.lowerSpeed = Math.min(0, (this.lowerTranslation - f.translation) * step.inv_dt);
    this.upperSpeed = Math.max(0, (this.upperTranslation - f.translation) * step.inv_dt);

    if (step.warmStarting) {
      this.lateralImpulse *= step.dtRatio;
      this.angularImpulse = clamp(this.angularImpulse * step.dtRatio, -this.torqueCap, this.torqueCap);
      this.axialMotorImpulse = clamp(this.axialMotorImpulse * step.dtRatio, -this.forceCap, this.forceCap);
      this.axialLimitImpulse *= step.dtRatio;
      this.applyImpulse(this.lateralImpulse, this.angularImpulse, this.axialMotorImpulse + this.axialLimitImpulse);
    } else {
      this.lateralImpulse = 0;
      this.angularImpulse = 0;
      this.axialMotorImpulse = 0;
      this.axialLimitImpulse = 0;
    }
  }

  solveVelocityConstraints(_step: TimeStep): void {
    const f = this.velocityFrame;
    const A = this.solverA.c_velocity, B = this.solverB.c_velocity;
    const relativeX = B.v.x - A.v.x, relativeY = B.v.y - A.v.y;
    const lateralSpeed = f.nx * relativeX + f.ny * relativeY + f.lateralB * B.w + f.lateralA * A.w;
    const angularSpeed = B.w - A.w;
    const axialSpeed = f.ax * relativeX + f.ay * relativeY + f.axialB * B.w + f.axialA * A.w;
    // Velocities with every impulse this joint has applied this step removed.
    const lateral = this.lateralImpulse, angular = this.angularImpulse;
    const axial = this.axialMotorImpulse + this.axialLimitImpulse;
    const baseL = lateralSpeed - (this.k00 * lateral + this.k01 * angular + this.k02 * axial);
    const baseT = angularSpeed - (this.k01 * lateral + this.k11 * angular + this.k12 * axial);
    const baseQ = axialSpeed - (this.k02 * lateral + this.k12 * angular + this.k22 * axial);
    const speedScale = Math.max(Math.abs(baseL), Math.abs(baseT), Math.abs(baseQ), Math.abs(this.angularMotorSpeed),
      Math.abs(this.linearMotorSpeed), -this.lowerSpeed, this.upperSpeed);
    const speedTolerance = FEASIBILITY_TOLERANCE * (1 + speedScale);

    let solved = false;
    for (let angularState = 0; angularState < ANGULAR_STATES && !solved; angularState++) {
      for (let axialState = 0; axialState < AXIAL_STATES && !solved; axialState++) {
        solved = this.tryActiveSet(angularState, axialState, baseL, baseT, baseQ, speedTolerance);
      }
    }
    if (!solved) {
      throw new HammerJointError(`HammerJoint found no feasible motor/stop state (base ${baseL}, ${baseT}, ${baseQ}; `
        + `caps ${this.torqueCap}, ${this.forceCap}; stop speeds ${this.lowerSpeed}, ${this.upperSpeed}).`);
    }
    this.applyImpulse(this.candidateLateral - lateral, this.candidateAngular - angular,
      this.candidateMotor + this.candidateLimit - axial);
    this.lateralImpulse = this.candidateLateral;
    this.angularImpulse = this.candidateAngular;
    this.axialMotorImpulse = this.candidateMotor;
    this.axialLimitImpulse = this.candidateLimit;
  }

  // Solves the block for one active set: free rows reach their target speed, fixed rows take their bound.
  // Accepts the total impulses into the candidate fields only if every KKT condition holds.
  private tryActiveSet(angularState: number, axialState: number, baseL: number, baseT: number, baseQ: number, speedTolerance: number): boolean {
    const torqueCap = this.torqueCap, forceCap = this.forceCap;
    const angularFree = angularState === ANGULAR_FREE;
    const stopped = axialState === AXIAL_STOP_LOWER || axialState === AXIAL_STOP_UPPER;
    const axialFree = axialState === AXIAL_MOTOR_FREE || stopped;
    const axialTarget = axialState === AXIAL_STOP_LOWER ? this.lowerSpeed
      : axialState === AXIAL_STOP_UPPER ? this.upperSpeed : this.linearMotorSpeed;
    const rl = -baseL, rt = this.angularMotorSpeed - baseT, rq = axialTarget - baseQ;
    let lateral: number;
    // Fixed rows sit at their bound; free rows are overwritten by the solve below.
    let angular = angularState === ANGULAR_UPPER ? torqueCap : -torqueCap;
    let axial = axialState === AXIAL_MOTOR_UPPER ? forceCap : -forceCap;
    if (angularFree && axialFree) {
      lateral = this.inv00 * rl + this.inv01 * rt + this.inv02 * rq;
      angular = this.inv01 * rl + this.inv11 * rt + this.inv12 * rq;
      axial = this.inv02 * rl + this.inv12 * rt + this.inv22 * rq;
    } else if (angularFree) {
      const r0 = rl - this.k02 * axial, r1 = rt - this.k12 * axial;
      lateral = this.turn00 * r0 + this.turn01 * r1;
      angular = this.turn01 * r0 + this.turn11 * r1;
    } else if (axialFree) {
      const r0 = rl - this.k01 * angular, r2 = rq - this.k12 * angular;
      lateral = this.slide00 * r0 + this.slide02 * r2;
      axial = this.slide02 * r0 + this.slide22 * r2;
    } else {
      lateral = (rl - this.k01 * angular - this.k02 * axial) / this.k00;
    }
    const angularSpeed = baseT + this.k01 * lateral + this.k11 * angular + this.k12 * axial;
    const axialSpeed = baseQ + this.k02 * lateral + this.k12 * angular + this.k22 * axial;
    // Motor bounds and passive impulse signs are exact. An out-of-bounds free candidate must
    // select its bounded active set and re-solve the other rows, not be admitted or clipped.
    // Speed feasibility alone uses rounding slack.
    const angularSlip = angularSpeed - this.angularMotorSpeed;
    if (angularFree ? Math.abs(angular) > torqueCap
      : angularState === ANGULAR_LOWER ? angularSlip < -speedTolerance : angularSlip > speedTolerance) return false;

    let motor = axial, limit = 0;
    if (stopped) {
      // The net axial impulse splits canonically: the motor sits at whichever bound its command implies.
      const command = this.linearMotorSpeed;
      motor = axialTarget > command ? -forceCap : axialTarget < command ? forceCap : clamp(axial, -forceCap, forceCap);
      limit = axial - motor;
      if (axialState === AXIAL_STOP_LOWER ? limit < 0 : limit > 0) return false;
    } else {
      // Inactive stops must leave the axial speed between them.
      if (axialSpeed < this.lowerSpeed - speedTolerance || axialSpeed > this.upperSpeed + speedTolerance) return false;
      const axialSlip = axialSpeed - this.linearMotorSpeed;
      if (axialState === AXIAL_MOTOR_FREE ? Math.abs(axial) > forceCap
        : axialState === AXIAL_MOTOR_LOWER ? axialSlip < -speedTolerance : axialSlip > speedTolerance) return false;
    }
    this.candidateLateral = lateral;
    this.candidateAngular = angular;
    this.candidateMotor = motor;
    this.candidateLimit = limit;
    return true;
  }

  private applyImpulse(lateral: number, angular: number, axial: number): void {
    const f = this.velocityFrame;
    const A = this.solverA.c_velocity, B = this.solverB.c_velocity;
    const px = lateral * f.nx + axial * f.ax, py = lateral * f.ny + axial * f.ay;
    A.v.x -= this.mA * px; A.v.y -= this.mA * py;
    A.w += this.iA * (lateral * f.lateralA - angular + axial * f.axialA);
    B.v.x += this.mB * px; B.v.y += this.mB * py;
    B.w += this.iB * (lateral * f.lateralB + angular + axial * f.axialB);
  }

  // Projects lateral drift and passive stops, without a positional target-angle constraint.
  solvePositionConstraints(_step: TimeStep): boolean {
    const A = this.solverA.c_position, B = this.solverB.c_position;
    const f = this.positionFrame;
    f.measure(A.c, A.a, this.offsetAx, this.offsetAy, B.c, B.a, this.offsetBx, this.offsetBy);
    const slop = Settings.linearSlop, maxCorrection = Settings.maxLinearCorrection;
    const lateralC = clamp(f.lateral, -maxCorrection, maxCorrection);
    let axialC = 0, axialError = 0, stopActive = true;
    if (f.translation <= this.lowerTranslation) {
      axialC = clamp(f.translation - this.lowerTranslation + slop, -maxCorrection, 0);
      axialError = this.lowerTranslation - f.translation;
    } else if (f.translation >= this.upperTranslation) {
      axialC = clamp(f.translation - this.upperTranslation - slop, 0, maxCorrection);
      axialError = f.translation - this.upperTranslation;
    } else {
      stopActive = false;
    }

    const { mA, mB, iA, iB } = this;
    const k00 = mA + mB + iA * f.lateralA * f.lateralA + iB * f.lateralB * f.lateralB;
    let lateral: number, axial = 0;
    if (stopActive) {
      const k02 = iA * f.lateralA * f.axialA + iB * f.lateralB * f.axialB;
      const k22 = mA + mB + iA * f.axialA * f.axialA + iB * f.axialB * f.axialB;
      const det = k00 * k22 - k02 * k02;
      lateral = (-k22 * lateralC + k02 * axialC) / det;
      axial = (k02 * lateralC - k00 * axialC) / det;
      // Stops can push only inward. If correcting the lateral row already clears the stop,
      // release its row and re-solve the equality instead of pulling the butt back to it.
      if (f.translation <= this.lowerTranslation ? axial < 0 : axial > 0) {
        axial = 0;
        lateral = -lateralC / k00;
      }
    } else {
      lateral = -lateralC / k00;
    }
    const px = lateral * f.nx + axial * f.ax, py = lateral * f.ny + axial * f.ay;
    A.c.x -= mA * px; A.c.y -= mA * py;
    A.a += iA * (lateral * f.lateralA + axial * f.axialA);
    B.c.x += mB * px; B.c.y += mB * py;
    B.a += iB * (lateral * f.lateralB + axial * f.axialB);
    return Math.max(Math.abs(f.lateral), axialError) <= slop;
  }
}
