// Editor-only library of multi-object set pieces. Every part is an ordinary level object built
// from the built-in shapes, authored relative to the piece's base (y = 0). Placing a piece only
// translates (and optionally mirrors) its parts, so the level format, runtime and game-only build
// are unchanged and pieces never add geometry templates beyond the built-in shapes.
import type { Point } from '../config';
import { ENEMY_SPECS, enemyBounds } from '../enemy-types';
import type { EnemyFacing, EnemySpecies } from '../enemy-types';
import {
  objectVertices, ROCK_COLOR, TRIGGER_LIMITS, triggerBounds, validateLevelMetadata, validateLevelObject,
} from '../level';
import type { EnemyObject, LevelLabel, LevelObject, ShapeKind, TerrainObject, TriggerObject } from '../level';
import { ENDING_EVENTS } from '../trigger-events';

export type TerrainPart = Omit<TerrainObject, 'id'>;
export type TriggerPart = Omit<TriggerObject, 'id'>;
export type EnemyPart = Omit<EnemyObject, 'id'>;
export interface LabelPart extends LevelLabel { readonly kind: 'label' }
export type SetPiecePart = TerrainPart | TriggerPart | EnemyPart | LabelPart;
export interface SetPieceBounds { readonly left: number; readonly right: number; readonly bottom: number; readonly top: number }
export interface SetPieceCounts { readonly terrain: number; readonly triggers: number; readonly enemies: number; readonly labels: number }

export const SET_PIECE_CATEGORIES = [
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'vertical', label: 'Vertical climbs' },
  { id: 'gaps', label: 'Gaps & leaps' },
  { id: 'balance', label: 'Balance' },
  { id: 'technique', label: 'Hammer technique' },
  { id: 'descent', label: 'Descents' },
  { id: 'surfaces', label: 'Surfaces' },
  { id: 'forces', label: 'Updrafts' },
  { id: 'enemies', label: 'Enemies' },
  { id: 'route', label: 'Route tricks' },
  { id: 'stakes', label: 'Stakes & finish' },
] as const;
export type SetPieceCategory = (typeof SET_PIECE_CATEGORIES)[number]['id'];

export interface SetPiece {
  readonly id: string;
  readonly category: SetPieceCategory;
  readonly name: string;
  /** The distinct player skill this piece tests. */
  readonly skill: string;
  readonly parts: readonly SetPiecePart[];
  readonly counts: SetPieceCounts;
  /** Local extent of every part, including trigger regions, enemies and labels. */
  readonly bounds: SetPieceBounds;
}

export interface SetPiecePlacement {
  readonly objects: readonly LevelObject[];
  readonly labels: readonly LevelLabel[];
}

/** World size of a course label sprite; see the view's label renderer. */
export const LABEL_SIZE = { width: 2.25, height: 0.42 } as const;
const CHECK_ID = 'set-piece-check';
const DEPTH = 1.5;
const COLOR = {
  rock: ROCK_COLOR, stone: 0x8a8f86, slate: 0x5d6b68, wood: 0x9a7660, crate: 0x7f5f4b, bark: 0x6e5540,
  leaf: 0x5f7f4b, metal: 0x707a80, rust: 0xb0643a, concrete: 0xa6a59b, snake: 0x6f8f3c, brick: 0x8c5a48,
  roof: 0x7a4a3c, ivory: 0xcfc6ad, canvas: 0xb44a3c,
} as const;

interface Style { readonly color?: number; readonly depth?: number; readonly illusion?: boolean }

function shape(type: ShapeKind, x: number, y: number, width: number, height: number, angle: number, style: Style): TerrainPart {
  return {
    kind: 'terrain', shape: { type }, x, y, width, height, angle,
    depth: style.depth ?? DEPTH, color: style.color ?? COLOR.rock, illusion: style.illusion ?? false,
  };
}
const block = (left: number, bottom: number, width: number, height: number, style: Style = {}) =>
  shape('box', left + width / 2, bottom + height / 2, width, height, 0, style);
/** Right triangle rising to the right: its vertical side is on the right. */
const rampUp = (left: number, bottom: number, width: number, height: number, style: Style = {}) =>
  shape('ramp', left + width / 2, bottom + height / 2, width, height, 0, style);
const peak = (left: number, bottom: number, width: number, height: number, style: Style = {}) =>
  shape('triangle', left + width / 2, bottom + height / 2, width, height, 0, style);
const ball = (centerX: number, bottom: number, diameter: number, style: Style = {}) =>
  shape('circle', centerX, bottom + diameter / 2, diameter, diameter, 0, style);
const hex = (centerX: number, bottom: number, width: number, height: number, style: Style = {}) =>
  shape('hexagon', centerX, bottom + height / 2, width, height, 0, style);

/** A rotated box whose underside runs from (x1, y1) to (x2, y2); its thickness extends upward. */
function plank(x1: number, y1: number, x2: number, y2: number, thickness: number, style: Style = {}): TerrainPart {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const flip = x2 < x1 || (x2 === x1 && y2 < y1) ? -1 : 1;
  const ux = (x2 - x1) / length * flip;
  const uy = (y2 - y1) / length * flip;
  return shape('box', (x1 + x2) / 2 - uy * thickness / 2, (y1 + y2) / 2 + ux * thickness / 2,
    length, thickness, Math.atan2(uy, ux), style);
}

