import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Euler, ExtrudeGeometry,
  IcosahedronGeometry, LatheGeometry, Matrix4, Quaternion, Shape, SphereGeometry, TorusGeometry, Vector2, Vector3,
} from 'three';
import type { Point } from './config';

/**
 * A decoration model's geometry: the centre of its base at the origin, standing along +y and
 * facing +z, toward the camera. Lit surfaces and glowing ones (fire, windows, runes) are separate
 * geometries so each can have its own material; either may be null.
 */
export interface DecorationGeometry {
  readonly lit: BufferGeometry | null;
  readonly glow: BufferGeometry | null;
  // Natural size, from the model's bounds.
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

export interface Placement {
  readonly x?: number; readonly y?: number; readonly z?: number;
  // Rotations in radians, applied in X, Y, Z order.
  readonly rx?: number; readonly ry?: number; readonly rz?: number;
  readonly sx?: number; readonly sy?: number; readonly sz?: number;
}

export type Vec3 = readonly [number, number, number];

interface Part {
  readonly geometry: BufferGeometry;
  readonly color: Color;
  readonly glow: boolean;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function merge(parts: readonly Part[], offset: Vector3): BufferGeometry | null {
  if (parts.length === 0) return null;
  let count = 0;
  for (const part of parts) count += part.geometry.getAttribute('position').count;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  let at = 0;
  for (const part of parts) {
    const position = part.geometry.getAttribute('position');
    const normal = part.geometry.getAttribute('normal');
    for (let index = 0; index < position.count; index++, at++) {
      positions[at * 3] = position.getX(index) + offset.x;
      positions[at * 3 + 1] = position.getY(index) + offset.y;
      positions[at * 3 + 2] = position.getZ(index) + offset.z;
      normals[at * 3] = normal.getX(index);
      normals[at * 3 + 1] = normal.getY(index);
      normals[at * 3 + 2] = normal.getZ(index);
      colors[at * 3] = part.color.r;
      colors[at * 3 + 1] = part.color.g;
      colors[at * 3 + 2] = part.color.b;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Builds a model from simple solids, each placed, coloured and either lit or glowing, then merged
 * into at most two geometries with vertex colours. `random` is seeded, so a model is the same
 * every time it is built.
 */
export class ModelKit {
  readonly random: () => number;
  private readonly parts: Part[] = [];
  private readonly matrix = new Matrix4();
  private readonly rotation = new Quaternion();
  private readonly euler = new Euler();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();

  constructor(seed: number) {
    this.random = mulberry32(seed);
  }

  /** A value between `min` and `max`. */
  between(min: number, max: number): number {
    return min + (max - min) * this.random();
  }

  add(source: BufferGeometry, color: number, placement: Placement = {}, glow = false): this {
    const geometry = source.index === null ? source : source.toNonIndexed();
    if (geometry !== source) source.dispose();
    geometry.deleteAttribute('uv');
    if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
    this.euler.set(placement.rx ?? 0, placement.ry ?? 0, placement.rz ?? 0);
    this.matrix.compose(
      this.position.set(placement.x ?? 0, placement.y ?? 0, placement.z ?? 0),
      this.rotation.setFromEuler(this.euler),
      this.scale.set(placement.sx ?? 1, placement.sy ?? 1, placement.sz ?? 1),
    );
    geometry.applyMatrix4(this.matrix);
    this.parts.push({ geometry, color: new Color(color), glow });
    return this;
  }

  /** A box centred on its placement. */
  box(width: number, height: number, depth: number, color: number, placement?: Placement, glow = false): this {
    return this.add(new BoxGeometry(width, height, depth), color, placement, glow);
  }

  /** An upright cylinder or frustum centred on its placement. */
  cylinder(top: number, bottom: number, height: number, color: number, placement?: Placement, segments = 8, glow = false): this {
    return this.add(new CylinderGeometry(top, bottom, height, segments), color, placement, glow);
  }

  /** An upright cone centred on its placement. */
  cone(radius: number, height: number, color: number, placement?: Placement, segments = 8, glow = false): this {
    return this.add(new ConeGeometry(radius, height, segments), color, placement, glow);
  }

  sphere(radius: number, color: number, placement?: Placement, segments = 8, glow = false): this {
    return this.add(new SphereGeometry(radius, segments, Math.max(3, Math.round(segments * 0.6))), color, placement, glow);
  }

  /** A ring in the x-y plane, facing the camera until rotated. */
  torus(radius: number, tube: number, color: number, placement?: Placement, segments = 12, sides = 4): this {
    return this.add(new TorusGeometry(radius, tube, sides, segments), color, placement);
  }

  /** A faceted boulder: an icosahedron with its corners pushed in and out. */
  rock(radius: number, color: number, placement?: Placement, roughness = 0.25, glow = false): this {
    const geometry = new IcosahedronGeometry(radius, 0);
    const position = geometry.getAttribute('position');
    const corners = new Map<string, number>();
    for (let index = 0; index < position.count; index++) {
      const key = `${position.getX(index).toFixed(4)},${position.getY(index).toFixed(4)},${position.getZ(index).toFixed(4)}`;
      let factor = corners.get(key);
      if (factor === undefined) {
        factor = 1 + (this.random() * 2 - 1) * roughness;
        corners.set(key, factor);
      }
      position.setXYZ(index, position.getX(index) * factor, position.getY(index) * factor, position.getZ(index) * factor);
    }
    geometry.computeVertexNormals();
    return this.add(geometry, color, placement, glow);
  }

  /** A flat outline in the x-y plane, extruded `depth` along z and centred on it. */
  extrude(outline: readonly Point[], depth: number, color: number, placement: Placement = {}, holes: readonly (readonly Point[])[] = [], glow = false): this {
    const shape = new Shape(outline.map((point) => new Vector2(point.x, point.y)));
    for (const hole of holes) shape.holes.push(new Shape(hole.map((point) => new Vector2(point.x, point.y))));
    const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 6 });
    geometry.translate(0, 0, -depth / 2);
    return this.add(geometry, color, placement, glow);
  }

  /** A profile of (radius, height) points turned about the y axis. */
  lathe(profile: readonly Point[], color: number, placement?: Placement, segments = 10, glow = false): this {
    return this.add(new LatheGeometry(profile.map((point) => new Vector2(point.x, point.y)), segments), color, placement, glow);
  }

  /** A tapered cylinder from one point to another: branches, bars, legs and beams. */
  beam(from: Vec3, to: Vec3, fromRadius: number, toRadius: number, color: number, segments = 6, glow = false): this {
    const start = new Vector3(...from);
    const direction = new Vector3(...to).sub(start);
    const length = direction.length();
    if (length === 0) return this;
    const geometry = new CylinderGeometry(toRadius, fromRadius, length, segments);
    geometry.translate(0, length / 2, 0);
    geometry.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()));
    geometry.translate(start.x, start.y, start.z);
    return this.add(geometry, color, {}, glow);
  }

