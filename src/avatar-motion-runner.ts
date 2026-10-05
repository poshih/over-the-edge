import { Matrix4 } from 'three';
import type { Object3D } from 'three';
import { MOTION_STEP_SECONDS, MotionClock } from './motion-clock';
import type { AvatarJointId } from './character-profile';
import type { AvatarMotion, AvatarMotionFrame, AvatarMotionSkeleton } from './avatar-motion';
import type { PreparedAvatarMotions } from './avatar-motion-prepare';

// Where a claimed joint's parent sits this frame: a frame the engine writes before the bone pass (a mapped joint's, or
// another claim of the same motion), or nothing that moves.
type Anchor =
  | { readonly kind: 'frame'; readonly frame: Matrix4 }
  | { readonly kind: 'static' };

interface ClaimBinding {
  readonly bone: Object3D;
  readonly anchor: Anchor;
  // The parent's bind relative to its anchor's, or null where the parent is the anchor itself; for a static anchor,
  // the parent's inverse bind.
  readonly offset: Matrix4 | null;
  // The rest frame's source: the nearest mapped joint's frame and the claim's bind relative to it, or null where no
  // mapped joint carries the claim and its rest stays its bind.
  readonly follow: Matrix4 | null;
  readonly restOffset: Matrix4;
  // The local matrix the scene gave it at bind, restored when its motion is replaced.
  readonly bindLocal: Matrix4;
}

interface MutableFrame {
  reset: boolean;
  steps: number;
  readonly stepSeconds: number;
  body: Readonly<Matrix4>;
  pot: Readonly<Matrix4>;
  readonly mapped: AvatarMotionSkeleton;
  readonly rest: readonly Matrix4[];
  readonly out: readonly Matrix4[];
}

interface MotionRun {
  readonly id: string;
  readonly motion: AvatarMotion;
  readonly claims: readonly ClaimBinding[];
  readonly frame: MutableFrame;
  // A motion that has not run yet starts from rest.
  fresh: boolean;
  writes: number;
}

/**
 * Runs an imported avatar's motions for its view (SkinnedAvatarView): one clock for all of them, each claim's rest
 * frame from its nearest mapped joint, and the bone pass that turns the avatar-space frames a motion writes into local
 * matrices, so joints below a claimed joint follow it rigidly. Built once per set of prepared motions, continuing the
 * clock and the motions it shares with the runner it replaces, while a new motion starts from rest; per frame it
 * allocates nothing and its work is bounded by the claimed joints.
 */
export class AvatarMotionRunner {
  private readonly clock = new MotionClock();
  private readonly runs: readonly MotionRun[];
  private readonly parentNow = new Matrix4();

