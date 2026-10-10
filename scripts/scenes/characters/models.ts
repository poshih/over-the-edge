// The example characters: a hollow soldier with sword and shield, a hollow archer with a bow, and a carrion crow, each a
// low-poly figure of boxes with the clips its species plays. Ground figures move by root motion: their hips travel along
// +Z as far as their feet carry them, solved per frame so a planted foot never slides. They stand 1.4 m tall, the
// crow 0.8 m across its raised wings and talons, the heights the engine fits each species to.
import { box, DEGREE, keys, mirror, rotation, smooth, strut, taper } from './rig.ts';
import type { Clip, Joint, JointPose, Part, Rig, Vec3 } from './rig.ts';

type Side = 'Left' | 'Right';
type MutablePose = Record<string, JointPose>;

// The humanoid: hips 0.7 m up, legs of two 0.3 m bones over a 0.07 m ankle, arms of 0.24 and 0.22 m.
const HIPS = 0.7;
const HIP_DROP = 0.03;
const THIGH = 0.3;
const SHIN = 0.3;
const ANKLE = 0.07;
const SIDES: readonly Side[] = ['Left', 'Right'];

const HUMANOID_JOINTS: readonly Joint[] = [
  { name: 'Hips', parent: null, at: [0, HIPS, 0] },
  { name: 'Spine', parent: 'Hips', at: [0, 0.8, 0] },
  { name: 'Chest', parent: 'Spine', at: [0, 0.98, 0] },
  { name: 'Head', parent: 'Chest', at: [0, 1.18, 0] },
  ...SIDES.flatMap((side): Joint[] => {
    const x = side === 'Left' ? 1 : -1;
    return [
      { name: `${side}UpperArm`, parent: 'Chest', at: [0.2 * x, 1.12, 0] },
      { name: `${side}Forearm`, parent: `${side}UpperArm`, at: [0.2 * x, 0.88, 0] },
      { name: `${side}Hand`, parent: `${side}Forearm`, at: [0.2 * x, 0.66, 0] },
      { name: `${side}Thigh`, parent: 'Hips', at: [0.09 * x, HIPS - HIP_DROP, 0] },
      { name: `${side}Shin`, parent: `${side}Thigh`, at: [0.09 * x, HIPS - HIP_DROP - THIGH, 0] },
      { name: `${side}Foot`, parent: `${side}Shin`, at: [0.09 * x, ANKLE, 0] },
    ];
  }),
];

interface BodyColors {
  readonly pelvis: number;
  readonly belly: number;
  readonly chest: number;
  readonly neck: number;
  readonly sleeve: number;
  readonly forearm: number;
  readonly hand: number;
  readonly thigh: number;
  readonly shin: number;
  readonly foot: number;
}

// The body every humanoid shares, from its soles at 0 to its shoulders; each figure adds its own head and gear.
function humanoidBody(colors: BodyColors): Part[] {
  const left = [
    taper('LeftUpperArm', colors.sleeve, [0.155, 0.89, -0.045], [0.245, 1.14, 0.045], [1.15, 1.15]),
    taper('LeftForearm', colors.forearm, [0.165, 0.67, -0.04], [0.235, 0.89, 0.04], [1.1, 1.1]),
    box('LeftHand', colors.hand, [0.17, 0.585, -0.035], [0.23, 0.67, 0.045]),
    taper('LeftThigh', colors.thigh, [0.035, 0.37, -0.06], [0.145, 0.68, 0.06], [1.1, 1.1]),
    taper('LeftShin', colors.shin, [0.045, 0.075, -0.05], [0.135, 0.37, 0.05], [1.1, 1.1]),
    box('LeftFoot', colors.foot, [0.045, 0, -0.06], [0.135, 0.075, 0.16]),
  ];
  return [
    taper('Hips', colors.pelvis, [-0.13, 0.62, -0.09], [0.13, 0.8, 0.09], [0.95, 0.95]),
    taper('Spine', colors.belly, [-0.12, 0.8, -0.085], [0.12, 0.98, 0.085], [1.1, 1.1]),
    taper('Chest', colors.chest, [-0.15, 0.98, -0.1], [0.15, 1.16, 0.1], [1.2, 1]),
    box('Head', colors.neck, [-0.04, 1.15, -0.04], [0.04, 1.21, 0.04]),
    ...left,
    ...left.map((part) => mirror(part, part.joint.replace('Left', 'Right'))),
  ];
}

