#!/usr/bin/env node
// Builds the built-in course, the level every new game starts from: node scripts/default-course/generate.mjs
// It models the course's rocks as GLB meshes, works out each one's collision as the engine does (src/mesh-collision.ts),
// places them and writes src/default-course/: the GLBs, and course.json, which lists them and holds the level.
//
// A rock is its outline extruded: through the middle of its depth its walls are the outline itself, so the slice the
// course collides with is that outline; toward the front and back the walls lean in and the faces bulge, roughened by
// seeded noise, so it reads as stone. The ground declares a box instead. Materials are PBR, coloured per vertex.
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShapeUtils, Vector2 } from 'three';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT = 'src/default-course';

// The course: each rock's outline as first placed, in metres, counterclockwise. The climb keeps the shape the
// practice positions were tuned on; rocks reach a little below the ground's top, so they stand in it. `face` is the
// longest inside edge of a rock's faces, which are split so they can bulge.
const ROCKS = [
  {
    id: 'ground', file: 'ground.glb', name: 'Ground slab', collision: 'box', color: 0x485d5a, palette: ['#485d5a', '#56684c'],
    depth: 3, bevel: 0.22, chamfer: 0.35, bulge: 0.18, reach: 0.6, segment: 0.7, face: 0.9, seed: 11,
    outline: [[-22, -2], [34, -2], [34, 0], [-22, 0]],
  },
  {
    id: 'cliff', file: 'cliff.glb', name: 'Cliff', color: 0x71817a, palette: ['#71817a', '#8a8f86'],
    depth: 2.1, bevel: 0.12, chamfer: 0.3, bulge: 0.26, reach: 1.2, segment: 0.5, face: 0.8, seed: 23,
    outline: [
      [3.2, -0.3], [18.4, -0.3], [18.4, 12.2], [15, 12.2], [15, 10.6], [13, 10.6], [13, 9], [11.6, 9], [10.9, 7.3],
      [8.8, 7.3], [8.8, 6.8], [10, 6.8], [10, 5.1], [8.1, 5.1], [7.4, 3.6], [5.9, 3.6], [5.3, 2.1], [3.2, 2.1],
    ],
  },
  {
    id: 'boulder', file: 'boulder.glb', name: 'Boulder', color: 0x9a7660, palette: ['#9a7660', '#7f5f4b'],
    depth: 1.5, bevel: 0.12, chamfer: 0.25, bulge: 0.12, reach: 0.4, segment: 0.25, face: 0.3, seed: 37,
    outline: [
      [-10, -0.15], [-8.2, -0.15], [-8.2, 0.86], [-8.24, 0.97], [-8.33, 1.06], [-8.46, 1.11], [-8.62, 1.12], [-9.1, 1.1],
      [-9.58, 1.12], [-9.74, 1.1], [-9.87, 1.04], [-9.96, 0.95], [-10, 0.84],
    ],
  },
  {
    id: 'crag', file: 'crag.glb', name: 'Crag', color: 0x5d6b68, palette: ['#5d6b68', '#707a80'],
    depth: 2.6, bevel: 0.2, chamfer: 0.4, bulge: 0.2, reach: 0.8, segment: 0.5, face: 0.5, seed: 53,
    outline: [
      [-21.35, -0.25], [-17.85, -0.25], [-17.98, 0.65], [-18.22, 1.6], [-18.1, 2.3], [-18.48, 3.2], [-18.62, 4.25],
      [-18.95, 5.15], [-19.25, 6], [-19.45, 6.3], [-19.8, 6.35], [-20.05, 6.1], [-20.2, 5.6], [-20.38, 4.45],
      [-20.78, 3.5], [-20.62, 2.65], [-21.02, 1.6], [-21.2, 0.7],
    ],
  },
];

// Where each rock stands: the crag closes both ends of the course, mirrored on the right.
const PLACEMENTS = [
  { id: 'ground', rock: 'ground' },
  { id: 'ascent', rock: 'cliff' },
  { id: 'vault', rock: 'boulder' },
  { id: 'crag-left', rock: 'crag' },
  { id: 'crag-right', rock: 'crag', x: 31.6, mirror: true },
];