  // `bones` gives each skin joint's scene object by index, `avatarBind` any node's avatar-space bind, and `mapped`
  // the mapped joints' nodes and frames; their current frames are written before every apply.
  constructor(prepared: PreparedAvatarMotions, bones: readonly Object3D[], avatarBind: (object: Object3D) => Matrix4,
    mapped: { readonly nodes: ReadonlyMap<Object3D, AvatarJointId>; readonly frames: AvatarMotionSkeleton },
    previous: AvatarMotionRunner | null = null) {
    if (previous !== null) this.clock.copyFrom(previous.clock);
    this.runs = Object.freeze(prepared.motions.map((entry): MotionRun => {
      const before = previous?.runs.find(run => run.motion === entry.motion);
      const out = entry.claims.map(() => new Matrix4());
      const claimed = new Map(entry.claims.map((joint, index) => [bones[joint]!, index] as const));
      const claims = entry.claims.map((joint): ClaimBinding => {
        const bone = bones[joint]!;
        const parent = bone.parent!;
        const parentBind = avatarBind(parent);
        // The nearest node at or above the parent whose frame is written this frame.
        let anchor: Anchor = { kind: 'static' };
        let anchorBind: Matrix4 | null = null;
        let anchorNode: Object3D | null = null;
        for (let node: Object3D | null = parent; node !== null; node = node.parent) {
          const claim = claimed.get(node);
          const id = mapped.nodes.get(node);
          if (claim !== undefined) anchor = { kind: 'frame', frame: out[claim]! };
          else if (id !== undefined) anchor = { kind: 'frame', frame: mapped.frames.current[id] as Matrix4 };
          else continue;
          anchorBind = avatarBind(node);
          anchorNode = node;
          break;
        }
        let follow: Matrix4 | null = null;
        let followBind: Matrix4 | null = null;
        for (let node: Object3D | null = parent; node !== null; node = node.parent) {
          const id = mapped.nodes.get(node);
          if (id === undefined) continue;
          follow = mapped.frames.current[id] as Matrix4;
          followBind = mapped.frames.bind[id] as Matrix4;
          break;
        }
        const bind = avatarBind(bone);
        return {
          bone, anchor,
          offset: anchorNode === parent ? null
            : anchorBind === null ? parentBind.clone().invert() : anchorBind.clone().invert().multiply(parentBind),
          follow,
          restOffset: followBind === null ? bind : followBind.clone().invert().multiply(bind),
          bindLocal: parentBind.clone().invert().multiply(bind),
        };
      });
      // A claim no mapped joint carries rests at its bind.
      const rest = claims.map(claim => claim.follow === null ? claim.restOffset.clone() : new Matrix4());
      return {
        id: entry.id, motion: entry.motion, claims: Object.freeze(claims),
        // A motion that never ran under the runner it comes from still starts from rest.
        fresh: before?.fresh ?? true, writes: before?.writes ?? 0,
        frame: {
          reset: true, steps: 0, stepSeconds: MOTION_STEP_SECONDS, body: new Matrix4(), pot: new Matrix4(), mapped: mapped.frames,
          rest: Object.freeze(rest), out: Object.freeze(out),
        },
      };
    }));
  }

  get empty(): boolean {
    return this.runs.length === 0;
  }

  // Runs every motion for the frame at `time` (simulation seconds), once the mapped joints are posed. `body` places
  // avatar space in the world; `pot` places the jar, its origin at the jar's bottom-centre.
  apply(body: Readonly<Matrix4>, pot: Readonly<Matrix4>, time: number): void {
    if (this.runs.length === 0) return;
    this.clock.advance(time);
    for (const run of this.runs) {
      const { frame, claims } = run;
      frame.reset = this.clock.reset || run.fresh;
      frame.steps = frame.reset ? 0 : this.clock.steps;
      run.fresh = false;
      frame.body = body;
      frame.pot = pot;
      for (let index = 0; index < claims.length; index += 1) {
        const claim = claims[index]!;
        if (claim.follow !== null) frame.rest[index]!.multiplyMatrices(claim.follow, claim.restOffset);
      }
      run.motion.update(frame as AvatarMotionFrame);
      for (let index = 0; index < claims.length; index += 1) {
        const claim = claims[index]!;
        const out = frame.out[index]!;
        if (claim.anchor.kind === 'static') claim.bone.matrix.multiplyMatrices(claim.offset!, out);
        else {
          if (claim.offset === null) this.parentNow.copy(claim.anchor.frame);
          else this.parentNow.multiplyMatrices(claim.anchor.frame, claim.offset);
          claim.bone.matrix.copy(this.parentNow.invert()).multiply(out);
        }
        claim.bone.matrixWorldNeedsUpdate = true;
      }
      run.writes += claims.length;
    }
  }

  // The character was placed anew while time went on: every motion starts again from rest on the next frame.
  interrupt(): void {
    this.clock.interrupt();
  }

  // Each motion's claimed joints and cumulative joint writes.
  inspect(): { id: string; claims: number; writes: number }[] {
    return this.runs.map(run => ({ id: run.id, claims: run.claims.length, writes: run.writes }));
  }

  // Returns every claimed joint to its bind, for motions that stop running.
  restore(): void {
    for (const run of this.runs) {
      for (const claim of run.claims) {
        claim.bone.matrix.copy(claim.bindLocal);
        claim.bone.matrixWorldNeedsUpdate = true;
      }
    }
  }
}
