import {
  Box3, BoxGeometry, CylinderGeometry, Group, Matrix4, Mesh, MeshStandardMaterial,
  Quaternion, SphereGeometry, TorusGeometry, Vector3,
} from 'three';
import type { LatheGeometry, Object3D } from 'three';
import { ARM_SIDES, SHAFT_ARTWORK_LENGTH } from './character';
import type { ArmSide, VisualBinding, VisualPartId } from './character';
import { ArmPoseSolver } from './arm-ik';
import type { ArmPose } from './arm-ik';
import { ARM_LAYER } from './arm-layer';
import { PLAYER_DEPTH } from './character-depth';
import { HEAD_RISE } from './character-figure';
import type { CharacterStance, ShaftFrame } from './character-presenter';
import { PHYSICS, RIG } from './config';
import type { Point } from './config';
import type { ReadonlyDeathAppearance } from './death-pose';
import { Disposal } from './disposal';
import { DEFAULT_HAMMER_HEAD } from './hammer-head';
import type { HammerHead } from './hammer-head';
import { HeadAim } from './head-aim';
import { OBSTACLE_LINE } from './obstacle-line';
import { createHammerHeadGeometry, createPotGeometry, placeLimb, PLAYER_FIGURE } from './player-figure';
import { copyRotation } from './player-pose';
import type { DeathPose, LivePlayerFrame, Rotation3 } from './player-pose';
import type { RigGeometry } from './rig';
import { disposeResources } from './scene-resources';
import { physicsPart } from './simulation';
import type { PhysicsFrame } from './simulation';
import type { GameTheme } from './theme';
import { VisualVisibility } from './visual-visibility';
import { WaistLean } from './waist-lean';

// The brass sleeve near the start of each two-part hammer segment.
const SLEEVE_INSET = 0.07;
const ARM_PARTS: ReadonlySet<VisualPartId> = new Set(ARM_SIDES.flatMap((side) =>
  [`${side}-upper-arm`, `${side}-forearm`, `${side}-elbow`, `${side}-hand`] as const));

function solid(geometry: BoxGeometry | SphereGeometry | CylinderGeometry | LatheGeometry | TorusGeometry,
  material: MeshStandardMaterial, position: [number, number, number] = [0, 0, 0]): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(...position);
  return mesh;
}

// Puts a mesh-part arm visual, the built-in one or an Appearance import, on the arms' render layer.
function onArmLayer(root: Object3D): void {
  root.traverse((object) => { object.layers.set(ARM_LAYER); });
}

interface Arm {
  readonly upper: Group;
  readonly lower: Group;
  readonly elbow: Group;
  readonly hand: Group;
  readonly solver: ArmPoseSolver;
}

// The shared figure scene, pose filters and mesh-arm mechanics. Renderers borrow its matrices and arm poses.
export class FigureRig {
  readonly actors = new Group();
  readonly foreground = new Group();
  readonly visuals = new Map<VisualPartId, VisualBinding>();
  // Internal collision diagnostics read these after the player's arms are posed, outside the public layer contract.
  readonly posedArms: ArmPose[] = [];
  readonly torso = new Group();
  readonly headAim = new HeadAim();
  // The upper body turns about the waist, at the jar's rim, toward the hammer, up to the character's waistLean.
  readonly waistLean = new WaistLean(Math.max(...RIG.potVertices.map((point) => point.y)));
  readonly headRotation = new Quaternion();
  readonly headDelta = new Matrix4();
  readonly potFrame = new Matrix4();
  // The physical tool: origin at the butt, +X along the handle, in unscaled metres.
  readonly toolFrame = new Matrix4();
  readonly aim = { x: 0, y: 0 };
  private readonly shaftBase = { x: 0, y: 0, angle: 0 };
  private readonly shaftTip = { x: 0, y: 0, angle: 0 };
  private readonly shaftCenter = { x: 0, y: 0 };
  readonly shaft: { -readonly [K in keyof ShaftFrame]: ShaftFrame[K] } = {
    base: this.shaftBase, centre: this.shaftCenter, tip: this.shaftTip, length: 0, angle: 0,
  };
  private readonly playerMeshes = new Map<string, Group>();
  private readonly meshHead = new Group();
  private readonly torsoOrigin = { x: 0, y: 0 };
  private readonly headOffset = new Vector3();
  private readonly localAim = { x: 0, y: 0 };
  private readonly headWorld = new Matrix4();
  private readonly inverseBody = new Matrix4();
  private readonly headCentre = new Vector3();
  private readonly headCentreLocal = new Vector3(0, PLAYER_FIGURE.helmet.y, 0);
  private readonly headRoll = new Quaternion();
  private readonly zAxis = new Vector3(0, 0, 1);
  private readonly customShaft = new Group();
  // Two-part hammer segments, rescaled when the rig changes.
  private readonly shaftSegments: { readonly shaft: Mesh; readonly sleeve: Mesh }[] = [];
  private readonly arms = new Map<ArmSide, Arm>();
  private readonly palette: Record<keyof GameTheme['character'], MeshStandardMaterial>;
  // The physical head's outline, which the built-in head mesh follows.
  private headOutline: HammerHead = DEFAULT_HAMMER_HEAD;
  private headMesh!: Mesh;
  private rig: RigGeometry;
  private disposed = false;

