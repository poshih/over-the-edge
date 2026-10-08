// The default phantom look: pooled translucent white figures with shared geometry and allocation-free arm IK.
// Engine-owned playback supplies the poses and fades; a look never chooses tracks or advances time.
import { CylinderGeometry, Group, Mesh, MeshLambertMaterial, SphereGeometry, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ArmPoseSolver } from './arm-ik';
import { DEFAULT_ARM_CHAINS } from './player-figure-data';
import { ARM_SIDES, DEFAULT_ARM_IK } from './character';
import type { ArmSide } from './character';
import { DEFAULT_ARM_FORWARD_DISTANCE, getToolDepth, PLAYER_DEPTH } from './character-depth';
import { RIG } from './config';
import { DEFAULT_GRIPS, GripHold, headGripMargin } from './grips';
import { DEFAULT_HAMMER_HEAD } from './hammer-head';
import type { HammerHead } from './hammer-head';
import { DEFAULT_POT_OUTLINE } from './pot-outline';
import type { PotOutline } from './pot-outline';
import type { GripDistances, GripShoulder } from './grips';
import type { PhantomFigureFrame, PhantomLook, PhantomLookFactory } from './object-looks';
import { createHammerHeadGeometry, createPotGeometry, placeLimb, PLAYER_FIGURE } from './player-figure';

export const PHANTOM_LOOK = {
  opacity: 0.38,
} as const;

// Nearer parts draw first and write depth, so a ghost covers what it hides once instead of doubling up.
const DRAW_ORDER = { tool: 0, hand: 1, forearm: 2, elbow: 3, upperArm: 4, body: 5, pot: 6 } as const;
// After the scene's other translucent objects, which a phantom's depth must not hide.
const FIRST_DRAW = 100;
const HINT_OFFSETS: Readonly<Record<ArmSide, readonly [number, number, number]>> = {
  left: [DEFAULT_ARM_IK.leftHintX, DEFAULT_ARM_IK.leftHintY, DEFAULT_ARM_IK.leftHintZ],
  right: [DEFAULT_ARM_IK.rightHintX, DEFAULT_ARM_IK.rightHintY, DEFAULT_ARM_IK.rightHintZ],
};

interface FigureGeometry {
  readonly body: BufferGeometry;
  readonly upperArm: BufferGeometry;
  readonly forearm: BufferGeometry;
  readonly elbow: BufferGeometry;
  readonly hand: BufferGeometry;
  readonly shaft: BufferGeometry;
  // The game's default hammer head and its jar, replaced when the game settings change them.
  head: BufferGeometry;
  pot: BufferGeometry;
}

interface Limbs {
  readonly upper: Mesh;
  readonly lower: Mesh;
  readonly elbow: Mesh;
  readonly hand: Mesh;
  readonly solver: ArmPoseSolver;
}

interface Figure {
  readonly root: Group;
  readonly material: MeshLambertMaterial;
  readonly pot: Mesh;
  readonly body: Mesh;
  readonly shaft: Mesh;
  readonly head: Mesh;
  readonly arms: Readonly<Record<ArmSide, Limbs>>;
  // Where its sliding hands hold the handle.
  readonly hold: GripHold;
}

function createFigureGeometry(): FigureGeometry {
  const { chest, neck, helmet, upperArm, forearm } = PLAYER_FIGURE;
  const parts = [
    new SphereGeometry(chest.radius, 16, 12).scale(...chest.scale).translate(0, chest.y, 0),
    new CylinderGeometry(neck.top, neck.bottom, neck.height, 12).translate(0, neck.y, 0),
    new SphereGeometry(helmet.radius, 20, 14).scale(1, helmet.scaleY, 1).translate(0, helmet.y, 0),
  ];
  const body = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (body === null) throw new Error('The phantom figure\'s body could not be merged.');
  return {
    pot: createPotGeometry(DEFAULT_POT_OUTLINE),
    body,
    upperArm: new CylinderGeometry(upperArm.top, upperArm.bottom, 1, 10),
    forearm: new CylinderGeometry(forearm.top, forearm.bottom, 1, 10),
    elbow: new SphereGeometry(PLAYER_FIGURE.elbow, 12, 8),
    hand: new SphereGeometry(PLAYER_FIGURE.hand, 12, 8),
    // A unit length along x, stretched to each recording's handle.
    shaft: new CylinderGeometry(RIG.handleHalfWidth, RIG.handleHalfWidth, 1, 10).rotateZ(Math.PI / 2),
    head: createHammerHeadGeometry(DEFAULT_HAMMER_HEAD),
  };
}

function createFigure(geometry: FigureGeometry): Figure {
  const material = new MeshLambertMaterial({
    color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.55, transparent: true, opacity: 0, depthWrite: true,
  });
  const root = new Group();
  root.visible = false;
  const part = (shape: BufferGeometry, order: number): Mesh => {
    const mesh = new Mesh(shape, material);
    mesh.renderOrder = FIRST_DRAW + order;
    root.add(mesh);
    return mesh;
  };
  const limbs = (side: ArmSide): Limbs => ({
    upper: part(geometry.upperArm, DRAW_ORDER.upperArm), lower: part(geometry.forearm, DRAW_ORDER.forearm),
    elbow: part(geometry.elbow, DRAW_ORDER.elbow), hand: part(geometry.hand, DRAW_ORDER.hand), solver: new ArmPoseSolver(side),
  });
  return {
    root, material,
    pot: part(geometry.pot, DRAW_ORDER.pot), body: part(geometry.body, DRAW_ORDER.body),
    shaft: part(geometry.shaft, DRAW_ORDER.tool), head: part(geometry.head, DRAW_ORDER.tool),
    arms: { left: limbs('left'), right: limbs('right') },
    hold: new GripHold(),
  };
}