const START = { kind: 'start', id: 'player-start', x: 0, y: 0.65, angle: -0.42, reach: 1.7 };
// The top of the cliff, where the ending trigger stands.
const SUMMIT = { left: 15.25, right: 18.1, y: 12.2, arrivalTolerance: 0.08 };
const LABELS = [
  { x: 4.2, y: 1.1, text: '01 / THE LEDGE' },
  { x: 6.8, y: 2.7, text: '02 / KEEP GOING' },
  { x: 10, y: 6.05, text: '03 / REACH BACK' },
  { x: 16.5, y: 11.3, text: '04 / THE TOP' },
  { x: -9.1, y: 0.45, text: 'THE VAULT' },
];

const tidy = (value, digits = 4) => Number(value.toFixed(digits)) + 0;

// Smooth value noise in -1 to 1, the same for a seed on every run.
function valueNoise(seed) {
  const hash = (x, y, z) => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca77);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967295 * 2 - 1;
  };
  const fade = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sample = (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
    const at = (dx, dy, dz) => hash(ix + dx, iy + dy, iz + dz);
    return lerp(
      lerp(lerp(at(0, 0, 0), at(1, 0, 0), fx), lerp(at(0, 1, 0), at(1, 1, 0), fx), fy),
      lerp(lerp(at(0, 0, 1), at(1, 0, 1), fx), lerp(at(0, 1, 1), at(1, 1, 1), fx), fy), fz);
  };
  return (x, y, z) => 0.57 * sample(x, y, z) + 0.29 * sample(x * 2.1 + 17.3, y * 2.1 - 4.1, z * 2.1 + 9.7) +
    0.14 * sample(x * 4.3 - 31.1, y * 4.3 + 12.9, z * 4.3 - 2.3);
}

const smoothstep = (edge0, edge1, value) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

function signedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const [ax, ay] = points[index];
    const [bx, by] = points[(index + 1) % points.length];
    area += ax * by - bx * ay;
  }
  return area / 2;
}

// Points along a closed outline, at most `segment` metres apart.
function densify(outline, segment) {
  const points = [];
  outline.forEach(([x, y], index) => {
    const [nx, ny] = outline[(index + 1) % outline.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y) / segment));
    for (let step = 0; step < steps; step++) points.push([x + (nx - x) * step / steps, y + (ny - y) * step / steps]);
  });
  return points;
}

// Each point's inward direction, scaled so a point moved `d` along it stays `d` from both its edges; spikes are capped.
function inwards(points) {
  const unit = (x, y) => {
    const length = Math.hypot(x, y);
    return [x / length, y / length];
  };
  return points.map(([x, y], index) => {
    const [px, py] = points[(index + points.length - 1) % points.length];
    const [nx, ny] = points[(index + 1) % points.length];
    const before = unit(-(y - py), x - px);
    const after = unit(-(ny - y), nx - x);
    const [mx, my] = unit(before[0] + after[0], before[1] + after[1]);
    const scale = 1 / Math.max(mx * before[0] + my * before[1], 0.4);
    return [mx * scale, my * scale];
  });
}

