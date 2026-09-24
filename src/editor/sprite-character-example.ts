import { ARM_GEOMETRY } from '../arm-ik';
import { DEFAULT_ARM_FORWARD_DISTANCE, PLAYER_DEPTH } from '../character-depth';
import { ARM_SIDES } from '../character';
import type { ArmSide, VisualPartId } from '../character';
import { RIG } from '../config';
import { DEFAULT_SPRITE_RIGGING, SpriteError, validateSpriteDocument } from '../sprite-data';
import type { SpriteDocument, SpriteImage, SpriteLayer } from '../sprite-data';
import { FACING_DIRECTIONS } from '../skeleton-data';
import type { BoneDefinition, FacingDirection, SkeletonIk } from '../skeleton-data';

const PAPER = {
  ink: '#263f4a',
  cream: '#f8ebc9',
  light: '#fff8e3',
  teal: '#4c8990',
  tealDark: '#32636d',
  orange: '#df8255',
  gold: '#e9b65f',
  copper: '#bd7449',
  wood: '#c79156',
  steel: '#8fa8aa',
} as const;
const OUTLINE = 4;
const BODY_BASE_Y = 0.3;
const BODY_LENGTH = 0.54;
const TORSO_CENTER_Y = 0.56;
const HEAD_LENGTH = 0.49;
const UPPER_ARM_LENGTH = 0.9;
const FOREARM_LENGTH = 0.9;
const HAND_LENGTH = 0.18;
const ARM_END_OVERLAP = 0.08;
const ELBOW_SIZE = 0.2;
const GLOVE_SIZE = 0.25;
const ARM_BEND: Readonly<Record<ArmSide, -1 | 1>> = { left: 1, right: -1 };
const DEPTH = {
  leftArm: 0.3,
  leftElbow: 0.32,
  torso: 0.38,
  head: 0.4,
  rightArm: 0.46,
  rightElbow: 0.48,
  leftHand: 0.57,
  rightHand: 0.59,
  pot: 0.62,
} as const;
const TOOL_DEPTH_OFFSET = { shaft: 0, head: 0.02 } as const;

type ArtPoint = readonly [number, number];
interface Artwork {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly paint: (context: CanvasRenderingContext2D) => void;
}
type ExampleLayer = Pick<SpriteLayer, 'name' | 'image' | 'width' | 'height' | 'offset'> & {
  readonly anchor: VisualPartId;
  readonly bone?: string;
  readonly rotation?: number;
};

function fillPath(context: CanvasRenderingContext2D, color: string): void {
  context.fillStyle = color;
  context.strokeStyle = PAPER.ink;
  context.fill();
  context.stroke();
}

function polygon(context: CanvasRenderingContext2D, color: string, points: readonly ArtPoint[]): void {
  context.beginPath();
  context.moveTo(...points[0]);
  for (let index = 1; index < points.length; index += 1) context.lineTo(...points[index]);
  context.closePath();
  fillPath(context, color);
}

function oval(context: CanvasRenderingContext2D, color: string, x: number, y: number, rx: number, ry: number): void {
  context.beginPath();
  context.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  fillPath(context, color);
}

function roundedBox(
  context: CanvasRenderingContext2D, color: string, x: number, y: number, width: number, height: number, radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
  fillPath(context, color);
}

function line(context: CanvasRenderingContext2D, points: readonly ArtPoint[], color: string = PAPER.ink): void {
  context.beginPath();
  context.moveTo(...points[0]);
  for (let index = 1; index < points.length; index += 1) context.lineTo(...points[index]);
  context.strokeStyle = color;
  context.stroke();
}

