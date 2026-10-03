import { Box, Polygon, Vec2, WeldJoint } from 'planck';
import type { Body, Fixture, World } from 'planck';
import { PHYSICS, RIG } from './config';
import type { Point, Tuning } from './config';
import type { HammerHead } from './hammer-head';
import { transformPoint } from './math';
import { playerBody, PlayerRigError } from './player-bodies';
import type { PlayerBody, PlayerContactPart, PlayerPart } from './player-bodies';
import type { RigGeometry } from './rig';

export interface PlayerTool {
  readonly bodies: readonly PlayerBody[];
  readonly parts: readonly PlayerPart[];
  readonly driveBody: Body;
  readonly butt: PlayerPart;
  readonly head: PlayerContactPart;
  readonly welds: readonly WeldJoint[];
  readonly acceptsTuning: (tuning: Readonly<Tuning>) => boolean;
  readonly tune: (tuning: Readonly<Tuning>) => void;
  // Replaces the head's collision outline in place, keeping the tool's motion; outside a physics step only.
  readonly setHead: (head: HammerHead, tuning: Readonly<Tuning>) => void;
}

type ToolConstruction = Omit<PlayerTool, 'acceptsTuning'>;

interface ToolInput {
  readonly world: World;
  readonly shoulder: Readonly<Point>;
  readonly angle: number;
  readonly extension: number;
  readonly geometry: RigGeometry;
  readonly tuning: Readonly<Tuning>;
  readonly head: HammerHead;
}

const ORIGIN = Object.freeze({ x: 0, y: 0 });

// A head's mass properties at unit density: its area, centroid and inertia about its centre. The head's mass is a
// setting, so its outline only spreads that mass.
function headUnitMass(head: HammerHead): { mass: number; center: Vec2; I: number } {
  const data = { mass: 0, center: new Vec2(), I: 0 };
  new Polygon(head.map((point) => new Vec2(point.x, point.y))).computeMass(data, 1);
  return data;
}
function handleVertices(half: number): readonly Point[] {
  return [
    { x: -half, y: -RIG.handleHalfWidth }, { x: half, y: -RIG.handleHalfWidth },
    { x: half, y: RIG.handleHalfWidth }, { x: -half, y: RIG.handleHalfWidth },
  ];
}

function headFixture(body: Body, head: HammerHead, offset: number, tuning: Readonly<Tuning>): Fixture {
  return body.createFixture(new Polygon(head.map((point) => new Vec2(point.x + offset, point.y))), {
    density: 1, friction: tuning.gripFriction, restitution: tuning.hammerBounciness / 100,
    filterCategoryBits: PHYSICS.toolCategory,
    filterMaskBits: PHYSICS.terrainCategory | PHYSICS.enemyCategory,
  });
}

function shaftFixture(body: Body, half: number, offset: number): Fixture {
  return body.createFixture(new Box(half, RIG.handleHalfWidth, new Vec2(offset, 0)), {
    density: 1, filterCategoryBits: PHYSICS.toolCategory, filterMaskBits: 0,
  });
}

function rigidTool(input: ToolInput): ToolConstruction {
  const { world, shoulder, angle, extension, geometry } = input;
  const owned = playerBody(world, { id: 'tool',
    position: transformPoint({ x: extension, y: 0 }, shoulder, angle), angle, fixedRotation: false });
  const body = owned.body;
  const butt: PlayerPart = { id: 'slider', kind: 'slider', body, localPoint: ORIGIN, vertices: [] };
  const parts: PlayerPart[] = [butt];
  for (let index = 0; index < RIG.handleSegments; index++) {
    const offset = (index + 0.5) * geometry.segmentLength;
    const fixture = shaftFixture(body, geometry.segmentLength / 2, offset);
    parts.push({ id: `handle-${index}`, kind: 'handle', body, localPoint: { x: offset, y: 0 },
      vertices: handleVertices(geometry.segmentLength / 2), fixture });
  }
  const head: PlayerContactPart = { id: 'head', kind: 'head', body, localPoint: { x: geometry.handleLength, y: 0 },
    vertices: input.head, fixture: headFixture(body, input.head, geometry.handleLength, input.tuning) };
  parts.push(head);
  let unit = headUnitMass(input.head);
  const massData = { mass: 0, center: new Vec2(), I: 0 };
  const tune = (tuning: Readonly<Tuning>): void => {
    const carriage = tuning.sliderCarriageMass, shaft = tuning.shaftMass, headMass = tuning.hammerMass;
    const length = geometry.handleLength;
    const headX = length + unit.center.x, headY = unit.center.y;
    massData.mass = carriage + shaft + headMass;
    massData.center.set((shaft * length / 2 + headMass * headX) / massData.mass,
      headMass * headY / massData.mass);
    // Planck expects inertia about the body origin, not the COM. The carrier's rotor inertia is
    // real rotational energy; its translational mass belongs to the fixed-rotation root instead.
    massData.I = (carriage + tuning.hingeCarrierMass) * PHYSICS.guideInertiaPerMass +
      shaft * (length * length / 3 + (2 * RIG.handleHalfWidth) ** 2 / 12) +
      headMass * (unit.I / unit.mass + length * length + 2 * length * unit.center.x);
    body.setMassData(massData);
  };
  tune(input.tuning);
  const setHead = (outline: HammerHead, tuning: Readonly<Tuning>): void => {
    body.destroyFixture(head.fixture);
    head.fixture = headFixture(body, outline, geometry.handleLength, tuning);
    head.vertices = outline;
    unit = headUnitMass(outline);
    tune(tuning);
  };
  return { bodies: [owned], parts, driveBody: body, butt, head, welds: [], tune, setHead };
}