function distanceToOutline(x, y, outline) {
  let nearest = Infinity;
  for (let index = 0; index < outline.length; index++) {
    const [ax, ay] = outline[index];
    const [bx, by] = outline[(index + 1) % outline.length];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    nearest = Math.min(nearest, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return nearest;
}

// Flips a face's inside edges until each is locally Delaunay, so the face keeps no needless slivers; its own edges
// stay, and so does every triangle's winding.
function delaunay(faces, positions) {
  const x = (index) => positions[index * 3];
  const y = (index) => positions[index * 3 + 1];
  const orient = (a, b, c) => (x(b) - x(a)) * (y(c) - y(a)) - (x(c) - x(a)) * (y(b) - y(a));
  // Positive when d lies inside the circle through a, b and c, taken counterclockwise.
  const inCircle = (a, b, c, d) => {
    const ax = x(a) - x(d), ay = y(a) - y(d), bx = x(b) - x(d), by = y(b) - y(d), cx = x(c) - x(d), cy = y(c) - y(d);
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
  };
  for (let sweep = 0; sweep < 256; sweep++) {
    const owners = new Map();
    faces.forEach((face, at) => {
      for (let corner = 0; corner < 3; corner++) {
        const a = face[corner];
        const b = face[(corner + 1) % 3];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const list = owners.get(key);
        if (list === undefined) owners.set(key, [{ at, corner }]);
        else list.push({ at, corner });
      }
    });
    const changed = new Set();
    for (const list of owners.values()) {
      if (list.length !== 2 || list.some(({ at }) => changed.has(at))) continue;
      const [first, second] = list;
      const one = faces[first.at];
      const a = one[first.corner], b = one[(first.corner + 1) % 3], c = one[(first.corner + 2) % 3];
      const d = faces[second.at][(second.corner + 2) % 3];
      const side = Math.sign(orient(a, b, c));
      if (side * inCircle(a, b, c, d) <= 1e-9 || Math.sign(orient(c, a, d)) !== side || Math.sign(orient(c, d, b)) !== side) continue;
      faces[first.at] = [c, a, d];
      faces[second.at] = [c, d, b];
      changed.add(first.at);
      changed.add(second.at);
    }
    if (changed.size === 0) return faces;
  }
  return faces;
}

// Splits a face's inside edges, longest first, until none is longer than `longest`, flipping it back to Delaunay after
// each round. The face's own edges stay whole, so it still meets its walls, and every split keeps the winding.
function refine(faces, positions, longest) {
  faces = delaunay(faces, positions);
  const length = (a, b) => Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1]);
  for (let pass = 0; pass < 64; pass++) {
    const owners = new Map();
    faces.forEach((face, at) => {
      for (let corner = 0; corner < 3; corner++) {
        const a = face[corner];
        const b = face[(corner + 1) % 3];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const list = owners.get(key);
        if (list === undefined) owners.set(key, [at]);
        else list.push(at);
      }
    });
    const long = [...owners].flatMap(([key, list]) => {
      const [a, b] = key.split(':').map(Number);
      return list.length === 2 && length(a, b) > longest ? [{ a, b, list, length: length(a, b) }] : [];
    }).sort((first, second) => second.length - first.length);
    if (long.length === 0) return faces;
    const changed = new Set();
    const next = faces.slice();
    for (const { a, b, list } of long) {
      if (list.some((at) => changed.has(at))) continue;
      const middle = positions.length / 3;
      positions.push((positions[a * 3] + positions[b * 3]) / 2, (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2,
        (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2);
      for (const at of list) {
        changed.add(at);
        const face = faces[at];
        const corner = face.findIndex((index, c) => (index === a && face[(c + 1) % 3] === b) || (index === b && face[(c + 1) % 3] === a));
        const [u, v, w] = [face[corner], face[(corner + 1) % 3], face[(corner + 2) % 3]];
        next[at] = [u, middle, w];
        next.push([middle, v, w]);
      }
    }
    faces = delaunay(next, positions);
  }
  return faces;
}

const srgbToLinear = (value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const hexColor = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);

/**
 * A rock around `outline`, `depth` deep around z = 0 and centred on its outline's bounds. Its walls are the outline
 * through the middle of its depth; over `chamfer` metres toward each face they lean in by up to `bevel` metres, and each
 * face bulges out by up to `bulge` metres, fully `reach` metres in from its edge.
 */
function rock(spec, isSimplePolygon) {
  if (signedArea(spec.outline) <= 0) throw new Error(`${spec.id}: outlines run counterclockwise.`);
  const xs = spec.outline.map(([x]) => x);
  const ys = spec.outline.map(([, y]) => y);
  const center = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const noise = valueNoise(spec.seed);
  const points = densify(spec.outline.map(([x, y]) => [x - center[0], y - center[1]]), spec.segment);
  const toward = inwards(points);
  const half = spec.depth / 2;
  const positions = [];
  const add = (x, y, z) => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  // Back to front: the back face's edge, its chamfer, the wall; then the wall, the chamfer and the front face's edge.
  const RINGS = [[-1, 1, 1], [-1, 0.6, 0.3], [-1, 0, 0], [1, 0, 0], [1, 0.6, 0.3], [1, 1, 1]];
  const rings = RINGS.map(([side, along, lean]) => {
    const ring = points.map(([x, y], index) => {
      const z = side * (half - spec.chamfer * (1 - along));
      if (lean === 0) return add(x, y, z);
      const rough = noise(x * 0.8, y * 0.8, side * 3 + along);
      const inset = spec.bevel * lean * (1 + 0.5 * rough);
      return add(x + toward[index][0] * inset, y + toward[index][1] * inset, z - side * spec.chamfer * 0.12 * lean * (1 + rough));
    });
    const outline = ring.map((index) => ({ x: positions[index * 3], y: positions[index * 3 + 1] }));
    if (!isSimplePolygon(outline)) throw new Error(`${spec.id}: its chamfer folds over; use a smaller bevel.`);
    return ring;
  });
  const indices = [];
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      const [a, b, c, d] = [rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]];
      indices.push(a, b, c, a, c, d);
    }
  }
  const face = (ring, side) => {
    const outline = ring.map((index) => [positions[index * 3], positions[index * 3 + 1]]);
    let faces = ShapeUtils.triangulateShape(outline.map(([x, y]) => new Vector2(x, y)), []).map((corners) => corners.map((at) => ring[at]));
    const used = new Set(faces.flat());
    if (ring.some((index) => !used.has(index))) throw new Error(`${spec.id}: a face lost a point of its edge.`);
    // Seen from its own side, each face runs counterclockwise.
    faces = faces.map(([a, b, c]) => {
      const area = (positions[b * 3] - positions[a * 3]) * (positions[c * 3 + 1] - positions[a * 3 + 1]) -
        (positions[c * 3] - positions[a * 3]) * (positions[b * 3 + 1] - positions[a * 3 + 1]);
      return (area > 0) === (side > 0) ? [a, b, c] : [a, c, b];
    });
    const edge = new Set(ring);
    faces = refine(faces, positions, spec.face);
    for (const index of new Set(faces.flat())) {
      if (edge.has(index)) continue;
      const x = positions[index * 3];
      const y = positions[index * 3 + 1];
      const rise = smoothstep(0, spec.reach, distanceToOutline(x, y, outline));
      positions[index * 3 + 2] = side * (half + spec.bulge * rise * (0.75 + 0.25 * noise(x * 0.6, y * 0.6, side * 7)));
    }
    for (const corners of faces) indices.push(...corners);
  };
  face(rings[0], -1);
  face(rings[rings.length - 1], 1);
  const [base, accent] = spec.palette.map(hexColor);
  const colors = [];
  for (let index = 0; index < positions.length / 3; index++) {
    const [x, y, z] = [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
    const shade = 1 + 0.16 * noise(x * 0.45 + 40, y * 0.45 - 12, z * 0.45);
    const mix = Math.min(1, Math.max(0, 0.5 + 0.9 * noise(x * 0.25 - 7, y * 0.25 + 23, z * 0.25)));
    colors.push(...base.map((value, channel) => Math.round(255 * srgbToLinear(Math.min(1, (value + (accent[channel] - value) * mix) * shade)))), 255);
  }
  return { center, positions, indices, colors };
}

