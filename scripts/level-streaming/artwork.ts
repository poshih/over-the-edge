import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { BoxGeometry, ExtrudeGeometry, Shape } from 'three';
import type { BufferGeometry } from 'three';
import type { ART_LIMITS } from '../../src/art-types.ts';
import type { Outline, ShapeKind, TerrainMesh } from '../../src/level.ts';
import { random } from '../course-kit/course.ts';
import { CourseLevelError } from '../course-kit/errors.ts';
import type { CourseJob } from '../course-kit/job.ts';
import { encodeGlb } from '../glb.ts';

export const DENSE_TEXTURE_EDGE = 512;
export const SLICE_RISE = 2;
export const REPEATED_MODELS = ['ruined-pillar', 'obelisk', 'dead-tree', 'lantern-post'] as const;
export type ArtLimits = typeof ART_LIMITS;
const SLICE_THICKNESS = 0.4;
export const tidy = (value: number) => Number(value.toFixed(6)) + 0;

export interface ArtworkAsset {
  readonly id: string;
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly model: string | null;
}
export interface TerrainAsset extends ArtworkAsset {
  readonly mesh: Extract<TerrainMesh, { type: 'asset' }>;
}
export interface RepeatedAsset extends TerrainAsset {
  readonly model: string;
}
export interface SliceAsset extends TerrainAsset {
  readonly width: number;
  readonly height: number;
  readonly centerY: number;
}
interface ModelPart {
  readonly color: readonly [number, number, number];
  readonly translation?: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
}
interface BufferView {
  readonly buffer: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly target?: number;
}
interface Accessor {
  readonly bufferView: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: 'VEC2' | 'VEC3' | 'SCALAR';
  readonly min?: readonly number[];
  readonly max?: readonly number[];
}

function modelGlb(name: string, geometry: BufferGeometry, parts: readonly ModelPart[], image?: Uint8Array, collision?: ShapeKind): Uint8Array<ArrayBuffer> {
  const chunks: { offset: number; bytes: Uint8Array }[] = [];
  const bufferViews: BufferView[] = [];
  const accessors: Accessor[] = [];
  let byteLength = 0;
  const view = (bytes: Uint8Array, target?: number): number => {
    const offset = Math.ceil(byteLength / 4) * 4;
    chunks.push({ offset, bytes });
    byteLength = offset + bytes.byteLength;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target === undefined ? {} : { target }) });
    return bufferViews.length - 1;
  };
  const attribute = (name: string, size: 2 | 3): number => {
    const source = geometry.getAttribute(name);
    if (source === undefined || source.itemSize !== size || source.count === 0) {
      throw new CourseLevelError({ field: `GLB ${name} attribute`, value: source });
    }
    const values = new Float32Array(source.count * size);
    const min = Array<number>(size).fill(Infinity), max = Array<number>(size).fill(-Infinity);
    for (let index = 0; index < source.count; index++) {
      values[index * size] = source.getX(index);
      values[index * size + 1] = source.getY(index);
      if (size === 3) values[index * size + 2] = source.getZ(index);
      for (let channel = 0; channel < size; channel++) {
        const value = values[index * size + channel];
        if (!Number.isFinite(value)) throw new CourseLevelError({ field: `GLB ${name} coordinate`, value });
        min[channel] = Math.min(min[channel], value);
        max[channel] = Math.max(max[channel], value);
      }
    }
    accessors.push({
      bufferView: view(new Uint8Array(values.buffer), 34962), componentType: 5126,
      count: source.count, type: size === 3 ? 'VEC3' : 'VEC2', ...(name === 'position' ? { min, max } : {}),
    });
    return accessors.length - 1;
  };
  const attributes = { POSITION: attribute('position', 3), NORMAL: attribute('normal', 3), TEXCOORD_0: attribute('uv', 2) };
  let indices: number | undefined;
  if (geometry.index !== null) {
    const count = geometry.getAttribute('position').count;
    const values = count < 65536 ? new Uint16Array(geometry.index.count) : new Uint32Array(geometry.index.count);
    for (let index = 0; index < values.length; index++) values[index] = geometry.index.getX(index);
    accessors.push({
      bufferView: view(new Uint8Array(values.buffer), 34963), componentType: values instanceof Uint16Array ? 5123 : 5125,
      count: values.length, type: 'SCALAR',
    });
    indices = accessors.length - 1;
  }
  const imageView = image === undefined ? undefined : view(image);
  const binary = new Uint8Array(byteLength);
  for (const chunk of chunks) binary.set(chunk.bytes, chunk.offset);
  const json = {
    asset: { version: '2.0', generator: 'Over the Edge streaming benchmarks' },
    scene: 0,
    scenes: [{ name, nodes: parts.map((_, index) => index), ...(collision === undefined ? {} : { extras: { collision } }) }],
    nodes: parts.map((part, index) => ({
      name: `${name} part ${index + 1}`, mesh: index,
      ...(part.translation === undefined ? {} : { translation: part.translation }),
      ...(part.scale === undefined ? {} : { scale: part.scale }),
    })),
    meshes: parts.map((_, index) => ({
      primitives: [{ attributes, ...(indices === undefined ? {} : { indices }), material: index, mode: 4 }],
    })),
    materials: parts.map((part) => ({
      pbrMetallicRoughness: {
        baseColorFactor: [...part.color, 1], metallicFactor: 0, roughnessFactor: 0.82,
        ...(image === undefined ? {} : { baseColorTexture: { index: 0 } }),
      },
    })),
    buffers: [{ byteLength }], bufferViews, accessors,
    ...(imageView === undefined ? {} : {
      images: [{ bufferView: imageView, mimeType: 'image/png' }],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
      textures: [{ sampler: 0, source: 0 }],
    }),
  };
  return encodeGlb(json, binary);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngChunk(name: 'IHDR' | 'IDAT' | 'IEND', data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  chunk.write(name, 4, 'ascii');
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, 8 + data.byteLength)) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.byteLength);
  return chunk;
}

