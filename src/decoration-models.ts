import { ModelKit, pointedArc, roundArc } from './decoration-geometry';
import type { DecorationGeometry, Vec3 } from './decoration-geometry';
import type { Point } from './config';
import { decorationAsset } from './decoration-art';
import type { DecorationArt } from './decoration-art';
import type { LevelDefinition } from './level';

// The built-in placeholder decorations: original, low-poly models in a dark-fantasy mood, to block
// out a level's atmosphere until a game supplies its own meshes under the same IDs.

export const DECORATION_CATEGORIES = [
  { id: 'ruins', label: 'Ruins' },
  { id: 'wilds', label: 'Wilds' },
  { id: 'relics', label: 'Relics' },
  { id: 'fire', label: 'Fire & light' },
] as const;
export type DecorationCategory = (typeof DECORATION_CATEGORIES)[number]['id'];

/** A built-in model. `height` and `z` place it where it reads well when first dropped. */
export interface DecorationModel {
  readonly id: string;
  readonly name: string;
  readonly category: DecorationCategory;
  readonly description: string;
  readonly height: number;
  readonly z: number;
  readonly build: (kit: ModelKit) => void;
}

const STONE = 0x8d877b;
const STONE_DARK = 0x5f5a52;
const STONE_LIGHT = 0xaba594;
const MOSS = 0x55603f;
const SHADOW = 0x1c1a19;
const IRON = 0x3b3b40;
const IRON_LIGHT = 0x767a80;
const WOOD = 0x5a4330;
const WOOD_DARK = 0x3f2f24;
const BARK = 0x3d332b;
const BONE = 0xd9cfb6;
const CLOTH = 0x6a2226;
const GOLD = 0xb8903e;
const SLATE = 0x33384a;
const ROCK = 0x625d57;
const ROCK_DARK = 0x46454b;
const SNOW = 0xdfe3e8;
const ASH = 0x3a3634;
const DIRT = 0x3b3530;
const THORN = 0x3a2a24;
const CANDLE = 0xe8dcc0;
const EMBER = 0xff7a1f;
const FLAME = 0xffc35a;
const GLOW_GOLD = 0xffcf6a;
const RUNE = 0x86d8ff;
const WINDOW = 0xffb454;

// A pointed doorway or window: straight jambs up to `spring`, then a pointed arch.
function lancet(halfSpan: number, radius: number, spring: number): Point[] {
  const left = pointedArc(halfSpan, radius, spring);
  const right = [...left].reverse().map((point) => ({ x: -point.x, y: point.y }));
  return [{ x: -halfSpan, y: 0 }, ...left, ...right.slice(1), { x: halfSpan, y: 0 }];
}

function rubble(kit: ModelKit, count: number, spread: number, size: number, colors: readonly number[]): void {
  for (let index = 0; index < count; index++) {
    const angle = kit.between(0, Math.PI * 2);
    const radius = kit.between(size * 0.5, size);
    kit.rock(radius, colors[index % colors.length]!, {
      x: Math.cos(angle) * kit.between(spread * 0.5, spread), y: radius * 0.45, z: Math.sin(angle) * kit.between(spread * 0.3, spread * 0.7), sy: 0.6,
    });
  }
}

function flames(kit: ModelKit, count: number, width: number, height: number, base: number): void {
  for (let index = 0; index < count; index++) {
    const tall = kit.between(height * 0.45, height);
    kit.cone(kit.between(width * 0.12, width * 0.22), tall, index % 2 === 0 ? EMBER : FLAME, {
      x: kit.between(-width / 2, width / 2), y: base + tall / 2, z: kit.between(-width / 3, width / 3), rz: kit.between(-0.2, 0.2),
    }, 5, true);
  }
}

function chain(kit: ModelKit, x: number, top: number, length: number, z = 0): void {
  for (let link = 0; link * 0.24 < length; link++) {
    kit.torus(0.095, 0.024, IRON, { x, y: top - link * 0.24, z, ry: link % 2 === 0 ? 0 : Math.PI / 2, sy: 1.5 }, 6, 3);
  }
}