// The leg angles, in degrees about X, that put the ankle `forward` metres ahead of the thigh joint and `height` above
// the ground while the thigh joint is `hip` above it, the knee bending forward and the foot flat.
function legAngles(hip: number, forward: number, height: number): { thigh: number; shin: number; foot: number } {
  const down = hip - height;
  const reach = Math.min(Math.max(Math.hypot(forward, down), Math.abs(THIGH - SHIN) + 1e-6), THIGH + SHIN - 1e-6);
  const line = Math.atan2(forward, down);
  const atHip = Math.acos((THIGH * THIGH + reach * reach - SHIN * SHIN) / (2 * THIGH * reach));
  const atAnkle = Math.acos((SHIN * SHIN + reach * reach - THIGH * THIGH) / (2 * SHIN * reach));
  return { thigh: -(line + atHip) / DEGREE, shin: (atHip + atAnkle) / DEGREE, foot: (line - atAnkle) / DEGREE };
}

interface Foot {
  // Where the ankle is ahead of the hips, in metres, and how high it is lifted.
  readonly forward: number;
  readonly lift: number;
}

// A standing humanoid's hips and legs: the hips `height` up and `travel` along the facing, each foot placed by IK.
function stand(pose: MutablePose, height: number, travel: number, left: Foot, right: Foot): void {
  pose.Hips = { rotation: rotation(0), offset: [0, height - HIPS, travel] };
  for (const [side, foot] of [['Left', left], ['Right', right]] as const) {
    const angles = legAngles(height - HIP_DROP, foot.forward, ANKLE + foot.lift);
    pose[`${side}Thigh`] = { rotation: rotation(angles.thigh) };
    pose[`${side}Shin`] = { rotation: rotation(angles.shin) };
    pose[`${side}Foot`] = { rotation: rotation(angles.foot) };
  }
}

// How an arm is held: swung `forward` and `out` from hanging, the elbow bent forward, and the hand pitched (positive
// back), in degrees.
interface Arm {
  readonly forward: number;
  readonly elbow: number;
  readonly out: number;
  readonly hand: number;
}

function arm(pose: MutablePose, side: Side, held: Arm): void {
  pose[`${side}UpperArm`] = { rotation: rotation(-held.forward, 0, side === 'Left' ? held.out : -held.out) };
  pose[`${side}Forearm`] = { rotation: rotation(-held.elbow) };
  pose[`${side}Hand`] = { rotation: rotation(held.hand) };
}

function mix(a: Arm, b: Arm, amount: number): Arm {
  const at = (from: number, to: number): number => from + (to - from) * amount;
  return { forward: at(a.forward, b.forward), elbow: at(a.elbow, b.elbow), out: at(a.out, b.out), hand: at(a.hand, b.hand) };
}

function shift(held: Arm, change: Partial<Arm>): Arm {
  return {
    forward: held.forward + (change.forward ?? 0), elbow: held.elbow + (change.elbow ?? 0),
    out: held.out + (change.out ?? 0), hand: held.hand + (change.hand ?? 0),
  };
}

// How a figure carries its gear: each arm's resting hold, and how far it swings as the figure walks.
interface Carry {
  readonly left: Arm;
  readonly right: Arm;
  readonly swing: readonly [number, number];
}

function blank(joints: readonly Joint[]): MutablePose {
  return Object.fromEntries(joints.map((joint) => [joint.name, { rotation: rotation(0) }]));
}