// A one-mesh GLB: positions, linear vertex colours and triangles, with one rough, non-metallic PBR material. It has no
// normals, so it is drawn flat-shaded, faceted like cut stone.
function glb({ name, positions, colors, indices }, collision) {
  const count = positions.length / 3;
  const position = new Float32Array(positions);
  const color = Uint8Array.from(colors);
  const index = count < 65536 ? Uint16Array.from(indices) : Uint32Array.from(indices);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < position.length; at++) {
    min[at % 3] = Math.min(min[at % 3], position[at]);
    max[at % 3] = Math.max(max[at % 3], position[at]);
  }
  const padded = (length) => (length + 3) & ~3;
  const colorOffset = padded(position.byteLength);
  const indexOffset = colorOffset + padded(color.byteLength);
  const binary = new Uint8Array(padded(indexOffset + index.byteLength));
  binary.set(new Uint8Array(position.buffer), 0);
  binary.set(color, colorOffset);
  binary.set(new Uint8Array(index.buffer), indexOffset);
  const json = {
    asset: { version: '2.0', generator: 'Over the Edge built-in course' },
    scene: 0,
    scenes: [{ name, nodes: [0], ...(collision === undefined ? {} : { extras: { collision } }) }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, material: 0, mode: 4 }] }],
    materials: [{ name, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.92 } }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: position.byteLength, target: 34962 },
      { buffer: 0, byteOffset: colorOffset, byteLength: color.byteLength, target: 34962 },
      { buffer: 0, byteOffset: indexOffset, byteLength: index.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5121, normalized: true, count, type: 'VEC4' },
      { bufferView: 2, componentType: index instanceof Uint16Array ? 5123 : 5125, count: index.length, type: 'SCALAR' },
    ],
  };
  const text = Buffer.from(JSON.stringify(json));
  const description = Buffer.alloc(padded(text.byteLength), 0x20);
  text.copy(description);
  const file = Buffer.alloc(12 + 8 + description.byteLength + 8 + binary.byteLength);
  file.writeUInt32LE(0x46546c67, 0);
  file.writeUInt32LE(2, 4);
  file.writeUInt32LE(file.byteLength, 8);
  file.writeUInt32LE(description.byteLength, 12);
  file.writeUInt32LE(0x4e4f534a, 16);
  description.copy(file, 20);
  const binaryStart = 20 + description.byteLength;
  file.writeUInt32LE(binary.byteLength, binaryStart);
  file.writeUInt32LE(0x004e4942, binaryStart + 4);
  file.set(binary, binaryStart + 8);
  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
}