function vent(centerX: number, bottom: number, lift: number, width = 2, height = 1.4): TriggerPart {
  return {
    kind: 'trigger', name: 'Updraft', x: centerX, y: bottom + height / 2, region: { type: 'box', width, height },
    activation: 'on-enter', marker: 'updraft', events: [{ type: 'launch-player', height: lift, strength: 1 }],
  };
}

function goal(centerX: number, bottom: number, width: number): TriggerPart {
  const height = TRIGGER_LIMITS.endingHeight;
  return {
    kind: 'trigger', name: 'Ending', x: centerX, y: bottom + height / 2, region: { type: 'box', width, height },
    activation: 'once', marker: 'flag', events: ENDING_EVENTS,
  };
}

function note(x: number, y: number, radius: number, title: string, message: string, marker: TriggerPart['marker'] = 'none'): TriggerPart {
  return {
    kind: 'trigger', name: title, x, y, region: { type: 'circle', radius },
    activation: 'once', marker, events: [{ type: 'popup', title, message }],
  };
}

function enemy(species: EnemySpecies, x: number, base: number, facing: EnemyFacing, patrolDistance: number, speed: number): EnemyPart {
  return { kind: 'enemy', species, x, y: base + ENEMY_SPECS[species].height / 2, facing, patrolDistance, speed };
}
const bird = (x: number, base: number, facing: EnemyFacing, patrol: number = ENEMY_SPECS.bird.patrolDistance,
  speed: number = ENEMY_SPECS.bird.speed) => enemy('bird', x, base, facing, patrol, speed);
const soldier = (x: number, base: number, facing: EnemyFacing, patrol: number = ENEMY_SPECS['hollow-soldier'].patrolDistance,
  speed: number = ENEMY_SPECS['hollow-soldier'].speed) => enemy('hollow-soldier', x, base, facing, patrol, speed);
const sign = (x: number, y: number, text: string): LabelPart => ({ kind: 'label', x, y, text });

interface Draft { readonly id: string; readonly category: SetPieceCategory; readonly name: string; readonly skill: string; readonly parts: readonly SetPiecePart[] }