// A walk of two 0.4 m steps a second: each foot stands for half the cycle while the hips pass over it, then swings
// ahead in the other half, lifted 7 cm. The hips ride highest over the standing foot.
function walk(carry: Carry): Clip {
  const duration = 1;
  const stride = 0.8;
  const step = stride / 2;
  const top = 0.655;
  const dip = (top - 0.6304) / (step / 2) ** 2;
  const foot = (phase: number): Foot => {
    if (phase < 0.5) return { forward: step / 2 - step * (phase / 0.5), lift: 0 };
    const swing = (phase - 0.5) / 0.5;
    return { forward: -step / 2 + 2 * step * smooth(swing) - step * swing, lift: 0.07 * Math.sin(Math.PI * swing) };
  };
  return {
    name: 'Walk', duration,
    pose: (time) => {
      const cycle = time / duration;
      const phase = cycle - Math.floor(cycle);
      const left = foot(phase);
      const right = foot((phase + 0.5) % 1);
      const standing = phase < 0.5 ? left.forward : right.forward;
      const pose = blank(HUMANOID_JOINTS);
      stand(pose, top - dip * standing * standing + HIP_DROP, stride * cycle, left, right);
      // Positive while the left foot is ahead: the right arm and shoulder swing forward with it.
      const swing = Math.cos(2 * Math.PI * phase);
      pose.Spine = { rotation: rotation(4) };
      pose.Chest = { rotation: rotation(2, 5 * swing) };
      pose.Head = { rotation: rotation(-3 - 2 * Math.cos(4 * Math.PI * phase), -4 * swing) };
      arm(pose, 'Left', shift(carry.left, { forward: -carry.swing[0] * swing }));
      arm(pose, 'Right', shift(carry.right, { forward: carry.swing[1] * swing }));
      return pose;
    },
  };
}

// Standing guard, breathing, glancing about.
function idle(carry: Carry): Clip {
  const duration = 2.4;
  return {
    name: 'Idle', duration,
    pose: (time) => {
      const breath = Math.sin(2 * Math.PI * time / duration);
      const pose = blank(HUMANOID_JOINTS);
      stand(pose, 0.692 + 0.004 * breath, 0, { forward: 0.03, lift: 0 }, { forward: -0.03, lift: 0 });
      pose.Spine = { rotation: rotation(2 + 1.2 * breath) };
      pose.Chest = { rotation: rotation(breath) };
      pose.Head = { rotation: rotation(-breath, 7 * Math.sin(2 * Math.PI * time / duration + 1)) };
      arm(pose, 'Left', shift(carry.left, { forward: 2 * breath }));
      arm(pose, 'Right', shift(carry.right, { forward: -2 * breath }));
      return pose;
    },
  };
}

// Struck: thrown back 6 cm within the hurt's 0.18 s, the feet planted, then gathering itself.
function hurt(carry: Carry): Clip {
  const back = keys([[0, 0], [0.16, -0.06]]);
  const jolt = keys([[0, 0], [0.08, 1], [0.35, 0.35]]);
  return {
    name: 'Hurt', duration: 0.35,
    pose: (time) => {
      const travel = back(time);
      const shock = jolt(time);
      const pose = blank(HUMANOID_JOINTS);
      stand(pose, 0.685 - 0.015 * shock, travel, { forward: 0.03 - travel, lift: 0 }, { forward: -0.03 - travel, lift: 0 });
      pose.Spine = { rotation: rotation(-14 * shock) };
      pose.Chest = { rotation: rotation(-6 * shock) };
      pose.Head = { rotation: rotation(-20 * shock) };
      arm(pose, 'Left', shift(carry.left, { forward: -30 * shock, elbow: 10 * shock, out: 18 * shock }));
      arm(pose, 'Right', shift(carry.right, { forward: -30 * shock, elbow: 10 * shock, out: 18 * shock }));
      return pose;
    },
  };
}