// One RGB image per dense asset, shared by its parts; even incompressible data stays below the total art byte limit.
function proceduralPng(seed: number): Buffer {
  const rng = random(seed), edge = DENSE_TEXTURE_EDGE;
  const pixels = Buffer.alloc(edge * (1 + edge * 3));
  for (let y = 0; y < edge; y++) {
    const row = y * (1 + edge * 3);
    for (let x = 0; x < edge; x++) {
      const checker = ((x >>> 5) ^ (y >>> 5)) & 1;
      for (let channel = 0; channel < 3; channel++) pixels[row + 1 + x * 3 + channel] = Math.floor(rng() * 192) + checker * 32;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(edge, 0);
  header.writeUInt32BE(edge, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels, { level: 6 })), pngChunk('IEND', new Uint8Array()),
  ]);
}

const color = (rng: () => number): ModelPart['color'] => [tidy(0.35 + rng() * 0.5), tidy(0.35 + rng() * 0.5), tidy(0.35 + rng() * 0.5)];
function asset(name: string, bytes: Uint8Array<ArrayBuffer>, model: string | null): ArtworkAsset {
  return { name, bytes, model, id: `asset-${createHash('sha256').update(bytes).digest('hex')}` };
}

export function repeatedArtwork(job: CourseJob, seed: number, slender = false): RepeatedAsset[] {
  const rng = random(seed);
  const geometry = new BoxGeometry(slender ? 0.2 : 1, 1, slender ? 0.2 : 1);
  try {
    return REPEATED_MODELS.map((model, index): RepeatedAsset => {
      const built = asset(`Repeated form ${index + 1}`, modelGlb(`Repeated form ${index + 1}`, geometry, [{ color: color(rng) }], undefined, 'box'), model);
      const terrain = job.readMesh(built.id, built.bytes.buffer.slice(built.bytes.byteOffset, built.bytes.byteOffset + built.bytes.byteLength));
      return { ...built, model, mesh: terrain.mesh };
    });
  } finally {
    geometry.dispose();
  }
}