export class PhantomView implements PhantomLook {
  readonly root = new Group();
  private readonly geometry = createFigureGeometry();
  private readonly figures: readonly Figure[];
  // The game's current default hammer head, whatever hammer a recorded player held.
  private head: HammerHead = DEFAULT_HAMMER_HEAD;
  private pot: PotOutline = DEFAULT_POT_OUTLINE;
  private headMargin = headGripMargin(DEFAULT_HAMMER_HEAD);
  private readonly toolDepth = getToolDepth(DEFAULT_ARM_FORWARD_DISTANCE);
  private readonly shoulders: Record<ArmSide, GripShoulder> = {
    left: { along: 0, aside2: 0, arm: 0 }, right: { along: 0, aside2: 0, arm: 0 },
  };
  private readonly grips: GripDistances = { left: 0, right: 0 };
  private readonly targets = {
    shoulder: new Vector3(), hand: new Vector3(), hint: new Vector3(), shaftAxis: new Vector3(),
  };

  constructor(figures: number) {
    this.root.name = 'phantoms';
    this.figures = Array.from({ length: figures }, () => createFigure(this.geometry));
    for (const figure of this.figures) this.root.add(figure.root);
  }

  draw(frames: readonly PhantomFigureFrame[], head: HammerHead, pot: PotOutline): void {
    if (head !== this.head) this.setHead(head);
    if (pot !== this.pot) this.setPot(pot);
    for (let index = 0; index < this.figures.length; index++) {
      const figure = this.figures[index]!;
      const frame = frames[index]!;
      figure.root.visible = frame.visible;
      if (!frame.visible) continue;
      if (frame.fresh) {
        figure.hold.reset();
        for (const side of ARM_SIDES) figure.arms[side].solver.reset();
      }
      this.place(figure, frame);
    }
  }

  dispose(): void {
    for (const figure of this.figures) figure.material.dispose();
    for (const geometry of Object.values(this.geometry)) geometry.dispose();
  }

  private setHead(head: HammerHead): void {
    const previous = this.geometry.head;
    this.geometry.head = createHammerHeadGeometry(head);
    for (const figure of this.figures) figure.head.geometry = this.geometry.head;
    previous.dispose();
    this.head = head;
    this.headMargin = headGripMargin(head);
  }

  private setPot(pot: PotOutline): void {
    const previous = this.geometry.pot;
    this.geometry.pot = createPotGeometry(pot);
    for (const figure of this.figures) figure.pot.geometry = this.geometry.pot;
    previous.dispose();
    this.pot = pot;
  }

  private place(figure: Figure, frame: PhantomFigureFrame): void {
    const { pose, tool, handleLength, dt } = frame;
    figure.material.opacity = PHANTOM_LOOK.opacity * frame.opacity;
    figure.pot.position.set(pose.x, pose.y, PLAYER_DEPTH.pot);
    figure.pot.rotation.z = pose.pot;
    figure.body.position.set(pose.x, pose.y, PLAYER_DEPTH.torso);
    const cos = Math.cos(pose.angle);
    const sin = Math.sin(pose.angle);
    figure.shaft.position.set((tool.buttX + tool.tipX) / 2, (tool.buttY + tool.tipY) / 2, this.toolDepth);
    figure.shaft.rotation.z = pose.angle;
    figure.shaft.scale.x = handleLength;
    figure.head.position.set(tool.tipX, tool.tipY, this.toolDepth);
    figure.head.rotation.z = pose.angle;
    for (const side of ARM_SIDES) {
      const chain = DEFAULT_ARM_CHAINS[side];
      const dx = pose.x + chain.shoulder[0] - tool.buttX;
      const dy = pose.y + chain.shoulder[1] - tool.buttY;
      // Reach is measured in the course plane, as for the player.
      const along = dx * cos + dy * sin;
      const shoulder = this.shoulders[side];
      shoulder.along = along;
      shoulder.aside2 = Math.max(0, dx * dx + dy * dy - along * along);
      shoulder.arm = chain.upper + chain.forearm;
    }
    figure.hold.place(DEFAULT_GRIPS, this.shoulders, handleLength, this.headMargin, this.grips);
    for (const side of ARM_SIDES) {
      const chain = DEFAULT_ARM_CHAINS[side];
      const limbs = figure.arms[side];
      const grip = this.grips[side];
      const targets = this.targets;
      targets.shoulder.set(pose.x + chain.shoulder[0], pose.y + chain.shoulder[1], PLAYER_DEPTH.torso + chain.shoulder[2]);
      targets.hand.set(tool.buttX + grip * cos, tool.buttY + grip * sin, this.toolDepth);
      const hint = HINT_OFFSETS[side];
      targets.hint.set(pose.x + hint[0], pose.y + hint[1], PLAYER_DEPTH.torso + hint[2]);
      targets.shaftAxis.set(cos, sin, 0);
      const arm = limbs.solver.solve(targets, dt, chain);
      placeLimb(limbs.upper, arm.shoulder, arm.elbow, arm.normal);
      placeLimb(limbs.lower, arm.elbow, arm.hand, arm.normal);
      limbs.elbow.position.copy(arm.elbow);
      limbs.hand.position.copy(arm.hand);
    }
  }
}

// Kept with the drawing, not the point catalogue: only phantom consumers import this implementation.
export const DEFAULT_PHANTOM_LOOK: PhantomLookFactory = ({ figures }) => new PhantomView(figures);