// Defeated: staggers back, falls on its back 0.55 m behind where it stood, and lies still until the corpse goes.
function death(carry: Carry): Clip {
  const stagger = keys([[0, 0], [0.25, -0.12]]);
  const lying: Arm = { forward: -10, elbow: 15, out: 75, hand: 0 };
  return {
    name: 'Death', duration: 2,
    pose: (time) => {
      const reel = smooth(time / 0.25);
      const fall = smooth((time - 0.25) / 0.75);
      const travel = stagger(time) - 0.43 * fall;
      const height = 0.685 + (0.12 - 0.685) * fall;
      const pose = blank(HUMANOID_JOINTS);
      // The legs stand on planted feet while it reels, then follow the hips down.
      stand(pose, height, travel, { forward: 0.03 - stagger(time), lift: 0 }, { forward: -0.03 - stagger(time), lift: 0 });
      pose.Hips = { rotation: rotation(-85 * fall), offset: [0, height - HIPS, travel] };
      for (const side of SIDES) {
        for (const [bone, rest] of [['Thigh', 6], ['Shin', 4], ['Foot', -10]] as const) {
          const standing = pose[`${side}${bone}`]!.rotation!;
          // The planted angle, read back from its quaternion: X rotations only.
          const angle = 2 * Math.atan2(standing[0], standing[3]) / DEGREE;
          pose[`${side}${bone}`] = { rotation: rotation(angle + (rest - angle) * fall) };
        }
      }
      pose.Spine = { rotation: rotation(-12 * reel * (1 - fall) + 4 * fall) };
      pose.Chest = { rotation: rotation(-6 * reel * (1 - fall)) };
      pose.Head = { rotation: rotation(-25 * reel * (1 - fall) + 15 * fall) };
      for (const side of SIDES) {
        const held = side === 'Left' ? carry.left : carry.right;
        arm(pose, side, mix(shift(held, { forward: 35 * reel, out: 20 * reel }), lying, fall));
      }
      return pose;
    },
  };
}

// A soldier's pause after a bump: it recoils half a step, its front foot planted, and raises its shield.
function soldierRecover(carry: Carry): Clip {
  const back = keys([[0, 0], [0.3, -0.12]]);
  const rear = keys([[0, 0], [0.3, -0.22]]);
  const lean = keys([[0, 0], [0.15, -9], [0.45, -4], [0.7, 0]]);
  const sink = keys([[0, 0], [0.2, -0.02], [0.7, -0.01]]);
  const guard = keys([[0, 0], [0.25, 1], [0.7, 0.4]]);
  return {
    name: 'Recover', duration: 0.7,
    pose: (time) => {
      const travel = back(time);
      const pose = blank(HUMANOID_JOINTS);
      stand(pose, 0.685 + sink(time), travel, { forward: -travel, lift: 0 },
        { forward: rear(time) - travel, lift: 0.05 * Math.sin(Math.PI * Math.min(time / 0.3, 1)) });
      pose.Spine = { rotation: rotation(lean(time)) };
      const raised = guard(time);
      arm(pose, 'Left', shift(carry.left, { forward: 15 * raised, elbow: 20 * raised }));
      arm(pose, 'Right', shift(carry.right, { forward: -18 * raised, out: 10 * raised }));
      return pose;
    },
  };
}

// An archer's draw: it turns its bow side forward, raises the bow and pulls the string to its cheek, then holds.
function archerDraw(carry: Carry): Clip {
  const bow: Arm = { forward: 88, elbow: 5, out: 8, hand: 85 };
  const string: Arm = { forward: 70, elbow: 125, out: 25, hand: 0 };
  return {
    name: 'Draw', duration: 0.8,
    pose: (time) => {
      const raised = smooth(time / 0.35);
      const pose = blank(HUMANOID_JOINTS);
      stand(pose, 0.68, 0, { forward: 0.08, lift: 0 }, { forward: -0.08, lift: 0 });
      pose.Spine = { rotation: rotation(2) };
      pose.Chest = { rotation: rotation(0, -20 * raised) };
      pose.Head = { rotation: rotation(-3, 16 * raised) };
      arm(pose, 'Left', mix(carry.left, bow, raised));
      arm(pose, 'Right', mix(carry.right, string, smooth((time - 0.1) / 0.35)));
      return pose;
    },
  };
}