function drawPot(context: CanvasRenderingContext2D): void {
  context.beginPath();
  context.moveTo(28, 24);
  context.lineTo(196, 24);
  context.quadraticCurveTo(220, 60, 211, 106);
  context.lineTo(194, 148);
  context.lineTo(155, 181);
  context.lineTo(69, 181);
  context.lineTo(30, 148);
  context.quadraticCurveTo(8, 94, 14, 64);
  context.closePath();
  fillPath(context, PAPER.copper);
  polygon(context, PAPER.gold, [[29, 42], [58, 49], [63, 144], [85, 176], [63, 169], [37, 139], [22, 87]]);
  roundedBox(context, PAPER.ink, 20, 16, 184, 30, 12);
  roundedBox(context, PAPER.gold, 13, 29, 198, 22, 10);
  line(context, [[30, 38], [194, 38]], PAPER.light);
  oval(context, PAPER.cream, 114, 106, 33, 31);
  polygon(context, PAPER.teal, [[90, 119], [106, 95], [116, 107], [125, 99], [138, 119]]);
  line(context, [[62, 154], [70, 162]], PAPER.cream);
  line(context, [[163, 71], [166, 86]], PAPER.gold);
}

function drawTorso(context: CanvasRenderingContext2D): void {
  polygon(context, PAPER.cream, [[60, 9], [100, 9], [104, 43], [56, 43]]);
  context.beginPath();
  context.moveTo(53, 26);
  context.lineTo(28, 36);
  context.quadraticCurveTo(15, 41, 16, 66);
  context.lineTo(29, 185);
  context.quadraticCurveTo(80, 198, 131, 185);
  context.lineTo(144, 66);
  context.quadraticCurveTo(145, 41, 132, 36);
  context.lineTo(107, 26);
  context.lineTo(80, 46);
  context.closePath();
  fillPath(context, PAPER.teal);
  polygon(context, PAPER.cream, [[52, 28], [80, 45], [69, 66], [42, 41]]);
  polygon(context, PAPER.cream, [[108, 28], [80, 45], [91, 66], [118, 41]]);
  polygon(context, PAPER.orange, [[41, 64], [52, 68], [59, 179], [46, 185]]);
  polygon(context, PAPER.orange, [[119, 64], [108, 68], [101, 179], [114, 185]]);
  line(context, [[80, 58], [80, 170]], PAPER.tealDark);
  roundedBox(context, PAPER.gold, 90, 86, 31, 26, 4);
  line(context, [[96, 96], [115, 96]]);
  oval(context, PAPER.cream, 80, 83, 3, 3);
  oval(context, PAPER.cream, 80, 125, 3, 3);
  roundedBox(context, PAPER.tealDark, 30, 165, 100, 19, 5);
}

function drawHead(context: CanvasRenderingContext2D, gaze: ArtPoint): void {
  roundedBox(context, PAPER.tealDark, 58, 128, 44, 29, 7);
  context.beginPath();
  context.moveTo(21, 86);
  context.quadraticCurveTo(16, 17, 80, 12);
  context.quadraticCurveTo(144, 17, 139, 86);
  context.lineTo(135, 122);
  context.quadraticCurveTo(80, 158, 25, 122);
  context.closePath();
  fillPath(context, PAPER.gold);
  polygon(context, PAPER.cream, [[70, 15], [90, 15], [94, 59], [66, 59]]);
  const faceX = 80 + gaze[0] * 18;
  const faceY = -gaze[1] * 12;
  const halfWidth = 50 - Math.abs(gaze[0]) * 12;
  roundedBox(context, PAPER.cream, faceX - halfWidth, 63 + faceY, halfWidth * 2, 68, 24);
  roundedBox(context, PAPER.ink, faceX - halfWidth + 8, 69 + faceY, halfWidth * 2 - 16, 34, 14);
  const eyeGap = 25 * (1 - Math.abs(gaze[0]) * 0.7);
  const eyeX = faceX + gaze[0] * 7;
  line(context, [[eyeX - eyeGap - 6, 81 + faceY], [eyeX - eyeGap + 6, 81 + faceY]], PAPER.light);
  line(context, [[eyeX + eyeGap - 6, 81 + faceY], [eyeX + eyeGap + 6, 81 + faceY]], PAPER.light);
  polygon(context, PAPER.orange, [
    [faceX - 7, 107 + faceY], [faceX + 7, 107 + faceY],
    [faceX + 12 + gaze[0] * 6, 122 + faceY], [faceX - 12 + gaze[0] * 6, 122 + faceY],
  ]);
  roundedBox(context, PAPER.tealDark, 14, 67, 18, 38, 6);
  roundedBox(context, PAPER.tealDark, 128, 67, 18, 38, 6);
  oval(context, PAPER.cream, 23, 84, 4, 4);
  oval(context, PAPER.cream, 137, 84, 4, 4);
}

