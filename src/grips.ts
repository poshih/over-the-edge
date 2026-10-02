import { RIG } from './config.ts';
import { RIG_LIMITS } from './rig.ts';

// Where a character's hands hold the handle. Grips are presentation: physics never reads them.
export const GRIP_PLACEMENTS = ['fixed', 'sliding'] as const;
export type GripPlacement = (typeof GRIP_PLACEMENTS)[number];

// A 3D hand's rotation on the handle, in degrees, about the grip frame's axes: X along the handle toward
// the head, Y across it in the course plane and Z toward the camera. The frame turns with the handle and
// sits on the grip, so the hand pivots there; it turns about X, then Y, then Z, each about those axes.
export interface GripRotation {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// Each hand's distance from the butt, where fixed hands stay and sliding hands start. Sliding hands ride
// with the handle, extending or retracting, until one would be farther from its shoulder in the course
// plane than `slideAt` times its arm's length. `rotation` turns each 3D hand on its grip.
export interface Grips {
  readonly placement: GripPlacement;
  readonly left: number;
  readonly right: number;
  readonly slideAt: number;
  readonly rotation: Readonly<Record<'left' | 'right', GripRotation>>;
}

export const NO_GRIP_ROTATION: GripRotation = Object.freeze({ x: 0, y: 0, z: 0 });
export const DEFAULT_GRIPS: Grips = Object.freeze({
  placement: 'sliding', left: 0.04, right: 0.22, slideAt: 0.85,
  rotation: Object.freeze({ left: NO_GRIP_ROTATION, right: NO_GRIP_ROTATION }),
});
export const GRIP_LIMITS = { min: 0, max: RIG_LIMITS.handleLength.max, step: 0.01 } as const;
export const GRIP_ROTATION_LIMITS = { min: -180, max: 180, step: 1 } as const;
// Below 40% a shoulder is often farther than that from the handle's line, where hands can only hold its nearest point.
export const SLIDE_AT_LIMITS = { min: 0.4, max: 1, step: 0.05 } as const;
// Space kept between the leading hand and the head's collision block.
export const HEAD_GRIP_CLEARANCE = 0.1;
// No hand holds nearer the head's centre than this, so none enters its collision block.
export const HEAD_GRIP_MARGIN = Math.max(...RIG.headVertices.map((point) => point.x)) + HEAD_GRIP_CLEARANCE;

export interface GripDistances {
  left: number;
  right: number;
}

// One hand's shoulder relative to the handle in the course plane, as the camera sees them, and the arm
// between them.
export interface GripShoulder {
  // Where the shoulder projects onto the handle's line, measured from the butt.
  along: number;
  // The squared distance from the shoulder to that line in the course plane.
  aside2: number;
  // Upper arm plus forearm.
  arm: number;
}

/**
 * Where a character's hands hold the handle, as distances from its butt, kept from frame to frame. Fixed
 * hands hold their grips. Sliding hands start on their grips and ride with the handle, extending or
 * retracting, while each stays within `slideAt` of its arm's length from its shoulder; past that, the
 * handle slides through both hands, together, by the least amount that brings them back, and they ride on
 * from there. Hands stay on the handle and short of the head. The placement is continuous in aim and
 * extension and costs the same every frame.
 */
export class GripHold {
  // How far the hands have slid from their grips: toward the head when positive.
  private offset = 0;

  // Puts the hands back on their grips, for example when the run restarts or the grips change.
  reset(): void {
    this.offset = 0;
  }

  // Places both hands into `out` for this frame.
  place(grips: Grips, shoulders: Readonly<Record<'left' | 'right', GripShoulder>>, shaftLength: number,
    out: GripDistances): GripDistances {
    const farthest = Math.max(0, shaftLength - HEAD_GRIP_MARGIN);
    const left = Math.min(grips.left, farthest);
    const right = Math.min(grips.right, farthest);
    if (grips.placement === 'fixed') {
      this.offset = 0;
      out.left = left;
      out.right = right;
      return out;
    }
    // Each hand is within reach while its grip lies on the chord its reach cuts from the handle's line.
    const leftChord = reachChord(shoulders.left, grips.slideAt);
    const rightChord = reachChord(shoulders.right, grips.slideAt);
    const low = Math.max(shoulders.left.along - leftChord - left, shoulders.right.along - rightChord - right);
    const high = Math.min(shoulders.left.along + leftChord - left, shoulders.right.along + rightChord - right);
    // The hands keep their hold while it is within reach; when no shared slide suits both, they split the difference.
    const wanted = low <= high ? Math.min(Math.max(this.offset, low), high) : (low + high) / 2;
    this.offset = Math.min(Math.max(wanted, -Math.min(left, right)), farthest - Math.max(left, right));
    out.left = left + this.offset;
    out.right = right + this.offset;
    return out;
  }
}

// Half the stretch of the handle's line within this share of the arm's length from the shoulder: none,
// leaving only the nearest point, when the line is farther than that.
function reachChord(shoulder: GripShoulder, slideAt: number): number {
  return Math.sqrt(Math.max(0, (slideAt * shoulder.arm) ** 2 - shoulder.aside2));
}

export function sameGripRotation(left: GripRotation, right: GripRotation): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

export function sameGrips(left: Grips, right: Grips): boolean {
  return left.placement === right.placement && left.left === right.left && left.right === right.right &&
    left.slideAt === right.slideAt && sameGripRotation(left.rotation.left, right.rotation.left) &&
    sameGripRotation(left.rotation.right, right.rotation.right);
}