// An archer's reload: it lowers the bow, reaches over its shoulder into the quiver and brings an arrow to the string.
function archerReload(carry: Carry): Clip {
  const bowForward = keys([[0, 80], [0.4, 25], [1.6, carry.left.forward]]);
  const bowHand = keys([[0, 80], [0.4, 20], [1.6, carry.left.hand]]);
  const reach = keys([[0, 60], [0.5, 150], [1.1, 60], [1.6, carry.right.forward]]);
  const bend = keys([[0, 110], [0.5, 100], [1.1, 60], [1.6, carry.right.elbow]]);
  return {
    name: 'Reload', duration: 1.6,
    pose: (time) => {
      const pose = blank(HUMANOID_JOINTS);
      stand(pose, 0.688, 0, { forward: 0.05, lift: 0 }, { forward: -0.05, lift: 0 });
      pose.Spine = { rotation: rotation(3) };
      pose.Head = { rotation: rotation(-2, -10 * Math.sin(Math.PI * Math.min(time / 1.1, 1))) };
      arm(pose, 'Left', { ...carry.left, forward: bowForward(time), hand: bowHand(time) });
      arm(pose, 'Right', { ...carry.right, forward: reach(time), elbow: bend(time), out: carry.right.out + 15 * Math.sin(Math.PI * Math.min(time / 1.1, 1)) });
      return pose;
    },
  };
}

const SOLDIER_CARRY: Carry = {
  left: { forward: 18, elbow: 75, out: 12, hand: 0 },
  right: { forward: 12, elbow: 25, out: 8, hand: -35 },
  swing: [6, 14],
};

const ARCHER_CARRY: Carry = {
  left: { forward: 10, elbow: 18, out: 6, hand: 0 },
  right: { forward: 4, elbow: 15, out: 6, hand: 0 },
  swing: [8, 18],
};

/** A hollow soldier in a rusted helm and mail, with a sword and a round shield. */
export function hollowSoldier(): Rig {
  const steel = 0x8a929c;
  const dark = 0x5a616b;
  const mail = 0x4b5058;
  const parts = [
    ...humanoidBody({
      pelvis: 0x4a3424, belly: mail, chest: steel, neck: mail, sleeve: mail, forearm: dark, hand: dark, thigh: mail, shin: dark, foot: 0x2f2620,
    }),
    taper('Head', steel, [-0.1, 1.21, -0.11], [0.1, 1.4, 0.11], [0.85, 0.9]),
    box('Head', 0x1a1a1e, [-0.075, 1.285, 0.105], [0.075, 1.305, 0.118]),
    box('Head', 0xff8a3c, [-0.06, 1.29, 0.112], [-0.025, 1.3, 0.121]),
    box('Head', 0xff8a3c, [0.025, 1.29, 0.112], [0.06, 1.3, 0.121]),
    box('LeftUpperArm', steel, [0.15, 1.06, -0.075], [0.275, 1.16, 0.075]),
    box('RightUpperArm', steel, [-0.275, 1.06, -0.075], [-0.15, 1.16, 0.075]),
    box('Hips', 0x6e2626, [-0.1, 0.5, 0.085], [0.1, 0.8, 0.105]),
    box('Hips', 0x6e2626, [-0.1, 0.52, -0.105], [0.1, 0.8, -0.085]),
    // The sword hangs from the right fist, its blade down.
    box('RightHand', 0x4a3424, [-0.214, 0.565, -0.016], [-0.186, 0.7, 0.016]),
    box('RightHand', 0xb08a3e, [-0.222, 0.545, -0.08], [-0.178, 0.565, 0.08]),
    box('RightHand', 0xd0d6de, [-0.211, 0.15, -0.032], [-0.189, 0.545, 0.032]),
    box('RightHand', 0xd0d6de, [-0.208, 0.1, -0.018], [-0.192, 0.15, 0.018]),
    // The shield rides the left forearm, facing out.
    box('LeftForearm', 0x5d4330, [0.236, 0.6, -0.15], [0.26, 0.97, 0.15]),
    box('LeftForearm', steel, [0.26, 0.74, -0.04], [0.276, 0.83, 0.04]),
  ];
  return {
    name: 'Hollow soldier', joints: HUMANOID_JOINTS, parts, metallic: 0.35, roughness: 0.6,
    clips: [idle(SOLDIER_CARRY), walk(SOLDIER_CARRY), soldierRecover(SOLDIER_CARRY), hurt(SOLDIER_CARRY), death(SOLDIER_CARRY)],
  };
}