function drawUpperArm(context: CanvasRenderingContext2D): void {
  roundedBox(context, PAPER.teal, 7, 13, 242, 38, 18);
  roundedBox(context, PAPER.tealDark, 13, 15, 40, 34, 14);
  polygon(context, PAPER.cream, [[190, 14], [207, 14], [213, 50], [196, 50]]);
  line(context, [[64, 25], [121, 23], [166, 27]], PAPER.cream);
  line(context, [[65, 39], [116, 41], [158, 37]], PAPER.tealDark);
}

function drawForearm(context: CanvasRenderingContext2D): void {
  roundedBox(context, PAPER.cream, 7, 15, 242, 34, 16);
  roundedBox(context, PAPER.gold, 13, 17, 32, 30, 13);
  polygon(context, PAPER.orange, [[202, 16], [231, 16], [238, 23], [238, 41], [231, 48], [202, 48]]);
  line(context, [[59, 26], [115, 25], [180, 29]], PAPER.light);
  line(context, [[77, 40], [132, 38]], PAPER.copper);
}

function drawElbow(context: CanvasRenderingContext2D): void {
  oval(context, PAPER.orange, 48, 48, 35, 35);
  oval(context, PAPER.gold, 48, 48, 22, 22);
  oval(context, PAPER.cream, 48, 48, 7, 7);
  line(context, [[23, 45], [25, 35]], PAPER.cream);
}

function drawGlove(context: CanvasRenderingContext2D): void {
  roundedBox(context, PAPER.tealDark, 8, 31, 25, 34, 6);
  context.beginPath();
  context.moveTo(29, 27);
  context.quadraticCurveTo(39, 15, 54, 19);
  context.lineTo(74, 25);
  context.quadraticCurveTo(88, 30, 85, 45);
  context.lineTo(82, 65);
  context.quadraticCurveTo(79, 79, 62, 77);
  context.lineTo(36, 73);
  context.quadraticCurveTo(23, 66, 25, 51);
  context.closePath();
  fillPath(context, PAPER.orange);
  line(context, [[44, 30], [68, 34]], PAPER.cream);
  line(context, [[54, 47], [76, 50]]);
  line(context, [[51, 58], [74, 61]]);
  context.beginPath();
  context.moveTo(30, 43);
  context.quadraticCurveTo(45, 37, 54, 48);
  context.quadraticCurveTo(57, 56, 48, 59);
  context.lineTo(33, 56);
  context.closePath();
  fillPath(context, PAPER.gold);
}

function drawShaft(context: CanvasRenderingContext2D): void {
  context.fillStyle = PAPER.wood;
  context.fillRect(0, 0, 512, 32);
  line(context, [[0, 2], [512, 2]]);
  line(context, [[0, 30], [512, 30]]);
  line(context, [[2, 2], [2, 30]]);
  line(context, [[510, 2], [510, 30]]);
  line(context, [[9, 10], [175, 9], [320, 12], [501, 10]], PAPER.cream);
  line(context, [[11, 23], [161, 24], [329, 21], [498, 23]], PAPER.copper);
  for (const x of [24, 164, 304, 468]) {
    polygon(context, PAPER.gold, [[x, 2], [x + 12, 2], [x + 16, 30], [x + 4, 30]]);
  }
}

function drawHammer(context: CanvasRenderingContext2D): void {
  polygon(context, PAPER.tealDark, [[22, 7], [58, 7], [70, 25], [70, 167], [58, 185], [22, 185], [10, 167], [10, 25]]);
  polygon(context, PAPER.steel, [[22, 7], [58, 7], [68, 26], [66, 43], [14, 43], [12, 26]]);
  polygon(context, PAPER.steel, [[14, 149], [66, 149], [68, 166], [58, 185], [22, 185], [12, 166]]);
  line(context, [[23, 21], [54, 21]], PAPER.light);
  line(context, [[23, 169], [54, 169]], PAPER.light);
  oval(context, PAPER.gold, 40, 96, 18, 18);
  line(context, [[32, 96], [48, 96]]);
  line(context, [[40, 88], [40, 104]]);
}