// Distances follow the rig: the shoulder sits about 1.15 m above the pot's base and a lip within about
// 2.5 m of it can be pulled over; the pot slides on slopes steeper than about 49 degrees.
const DRAFTS: readonly Draft[] = [
  {
    id: 'first-boulder', category: 'onboarding', name: 'First boulder',
    skill: 'Hook the lip of an undercut boulder and pull the pot up and over: the first move every climber learns.',
    parts: [hex(0, 0, 3.4, 1.8), hex(0.3, 1.8, 1.4, 0.8)],
  },
  {
    id: 'rising-steps', category: 'onboarding', name: 'Rising steps',
    skill: 'Three knee-high ledges to practise hook, pull and settle before anything is at stake.',
    parts: [block(0, 0, 2, 0.9, { color: COLOR.slate }), block(2, 0, 2, 1.8), block(4, 0, 2, 2.7, { color: COLOR.stone })],
  },
  {
    id: 'the-tree', category: 'onboarding', name: 'The tree',
    skill: 'Climb from branch to branch: thin limbs take the hammer easily but barely hold the pot.',
    parts: [
      block(-0.35, 0, 0.7, 5.2, { color: COLOR.bark }),
      plank(0, 2.1, -2.3, 2.5, 0.3, { color: COLOR.bark, depth: 1 }),
      plank(0, 3.3, 2.4, 3.8, 0.3, { color: COLOR.bark, depth: 1 }),
      plank(0, 4.4, -2, 4.8, 0.3, { color: COLOR.bark, depth: 1 }),
      hex(0, 5.2, 3.6, 2.4, { color: COLOR.leaf, depth: 2 }),
    ],
  },
  {
    id: 'leaning-plank', category: 'onboarding', name: 'Leaning plank',
    skill: 'Walk the pot up a narrow board propped on a boulder, or skip it by hooking the boulder itself.',
    parts: [block(-3.2, 0, 2, 1.5), plank(2.8, 0, -2.3236, 1.9213, 0.25, { color: COLOR.wood, depth: 1 })],
  },
  {
    id: 'hut-roof', category: 'onboarding', name: 'Hut and roof',
    skill: 'Blank walls, then overhanging eaves: reach out and over the eave, then balance on the pitched roof.',
    parts: [block(0, 0, 3.2, 2, { color: COLOR.wood }), peak(-0.6, 2, 4.4, 2.4, { color: COLOR.roof })],
  },
  {
    id: 'barrel-and-bucket', category: 'onboarding', name: 'Barrel and bucket',
    skill: 'A round barrel that sheds the pot and a narrow bucket to climb out of: curves and cramped spaces.',
    parts: [
      ball(0, 0, 1.6, { color: COLOR.wood }),
      block(1.6, 0, 0.25, 2.6, { color: COLOR.metal }), block(1.85, 0, 1.3, 0.25, { color: COLOR.metal }),
      block(3.15, 0, 0.25, 2.6, { color: COLOR.metal }),
    ],
  },
  {
    id: 'tutorial-note', category: 'onboarding', name: 'Tutorial note',
    skill: 'A small rock with a one-time popup: explain the next obstacle. Edit the message after placing.',
    parts: [
      hex(0, 0, 1.6, 0.9, { color: COLOR.stone }),
      note(0, 2.1, 1.2, 'Keep climbing', 'Swing the hammer over the rock, hook it and pull. Edit this message in Trigger events.'),
    ],
  },
  {
    id: 'ledge-ladder', category: 'vertical', name: 'Ledge ladder',
    skill: 'Hop up a sheer wall between small ledges that only just fit the pot.',
    parts: [
      block(0, 0, 2.4, 8.5),
      block(-0.9, 1.9, 0.9, 0.3, { color: COLOR.stone }), block(-0.9, 4, 0.9, 0.3, { color: COLOR.stone }),
      block(-0.9, 6.1, 0.9, 0.3, { color: COLOR.stone }),
    ],
  },
  {
    id: 'max-reach-wall', category: 'vertical', name: 'Full-reach wall',
    skill: 'Two lips at the very edge of the hammer reach: fully extend and pull with perfect timing.',
    parts: [block(0, 0, 4, 3.5), block(1.6, 3.5, 2.4, 3.5, { color: COLOR.stone })],
  },
  {
    id: 'overhang', category: 'vertical', name: 'Overhang roof',
    skill: 'A roof juts out above the ledge: swing out from underneath, hook its outer lip and pull over.',
    parts: [block(0, 0, 3.2, 3), block(2, 3, 1.2, 3.6), block(-1, 5, 3, 0.8, { color: COLOR.slate })],
  },
  {
    id: 'devils-chimney', category: 'vertical', name: "Devil's chimney",
    skill: 'Enter under the arch and climb a body-wide shaft by wedging, pushing off walls and hooking lamps.',
    parts: [
      block(0, 2.2, 1.2, 7.8), block(3.6, 0, 1.2, 8.5),
      block(1.2, 3.6, 0.5, 0.25, { color: COLOR.metal, depth: 0.6 }), block(1.45, 3.3, 0.25, 0.3, { color: COLOR.metal, depth: 0.6 }),
      block(3.1, 6.4, 0.5, 0.25, { color: COLOR.metal, depth: 0.6 }), block(3.1, 6.1, 0.25, 0.3, { color: COLOR.metal, depth: 0.6 }),
    ],
  },
  {
    id: 'mantle-shelf', category: 'vertical', name: 'Mantle shelf',
    skill: 'Land the pot on a thin shelf, then reach around the bulge that blocks the straight pull above.',
    parts: [block(0, 0, 2.4, 6), block(-1.1, 2.65, 1.1, 0.25, { color: COLOR.stone }), block(-0.8, 4, 0.8, 1)],
  },
  {
    id: 'orange-hell', category: 'vertical', name: 'Orange hell',
    skill: 'A 72 degree slope the pot cannot stand on: hammer-walk up it using three tiny holds.',
    parts: [
      rampUp(0, 0, 3, 9, { color: COLOR.rust }), block(3, 0, 1.5, 9, { color: COLOR.rust }),
      ...[2.6, 5, 7.2].map((top) => block(top / 3 - 0.5, top - 0.25, 0.5, 0.25, { color: COLOR.rust })),
    ],
  },
  {
    id: 'crate-tower', category: 'vertical', name: 'Crate tower',
    skill: 'Chain short pulls up a stack of offset crates, each one overhanging the last.',
    parts: [0, 0.5, -0.1, 0.6, 0].map((left, index) =>
      block(left, index * 1.4, 1.6, 1.4, { color: index % 2 === 0 ? COLOR.wood : COLOR.crate, depth: 1.6 })),
  },
  {
    id: 'zigzag-shaft', category: 'vertical', name: 'Zigzag shaft',
    skill: 'Enter under the arch and climb a narrow shaft by alternating tiny ledges on opposite walls.',
    parts: [
      block(0, 2.2, 1, 6.8), block(4.2, 0, 1, 9),
      block(3.2, 2.1, 1, 0.3, { color: COLOR.stone }), block(1, 4.2, 1, 0.3, { color: COLOR.stone }),
      block(3.2, 6.3, 1, 0.3, { color: COLOR.stone }),
    ],
  },
  {
    id: 'stepping-stones', category: 'gaps', name: 'Stepping stones',
    skill: 'Hop across narrow pillars without stopping to rebalance; a slip drops you to the floor.',
    parts: [
      block(-6.2, 0, 2, 2), block(-3.1, 0, 1, 2, { color: COLOR.stone }), block(-0.5, 0, 1, 2.3, { color: COLOR.stone }),
      block(2.1, 0, 1, 2, { color: COLOR.stone }), block(4.2, 0, 2, 2),
    ],
  },
  {
    id: 'chasm-leap', category: 'gaps', name: 'Chasm leap',
    skill: 'A 4.4 m gap between cliffs: build momentum, fling the pot and hook the higher far lip.',
    parts: [block(0, 0, 4, 5), block(8.4, 0, 4, 5.3, { color: COLOR.slate })],
  },
  {
    id: 'pole-vault', category: 'gaps', name: 'Pole vault',
    skill: 'Plant the hammer head on a post in the middle of the gap and vault across.',
    parts: [block(0, 0, 3, 2.5), block(4.475, 0, 0.25, 1.9, { color: COLOR.metal, depth: 0.5 }), block(6.2, 0, 3, 3)],
  },
  {
    id: 'catch-wall', category: 'gaps', name: 'Catch wall',
    skill: 'Fling into a tall wall and catch the narrow landing below it before sliding off.',
    parts: [block(0, 0, 3, 3), block(7, 0, 1.4, 2.4), block(8.4, 0, 1.2, 5.8, { color: COLOR.concrete })],
  },
  {
    id: 'ceiling-traverse', category: 'gaps', name: 'Ceiling traverse',
    skill: 'Cross a wide gap by hooking stalactites under a low roof and swinging hand over hand.',
    parts: [
      block(-5.4, 0, 2.8, 3), block(2.6, 0, 2.8, 3), block(-3.2, 5.2, 6.4, 3, { color: COLOR.slate }),
      ...[-1.3, 0, 1.3].map((x) => block(x - 0.15, 4.6, 0.3, 0.6, { color: COLOR.slate })),
    ],
  },
  {
    id: 'grill-to-house', category: 'gaps', name: 'Grill, umbrella and house',
    skill: 'Backyard hops: from the grill to the umbrella canopy, then over the gable onto the house roof.',
    parts: [
      block(0, 0, 0.25, 1.1, { color: COLOR.metal, depth: 0.8 }), block(1.35, 0, 0.25, 1.1, { color: COLOR.metal, depth: 0.8 }),
      block(-0.1, 1.1, 1.8, 0.6, { color: COLOR.metal, depth: 0.8 }),
      block(2.9, 0, 0.25, 2.6, { color: COLOR.metal, depth: 0.5 }), peak(1.775, 2.6, 2.5, 0.6, { color: COLOR.canvas, depth: 1.2 }),
      block(4.6, 0, 4, 3.2, { color: COLOR.brick }), peak(4.2, 3.2, 4.8, 1.8, { color: COLOR.roof }),
    ],
  },
  {
    id: 'fridge-fling', category: 'gaps', name: 'Fridge fling',
    skill: 'From the top of a narrow fridge, fling the pot up to a ledge beyond hammer reach.',
    parts: [
      block(0, 0, 1, 2.2, { color: COLOR.ivory, depth: 1 }), block(5, 0, 0.8, 2.9),
      block(4.4, 2.9, 2.6, 0.5, { color: COLOR.stone }),
    ],
  },
  {
    id: 'crumbling-bridge', category: 'gaps', name: 'Crumbling bridge',
    skill: 'Illusion planks fade 0.8 s after the pot lands: keep moving across without stopping.',
    parts: [
      block(0, 0, 2.4, 3), block(10.6, 0, 2.4, 3),
      ...[0, 1, 2, 3].map((index) => block(2.6 + index * 2, 2.6, 1.8, 0.4, { color: COLOR.wood, depth: 1.2, illusion: true })),
    ],
  },
  {
    id: 'floating-rock', category: 'gaps', name: 'Floating rock',
    skill: 'Nothing to stand on in the gap: hook a floating boulder and swing to the far bank.',
    parts: [block(0, 0, 2.2, 1.4), hex(4.7, 3, 2.4, 1.4, { color: COLOR.stone }), block(7.2, 0, 2.2, 1.4)],
  },
  {
    id: 'needle-pillars', category: 'balance', name: 'Needle pillars',
    skill: 'Perch the pot on rising pillars barely wider than its base.',
    parts: [0, 1, 2].map((index) => block(index * 2.2, 0, 0.6, 2.6 + index * 0.8, { color: COLOR.stone })),
  },
  {
    id: 'knife-edge', category: 'balance', name: 'Knife-edge ridge',
    skill: 'Traverse steep, sharp peaks where any lean slides the pot into the next notch.',
    parts: [block(0, 0, 12, 2), peak(0.75, 2, 3.5, 2.2), peak(4.25, 2, 3.5, 2.6), peak(7.75, 2, 3.5, 2.2)],
  },
  {
    id: 'perched-boulder', category: 'balance', name: 'Perched boulder',
    skill: 'Climb the undercut of a wide boulder balanced on a thin pedestal, then settle on top.',
    parts: [block(-0.4, 0, 0.8, 1.6, { color: COLOR.stone }), hex(0, 1.6, 3.6, 2.2)],
  },
  {
    id: 'dome', category: 'balance', name: 'The dome',
    skill: 'A rounded summit with no flat spot: keep the pot centred or roll off either side.',
    parts: [block(0, 0, 4, 2), ball(2, 0, 4)],
  },
  {
    id: 'ball-stack', category: 'balance', name: 'Ball stack',
    skill: 'Round surfaces reject the pot: hook the seams between stacked balls to climb.',
    parts: [ball(0, 0, 2.4, { color: COLOR.stone }), ball(0, 2.4, 1.8, { color: COLOR.stone }), ball(0, 4.2, 1.2, { color: COLOR.stone })],
  },
  {
    id: 'tilted-slab', category: 'balance', name: 'Tilted slab',
    skill: 'Walk up a 40 degree slab from its low end without sliding off the unsupported high end.',
    parts: [block(-0.3, 0, 0.6, 2.4, { color: COLOR.stone }), plank(-3.1603, 0, 2.202, 4.4995, 0.4)],
  },
  {
    id: 'pogo-pit', category: 'technique', name: 'Pogo pit',
    skill: 'Cross a pit whose floor is too deep to pull out of: fall in and you must pogo off the floor.',
    parts: [
      block(-2.4, 0, 1.2, 1.4, { color: COLOR.stone }), block(-1.2, 0, 1.2, 2.8, { color: COLOR.stone }),
      block(0, 0, 1.2, 4.2), block(1.2, 0, 2, 0.4), block(3.2, 0, 1.2, 4.2),
    ],
  },
  {
    id: 'hook-swing', category: 'technique', name: 'Hook swing',
    skill: 'Hook a crossbar above the gap and swing across like a pendulum.',
    parts: [
      block(0, 0, 2.2, 3), block(4.275, 0, 0.25, 5, { color: COLOR.metal, depth: 0.5 }),
      block(3.7, 5, 1.4, 0.25, { color: COLOR.metal, depth: 0.5 }), block(6.6, 0, 2.2, 3),
    ],
  },
  {
    id: 'notch-wall', category: 'technique', name: 'Notch wall',
    skill: 'A blank wall with small slots: jam the hammer head into each notch to climb.',
    parts: [
      block(0.35, 0, 1.15, 8.5),
      ...[[0, 2], [2.35, 1.95], [4.65, 1.95], [6.95, 1.55]].map(([bottom, height]) => block(0, bottom, 0.35, height)),
    ],
  },
  {
    id: 'pogo-posts', category: 'technique', name: 'Pogo posts',
    skill: 'Posts too thin for the pot: cross by planting the hammer on their tops.',
    parts: [
      block(0, 0, 2, 2),
      ...[2.4, 2.8, 2.4].map((height, index) => block(3.075 + index * 1.6, 0, 0.25, height, { color: COLOR.metal, depth: 0.5 })),
      block(7.6, 0, 2, 2.4),
    ],
  },
  {
    id: 'crawlspace', category: 'technique', name: 'Crawlspace',
    skill: 'A tunnel too low to swing in: drag the pot along with the hammer pressed on floor and roof.',
    parts: [block(0, 1.3, 6, 3, { color: COLOR.slate }), block(2.6, 0, 0.8, 0.4, { color: COLOR.stone })],
  },
  {
    id: 'kicker-ramp', category: 'technique', name: 'Kicker ramp',
    skill: 'Carry speed up a short ramp and launch off its lip onto a higher block.',
    parts: [rampUp(0, 0, 3, 1.6, { color: COLOR.stone }), block(6.2, 0, 3, 3.2)],
  },
  {
    id: 'box-descent', category: 'descent', name: 'Box descent',
    skill: 'Down-climb stepped crates under control; a fall skips several steps at once. Mirror it to climb.',
    parts: [7, 5.3, 3.8, 2].map((height, index) =>
      block(index * 1.6, 0, 1.6, height, { color: index % 2 === 0 ? COLOR.wood : COLOR.crate, depth: 1.6 })),
  },
  {
    id: 'drop-shaft', category: 'descent', name: 'Drop shaft',
    skill: 'Drop into a shaft, brake on the walls and catch the ledge by the side window, or fall to the bottom.',
    parts: [
      block(0, 0, 1.2, 8), block(3.6, 0, 1.2, 4.3), block(3.6, 5.8, 1.2, 2.2),
      block(1.2, 3.7, 0.9, 0.3, { color: COLOR.stone }),
    ],
  },
  {
    id: 'the-snake', category: 'descent', name: 'The snake',
    skill: 'A long body steeper than the pot can grip: step onto it and it slides you all the way down.',
    parts: [
      block(-5.6, 0, 2.4, 8), hex(-3.4, 8, 1.4, 1, { color: COLOR.snake }),
      plank(-3.2, 8, 0, 4.3, 0.6, { color: COLOR.snake }), plank(0, 4.3, 3.4, 0, 0.6, { color: COLOR.snake }),
      sign(-3.4, 9.9, 'DO NOT RIDE SNAKE'),
    ],
  },
  {
    id: 'ledge-drop', category: 'descent', name: 'Ledge drop',
    skill: 'Lower yourself off a high ledge onto a narrow column instead of falling to the bottom.',
    parts: [block(0, 0, 2.5, 8), block(5, 0, 1.4, 4, { color: COLOR.stone })],
  },
  {
    id: 'friction-slab', category: 'surfaces', name: 'Friction slab',
    skill: 'A long 45 degree slab at the edge of the pot grip: keep moving or slide back.',
    parts: [rampUp(0, 0, 6, 6, { color: COLOR.slate }), block(6, 0, 1.5, 6, { color: COLOR.slate })],
  },
  {
    id: 'boulder-field', category: 'surfaces', name: 'Boulder field',
    skill: 'Uneven rounded rocks of every size: no two steps are the same and gaps trap the pot.',
    parts: [ball(0, 0, 1.6), hex(1.9, 0, 2, 1.2), ball(3.5, 0, 2.2), hex(5.3, 0, 1.6, 1), ball(6.7, 0, 1.4), ball(8.1, 0, 1.8)],
  },
  {
    id: 'spire', category: 'surfaces', name: 'The spire',
    skill: 'A pointed spire too steep to stand on: climb small side knobs to its tip.',
    parts: [
      peak(0, 0, 3.2, 9),
      block(-0.2089, 1.9, 0.8, 0.3), block(2.2533, 3.9, 0.8, 0.3), block(0.5022, 5.9, 0.8, 0.3), block(1.5778, 7.7, 0.8, 0.3),
    ],
  },
  {
    id: 'scree-slope', category: 'surfaces', name: 'Scree slope',
    skill: 'A 35 degree slope littered with rubble that trips the pot and deflects the hammer.',
    parts: [
      rampUp(0, 0, 8, 5.6, { color: COLOR.slate }), block(8, 0, 1.5, 5.6, { color: COLOR.slate }),
      ball(1.5, 0.85, 0.5, { color: COLOR.slate }), hex(3.2, 2, 0.9, 0.55, { color: COLOR.slate }),
      ball(4.8, 3.1, 0.6, { color: COLOR.slate }), hex(6.4, 4.25, 1, 0.6, { color: COLOR.slate }),
    ],
  },
  {
    id: 'crumbling-holds', category: 'surfaces', name: 'Crumbling holds',
    skill: 'Two tempting holds are illusions that fade once the pot lands: remember the real ones.',
    parts: [
      block(0, 0, 2.2, 9),
      ...[2.2, 3.4, 4.4, 5.6, 6.6].map((top, index) =>
        block(-0.9, top - 0.3, 0.9, 0.3, { color: COLOR.stone, illusion: index % 2 === 1 })),
    ],
  },
  {
    id: 'updraft-cliff', category: 'forces', name: 'Updraft cliff',
    skill: 'Ride a vent up the face of a sheer cliff and steer the pot onto its top.',
    parts: [block(0.2, 0, 2, 0.25, { color: COLOR.metal }), vent(1.2, 0.25, 9.5), block(2.4, 0, 3, 8.4)],
  },
  {
    id: 'launch-pad', category: 'forces', name: 'Launch pad',
    skill: 'A vent launches straight up: carry sideways momentum into it to land on a distant ledge.',
    parts: [
      block(0, 0, 2.4, 1, { color: COLOR.stone }), vent(1.2, 1, 6), block(6, 0, 1.2, 5.6),
      block(5.2, 5.6, 2.8, 0.4, { color: COLOR.stone }),
    ],
  },
  {
    id: 'vent-ladder', category: 'forces', name: 'Vent ladder',
    skill: 'Chain two vents, drifting onto each higher ledge before the next launch.',
    parts: [
      block(0.2, 0, 2, 0.25, { color: COLOR.metal }), vent(1.2, 0.25, 5),
      block(2.6, 0, 2.2, 3.2), vent(3.7, 3.2, 5, 1.6), block(5.4, 0, 2.2, 6.4),
    ],
  },
  {
    id: 'bird-ledge', category: 'enemies', name: 'Bird ledge',
    skill: 'A bird guards the ledge you need: strike it with the hammer head before it dives.',
    parts: [block(0, 0, 2.2, 1.6), block(3.6, 0, 1.4, 3.8, { color: COLOR.stone }), bird(2.9, 4.4, 'left', 1.5, 1.2)],
  },
  {
    id: 'guarded-landing', category: 'enemies', name: 'Guarded landing',
    skill: 'A hollow soldier patrols the landing: time your arrival or knock it off with two strikes.',
    parts: [block(0, 0, 2, 1.8, { color: COLOR.stone }), block(2, 0, 5, 3.4), soldier(4.5, 3.4, 'left', 1.8)],
  },
  {
    id: 'bird-gauntlet', category: 'enemies', name: 'Bird gauntlet',
    skill: 'Cross a long bridge while three birds take turns diving at you.',
    parts: [
      block(0, 0, 2, 3), block(2, 2.6, 8, 0.4, { color: COLOR.wood, depth: 1.2 }), block(10, 0, 2, 3),
      bird(4, 4.6, 'right', 1.5), bird(6.5, 5, 'left', 2), bird(9, 4.6, 'right', 1.5),
    ],
  },
  {
    id: 'updraft-ambush', category: 'enemies', name: 'Updraft ambush',
    skill: 'A bird waits at the top of the updraft: fight it mid-launch or get knocked back down.',
    parts: [
      block(0.2, 0, 2, 0.25, { color: COLOR.metal }), vent(1.2, 0.25, 8), block(2.4, 0, 3, 7.2),
      bird(1.2, 6.8, 'right', 1, 1),
    ],
  },
  {
    id: 'the-fork', category: 'route', name: 'The fork',
    skill: 'A choice: drop into the valley and climb the steps, or gamble on a leap off the pole.',
    parts: [
      block(0, 0, 2.4, 3), block(4.6, 0, 0.25, 2.6, { color: COLOR.metal, depth: 0.5 }),
      block(6, 0, 1.2, 1.4, { color: COLOR.stone }), block(7.2, 0, 1.2, 2.8, { color: COLOR.stone }), block(8.4, 0, 2.4, 4.2),
    ],
  },
  {
    id: 'false-floor', category: 'route', name: 'False floor',
    skill: 'Solid-looking ground over a deep pit is an illusion: it fades under the pot. Learn the way around.',
    parts: [
      block(-2.4, 0, 1.2, 1.4, { color: COLOR.stone }), block(-1.2, 0, 1.2, 2.8, { color: COLOR.stone }),
      block(0, 0, 1.2, 4.2), block(1.2, 3.8, 3.2, 0.4, { illusion: true }), block(4.4, 0, 1.2, 4.2),
    ],
  },
  {
    id: 'false-summit', category: 'route', name: 'False summit',
    skill: 'A flag that is not the end: a popup breaks the news and the real climb continues behind it.',
    parts: [
      block(0, 0, 4, 2.4), block(1, 2.4, 2, 0.8),
      note(2, 4.2, 1.2, 'False summit', 'Not the top yet. The real climb continues.', 'flag'),
      block(4, 0, 1.6, 6.8, { color: COLOR.stone }),
    ],
  },
  {
    id: 'danger-sign', category: 'stakes', name: 'Danger sign',
    skill: 'A thin lip over a long drop, marked with a warning so players feel the stakes.',
    parts: [block(0, 0, 3.6, 6), block(3.6, 5.6, 1.2, 0.4, { color: COLOR.stone }), sign(1.8, 7, 'DANGER: LONG FALL')],
  },
  {
    id: 'long-fall', category: 'stakes', name: 'Long fall',
    skill: 'Traverse a thin shelf 12 m up: any slip is a full fall. Place it after a big climb.',
    parts: [block(0, 0, 2, 12), block(2, 11.6, 5, 0.4, { color: COLOR.stone })],
  },
  {
    id: 'dead-end-tower', category: 'stakes', name: 'Dead-end tower',
    skill: 'A tempting tower that leads nowhere; a note at the top tells the climber to turn back.',
    parts: [
      block(0, 0, 1.6, 8, { color: COLOR.metal }), block(-0.8, 6.6, 3.2, 0.3, { color: COLOR.metal }),
      block(-0.5, 2, 0.5, 0.25, { color: COLOR.metal }), block(-0.5, 4.2, 0.5, 0.25, { color: COLOR.metal }),
      note(0.8, 9.2, 1.2, 'Dead end', 'Nice view. Nothing else up here: climb back down.'),
    ],
  },
  {
    id: 'summit', category: 'stakes', name: 'Summit',
    skill: 'The finish: a plinth under an ending trigger that stops the timer and shows the summit popup.',
    parts: [block(0, 0, 4, 1.2, { color: COLOR.stone }), block(0.6, 1.2, 2.8, 0.4, { color: COLOR.stone }), goal(2, 1.6, 2.6)],
  },
];

