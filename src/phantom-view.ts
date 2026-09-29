// Draws phantoms: other players' recorded movement, replayed as translucent white figures of the
// default character. Figures are pooled and share their geometry, and a frame costs only the phantoms
// that are playing. Arms are not recorded: each figure's hands take the default grips on its tool and
// its arms reach them with the game's arm IK. See docs/phantoms.md.
import { CylinderGeometry, Group, Mesh, MeshLambertMaterial, SphereGeometry, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEFAULT_ARM_CHAINS, solveArmPose } from './arm-ik';
import type { ArmPose } from './arm-ik';
import { ARM_SIDES, DEFAULT_ARM_IK } from './character';
import type { ArmSide } from './character';
import { DEFAULT_ARM_FORWARD_DISTANCE, getToolDepth, PLAYER_DEPTH } from './character-depth';
import { RIG } from './config';
import { DEFAULT_GRIPS, placeGrips } from './grips';
import type { GripDistances, GripShoulder } from './grips';
import { phantomTool, samplePhantom } from './phantom-format';
import type { PhantomPose, PhantomTool, PhantomTrack } from './phantom-format';
import { createHammerHeadGeometry, createPotGeometry, placeLimb, PLAYER_FIGURE } from './player-figure';
import type { PhysicsFrame } from './simulation';
import type { ViewLayer } from './view';

export const PHANTOM_LOOK = {
  // Phantoms that can play at once.
  figures: 3,
  opacity: 0.38,
  // Seconds a phantom takes to appear at its start and to vanish at its end.
  fadeIn: 0.5,
  fadeOut: 0.8,
} as const;

// Game time a frame may advance playback; a longer step, like a restart's jump back, holds it.
const MAX_FRAME_SECONDS = 0.25;
// Nearer parts draw first and write depth, so a ghost covers what it hides once instead of doubling up.
const DRAW_ORDER = { tool: 0, hand: 1, forearm: 2, elbow: 3, upperArm: 4, body: 5, pot: 6 } as const;
// After the scene's other translucent objects, which a phantom's depth must not hide.
const FIRST_DRAW = 100;

interface FigureGeometry {
  readonly pot: BufferGeometry;
  readonly body: BufferGeometry;
  readonly upperArm: BufferGeometry;
  readonly forearm: BufferGeometry;
  readonly elbow: BufferGeometry;
  readonly hand: BufferGeometry;
  readonly shaft: BufferGeometry;
  readonly head: BufferGeometry;
}

interface Limbs {
  readonly upper: Mesh;
  readonly lower: Mesh;
  readonly elbow: Mesh;
  readonly hand: Mesh;
  pose: ArmPose | null;
}

interface Figure {
  readonly root: Group;
  readonly material: MeshLambertMaterial;
  readonly pot: Mesh;
  readonly body: Mesh;
  readonly shaft: Mesh;
  readonly head: Mesh;
  readonly arms: Readonly<Record<ArmSide, Limbs>>;
  track: PhantomTrack | null;
  time: number;
  keyframe: number;
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
    pot: createPotGeometry(),
    body,
    upperArm: new CylinderGeometry(upperArm.top, upperArm.bottom, 1, 10),
    forearm: new CylinderGeometry(forearm.top, forearm.bottom, 1, 10),
    elbow: new SphereGeometry(PLAYER_FIGURE.elbow, 12, 8),
    hand: new SphereGeometry(PLAYER_FIGURE.hand, 12, 8),
    // A unit length along x, stretched to each recording's handle.
    shaft: new CylinderGeometry(RIG.handleHalfWidth, RIG.handleHalfWidth, 1, 10).rotateZ(Math.PI / 2),
    head: createHammerHeadGeometry(),
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
  const limbs = (): Limbs => ({
    upper: part(geometry.upperArm, DRAW_ORDER.upperArm), lower: part(geometry.forearm, DRAW_ORDER.forearm),
    elbow: part(geometry.elbow, DRAW_ORDER.elbow), hand: part(geometry.hand, DRAW_ORDER.hand), pose: null,
  });
  return {
    root, material,
    pot: part(geometry.pot, DRAW_ORDER.pot), body: part(geometry.body, DRAW_ORDER.body),
    shaft: part(geometry.shaft, DRAW_ORDER.tool), head: part(geometry.head, DRAW_ORDER.tool),
    arms: { left: limbs(), right: limbs() },
    track: null, time: 0, keyframe: 0,
  };
}

export class PhantomView implements ViewLayer {
  readonly root = new Group();
  private readonly geometry = createFigureGeometry();
  private readonly figures: readonly Figure[];
  private readonly toolDepth = getToolDepth(DEFAULT_ARM_FORWARD_DISTANCE);
  private time: number | null = null;
  private readonly pose: PhantomPose = { x: 0, y: 0, pot: 0, angle: 0, along: 0, across: 0 };
  private readonly tool: PhantomTool = { tipX: 0, tipY: 0, buttX: 0, buttY: 0 };
  private readonly shoulders: Record<ArmSide, GripShoulder> = {
    left: { along: 0, aside2: 0, arm: 0 }, right: { along: 0, aside2: 0, arm: 0 },
  };
  private readonly grips: GripDistances = { left: 0, right: 0 };