  /** Stands the model on its base centre and merges it. */
  build(): DecorationGeometry {
    const bounds = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
    for (const part of this.parts) {
      part.geometry.computeBoundingBox();
      bounds.min.min(part.geometry.boundingBox!.min);
      bounds.max.max(part.geometry.boundingBox!.max);
    }
    if (this.parts.length === 0) throw new Error('A decoration model needs at least one part.');
    const offset = new Vector3(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
    const lit = merge(this.parts.filter((part) => !part.glow), offset);
    const glow = merge(this.parts.filter((part) => part.glow), offset);
    for (const part of this.parts) part.geometry.dispose();
    this.parts.length = 0;
    return Object.freeze({
      lit, glow,
      width: bounds.max.x - bounds.min.x, height: bounds.max.y - bounds.min.y, depth: bounds.max.z - bounds.min.z,
    });
  }
}

/** Points along a pointed (gothic) arch from its left spring up to its apex. */
export function pointedArc(halfSpan: number, radius: number, base: number, steps = 6): Point[] {
  const centre = -halfSpan + radius;
  // Where the arc crosses x = 0, meeting its mirror image.
  const top = Math.acos(-centre / radius);
  const points: Point[] = [];
  for (let step = 0; step <= steps; step++) {
    const angle = Math.PI - (Math.PI - top) * (step / steps);
    points.push({ x: centre + radius * Math.cos(angle), y: base + radius * Math.sin(angle) });
  }
  return points;
}

/** Points along a round arch from its left spring over to its right spring. */
export function roundArc(halfSpan: number, base: number, steps = 8): Point[] {
  return Array.from({ length: steps + 1 }, (_, step) => {
    const angle = Math.PI * (1 - step / steps);
    return { x: halfSpan * Math.cos(angle), y: base + halfSpan * Math.sin(angle) };
  });
}

/**
 * A mirrored copy of any static geometry: flipped left to right, with its triangles wound the other
 * way so they still face out. Normals and tangents flip with it, so lighting and normal maps stay right.
 */
export function mirroredGeometry(source: BufferGeometry): BufferGeometry {
  const geometry = source.clone();
  for (const name of ['position', 'normal', 'tangent']) {
    const attribute = geometry.getAttribute(name);
    if (attribute === undefined) continue;
    for (let index = 0; index < attribute.count; index++) {
      attribute.setX(index, -attribute.getX(index));
      if (name === 'tangent') attribute.setW(index, -attribute.getW(index));
    }
  }
  const swap = (values: { [index: number]: number }, size: number, count: number): void => {
    for (let triangle = 0; triangle + 2 < count; triangle += 3) {
      for (let component = 0; component < size; component++) {
        const second = (triangle + 1) * size + component;
        const third = (triangle + 2) * size + component;
        const value = values[second]!;
        values[second] = values[third]!;
        values[third] = value;
      }
    }
  };
  const index = geometry.getIndex();
  if (index !== null) swap(index.array, 1, index.count);
  else for (const attribute of Object.values(geometry.attributes)) swap(attribute.array, attribute.itemSize, attribute.count);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