const tidy = (value: number, digits = 4): number => Number(value.toFixed(digits)) + 0;

function tidyAngle(angle: number): number {
  const wrapped = angle < -Math.PI ? angle + Math.PI * 2 : angle > Math.PI ? angle - Math.PI * 2 : angle;
  return Math.max(-Math.PI, Math.min(Math.PI, tidy(wrapped, 6)));
}

function partBounds(part: SetPiecePart): SetPieceBounds {
  if (part.kind === 'terrain') {
    const vertices = objectVertices({ ...part, id: CHECK_ID });
    const xs = vertices.map((point) => point.x);
    const ys = vertices.map((point) => point.y);
    return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
  }
  if (part.kind === 'label') {
    return {
      left: part.x - LABEL_SIZE.width / 2, right: part.x + LABEL_SIZE.width / 2,
      bottom: part.y - LABEL_SIZE.height / 2, top: part.y + LABEL_SIZE.height / 2,
    };
  }
  const region = part.kind === 'trigger' ? triggerBounds({ ...part, id: CHECK_ID }) : enemyBounds(part);
  return { left: region.minX, right: region.maxX, bottom: region.minY, top: region.maxY };
}

function union(bounds: readonly SetPieceBounds[]): SetPieceBounds {
  return {
    left: Math.min(...bounds.map((bound) => bound.left)), right: Math.max(...bounds.map((bound) => bound.right)),
    bottom: Math.min(...bounds.map((bound) => bound.bottom)), top: Math.max(...bounds.map((bound) => bound.top)),
  };
}