  constructor(rig: RigGeometry, theme: GameTheme) {
    this.rig = rig;
    const colors = theme.character;
    const brass = new MeshStandardMaterial({ color: colors.pot, roughness: 0.34, metalness: 0.65 });
    const trim = new MeshStandardMaterial({ color: colors.trim, roughness: 0.4, metalness: 0.5 });
    const dark = new MeshStandardMaterial({ color: colors.dark, roughness: 0.5, metalness: 0.4 });
    const suit = new MeshStandardMaterial({ color: colors.suit, roughness: 0.7 });
    const ceramic = new MeshStandardMaterial({ color: colors.ceramic, roughness: 0.5, metalness: 0.12 });
    const wood = new MeshStandardMaterial({ color: colors.wood, roughness: 0.7 });
    this.palette = { pot: brass, trim, dark, suit, ceramic, wood };

    const pot = new Group();
    pot.add(solid(createPotGeometry(), brass));
    const rim = solid(new TorusGeometry(0.433, 0.035, 10, 40), trim, [0, 0.31, 0]);
    rim.rotation.x = Math.PI / 2;
    pot.add(rim);
    pot.add(solid(new CylinderGeometry(0.425, 0.425, 0.018, 32), dark, [0, 0.285, 0]));
    const badge = solid(new SphereGeometry(0.11, 12, 8), ceramic, [0, -0.03, 0.472]);
    badge.scale.set(1, 0.9, 0.16);
    pot.add(badge);
    const potAnchor = this.visualSlot('pot', pot);
    this.playerMeshes.set('pot', potAnchor);
    this.actors.add(potAnchor);

    const { chest: chestShape, neck, helmet: helmetShape, upperArm, forearm } = PLAYER_FIGURE;
    const body = new Group();
    const chest = solid(new SphereGeometry(chestShape.radius, 16, 12), suit, [0, chestShape.y, 0]);
    chest.scale.set(...chestShape.scale);
    body.add(chest);
    body.add(solid(new CylinderGeometry(neck.top, neck.bottom, neck.height, 12), dark, [0, neck.y, 0]));
    this.torso.add(this.visualSlot('torso', body));
    const characterHead = new Group();
    const helmet = solid(new SphereGeometry(helmetShape.radius, 20, 14), ceramic, [0, helmetShape.y, 0]);
    helmet.scale.y = helmetShape.scaleY;
    characterHead.add(helmet);
    const visor = solid(new SphereGeometry(0.19, 20, 12), dark, [0, 1.10, 0.16]);
    visor.scale.set(0.92, 0.52, 0.43);
    characterHead.add(visor);
    const reflection = solid(new BoxGeometry(0.08, 0.018, 0.01), trim, [-0.05, 1.13, 0.243]);
    characterHead.add(reflection);
    this.torso.add(this.visualSlot('character-head', characterHead));
    this.actors.add(this.torso);
    for (const side of ARM_SIDES) {
      const arm: Arm = {
        upper: this.visualSlot(`${side}-upper-arm`, solid(new CylinderGeometry(upperArm.top, upperArm.bottom, 1, 10), side === 'left' ? dark : suit)),
        lower: this.visualSlot(`${side}-forearm`, solid(new CylinderGeometry(forearm.top, forearm.bottom, 1, 10), ceramic)),
        elbow: this.visualSlot(`${side}-elbow`, solid(new SphereGeometry(PLAYER_FIGURE.elbow, 12, 8), brass)),
        hand: this.visualSlot(`${side}-hand`, solid(new SphereGeometry(PLAYER_FIGURE.hand, 12, 8), dark)),
        solver: new ArmPoseSolver(side),
      };
      this.actors.add(arm.upper, arm.lower, arm.elbow, arm.hand);
      this.arms.set(side, arm);
    }
    const shaftSegments: Group[] = [];
    // Unit-length geometry, shared by the segments and scaled to the rig's segment length.
    const shaftGeometry = new CylinderGeometry(RIG.handleHalfWidth, RIG.handleHalfWidth, 1, 10);
    const sleeveGeometry = new CylinderGeometry(0.052, 0.052, 0.04, 10);
    for (let index = 0; index < RIG.handleSegments; index++) {
      const segment = new Group();
      const shaft = solid(shaftGeometry, wood);
      shaft.rotation.z = Math.PI / 2;
      segment.add(shaft);
      const sleeve = solid(sleeveGeometry, brass);
      sleeve.rotation.z = Math.PI / 2;
      segment.add(sleeve);
      this.shaftSegments.push({ shaft, sleeve });
      this.playerMeshes.set(`handle-${index}`, segment);
      this.foreground.add(segment);
      shaftSegments.push(segment);
    }
    this.layoutShaft();
    this.visuals.set('hammer-shaft', {
      anchor: this.customShaft,
      modelAnchor: this.customShaft,
      defaults: shaftSegments,
      bounds: new Box3(
        new Vector3(-SHAFT_ARTWORK_LENGTH / 2, -RIG.handleHalfWidth, -RIG.handleHalfWidth),
        new Vector3(SHAFT_ARTWORK_LENGTH / 2, RIG.handleHalfWidth, RIG.handleHalfWidth),
      ),
      visibility: this.visibility('hammer-shaft', shaftSegments),
    });
    this.foreground.add(this.customShaft);
    const head = new Group();
    this.headMesh = new Mesh(createHammerHeadGeometry(this.headOutline), dark);
    head.add(this.headMesh);
    const bolt = solid(new SphereGeometry(0.052, 10, 8), brass, [0, 0, 0.13]);
    bolt.scale.z = 0.3;
    head.add(bolt);
    const headAnchor = this.visualSlot('hammer-head', head);
    this.playerMeshes.set('head', headAnchor);
    this.foreground.add(headAnchor);
  }