function compliantTool(input: ToolInput): ToolConstruction {
  const { world, shoulder, angle, extension, geometry } = input;
  const bodies: PlayerBody[] = [];
  const parts: PlayerPart[] = [];
  const create = (id: string, distance: number): Body => {
    const owned = playerBody(world, { id,
      position: transformPoint({ x: extension + distance, y: 0 }, shoulder, angle), angle, fixedRotation: false });
    bodies.push(owned);
    return owned.body;
  };
  const carriage = create('slider', 0);
  const butt: PlayerPart = { id: 'slider', kind: 'slider', body: carriage, localPoint: ORIGIN, vertices: [] };
  parts.push(butt);
  const welds: WeldJoint[] = [];
  let previous = carriage;
  const weld = (body: Body, anchorA: number, anchorB: number): void => {
    const joint = world.createJoint(new WeldJoint({ bodyA: previous, bodyB: body,
      localAnchorA: new Vec2(anchorA, 0), localAnchorB: new Vec2(anchorB, 0), referenceAngle: 0,
      frequencyHz: input.tuning.handleFrequency, dampingRatio: input.tuning.handleDamping,
      collideConnected: false }));
    if (!joint) throw new PlayerRigError('Cannot construct a handle while the physics world is stepping.');
    welds.push(joint);
    previous = body;
  };
  const segments: Body[] = [];
  for (let index = 0; index < RIG.handleSegments; index++) {
    const half = geometry.segmentLength / 2;
    const body = create(`handle-${index}`, (index + 0.5) * geometry.segmentLength);
    const fixture = shaftFixture(body, half, 0);
    parts.push({ id: `handle-${index}`, kind: 'handle', body, localPoint: ORIGIN,
      vertices: handleVertices(half), fixture });
    weld(body, index === 0 ? 0 : half, -half);
    segments.push(body);
  }
  const headBody = create('head', geometry.handleLength);
  const head: PlayerContactPart = { id: 'head', kind: 'head', body: headBody, localPoint: ORIGIN,
    vertices: input.head, fixture: headFixture(headBody, input.head, 0, input.tuning) };
  parts.push(head);
  let unit = headUnitMass(input.head);
  weld(headBody, geometry.segmentLength / 2, 0);
  const massData = { mass: 0, center: new Vec2(), I: 0 };
  const tune = (tuning: Readonly<Tuning>): void => {
    massData.mass = tuning.sliderCarriageMass;
    massData.center.setZero();
    massData.I = (tuning.sliderCarriageMass + tuning.hingeCarrierMass) * PHYSICS.guideInertiaPerMass;
    carriage.setMassData(massData);
    massData.mass = tuning.shaftMass / RIG.handleSegments;
    massData.I = massData.mass * (geometry.segmentLength ** 2 + (2 * RIG.handleHalfWidth) ** 2) / 12;
    for (const segment of segments) segment.setMassData(massData);
    massData.mass = tuning.hammerMass;
    massData.center.set(unit.center);
    massData.I = tuning.hammerMass * unit.I / unit.mass;
    headBody.setMassData(massData);
    for (const joint of welds) {
      joint.setFrequency(tuning.handleFrequency);
      joint.setDampingRatio(tuning.handleDamping);
    }
  };
  tune(input.tuning);
  const setHead = (outline: HammerHead, tuning: Readonly<Tuning>): void => {
    headBody.destroyFixture(head.fixture);
    head.fixture = headFixture(headBody, outline, 0, tuning);
    head.vertices = outline;
    unit = headUnitMass(outline);
    tune(tuning);
  };
  return { bodies, parts, driveBody: carriage, butt, head, welds, tune, setHead };
}

const TOOL_STRATEGIES = [
  { accepts: (tuning: Readonly<Tuning>) => tuning.handleFrequency === 0, create: rigidTool },
  { accepts: (tuning: Readonly<Tuning>) => tuning.handleFrequency > 0, create: compliantTool },
] as const;

export function createPlayerTool(input: ToolInput): PlayerTool {
  const strategy = TOOL_STRATEGIES.find((candidate) => candidate.accepts(input.tuning));
  if (!strategy) throw new PlayerRigError('Handle frequency must be nonnegative before constructing the player.');
  return { ...strategy.create(input), acceptsTuning: strategy.accepts };
}