function shiftPart(part: SetPiecePart, dx: number): SetPiecePart {
  const x = tidy(part.x + dx);
  const y = tidy(part.y);
  switch (part.kind) {
    case 'terrain':
      return { ...part, x, y, width: tidy(part.width), height: tidy(part.height), angle: tidyAngle(part.angle) };
    case 'trigger':
      return {
        ...part, x, y, region: part.region.type === 'circle'
          ? { type: 'circle', radius: tidy(part.region.radius) }
          : { type: 'box', width: tidy(part.region.width), height: tidy(part.region.height) },
      };
    default:
      return { ...part, x, y };
  }
}

/** Mirrors a part about the piece's vertical axis (x = 0). */
export function mirrorPart(part: SetPiecePart): SetPiecePart {
  const x = -part.x + 0;
  if (part.kind === 'terrain') {
    // A mirrored ramp is the same right triangle turned a quarter turn with its sides swapped.
    return part.shape.type === 'ramp'
      ? { ...part, x, width: part.height, height: part.width, angle: tidyAngle(-part.angle - Math.PI / 2) }
      : { ...part, x, angle: tidyAngle(-part.angle) };
  }
  if (part.kind === 'enemy') return { ...part, x, facing: part.facing === 'left' ? 'right' : 'left' };
  return { ...part, x };
}