  setTheme(theme: GameTheme): void {
    for (const key of Object.keys(this.palette) as (keyof GameTheme['character'])[]) this.palette[key].color.set(theme.character[key]);
  }

  setStance(stance: Readonly<CharacterStance>): void {
    this.headCentreLocal.copy(stance.headPivot);
    this.headCentreLocal.y += HEAD_RISE;
  }

  placeParts(frame: PhysicsFrame, depth: number, pot: { update(frame: Matrix4): void } | null): void {
    for (const part of frame.parts) {
      const mesh = this.playerMeshes.get(part.id);
      if (!mesh) continue;
      mesh.position.set(part.x, part.y, part.kind === 'pot' ? PLAYER_DEPTH.pot : depth);
      mesh.rotation.z = part.angle;
      if (part.kind === 'pot') {
        // The jar's frame: origin at the physical pot's bottom-centre, at the pot's own depth. The pot model and
        // hair colliders held by the jar follow it.
        const cos = Math.cos(part.angle), sin = Math.sin(part.angle);
        this.potFrame.makeRotationZ(part.angle)
          .setPosition(part.x - RIG.potBottom * sin, part.y + RIG.potBottom * cos, PLAYER_DEPTH.pot);
        pot?.update(this.potFrame);
      }
    }
    const tip = physicsPart(frame, 'head'), shaftBase = physicsPart(frame, 'slider');
    const shaftLength = Math.hypot(tip.x - shaftBase.x, tip.y - shaftBase.y);
    const shaftCenter = this.shaftCenter;
    shaftCenter.x = (shaftBase.x + tip.x) / 2;
    shaftCenter.y = (shaftBase.y + tip.y) / 2;
    const shaftAngle = shaftLength <= PHYSICS.aimEpsilon ? shaftBase.angle : Math.atan2(tip.y - shaftBase.y, tip.x - shaftBase.x);
    // Keep the last drawn targets stable when the simulation rewrites its borrowed parts before a presenter swap.
    this.shaftBase.x = shaftBase.x; this.shaftBase.y = shaftBase.y; this.shaftBase.angle = shaftBase.angle;
    this.shaftTip.x = tip.x; this.shaftTip.y = tip.y; this.shaftTip.angle = tip.angle;
    this.shaft.length = shaftLength; this.shaft.angle = shaftAngle;
    this.customShaft.position.set(shaftCenter.x, shaftCenter.y, depth);
    this.customShaft.rotation.z = shaftAngle;
    this.customShaft.scale.x = shaftLength / SHAFT_ARTWORK_LENGTH;
    this.toolFrame.makeRotationZ(shaftAngle).setPosition(shaftBase.x, shaftBase.y, depth);
  }

