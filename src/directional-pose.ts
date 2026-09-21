import { DIRECTIONAL_LIMITS, DirectionalError, normalizeDegrees, sectorSpan, signedDegrees, validateDirectionalPresentation } from './directional-data';
import type { DirectionalPresentation, DirectionalRule } from './directional-data';
import { clamp } from './math';
import { FACING_DIRECTIONS } from './skeleton-data';
import type { FacingDirection } from './skeleton-data';
import { facingDirection } from './skeleton-pose';

export interface DirectionalFrame {
  readonly direction: FacingDirection;
  readonly aimAngle: number;
  readonly targetRotation: number;
  readonly displayedRotation: number;
}

const RAD_TO_DEG = 180 / Math.PI;
const AIM_EPSILON = 1e-6;
const INITIAL_FRAME: Readonly<DirectionalFrame> = Object.freeze({
  direction: 'right', aimAngle: 0, targetRotation: 0, displayedRotation: 0,
});

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new DirectionalError(`${label} must be finite.`);
}

function selectSector(presentation: DirectionalPresentation, angle: number): number {
  const offset = normalizeDegrees(angle - presentation.boundaries[0]);
  for (let index = FACING_DIRECTIONS.length - 1; index > 0; index -= 1) {
    if (offset >= normalizeDegrees(presentation.boundaries[index] - presentation.boundaries[0])) return index;
  }
  return 0;
}

function withinHold(presentation: DirectionalPresentation, index: number, angle: number): boolean {
  const rule = presentation.directions[index];
  const offset = normalizeDegrees(angle - presentation.boundaries[index]);
  return offset <= sectorSpan(presentation, index) + rule.counterclockwiseHold ||
    offset >= DIRECTIONAL_LIMITS.angle - rule.clockwiseHold;
}

function dampRotation(current: number, target: number, rule: DirectionalRule, elapsed: number): number {
  if (rule.responseTime === 0) return target;
  const fullCircle = rule.minimumRotation === -DIRECTIONAL_LIMITS.halfTurn &&
    rule.maximumRotation === DIRECTIONAL_LIMITS.halfTurn;
  const difference = target - current;
  // A wrapped shortest path leaves every proper subinterval of [-180, 180].
  if (!fullCircle && (difference >= DIRECTIONAL_LIMITS.halfTurn || difference < -DIRECTIONAL_LIMITS.halfTurn)) {
    return target;
  }
  const delta = fullCircle ? signedDegrees(difference) : difference;
  const alpha = -Math.expm1(-elapsed / rule.responseTime);
  const rotation = current + delta * alpha;
  return fullCircle ? signedDegrees(rotation) : clamp(rotation, rule.minimumRotation, rule.maximumRotation);
}

// Time is in seconds and frame angles are degrees. A zero aim initializes at 0 degrees;
// after initialization it retains the last aim, direction and target while easing continues.
export class DirectionalPose {
  private readonly presentation: DirectionalPresentation | null;
  private frame: Readonly<DirectionalFrame> = INITIAL_FRAME;
  private previousTime: number | null = null;

  constructor(presentation: DirectionalPresentation | null) {
    this.presentation = presentation === null ? null : validateDirectionalPresentation(presentation);
  }

  update(input: { readonly time: number; readonly aim: { readonly x: number; readonly y: number } }): Readonly<DirectionalFrame> {
    requireFinite(input.time, 'Directional time');
    requireFinite(input.aim.x, 'Directional aim X');
    requireFinite(input.aim.y, 'Directional aim Y');
    const elapsed = this.previousTime === null ? 0 : input.time - this.previousTime;
    if (this.presentation !== null && this.previousTime !== null && elapsed === 0) return this.frame;
    const initialize = this.previousTime === null || elapsed < 0;
    const zeroAim = Math.hypot(input.aim.x, input.aim.y) <= AIM_EPSILON;
    const radians = zeroAim ? 0 : Math.atan2(input.aim.y, input.aim.x);
    const aimAngle = zeroAim ? (initialize ? 0 : this.frame.aimAngle) : normalizeDegrees(radians * RAD_TO_DEG);
    const presentation = this.presentation;
    if (presentation === null) {
      return this.store({
        direction: zeroAim && !initialize ? this.frame.direction : facingDirection(radians),
        aimAngle, targetRotation: 0, displayedRotation: 0,
      }, input.time);
    }

    const previousIndex = FACING_DIRECTIONS.indexOf(this.frame.direction);
    let index = previousIndex;
    if (initialize || !zeroAim) {
      if (initialize || !presentation.hysteresis || !withinHold(presentation, previousIndex, aimAngle)) {
        index = selectSector(presentation, aimAngle);
      }
    }
    const rule = presentation.directions[index];
    const targetRotation = !presentation.rotation ? 0 : zeroAim && !initialize ? this.frame.targetRotation :
      clamp(signedDegrees(aimAngle - rule.neutralAngle), rule.minimumRotation, rule.maximumRotation);
    let displayedRotation = targetRotation;
    if (presentation.rotation && !initialize) {
      const previous = presentation.directions[previousIndex];
      const current = index === previousIndex ? this.frame.displayedRotation :
        clamp(signedDegrees(previous.neutralAngle + this.frame.displayedRotation - rule.neutralAngle),
          rule.minimumRotation, rule.maximumRotation);
      displayedRotation = dampRotation(current, targetRotation, rule, elapsed);
    }
    return this.store({ direction: rule.direction, aimAngle, targetRotation, displayedRotation }, input.time);
  }

  snapshot(): Readonly<DirectionalFrame> {
    return this.frame;
  }

  reset(): void {
    this.frame = INITIAL_FRAME;
    this.previousTime = null;
  }

  private store(frame: DirectionalFrame, time: number): Readonly<DirectionalFrame> {
    this.frame = Object.freeze(frame);
    this.previousTime = time;
    return this.frame;
  }
}