function mirrorBounds(bounds: SetPieceBounds): SetPieceBounds {
  return { ...bounds, left: -bounds.right, right: -bounds.left };
}

function finishPiece(draft: Draft): SetPiece {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.id) || draft.id.length > 32) {
    throw new Error(`Set piece ID "${draft.id}" must be lowercase words joined by hyphens, up to 32 characters.`);
  }
  const terrain = draft.parts.filter((part) => part.kind === 'terrain');
  if (terrain.length === 0) throw new Error(`Set piece "${draft.id}" needs at least one terrain part.`);
  const footprint = union(terrain.map(partBounds));
  const parts = draft.parts.map((part) => shiftPart(part, -(footprint.left + footprint.right) / 2));
  const labels: LevelLabel[] = [];
  for (const part of parts) {
    if (part.kind === 'label') labels.push({ x: part.x, y: part.y, text: part.text });
    else validateLevelObject({ ...part, id: CHECK_ID });
    if (part.kind !== 'label' && partBounds(part).bottom < -1e-6) {
      throw new Error(`Set piece "${draft.id}" has a part below its base.`);
    }
  }
  validateLevelMetadata({ labels });
  const count = (kind: SetPiecePart['kind']) => parts.filter((part) => part.kind === kind).length;
  return Object.freeze({
    id: draft.id, category: draft.category, name: draft.name, skill: draft.skill,
    parts: Object.freeze(parts.map((part) => Object.freeze(part))),
    counts: Object.freeze({ terrain: count('terrain'), triggers: count('trigger'), enemies: count('enemy'), labels: count('label') }),
    bounds: Object.freeze(union(parts.map(partBounds))),
  });
}