  poseLiveTorso(player: LivePlayerFrame, cursor: Readonly<Point>, time: number, stance: Readonly<CharacterStance>, turn: number): void {
    const root = player.centre, headAnchor = this.visuals.get('character-head')!.anchor;
    headAnchor.matrixAutoUpdate = false;
    headAnchor.matrix.identity();
    headAnchor.matrixWorldNeedsUpdate = true;
    this.waistLean.update(this.shaft.angle - turn, stance.waistLean, time);
    const lean = this.waistLean.angle;
    const origin = this.waistLean.torsoOrigin(root.x, root.y, this.torsoOrigin, lean);
    if (turn !== 0) {
      const dx = origin.x - root.x, dy = origin.y - root.y;
      const turnCos = Math.cos(turn), turnSin = Math.sin(turn);
      origin.x = root.x + dx * turnCos - dy * turnSin;
      origin.y = root.y + dx * turnSin + dy * turnCos;
    }
    this.torso.position.set(origin.x, origin.y, PLAYER_DEPTH.torso);
    this.torso.rotation.z = lean + turn;
    this.torso.updateWorldMatrix(true, false);
    const aim = this.aim;
    aim.x = cursor.x - player.shoulder.x;
    aim.y = cursor.y - player.shoulder.y;
    const cos = Math.cos(lean + turn), sin = Math.sin(lean + turn);
    this.localAim.x = aim.x * cos + aim.y * sin;
    this.localAim.y = aim.y * cos - aim.x * sin;
    this.headAim.update(this.localAim, time);
    this.headRotation.copy(this.headAim.rotation);
    this.headOffset.copy(stance.headPivot).applyQuaternion(this.headRotation).negate().add(stance.headPivot);
    this.meshHead.matrix.makeRotationFromQuaternion(this.headRotation).setPosition(this.headOffset);
    this.meshHead.matrixWorldNeedsUpdate = true;
  }

  poseDeath(pose: ReadonlyDeathAppearance, stance: Readonly<CharacterStance>): void {
    this.torso.position.set(pose.torso.x, pose.torso.y, OBSTACLE_LINE);
    this.torso.rotation.z = pose.torso.angle;
    this.torso.updateWorldMatrix(true, false);
    if (!stance.upperBody3d) this.headRotation.identity();
    else this.headRotation.set(pose.headFacing.x, pose.headFacing.y, pose.headFacing.z, pose.headFacing.w);
    this.headRoll.setFromAxisAngle(this.zAxis, pose.head.angle).multiply(this.headRotation);
    this.headWorld.makeRotationFromQuaternion(this.headRoll).setPosition(pose.head.x, pose.head.y, OBSTACLE_LINE);
    this.inverseBody.copy(this.torso.matrixWorld).invert();
    this.headDelta.multiplyMatrices(this.inverseBody, this.headWorld);
    this.headWorld.makeTranslation(-this.headCentreLocal.x, -this.headCentreLocal.y, -this.headCentreLocal.z);
    this.headDelta.multiply(this.headWorld);
    const headAnchor = this.visuals.get('character-head')!.anchor;
    headAnchor.matrixAutoUpdate = false;
    headAnchor.matrix.copy(this.headDelta);
    this.meshHead.matrix.identity();
    headAnchor.matrixWorldNeedsUpdate = this.meshHead.matrixWorldNeedsUpdate = true;
  }