/** A hollow archer in a green hood and cloak, with a bow and a quiver on its back. */
export function hollowArcher(): Rig {
  const tunic = 0x55603a;
  const leather = 0x5b4129;
  const face = 0xb8a891;
  const boot = 0x3a2a1f;
  const wood = 0x6b4a2a;
  const parts = [
    ...humanoidBody({
      pelvis: leather, belly: tunic, chest: tunic, neck: face, sleeve: tunic, forearm: leather, hand: face, thigh: 0x3f3a2e, shin: boot, foot: boot,
    }),
    taper('Head', 0x2e4632, [-0.105, 1.2, -0.12], [0.105, 1.4, 0.1], [0.7, 0.8]),
    box('Head', face, [-0.07, 1.225, 0.095], [0.07, 1.33, 0.11]),
    box('Head', 0xffb070, [-0.055, 1.285, 0.108], [-0.02, 1.3, 0.116]),
    box('Head', 0xffb070, [0.02, 1.285, 0.108], [0.055, 1.3, 0.116]),
    box('Chest', 0x263a2a, [-0.15, 0.62, -0.135], [0.15, 1.15, -0.105]),
    box('Chest', 0x4f3a28, [-0.11, 0.95, -0.17], [-0.03, 1.26, -0.13]),
    box('Chest', 0xe8e2d0, [-0.1, 1.26, -0.165], [-0.04, 1.33, -0.135]),
    // The bow stands in the left fist, its string behind it, ready to raise.
    box('LeftHand', wood, [0.19, 0.58, 0.03], [0.21, 0.67, 0.05]),
    box('LeftHand', wood, [0.19, 0.67, 0.03], [0.21, 0.86, 0.05]),
    box('LeftHand', wood, [0.192, 0.86, 0.005], [0.208, 1.01, 0.03]),
    box('LeftHand', wood, [0.19, 0.39, 0.03], [0.21, 0.58, 0.05]),
    box('LeftHand', wood, [0.192, 0.24, 0.005], [0.208, 0.39, 0.03]),
    box('LeftHand', 0xd9d2c3, [0.198, 0.25, -0.004], [0.202, 1, 0]),
  ];
  return {
    name: 'Hollow archer', joints: HUMANOID_JOINTS, parts, metallic: 0.05, roughness: 0.85,
    clips: [idle(ARCHER_CARRY), walk(ARCHER_CARRY), archerDraw(ARCHER_CARRY), archerReload(ARCHER_CARRY), hurt(ARCHER_CARRY), death(ARCHER_CARRY)],
  };
}

// The crow: wings raised 40 degrees in the bind pose, its talons hanging as far below its body's middle as the wing tips
// rise above it, so the engine centres it on its body.
const WING_RAISE = 40;
const WING: readonly [number, number] = [Math.cos(WING_RAISE * DEGREE), Math.sin(WING_RAISE * DEGREE)];
const WING_ROOT: Vec3 = [0.07, 0.05, 0.02];
const WING_LENGTH = 0.27;
const WING_TIP: Vec3 = [WING_ROOT[0] + WING[0] * WING_LENGTH, WING_ROOT[1] + WING[1] * WING_LENGTH, WING_ROOT[2]];