const server = await createServer({ configFile: false, root, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
try {
  const { isSimplePolygon, LEVEL_SCHEMA_VERSION, TRIGGER_LIMITS, validateLevel } = await server.ssrLoadModule('/src/level.ts');
  const { meshTerrain } = await server.ssrLoadModule('/src/mesh-collision.ts');
  const { ENDING_EVENTS } = await server.ssrLoadModule('/src/trigger-events.ts');
  const { DEFAULT_SURFACE } = await server.ssrLoadModule('/src/surfaces.ts');
  const built = new Map();
  for (const spec of ROCKS) {
    const model = rock(spec, isSimplePolygon);
    const bytes = glb({ name: spec.name, ...model }, spec.collision);
    const id = `asset-${createHash('sha256').update(bytes).digest('hex')}`;
    const terrain = meshTerrain(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    built.set(spec.id, { spec, model, bytes, id, terrain });
    const collision = terrain.mesh.collision;
    console.log(`${spec.file}: ${model.indices.length / 3} triangles, ${bytes.byteLength} bytes, collides as ${collision.type === 'slice'
      ? `a slice of ${collision.loops.map((loop) => loop.length).join(' + ')} points` : `its declared ${collision.type}`}.`);
  }
  const terrain = PLACEMENTS.map(({ id, rock: name, x, mirror }) => {
    const { spec, model, terrain: placed } = built.get(name);
    return {
      kind: 'terrain', id, mesh: placed.mesh, x: tidy(x ?? model.center[0]), y: tidy(model.center[1]),
      width: tidy(placed.width), height: tidy(placed.height), angle: 0, depth: tidy(placed.depth), mirror: mirror ?? false,
      color: spec.color, illusion: false, surface: DEFAULT_SURFACE,
    };
  });
  const ending = {
    kind: 'trigger', id: 'ending-trigger', name: 'Ending',
    x: (SUMMIT.left + SUMMIT.right) / 2, y: SUMMIT.y - SUMMIT.arrivalTolerance + TRIGGER_LIMITS.endingHeight / 2,
    region: { type: 'box', width: tidy(SUMMIT.right - SUMMIT.left), height: TRIGGER_LIMITS.endingHeight },
    activation: 'once', marker: 'flag', events: ENDING_EVENTS,
  };
  const level = validateLevel({ schemaVersion: LEVEL_SCHEMA_VERSION, labels: LABELS, objects: [...terrain, START, ending] });
  const meshes = ROCKS.map(({ id: name, file }) => {
    const { spec, bytes, id } = built.get(name);
    return { id, name: spec.name, file, bytes: bytes.byteLength };
  });
  const directory = join(root, OUTPUT, 'meshes');
  await mkdir(directory, { recursive: true });
  for (const stray of (await readdir(directory)).filter((file) => !ROCKS.some((spec) => spec.file === file))) await rm(join(directory, stray));
  for (const { spec, bytes } of built.values()) await writeFile(join(directory, spec.file), bytes);
  await writeFile(join(root, OUTPUT, 'course.json'), `${JSON.stringify({ meshes, level }, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT}: ${meshes.length} meshes and a level of ${level.objects.length} objects.`);
} finally {
  await server.close();
}