  armSolver(side: ArmSide): ArmPoseSolver {
    const arm = this.arms.get(side);
    if (!arm) throw new Error(`Missing visual arm: ${side}`);
    return arm.solver;
  }

  placeArm(pose: ArmPose, shaftAngle: number, rotation: Quaternion | null): void {
    const arm = this.arms.get(pose.side);
    if (!arm) throw new Error(`Missing visual arm: ${pose.side}`);
    placeLimb(arm.upper, pose.shoulder, pose.elbow, pose.normal);
    placeLimb(arm.lower, pose.elbow, pose.hand, pose.normal);
    arm.elbow.position.copy(pose.elbow);
    arm.hand.position.copy(pose.hand);
    arm.hand.rotation.set(0, 0, shaftAngle);
    // A mesh-part hand's own frame is its grip frame, so its rotation applies there.
    if (rotation !== null) arm.hand.quaternion.multiply(rotation);
  }

  writeShownPose(out: DeathPose, facing: Rotation3, stance: Readonly<CharacterStance>): void {
    out.torso.x = this.torso.position.x; out.torso.y = this.torso.position.y; out.torso.angle = this.torso.rotation.z;
    this.headCentre.copy(this.headCentreLocal);
    if (stance.upperBody3d) this.headCentre.applyMatrix4(this.meshHead.matrix);
    this.headCentre.applyMatrix4(this.torso.matrixWorld);
    out.head.x = this.headCentre.x; out.head.y = this.headCentre.y; out.head.angle = this.torso.rotation.z;
    copyRotation(facing, this.headRotation);
    for (const pose of this.posedArms) {
      const arm = out.arms[pose.side];
      arm.shoulder.x = pose.shoulder.x; arm.shoulder.y = pose.shoulder.y;
      arm.elbow.x = pose.elbow.x; arm.elbow.y = pose.elbow.y;
      arm.hand.x = pose.hand.x; arm.hand.y = pose.hand.y;
      arm.hand.angle = Math.atan2(pose.shaftAxis.y, pose.shaftAxis.x);
    }
  }

  resetFilters(): void { this.headAim.reset(); this.waistLean.reset(); }

  resetPoseHistory(): void {
    for (const arm of this.arms.values()) arm.solver.reset();
  }

  syncHead(outline: HammerHead): void {
    if (outline === this.headOutline) return;
    this.headOutline = outline;
    this.headMesh.geometry.dispose();
    this.headMesh.geometry = createHammerHeadGeometry(outline);
  }

  syncRig(rig: RigGeometry): void {
    if (rig === this.rig) return;
    this.rig = rig;
    this.layoutShaft();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const disposal = new Disposal();
    disposal.run(() => this.actors.removeFromParent());
    disposal.run(() => this.foreground.removeFromParent());
    disposal.run(() => disposeResources(this.actors, this.foreground));
    disposal.run(() => this.actors.clear());
    disposal.run(() => this.foreground.clear());
    this.visuals.clear();
    disposal.finish();
  }

  private visualSlot(slot: VisualPartId, model: Object3D): Group {
    const anchor = new Group();
    const modelAnchor = slot === 'character-head' ? this.meshHead : anchor;
    if (modelAnchor !== anchor) {
      modelAnchor.matrixAutoUpdate = false;
      anchor.add(modelAnchor);
    }
    modelAnchor.add(model);
    if (this.visuals.has(slot)) throw new Error(`Duplicate visual slot: ${slot}`);
    const defaults = [model];
    this.visuals.set(slot, {
      anchor, modelAnchor, defaults, bounds: new Box3().setFromObject(model, true),
      visibility: this.visibility(slot, defaults),
    });
    if (ARM_PARTS.has(slot)) onArmLayer(model);
    return anchor;
  }

  // Arm replacements from authoring tools draw over the body like the built-in arms.
  private visibility(slot: VisualPartId, defaults: readonly Object3D[]): VisualVisibility {
    if (ARM_PARTS.has(slot)) return new VisualVisibility(defaults, { onReplacement: (next) => { if (next !== null) onArmLayer(next); } });
    return new VisualVisibility(defaults);
  }

  private layoutShaft(): void {
    const length = this.rig.segmentLength;
    for (const { shaft, sleeve } of this.shaftSegments) {
      shaft.scale.y = length;
      sleeve.position.x = SLEEVE_INSET - length / 2;
    }
  }
}