const ARTWORK = {
  pot: { id: 'paper-pot', name: 'Paper Climber / copper pot', width: 224, height: 192, paint: drawPot },
  torso: { id: 'paper-torso', name: 'Paper Climber / jacket', width: 160, height: 200, paint: drawTorso },
  upper: { id: 'paper-upper-arm', name: 'Paper Climber / upper sleeve', width: 256, height: 64, paint: drawUpperArm },
  forearm: { id: 'paper-forearm', name: 'Paper Climber / forearm', width: 256, height: 64, paint: drawForearm },
  elbow: { id: 'paper-elbow', name: 'Paper Climber / elbow rivet', width: 96, height: 96, paint: drawElbow },
  glove: { id: 'paper-glove', name: 'Paper Climber / glove', width: 96, height: 96, paint: drawGlove },
  shaft: { id: 'paper-shaft', name: 'Paper Climber / wooden shaft', width: 512, height: 32, paint: drawShaft },
  hammer: { id: 'paper-hammer', name: 'Paper Climber / hammer head', width: 80, height: 192, paint: drawHammer },
} as const satisfies Readonly<Record<string, Artwork>>;

const HEAD_ARTWORK: readonly (Artwork & { readonly direction: FacingDirection })[] =
  FACING_DIRECTIONS.map((direction, index) => {
    const angle = index * Math.PI * 2 / FACING_DIRECTIONS.length;
    return {
      id: `paper-head-${direction}`, name: `Paper Climber / ${direction} helmet`,
      width: 160, height: 160, direction,
      paint: (context: CanvasRenderingContext2D) => drawHead(context, [Math.cos(angle), Math.sin(angle)]),
    };
  });