  constructor() {
    this.root.name = 'phantoms';
    this.figures = Array.from({ length: PHANTOM_LOOK.figures }, () => createFigure(this.geometry));
    for (const figure of this.figures) this.root.add(figure.root);
  }

  // Phantoms playing now.
  get playing(): number {
    let count = 0;
    for (const figure of this.figures) if (figure.track !== null) count++;
    return count;
  }

  // Starts a phantom from its beginning; false when every figure is busy.
  play(track: PhantomTrack): boolean {
    const figure = this.figures.find((candidate) => candidate.track === null);
    if (figure === undefined) return false;
    figure.track = track;
    figure.time = 0;
    figure.keyframe = 0;
    for (const side of ARM_SIDES) figure.arms[side].pose = null;
    this.place(figure, 0);
    figure.root.visible = true;
    return true;
  }

  // Playback follows the game's time: it holds while the game is paused.
  update(frame: PhysicsFrame): void {
    const previous = this.time;
    this.time = frame.time;
    const elapsed = previous === null ? 0 : frame.time - previous;
    const dt = elapsed >= 0 && elapsed <= MAX_FRAME_SECONDS ? elapsed : 0;
    for (const figure of this.figures) {
      if (figure.track === null) continue;
      figure.time += dt;
      if (figure.time >= figure.track.duration) this.stop(figure);
      else this.place(figure, dt);
    }
  }

  // Ends every phantom at once.
  clear(): void {
    for (const figure of this.figures) this.stop(figure);
  }

  dispose(): void {
    for (const figure of this.figures) figure.material.dispose();
    for (const geometry of Object.values(this.geometry)) geometry.dispose();
  }

  private stop(figure: Figure): void {
    figure.track = null;
    figure.root.visible = false;
  }

  private place(figure: Figure, dt: number): void {
    const track = figure.track!;
    const { pose, tool } = this;
    figure.keyframe = samplePhantom(track, figure.time, pose, figure.keyframe);
    phantomTool(pose, track.handleLength, tool);
    const fade = Math.min(1, figure.time / PHANTOM_LOOK.fadeIn, (track.duration - figure.time) / PHANTOM_LOOK.fadeOut);
    figure.material.opacity = PHANTOM_LOOK.opacity * Math.max(0, fade);
    figure.pot.position.set(pose.x, pose.y, PLAYER_DEPTH.pot);
    figure.pot.rotation.z = pose.pot;
    figure.body.position.set(pose.x, pose.y, PLAYER_DEPTH.torso);
    const cos = Math.cos(pose.angle);
    const sin = Math.sin(pose.angle);
    figure.shaft.position.set((tool.buttX + tool.tipX) / 2, (tool.buttY + tool.tipY) / 2, this.toolDepth);
    figure.shaft.rotation.z = pose.angle;
    figure.shaft.scale.x = track.handleLength;
    figure.head.position.set(tool.tipX, tool.tipY, this.toolDepth);
    figure.head.rotation.z = pose.angle;
    for (const side of ARM_SIDES) {
      const chain = DEFAULT_ARM_CHAINS[side];
      const dx = pose.x + chain.shoulder[0] - tool.buttX;
      const dy = pose.y + chain.shoulder[1] - tool.buttY;
      const dz = this.toolDepth - PLAYER_DEPTH.torso - chain.shoulder[2];
      const along = dx * cos + dy * sin;
      const shoulder = this.shoulders[side];
      shoulder.along = along;
      shoulder.aside2 = Math.max(0, dx * dx + dy * dy + dz * dz - along * along);
      shoulder.arm = chain.upper + chain.forearm;
    }
    placeGrips(DEFAULT_GRIPS, this.shoulders, track.handleLength, this.grips);
    for (const side of ARM_SIDES) {
      const chain = DEFAULT_ARM_CHAINS[side];
      const limbs = figure.arms[side];
      const grip = this.grips[side];
      const arm = solveArmPose(side, {
        shoulder: new Vector3(pose.x + chain.shoulder[0], pose.y + chain.shoulder[1], PLAYER_DEPTH.torso + chain.shoulder[2]),
        hand: new Vector3(tool.buttX + grip * cos, tool.buttY + grip * sin, this.toolDepth),
        hint: new Vector3(pose.x + DEFAULT_ARM_IK[`${side}HintX`], pose.y + DEFAULT_ARM_IK[`${side}HintY`],
          PLAYER_DEPTH.torso + DEFAULT_ARM_IK[`${side}HintZ`]),
        shaftAxis: new Vector3(cos, sin, 0),
      }, { previous: limbs.pose, dt, lengths: chain });
      placeLimb(limbs.upper, arm.shoulder, arm.elbow, arm.normal);
      placeLimb(limbs.lower, arm.elbow, arm.hand, arm.normal);
      limbs.elbow.position.copy(arm.elbow);
      limbs.hand.position.copy(arm.hand);
      limbs.pose = arm;
    }
  }
}