const CROW_JOINTS: readonly Joint[] = [
  { name: 'Body', parent: null, at: [0, 0, 0] },
  { name: 'Head', parent: 'Body', at: [0, 0.04, 0.16] },
  { name: 'Tail', parent: 'Body', at: [0, 0.01, -0.17] },
  { name: 'LeftWing', parent: 'Body', at: WING_ROOT },
  { name: 'LeftWingTip', parent: 'LeftWing', at: WING_TIP },
  { name: 'RightWing', parent: 'Body', at: [-WING_ROOT[0], WING_ROOT[1], WING_ROOT[2]] },
  { name: 'RightWingTip', parent: 'RightWing', at: [-WING_TIP[0], WING_TIP[1], WING_TIP[2]] },
  { name: 'LeftLeg', parent: 'Body', at: [0.045, -0.08, 0.03] },
  { name: 'RightLeg', parent: 'Body', at: [-0.045, -0.08, 0.03] },
];

// Each wing's elevation above level, sweep back and tip bend, in degrees.
function wings(pose: MutablePose, elevation: number, sweep = 0, tip = 0): void {
  pose.LeftWing = { rotation: rotation(0, sweep, elevation - WING_RAISE) };
  pose.RightWing = { rotation: rotation(0, -sweep, WING_RAISE - elevation) };
  pose.LeftWingTip = { rotation: rotation(0, 0, tip) };
  pose.RightWingTip = { rotation: rotation(0, 0, -tip) };
}

// Wings beating `per` seconds a stroke around `level`, `depth` up and down, the body lifting on each downstroke.
function flap(pose: MutablePose, time: number, per: number, level: number, depth: number, pitch: number, legs: number): void {
  const angle = 2 * Math.PI * time / per;
  wings(pose, level + depth * Math.cos(angle), 0, 18 * Math.sin(angle));
  pose.Body = { rotation: rotation(pitch), offset: [0, 0.025 * Math.sin(angle), 0] };
  pose.LeftLeg = { rotation: rotation(legs) };
  pose.RightLeg = { rotation: rotation(legs) };
  pose.Tail = { rotation: rotation(-4 * Math.sin(angle)) };
}

function looping(name: string, strokes: number, per: number, level: number, depth: number, pitch: number, legs: number): Clip {
  return { name, duration: strokes * per, pose: (time) => { const pose = blank(CROW_JOINTS); flap(pose, time, per, level, depth, pitch, legs); return pose; } };
}