export const DECORATION_MODELS: readonly DecorationModel[] = Object.freeze([
  {
    id: 'ruined-pillar', name: 'Ruined pillar', category: 'ruins', height: 6, z: -3,
    description: 'A broken column on its plinth, rubble at its feet. Line a hall that is no longer there.',
    build(kit) {
      kit.box(1.7, 0.45, 1.7, STONE_DARK, { y: 0.225 });
      kit.cylinder(0.72, 0.8, 0.3, STONE, { y: 0.6 }, 12);
      kit.cylinder(0.52, 0.58, 4.3, STONE, { y: 2.9 }, 12);
      kit.rock(0.62, STONE, { y: 5.05, sy: 0.32, ry: 0.4 });
      kit.rock(0.34, STONE_LIGHT, { x: 0.18, y: 5.3, sy: 0.5, rz: 0.4 });
      rubble(kit, 5, 1.7, 0.38, [STONE_DARK, MOSS, STONE]);
    },
  },
  {
    id: 'gothic-arch', name: 'Broken arch', category: 'ruins', height: 11, z: -15,
    description: 'Half of a pointed arch still standing on one pier; the other pier has fallen.',
    build(kit) {
      kit.box(1.1, 6.6, 1.3, STONE, { x: -3, y: 3.3 });
      kit.box(1.4, 0.4, 1.6, STONE_DARK, { x: -3, y: 0.2 });
      kit.box(1.1, 4.4, 1.3, STONE, { x: 3, y: 2.2 });
      kit.box(1.4, 0.4, 1.6, STONE_DARK, { x: 3, y: 0.2 });
      kit.rock(0.62, STONE, { x: 3, y: 4.45, sy: 0.45, rz: 0.3 });
      const outer = pointedArc(3.55, 4.6, 6.6);
      const inner = pointedArc(2.45, 3.3, 6.6);
      const apex = outer.at(-1)!;
      const low = inner.at(-1)!;
      kit.extrude([...outer, { x: 0.3, y: apex.y - 0.35 }, { x: -0.15, y: (apex.y + low.y) / 2 }, { x: 0.2, y: low.y + 0.05 }, ...[...inner].reverse()],
        1.2, STONE);
      kit.box(1.2, 0.8, 1, STONE, { x: 1.6, y: 0.4, z: 0.9, ry: 0.5, rz: 0.2 });
      rubble(kit, 4, 2.2, 0.45, [STONE, STONE_DARK]);
    },
  },
  {
    id: 'broken-wall', name: 'Crumbling wall', category: 'ruins', height: 6, z: -4,
    description: 'A stretch of fortification with arrow slits and a ragged top.',
    build(kit) {
      const top: Point[] = [];
      for (let x = 5; x > -5; x -= 0.8) top.push({ x, y: x < -1.5 && Math.round(x / 0.8) % 2 === 0 ? 6 : kit.between(2.8, 5.4) });
      kit.extrude([{ x: -5, y: 0 }, { x: 5, y: 0 }, ...top, { x: -5, y: 6 }], 1.3, STONE);
      for (const x of [-3.2, -0.6, 2.1]) kit.box(0.18, 1.1, 0.1, SHADOW, { x, y: 2.2, z: 0.66 });
      rubble(kit, 6, 4.5, 0.5, [STONE, STONE_DARK, MOSS]);
    },
  },
  {
    id: 'watchtower', name: 'Ruined watchtower', category: 'ruins', height: 22, z: -80,
    description: 'A round tower with fallen crenels and one window still lit.',
    build(kit) {
      kit.cylinder(3, 3.5, 17, STONE, { y: 8.5 }, 12);
      kit.cylinder(3.5, 3.4, 1, STONE_DARK, { y: 17.5 }, 12);
      for (let index = 0; index < 12; index++) {
        if (index === 2 || index === 3 || index === 7) continue;
        const angle = index * Math.PI / 6;
        kit.box(1.15, index % 4 === 1 ? 1 : 1.5, 0.7, STONE, { x: Math.sin(angle) * 3.15, y: 18.7, z: Math.cos(angle) * 3.15, ry: angle });
      }
      kit.box(0.55, 1.5, 0.3, SHADOW, { x: 0.9, y: 9, z: 3.18 });
      kit.box(0.55, 1.5, 0.3, WINDOW, { x: -0.8, y: 14, z: 3.02 }, true);
      kit.extrude(lancet(0.8, 1.1, 1.6), 0.3, SHADOW, { z: 3.4 });
      rubble(kit, 5, 4.8, 0.7, [STONE, STONE_DARK]);
    },
  },
  {
    id: 'cathedral', name: 'Distant cathedral', category: 'ruins', height: 75, z: -400,
    description: 'Twin spires and a glowing rose window. Place it far back, where fog softens it.',
    build(kit) {
      kit.extrude([{ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }, { x: 0, y: 42 }, { x: -10, y: 30 }], 8, STONE_DARK);
      kit.box(20, 30, 36, STONE_DARK, { y: 15, z: -22 });
      kit.extrude([{ x: -10.5, y: 30 }, { x: 10.5, y: 30 }, { x: 0, y: 40 }], 36, SLATE, { z: -22 });
      for (const side of [-1, 1]) {
        const x = side * 14.5;
        kit.box(9, 48, 9, STONE_DARK, { x, y: 24 });
        kit.box(10, 1.2, 10, STONE, { x, y: 48.6 });
        kit.cone(7, 26, SLATE, { x, y: 62.2, ry: Math.PI / 4 }, 4);
        for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]] as const) kit.cone(0.9, 5, STONE_DARK, { x: x + dx, y: 51.7, z: dz }, 4);
        kit.box(1.4, 7, 0.4, WINDOW, { x, y: 34, z: 4.6 }, true);
        kit.box(1.2, 5, 0.4, WINDOW, { x, y: 18, z: 4.6 }, true);
      }
      kit.cylinder(4, 4, 0.4, WINDOW, { y: 27, z: 4.1, rx: Math.PI / 2 }, 16, true);
      kit.torus(4.2, 0.35, STONE, { y: 27, z: 4.3 }, 16);
      kit.extrude(lancet(3.2, 4.2, 6), 0.6, SHADOW, { z: 4.1 });
    },
  },
  {
    id: 'castle', name: 'Castle on the horizon', category: 'ruins', height: 110, z: -600,
    description: 'Curtain walls, round towers and a great keep, windows lit. Set it deep in the background.',
    build(kit) {
      kit.box(96, 20, 6, STONE_DARK, { y: 10 });
      for (let x = -47; x <= 47; x += 3) kit.box(1.6, 2.2, 6.4, STONE_DARK, { x, y: 21.1 });
      for (const [x, radius, height, roof] of [[-48, 6, 38, 16], [-26, 5, 52, 18], [28, 5, 46, 16], [49, 6, 34, 14]] as const) {
        kit.cylinder(radius, radius * 1.08, height, STONE, { x, y: height / 2, z: 2 }, 10);
        kit.cone(radius * 1.25, roof, SLATE, { x, y: height + roof / 2, z: 2 }, 10);
        kit.box(1.2, 3, 0.6, WINDOW, { x, y: height * 0.72, z: 2 + radius }, true);
      }
      kit.box(26, 64, 20, STONE, { x: 4, y: 32, z: -8 });
      kit.cone(19, 22, SLATE, { x: 4, y: 75, z: -8, ry: Math.PI / 4 }, 4);
      kit.cone(2.4, 26, SLATE, { x: 4, y: 99, z: -8 }, 6);
      for (const [x, y] of [[-4, 40], [6, 48], [12, 36], [-2, 26], [10, 56]] as const) kit.box(1.6, 3.2, 0.6, WINDOW, { x, y, z: 2.1 }, true);
    },
  },
  {
    id: 'stone-bridge', name: 'Viaduct', category: 'ruins', height: 36, z: -200,
    description: 'Four arches carrying a road across a gorge, far away.',
    build(kit) {
      const outline: Point[] = [{ x: -42, y: 0 }];
      for (const centre of [-30, -10, 10, 30]) {
        outline.push({ x: centre - 7, y: 0 }, ...roundArc(7, 16).map((point) => ({ x: centre + point.x, y: point.y })), { x: centre + 7, y: 0 });
      }
      outline.push({ x: 42, y: 0 }, { x: 42, y: 34 }, { x: -42, y: 34 });
      kit.extrude(outline, 7, STONE);
      kit.box(84, 1.5, 7.4, STONE_DARK, { y: 34.75 });
    },
  },
  {
    id: 'obelisk', name: 'Rune obelisk', category: 'ruins', height: 9, z: -12,
    description: 'A tapering monolith carved with faintly glowing runes.',
    build(kit) {
      kit.box(2.6, 0.6, 2.6, STONE_DARK, { y: 0.3 });
      kit.box(2, 0.5, 2, STONE, { y: 0.85 });
      kit.cylinder(0.62, 0.95, 7.2, STONE_DARK, { y: 4.7, ry: Math.PI / 4 }, 4);
      kit.cone(0.62, 1, STONE_DARK, { y: 8.8, ry: Math.PI / 4 }, 4);
      for (let y = 2; y < 7.8; y += 0.55) {
        const face = (0.95 + (0.62 - 0.95) * (y - 1.1) / 7.2) * Math.SQRT1_2;
        for (let mark = 0; mark < 3; mark++) {
          kit.box(0.07, kit.between(0.14, 0.3), 0.05, RUNE, { x: kit.between(-face * 0.6, face * 0.6), y, z: face + 0.02 }, true);
        }
      }
    },
  },
  {
    id: 'knight-statue', name: 'Knight statue', category: 'ruins', height: 7, z: -5,
    description: 'A hooded knight resting both hands on a planted greatsword.',
    build(kit) {
      kit.box(2.4, 1.1, 2, STONE_DARK, { y: 0.55 });
      kit.box(2, 0.25, 1.7, STONE, { y: 1.225 });
      kit.cylinder(0.55, 1, 3.6, STONE_LIGHT, { y: 3.15 }, 8);
      kit.sphere(0.85, STONE_LIGHT, { y: 4.9, sy: 0.55, sz: 0.8 }, 10);
      kit.sphere(0.4, STONE_LIGHT, { y: 5.55 }, 10);
      kit.cone(0.46, 0.9, STONE_LIGHT, { y: 5.85, z: -0.05, rx: -0.25 }, 8);
      kit.box(0.26, 3.4, 0.08, STONE, { y: 3.05, z: 0.95 });
      kit.box(1.3, 0.16, 0.16, STONE, { y: 4.8, z: 0.95 });
      kit.cylinder(0.07, 0.07, 0.7, STONE, { y: 5.2, z: 0.95 });
      kit.sphere(0.16, STONE, { y: 5.6, z: 0.95 });
      kit.sphere(0.2, STONE_LIGHT, { x: -0.12, y: 5.25, z: 0.88 });
      kit.sphere(0.2, STONE_LIGHT, { x: 0.12, y: 5.38, z: 0.88 });
      kit.rock(0.3, MOSS, { x: -0.8, y: 1.3, z: 0.6, sy: 0.3 });
      kit.rock(0.25, MOSS, { x: 0.7, y: 1.3, z: -0.5, sy: 0.3 });
    },
  },
  {
    id: 'dead-tree', name: 'Dead tree', category: 'wilds', height: 8, z: -3,
    description: 'A gnarled, leafless tree. Mirror and rotate copies so no two look alike.',
    build(kit) {
      const grow = (from: Vec3, direction: Vec3, length: number, radius: number, depth: number): void => {
        const to: Vec3 = [from[0] + direction[0] * length, from[1] + direction[1] * length, from[2] + direction[2] * length];
        kit.beam(from, to, radius, radius * 0.62, BARK, 5);
        if (depth === 0) return;
        const count = depth > 2 ? 2 : kit.random() < 0.5 ? 2 : 3;
        for (let branch = 0; branch < count; branch++) {
          const turn = (branch % 2 === 0 ? 1 : -1) * kit.between(0.35, 0.8);
          const x = direction[0] * Math.cos(turn) - direction[1] * Math.sin(turn);
          const y = direction[0] * Math.sin(turn) + direction[1] * Math.cos(turn) + 0.15;
          const z = direction[2] + kit.between(-0.35, 0.35);
          const size = Math.hypot(x, y, z);
          grow(to, [x / size, y / size, z / size], length * kit.between(0.58, 0.78), radius * 0.62, depth - 1);
        }
      };
      grow([0, 0, 0], [0.08, 1, 0], 3.2, 0.42, 4);
      for (const [x, z] of [[1.1, 0.4], [-1, 0.3], [0.3, -0.9], [-0.5, 0.8]] as const) kit.beam([0, 0.35, 0], [x, 0, z], 0.26, 0.06, BARK, 5);
    },
  },
  {
    id: 'great-tree', name: 'Golden great tree', category: 'wilds', height: 240, z: -900,
    description: 'A colossal tree whose canopy glows gold on the horizon, visible from anywhere on the climb.',
    build(kit) {
      for (let trunk = 0; trunk < 5; trunk++) {
        let point: Vec3 = [kit.between(-6, 6), 0, kit.between(-4, 4)];
        for (let segment = 0; segment < 6; segment++) {
          const next: Vec3 = [point[0] * 0.8 + kit.between(-5, 5), point[1] + 22, point[2] + kit.between(-3, 3)];
          kit.beam(point, next, 5.2 - segment * 0.6, 4.6 - segment * 0.6, 0x4a3b2a, 7);
          point = next;
        }
      }
      for (let branch = 0; branch < 12; branch++) {
        const side = branch % 2 === 0 ? 1 : -1;
        kit.beam([0, 110 + branch * 5, 0], [side * kit.between(40, 90), kit.between(150, 200), kit.between(-18, 18)], 3, 1, 0x4a3b2a, 5);
      }
      for (let blob = 0; blob < 40; blob++) {
        const angle = kit.between(0.15, Math.PI - 0.15);
        const reach = kit.between(40, 95);
        kit.rock(kit.between(14, 26), blob % 3 === 0 ? GOLD : GLOW_GOLD, {
          x: Math.cos(angle) * reach, y: 130 + Math.sin(angle) * reach * 0.9, z: kit.between(-20, 20),
        }, 0.3, blob % 3 !== 0);
      }
    },
  },
  {
    id: 'thorn-bush', name: 'Thorn bush', category: 'wilds', height: 1.2, z: -1.5,
    description: 'A knot of black thorns for the edges of paths.',
    build(kit) {
      kit.rock(0.35, THORN, { y: 0.15, sy: 0.6 });
      for (let thorn = 0; thorn < 26; thorn++) {
        const angle = kit.between(0, Math.PI * 2);
        const lift = kit.between(0.2, 1.2);
        const length = kit.between(0.5, 1.3);
        const from: Vec3 = [kit.between(-0.3, 0.3), kit.between(0, 0.3), kit.between(-0.3, 0.3)];
        const size = Math.hypot(Math.cos(angle), lift, Math.sin(angle));
        kit.beam(from, [from[0] + Math.cos(angle) / size * length, from[1] + lift / size * length, from[2] + Math.sin(angle) / size * length], 0.05, 0.005, THORN, 4);
      }
    },
  },
  {
    id: 'rock-spire', name: 'Rock spire', category: 'wilds', height: 18, z: -60,
    description: 'A jagged crag, streaked with moss.',
    build(kit) {
      kit.cylinder(1.2, 3.2, 16, ROCK, { y: 8, rz: 0.06 }, 5);
      for (let chunk = 0; chunk < 7; chunk++) {
        kit.rock(kit.between(1.2, 2.6), chunk % 3 === 0 ? MOSS : ROCK, {
          x: kit.between(-1.6, 1.6), y: kit.between(1.5, 15), z: kit.between(-1, 1), sy: kit.between(1.2, 2.2),
        });
      }
      kit.cone(1.1, 3.5, ROCK, { x: 0.5, y: 17.5, rz: -0.1 }, 5);
    },
  },
  {
    id: 'rock-shelf', name: 'Rock shelf', category: 'wilds', height: 4, z: -16,
    description: 'A broad shelf of rock reaching 30 m back from the course, strewn with boulders: ground for scenery behind the climb to stand on.',
    build(kit) {
      const top: Point[] = [];
      for (let x = 12; x >= -12; x -= 1.5) top.push({ x, y: 4 + kit.between(-0.5, 0.3) });
      kit.extrude([{ x: -12, y: 0 }, { x: 12, y: 0 }, ...top], 30, ROCK_DARK);
      for (let boulder = 0; boulder < 7; boulder++) {
        const radius = kit.between(0.5, 1.3);
        kit.rock(radius, boulder % 3 === 0 ? MOSS : ROCK, { x: kit.between(-10, 10), y: 3.9 + radius * 0.4, z: kit.between(-13, 13), sy: 0.6 });
      }
    },
  },
  {
    id: 'mountain-ridge', name: 'Mountain ridge', category: 'wilds', height: 200, z: -1000,
    description: 'A snow-capped range for the far horizon. Scale it wide and deep.',
    build(kit) {
      const ridge: Point[] = [];
      for (let x = 300, index = 0; x > -300; x -= kit.between(18, 46), index++) {
        ridge.push({ x, y: index % 2 === 0 ? kit.between(110, 200) : kit.between(40, 100) });
      }
      kit.extrude([{ x: -300, y: 0 }, { x: 300, y: 0 }, ...ridge], 60, ROCK_DARK);
      for (let index = 1; index < ridge.length - 1; index++) {
        const peak = ridge[index]!;
        if (peak.y < 150) continue;
        const left = ridge[index + 1]!;
        const right = ridge[index - 1]!;
        const along = (to: Point, share: number): Point => ({ x: peak.x + (to.x - peak.x) * share, y: peak.y + (to.y - peak.y) * share });
        kit.extrude([along(left, 0.3), { x: peak.x, y: peak.y - 14 }, along(right, 0.3), peak], 2, SNOW, { z: 30.5 });
      }
    },
  },
  {
    id: 'graves', name: 'Graves', category: 'relics', height: 1.4, z: -1.2,
    description: 'Leaning headstones and a cross over fresh mounds.',
    build(kit) {
      const headstone = (x: number, width: number, height: number, tilt: number): void => {
        const radius = width / 2;
        const top = Array.from({ length: 7 }, (_, step) => {
          const angle = Math.PI * step / 6;
          return { x: radius * Math.cos(angle), y: height - radius + radius * Math.sin(angle) };
        });
        kit.extrude([{ x: -radius, y: 0 }, { x: radius, y: 0 }, ...top], 0.18, STONE, { x, rz: tilt, rx: kit.between(-0.08, 0.05) });
      };
      headstone(-1.6, 0.55, 1, 0.08);
      headstone(-0.6, 0.7, 1.3, -0.05);
      headstone(0.8, 0.5, 0.85, 0.15);
      headstone(1.7, 0.6, 1.1, -0.1);
      kit.box(0.14, 1.4, 0.14, STONE_DARK, { x: 0.1, y: 0.7, z: -0.45, rz: 0.05 });
      kit.box(0.7, 0.14, 0.14, STONE_DARK, { x: 0.12, y: 1.05, z: -0.45, rz: 0.05 });
      for (const x of [-1.1, 0.3, 1.3]) kit.sphere(0.5, DIRT, { x, z: 0.45, sx: 1.3, sy: 0.25, sz: 0.8 }, 8);
    },
  },
  {
    id: 'sword-grave', name: 'Sword grave', category: 'relics', height: 5, z: -2,
    description: 'A giant\'s sword driven into a mound, a rag tied to its hilt.',
    build(kit) {
      const tilt = 0.14;
      const along = (y: number): { x: number; y: number } => ({ x: -y * Math.sin(tilt), y: y * Math.cos(tilt) - 0.3 });
      kit.extrude([{ x: 0, y: 0 }, { x: 0.2, y: 0.6 }, { x: 0.2, y: 3.6 }, { x: -0.2, y: 3.6 }, { x: -0.2, y: 0.6 }], 0.07, IRON_LIGHT,
        { y: -0.3, rz: tilt });
      kit.box(1.5, 0.2, 0.22, IRON, { ...along(3.7), rz: tilt });
      kit.cylinder(0.07, 0.07, 1, WOOD_DARK, { ...along(4.3), rz: tilt });
      kit.sphere(0.17, IRON, { ...along(4.9) });
      kit.box(0.08, 0.55, 0.25, CLOTH, { ...along(4.1), x: along(4.1).x + 0.12, rz: tilt - 0.3 });
      kit.sphere(0.9, DIRT, { sy: 0.3 }, 10);
      rubble(kit, 4, 0.9, 0.2, [STONE_DARK, DIRT]);
    },
  },
  {
    id: 'skull-pile', name: 'Skull pile', category: 'relics', height: 1, z: -1,
    description: 'A heap of skulls and bones, for ossuaries and the lairs of things that eat climbers.',
    build(kit) {
      const skull = (x: number, y: number, z: number, turn: number): void => {
        const front = { x: Math.sin(turn), z: Math.cos(turn) };
        kit.sphere(0.17, BONE, { x, y, z, sx: 0.9, sy: 0.85, sz: 1.05, ry: turn }, 8);
        kit.box(0.2, 0.08, 0.16, BONE, { x: x + front.x * 0.08, y: y - 0.12, z: z + front.z * 0.08, ry: turn });
        for (const side of [-1, 1]) {
          kit.sphere(0.045, SHADOW, { x: x + front.x * 0.14 + front.z * side * 0.06, y: y + 0.02, z: z + front.z * 0.14 - front.x * side * 0.06 }, 4);
        }
      };
      for (let index = 0; index < 6; index++) {
        const angle = index * Math.PI / 3 + 0.3;
        skull(Math.cos(angle) * 0.45, 0.15, Math.sin(angle) * 0.35, kit.between(-0.6, 0.6));
      }
      for (let index = 0; index < 3; index++) {
        const angle = index * Math.PI * 2 / 3;
        skull(Math.cos(angle) * 0.2, 0.42, Math.sin(angle) * 0.16, kit.between(-0.5, 0.5));
      }
      skull(0, 0.68, 0.02, 0.1);
      for (let bone = 0; bone < 5; bone++) {
        const x = kit.between(-0.9, 0.9);
        const z = kit.between(-0.4, 0.5);
        kit.beam([x, 0.04, z], [x + kit.between(-0.5, 0.5), 0.04, z + kit.between(-0.3, 0.3)], 0.035, 0.035, BONE, 5);
      }
    },
  },
  {
    id: 'hanging-cage', name: 'Hanging cage', category: 'relics', height: 6, z: 2,
    description: 'A gibbet cage on a long chain, with a tenant who stopped climbing.',
    build(kit) {
      for (const y of [0.12, 2.12]) kit.torus(0.62, 0.04, IRON, { y, rx: Math.PI / 2 });
      for (let bar = 0; bar < 10; bar++) {
        const angle = bar * Math.PI / 5;
        kit.beam([Math.cos(angle) * 0.62, 0.1, Math.sin(angle) * 0.62], [Math.cos(angle) * 0.62, 2.14, Math.sin(angle) * 0.62], 0.03, 0.03, IRON, 4);
      }
      kit.cylinder(0.62, 0.62, 0.05, IRON, { y: 0.08 }, 10);
      kit.sphere(0.64, IRON, { y: 2.12, sy: 0.55 }, 10);
      kit.torus(0.12, 0.03, IRON, { y: 2.6 });
      chain(kit, 0, 6, 3.3);
      kit.sphere(0.16, BONE, { x: 0.15, y: 0.35 }, 8);
      kit.beam([-0.2, 0.15, 0.1], [0.3, 0.2, -0.2], 0.035, 0.035, BONE, 5);
    },
  },
  {
    id: 'banner', name: 'Tattered banner', category: 'relics', height: 6, z: -1.5,
    description: 'A torn war banner on its pole, gold emblem faded.',
    build(kit) {
      kit.cylinder(0.06, 0.08, 6.2, WOOD, { y: 3.1 }, 6);
      kit.beam([-1, 5.6, 0.05], [1, 5.6, 0.05], 0.04, 0.04, WOOD, 5);
      kit.extrude([
        { x: -0.9, y: 5.55 }, { x: 0.9, y: 5.55 }, { x: 0.9, y: 2.9 }, { x: 0.62, y: 2.45 }, { x: 0.4, y: 3 }, { x: 0.12, y: 2.2 },
        { x: -0.2, y: 2.85 }, { x: -0.52, y: 2.35 }, { x: -0.9, y: 2.95 },
      ], 0.03, CLOTH, { z: 0.1 });
      kit.extrude([{ x: 0, y: 3.7 }, { x: 0.35, y: 4.3 }, { x: 0, y: 4.9 }, { x: -0.35, y: 4.3 }], 0.02, GOLD, { z: 0.13 });
      kit.cone(0.1, 0.35, GOLD, { y: 6.37 }, 6);
    },
  },
  {
    id: 'chains', name: 'Hanging chains', category: 'relics', height: 8, z: 4,
    description: 'Chains of different lengths from a beam. Hang them in front of the course to frame a scene.',
    build(kit) {
      kit.box(4.2, 0.3, 0.3, WOOD_DARK, { y: 8.1 });
      for (const [x, length] of [[-1.5, 6.5], [-0.4, 3.8], [0.7, 7.6], [1.6, 5]] as const) chain(kit, x, 7.95, length);
      kit.torus(0.18, 0.035, IRON, { x: 0.7, y: 0.18 });
    },
  },
  {
    id: 'iron-fence', name: 'Iron fence', category: 'relics', height: 2.2, z: -1,
    description: 'A wrought-iron fence between stone posts, a few bars bent or missing.',
    build(kit) {
      for (const y of [0.35, 1.75]) kit.box(6, 0.08, 0.08, IRON, { y });
      for (let bar = 0; bar < 15; bar++) {
        if (bar === 4 || bar === 11) continue;
        const x = -2.8 + bar * 0.4;
        const bent = bar === 8 ? 0.14 : 0;
        kit.cylinder(0.025, 0.025, 1.9, IRON, { x: x - bent * 1.9 / 2, y: 0.95, rz: bent }, 4);
        kit.cone(0.06, 0.22, IRON, { x: x - bent * 1.9, y: 2.01 }, 4);
      }
      for (const x of [-3.05, 3.05]) {
        kit.box(0.24, 2.3, 0.24, STONE_DARK, { x, y: 1.15 });
        kit.cone(0.2, 0.3, STONE_DARK, { x, y: 2.45, ry: Math.PI / 4 }, 4);
      }
    },
  },
  {
    id: 'ember-cairn', name: 'Ember cairn', category: 'fire', height: 1.6, z: -1,
    description: 'A blade planted in warm ash, embers still glowing around it. A place to rest the eyes.',
    build(kit) {
      kit.sphere(0.75, ASH, { y: 0.02, sy: 0.28 }, 10);
      for (let stone = 0; stone < 8; stone++) {
        const angle = stone * Math.PI / 4;
        kit.rock(kit.between(0.16, 0.24), STONE_DARK, { x: Math.cos(angle) * 0.8, y: 0.1, z: Math.sin(angle) * 0.6 });
      }
      kit.box(0.09, 1.25, 0.03, IRON_LIGHT, { y: 0.75, rz: 0.1 });
      kit.box(0.34, 0.06, 0.06, IRON, { x: -0.065, y: 1.35, rz: 0.1 });
      kit.cylinder(0.03, 0.03, 0.22, WOOD_DARK, { x: -0.08, y: 1.49, rz: 0.1 });
      kit.sphere(0.05, IRON, { x: -0.09, y: 1.62 });
      flames(kit, 7, 0.6, 0.6, 0.12);
      for (let ember = 0; ember < 8; ember++) {
        kit.sphere(0.03, EMBER, { x: kit.between(-0.5, 0.5), y: 0.12, z: kit.between(-0.35, 0.35) }, 4, true);
      }
    },
  },
  {
    id: 'brazier', name: 'Brazier', category: 'fire', height: 1.8, z: -1,
    description: 'An iron fire bowl on three legs.',
    build(kit) {
      for (let leg = 0; leg < 3; leg++) {
        const angle = leg * Math.PI * 2 / 3 + 0.4;
        kit.beam([Math.cos(angle) * 0.3, 1.2, Math.sin(angle) * 0.3], [Math.cos(angle) * 0.58, 0, Math.sin(angle) * 0.58], 0.04, 0.03, IRON, 4);
      }
      kit.cylinder(0.5, 0.25, 0.35, IRON, { y: 1.3 }, 10);
      kit.cylinder(0.46, 0.46, 0.04, ASH, { y: 1.46 }, 10);
      kit.torus(0.5, 0.03, IRON, { y: 1.47, rx: Math.PI / 2 });
      flames(kit, 6, 0.7, 0.5, 1.47);
    },
  },
  {
    id: 'candelabra', name: 'Candelabra', category: 'fire', height: 2.4, z: 1.5,
    description: 'A tall iron candelabrum, its candles burnt down unevenly.',
    build(kit) {
      kit.cylinder(0.32, 0.45, 0.14, IRON, { y: 0.07 }, 8);
      kit.sphere(0.12, IRON, { y: 0.2 }, 8);
      kit.cylinder(0.04, 0.06, 1.7, IRON, { y: 1 }, 6);
      for (const y of [0.6, 1.2]) kit.sphere(0.07, IRON, { y }, 6);
      const candle = (x: number, base: number, height: number): void => {
        kit.cylinder(0.07, 0.04, 0.06, IRON, { x, y: base + 0.03 }, 6);
        kit.cylinder(0.035, 0.04, height, CANDLE, { x, y: base + 0.06 + height / 2 }, 6);
        kit.cone(0.03, 0.1, FLAME, { x, y: base + 0.06 + height + 0.06 }, 5, true);
      };
      for (const [x, height] of [[-0.55, 0.22], [-0.28, 0.34], [0.28, 0.16], [0.55, 0.3]] as const) {
        const tip = 1.95 - Math.abs(x) * 0.3;
        kit.beam([0, 1.6, 0], [x, tip, 0], 0.025, 0.025, IRON, 4);
        candle(x, tip, height);
      }
      candle(0, 1.85, 0.36);
    },
  },
  {
    id: 'lantern-post', name: 'Lantern post', category: 'fire', height: 3.5, z: -1,
    description: 'A lit lantern hung from a leaning post.',
    build(kit) {
      kit.box(0.4, 0.2, 0.4, STONE_DARK, { y: 0.1 });
      kit.box(0.16, 3.2, 0.16, WOOD_DARK, { y: 1.7 });
      kit.box(0.8, 0.1, 0.1, IRON, { x: 0.35, y: 3.2 });
      kit.beam([0.05, 2.8, 0], [0.5, 3.2, 0], 0.025, 0.025, IRON, 4);
      kit.beam([0.65, 3.2, 0], [0.65, 2.95, 0], 0.015, 0.015, IRON, 4);
      kit.box(0.24, 0.34, 0.24, WINDOW, { x: 0.65, y: 2.7 }, true);
      for (const [dx, dz] of [[-0.13, -0.13], [0.13, -0.13], [-0.13, 0.13], [0.13, 0.13]] as const) {
        kit.box(0.03, 0.38, 0.03, IRON, { x: 0.65 + dx, y: 2.7, z: dz });
      }
      kit.box(0.3, 0.04, 0.3, IRON, { x: 0.65, y: 2.51 });
      kit.cone(0.24, 0.2, IRON, { x: 0.65, y: 2.97, ry: Math.PI / 4 }, 4);
    },
  },
]);

const MODELS = new Map(DECORATION_MODELS.map((model) => [model.id, model]));
const BUILT = new Map<string, DecorationGeometry>();

export function builtInDecoration(id: string): DecorationModel | undefined {
  return MODELS.get(id);
}

/**
 * A level's decorations that nothing can draw, as one line each: their model is neither in the
 * library nor drawn by a GLB in `art`, the course artwork that draws decorations.
 */
export function unknownDecorationModels(level: LevelDefinition, art: DecorationArt): string[] {
  return level.objects.flatMap((object) => object.kind === 'decoration' && !MODELS.has(object.model) &&
    decorationAsset(art, object.model) === undefined
    ? [`Decoration "${object.id}" uses model ${object.model}, which is neither in the decoration library nor in the course artwork.`] : []);
}

/** The model's geometry, built the first time any decoration or preview needs it. */
export function builtInGeometry(model: DecorationModel): DecorationGeometry {
  let geometry = BUILT.get(model.id);
  if (geometry === undefined) {
    let seed = 2166136261;
    for (const character of model.id) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
    const kit = new ModelKit(seed);
    model.build(kit);
    geometry = kit.build();
    BUILT.set(model.id, geometry);
  }
  return geometry;
}