export const SET_PIECES: readonly SetPiece[] = Object.freeze(DRAFTS.map(finishPiece));
const PIECES_BY_ID = new Map(SET_PIECES.map((piece) => [piece.id, piece]));
if (PIECES_BY_ID.size !== SET_PIECES.length) throw new Error('Set piece IDs must be unique.');

/** Compact, serializable summary for diagnostics and verification. */
export const SET_PIECE_CATALOG = Object.freeze(SET_PIECES.map((piece) =>
  Object.freeze({ id: piece.id, category: piece.category, name: piece.name, counts: piece.counts })));

export function setPieceById(id: string): SetPiece {
  const piece = PIECES_BY_ID.get(id);
  if (piece === undefined) throw new Error(`Unknown set piece "${id}".`);
  return piece;
}

export function setPieceParts(piece: SetPiece, mirror: boolean): readonly SetPiecePart[] {
  return mirror ? piece.parts.map(mirrorPart) : piece.parts;
}

export function setPieceBounds(piece: SetPiece, mirror: boolean): SetPieceBounds {
  return mirror ? mirrorBounds(piece.bounds) : piece.bounds;
}

/**
 * Converts a piece into validated level objects and labels with its base at `anchor`.
 * `stamp` makes the generated IDs (`<piece>-<stamp>-<part>`) unique per placement.
 */
export function placeSetPiece(piece: SetPiece, anchor: Point, options: { readonly mirror: boolean; readonly stamp: string }): SetPiecePlacement {
  const objects: LevelObject[] = [];
  const labels: LevelLabel[] = [];
  setPieceParts(piece, options.mirror).forEach((part, index) => {
    const x = tidy(anchor.x + part.x);
    const y = tidy(anchor.y + part.y);
    if (part.kind === 'label') labels.push(Object.freeze({ x, y, text: part.text }));
    else objects.push(validateLevelObject({ ...part, id: `${piece.id}-${options.stamp}-${index}`, x, y }));
  });
  return { objects, labels };
}