export function denseArtwork(job: CourseJob, seed: number, limits: ArtLimits): TerrainAsset[] {
  const geometry = new BoxGeometry(1, 1, 1);
  const side = Math.ceil(Math.sqrt(limits.meshes));
  try {
    return Array.from({ length: limits.assets }, (_, index): TerrainAsset => {
      const rng = random(seed ^ Math.imul(index + 1, 0x9e3779b1));
      const parts: ModelPart[] = Array.from({ length: limits.meshes }, (_, part): ModelPart => ({
        color: color(rng),
        translation: [tidy((part % side + 0.5) / side - 0.5), tidy((Math.floor(part / side) + 0.5) / side - 0.5), 0],
        scale: [1 / side, 1 / side, tidy(0.12 + rng() * 0.04)],
      }));
      const name = `Dense textured form ${index + 1}`;
      const built = asset(name, modelGlb(name, geometry, parts, proceduralPng(seed ^ index), 'box'), null);
      const terrain = job.readMesh(built.id, built.bytes.buffer.slice(built.bytes.byteOffset, built.bytes.byteOffset + built.bytes.byteLength));
      return { ...built, mesh: terrain.mesh };
    });
  } finally {
    geometry.dispose();
  }
}

function roundedBar(centerX: number, top: number, width: number, radiusX: number, vertices: number): Outline {
  const left = centerX - width / 2, right = centerX + width / 2, bottom = top - SLICE_THICKNESS, radiusY = 0.08;
  const corners = [
    { x: right - radiusX, y: bottom + radiusY, angle: -Math.PI / 2 },
    { x: right - radiusX, y: top - radiusY, angle: 0 },
    { x: left + radiusX, y: top - radiusY, angle: Math.PI / 2 },
    { x: left + radiusX, y: bottom + radiusY, angle: Math.PI },
  ];
  const quarter = vertices / 4;
  return corners.flatMap((corner) => Array.from({ length: quarter }, (_, index) => {
    const angle = corner.angle + Math.PI / 2 * index / (quarter - 1);
    return { x: corner.x + radiusX * Math.cos(angle), y: corner.y + radiusY * Math.sin(angle) };
  }));
}

export function slicedArtwork(job: CourseJob, seed: number, artLimits: ArtLimits): SliceAsset[] {
  const limits = job.engine.level.LEVEL_LIMITS, count = limits.geometryKinds;
  const vertices = limits.sliceVertices / limits.sliceLoops;
  const height = (limits.sliceLoops - 1) * SLICE_RISE + SLICE_THICKNESS;
  if (count > artLimits.assets || !Number.isInteger(vertices) || vertices < 8 || vertices % 4 !== 0 ||
    vertices > limits.polygonVertices || height > limits.maximumSize) {
    throw new CourseLevelError({ field: 'maximum-complexity slice construction within engine limits', value: limits });
  }
  return Array.from({ length: count }, (_, index): SliceAsset => {
    const width = index === 0 ? 12 : 6, centerY = (height - SLICE_THICKNESS * 2) / 2;
    const radius = 0.12 + 0.12 * index / count;
    const loops = Array.from({ length: limits.sliceLoops }, (_, rung) =>
      roundedBar(rung === 0 && index === 0 ? 0 : rung % 2 === 0 ? -1 : 1, rung * SLICE_RISE,
        rung === 0 && index === 0 ? 12 : 4, radius, vertices)
        .map((point) => ({ x: tidy(point.x / width), y: tidy((point.y - centerY) / height) })));
    // The same loops author the saved collision and the GLB, without rasterizing away the benchmark's vertices.
    const shapes = loops.map((loop) => {
      const shape = new Shape();
      shape.moveTo(loop[0].x, loop[0].y);
      for (const point of loop.slice(1)) shape.lineTo(point.x, point.y);
      shape.closePath();
      return shape;
    });
    const geometry = new ExtrudeGeometry(shapes, { depth: 1, steps: 1, bevelEnabled: false });
    geometry.translate(0, 0, -0.5);
    try {
      const name = `Compound slice ${index + 1}`;
      const built = asset(name, modelGlb(name, geometry, [{ color: color(random(seed ^ index)) }]), null);
      return { ...built, width, height, centerY, mesh: { type: 'asset', assetId: built.id, collision: { type: 'slice', loops } } };
    } finally {
      geometry.dispose();
    }
  });
}