function createImage(artwork: Artwork): SpriteImage {
  const canvas = document.createElement('canvas');
  canvas.width = artwork.width;
  canvas.height = artwork.height;
  try {
    const context = canvas.getContext('2d');
    if (context === null) throw new SpriteError('Canvas 2D is required to draw the complete example.');
    context.lineWidth = OUTLINE;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    artwork.paint(context);
    const source = canvas.toDataURL('image/png');
    if (!source.startsWith('data:image/png;base64,')) {
      throw new SpriteError('This browser could not encode the example artwork as PNG.');
    }
    return { id: artwork.id, name: artwork.name, source };
  } catch (error) {
    if (error instanceof DOMException) {
      throw new SpriteError('Canvas 2D could not create the example PNG artwork.', { cause: error });
    }
    throw error;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function layer(artwork: ExampleLayer): SpriteLayer {
  return {
    ...DEFAULT_SPRITE_RIGGING,
    id: `paper-${artwork.anchor}`,
    rotation: 0,
    ...artwork,
  };
}

export function createSpriteCharacterExample(): SpriteDocument {
  if (typeof document === 'undefined') throw new SpriteError('The complete example requires a browser with Canvas 2D.');
  const images = [...Object.values(ARTWORK), ...HEAD_ARTWORK].map(createImage);
  const bones: BoneDefinition[] = [
    { id: 'body', name: 'Body', parent: null, x: 0, y: BODY_BASE_Y, rotation: 90, length: BODY_LENGTH },
    { id: 'head', name: 'Helmet', parent: 'body', x: BODY_LENGTH, y: 0, rotation: 0, length: HEAD_LENGTH },
  ];
  const ik: SkeletonIk[] = [];
  const layers: SpriteLayer[] = [
    layer({
      anchor: 'pot', name: 'Paper Climber / pot', image: ARTWORK.pot.id,
      width: 1.1, height: 0.9, offset: { x: 0, y: -0.065, z: DEPTH.pot - PLAYER_DEPTH.pot },
    }),
    layer({
      anchor: 'torso', name: 'Paper Climber / jacket', image: ARTWORK.torso.id,
      bone: 'body', width: 0.62, height: 0.7, rotation: -90,
      offset: { x: TORSO_CENTER_Y - BODY_BASE_Y, y: 0, z: DEPTH.torso - PLAYER_DEPTH.torso },
    }),
  ];
  for (const artwork of HEAD_ARTWORK) {
    layers.push({
      ...layer({
        anchor: 'character-head', name: artwork.name, image: artwork.id,
        bone: 'head', width: 0.5, height: 0.5, rotation: -90,
        offset: { x: HEAD_LENGTH / 2, y: 0, z: DEPTH.head - PLAYER_DEPTH.torso },
      }),
      id: `paper-character-head-${artwork.direction}`,
      directions: [artwork.direction],
    });
  }
  for (const side of ARM_SIDES) {
    const label = side === 'left' ? 'Left' : 'Right';
    const shoulder = ARM_GEOMETRY[side].shoulder;
    const upper = `${side}-upper-arm` as const;
    const lower = `${side}-forearm` as const;
    const hand = `${side}-hand` as const;
    const armDepth = side === 'left' ? DEPTH.leftArm : DEPTH.rightArm;
    const elbowDepth = side === 'left' ? DEPTH.leftElbow : DEPTH.rightElbow;
    const handDepth = side === 'left' ? DEPTH.leftHand : DEPTH.rightHand;
    bones.push(
      // The vertical body bone maps its local +X to torso +Y; ignore the 3D shoulder's Z.
      { id: upper, name: `${label} upper arm`, parent: 'body', x: shoulder[1] - BODY_BASE_Y, y: -shoulder[0],
        rotation: side === 'left' ? 90 : -90, length: UPPER_ARM_LENGTH },
      { id: lower, name: `${label} forearm`, parent: upper, x: UPPER_ARM_LENGTH, y: 0, rotation: 0, length: FOREARM_LENGTH },
      { id: hand, name: `${label} glove`, parent: lower, x: FOREARM_LENGTH, y: 0, rotation: 0, length: HAND_LENGTH },
    );
    ik.push({
      id: `${side}-grip-ik`, upper, lower, hand, target: `${side}-grip`,
      bend: ARM_BEND[side], mix: 1, offsetX: 0, offsetY: 0, handRotation: 0,
    });
    layers.push(
      layer({
        anchor: upper, name: `Paper Climber / ${label} upper arm`, image: ARTWORK.upper.id, bone: upper,
        width: UPPER_ARM_LENGTH + ARM_END_OVERLAP, height: 0.22,
        offset: { x: UPPER_ARM_LENGTH / 2, y: 0, z: armDepth - PLAYER_DEPTH.torso },
      }),
      layer({
        anchor: lower, name: `Paper Climber / ${label} forearm`, image: ARTWORK.forearm.id, bone: lower,
        width: FOREARM_LENGTH + ARM_END_OVERLAP, height: 0.19,
        offset: { x: FOREARM_LENGTH / 2, y: 0, z: armDepth - PLAYER_DEPTH.torso },
      }),
      layer({
        anchor: `${side}-elbow`, name: `Paper Climber / ${label} elbow`, image: ARTWORK.elbow.id, bone: lower,
        width: ELBOW_SIZE, height: ELBOW_SIZE, offset: { x: 0, y: 0, z: elbowDepth - PLAYER_DEPTH.torso },
      }),
      layer({
        anchor: hand, name: `Paper Climber / ${label} glove`, image: ARTWORK.glove.id, bone: hand,
        width: GLOVE_SIZE, height: GLOVE_SIZE, offset: { x: 0, y: 0, z: handDepth - PLAYER_DEPTH.torso },
      }),
    );
  }
  layers.push(
    layer({
      anchor: 'hammer-shaft', name: 'Paper Climber / shaft', image: ARTWORK.shaft.id,
      width: RIG.handleLength, height: RIG.handleHalfWidth * 2,
      offset: { x: 0, y: 0, z: TOOL_DEPTH_OFFSET.shaft },
    }),
    layer({
      anchor: 'hammer-head', name: 'Paper Climber / hammer head', image: ARTWORK.hammer.id,
      width: 0.24, height: 0.64, offset: { x: 0, y: 0, z: TOOL_DEPTH_OFFSET.head },
    }),
  );
  return validateSpriteDocument({
    schemaVersion: 6, characterRiggingType: 'sprite-2d', armForwardDistance: DEFAULT_ARM_FORWARD_DISTANCE,
    images, layers, presentation: null,
    skeleton: { anchor: 'torso', bones, poses: [], clips: [], animation: null, ik, hair: [], colliders: [] },
  });
}