/** A carrion crow with spread wings and red eyes. */
export function carrionCrow(): Rig {
  const body = 0x22222b;
  const feathers = 0x2d2d39;
  const tips = 0x4a4a5c;
  const talons = 0x8a7a4a;
  const leftWing = strut('LeftWing', feathers, WING_ROOT, WING, WING_LENGTH, [-0.12, 0.1], 0.03, 0.9);
  const leftTip = strut('LeftWingTip', tips, WING_TIP, WING, 0.25, [-0.14, 0.05], 0.022, 0.55);
  const parts = [
    taper('Body', body, [-0.085, -0.09, -0.19], [0.085, 0.09, 0.17], [0.8, 0.9]),
    taper('Head', body, [-0.06, 0, 0.13], [0.06, 0.14, 0.27], [0.8, 0.85]),
    box('Head', 0xc9a227, [-0.022, 0.035, 0.27], [0.022, 0.075, 0.37]),
    box('Head', 0xff5a3c, [0.058, 0.085, 0.215], [0.066, 0.105, 0.235]),
    box('Head', 0xff5a3c, [-0.066, 0.085, 0.215], [-0.058, 0.105, 0.235]),
    box('Tail', feathers, [-0.07, -0.015, -0.37], [0.07, 0.025, -0.16]),
    leftWing, leftTip, mirror(leftWing, 'RightWing'), mirror(leftTip, 'RightWingTip'),
    box('LeftLeg', talons, [0.035, -0.33, 0.02], [0.055, -0.08, 0.04]),
    box('RightLeg', talons, [-0.055, -0.33, 0.02], [-0.035, -0.08, 0.04]),
  ];
  const top = Math.max(...parts.flatMap((part) => part.corners.map((corner) => corner[1])));
  parts.push(
    box('LeftLeg', talons, [0.02, -top, -0.01], [0.07, -0.33, 0.07]),
    box('RightLeg', talons, [-0.07, -top, -0.01], [-0.02, -0.33, 0.07]),
  );
  const charge = (time: number): number => smooth(time / 0.2);
  return {
    name: 'Carrion crow', joints: CROW_JOINTS, parts, metallic: 0, roughness: 0.75,
    clips: [
      // Hovering on its patrol, and flying it.
      looping('Idle', 2, 0.6, 20, 35, 0, 25),
      looping('Fly', 2, 0.36, 15, 45, 8, 60),
      {
        // Before a dive: wings flung up and back, head down at its mark, talons out.
        name: 'Charge', duration: 0.5,
        pose: (time) => {
          const raised = charge(time);
          const pose = blank(CROW_JOINTS);
          wings(pose, 20 + 60 * raised, 20 * raised, 10 * raised + 6 * Math.sin(40 * time));
          pose.Body = { rotation: rotation(-18 * raised), offset: [0, 0.03 * raised, 0] };
          pose.Head = { rotation: rotation(25 * raised) };
          pose.LeftLeg = { rotation: rotation(-45 * raised) };
          pose.RightLeg = { rotation: rotation(-45 * raised) };
          return pose;
        },
      },
      {
        // The dive: wings folded back, beak down, talons reaching.
        name: 'Dive', duration: 1,
        pose: (time) => {
          const folded = smooth(time / 0.25);
          const pose = blank(CROW_JOINTS);
          wings(pose, 70 - 60 * folded, 70 * folded, -10 * folded);
          pose.Body = { rotation: rotation(25 * folded) };
          pose.LeftLeg = { rotation: rotation(-70 * folded) };
          pose.RightLeg = { rotation: rotation(-70 * folded) };
          pose.Tail = { rotation: rotation(-15 * folded) };
          return pose;
        },
      },
      // Beating hard back up to its post.
      looping('Recover', 4, 0.4, 20, 50, -5, 40),
      {
        // Struck: thrown back, wings flaring.
        name: 'Hit', duration: 0.3,
        pose: (time) => {
          const shock = keys([[0, 0], [0.07, 1], [0.3, 0.2]])(time);
          const pose = blank(CROW_JOINTS);
          wings(pose, 20 + 55 * shock, -15 * shock, 20 * shock);
          pose.Body = { rotation: rotation(-30 * shock, 0, 15 * shock) };
          pose.Head = { rotation: rotation(-20 * shock) };
          pose.Tail = { rotation: rotation(20 * shock) };
          return pose;
        },
      },
      {
        // Killed: it tumbles over and drops, wings limp.
        name: 'Death', duration: 1,
        pose: (time) => {
          const fall = smooth(time / 0.6);
          const pose = blank(CROW_JOINTS);
          wings(pose, 30 - 80 * fall, 10 * fall, -30 * fall);
          pose.Body = { rotation: rotation(30 * fall, 0, 160 * fall), offset: [0, -0.3 * fall, 0] };
          pose.Head = { rotation: rotation(30 * fall) };
          pose.LeftLeg = { rotation: rotation(-90 * fall) };
          pose.RightLeg = { rotation: rotation(-90 * fall) };
          return pose;
        },
      },
    ],
  };
}

// The clip each role of a species plays, by the names these figures give their clips.
export const SOLDIER_CLIPS = { idle: 'Idle', walk: 'Walk', recover: 'Recover', hurt: 'Hurt', death: 'Death' } as const;
export const ARCHER_CLIPS = { idle: 'Idle', walk: 'Walk', windup: 'Draw', recover: 'Reload', hurt: 'Hurt', death: 'Death' } as const;
export const CROW_CLIPS = { idle: 'Idle', walk: 'Fly', windup: 'Charge', dive: 'Dive', recover: 'Recover', hurt: 'Hit', death: 'Death' } as const;
