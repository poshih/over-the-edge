// Editor-only lookup of exposed terrain tops, used to rest set pieces on the surface under the pointer.
import type { Point } from '../config';
import { isTerrainObject, objectVertices } from '../level';
import type { LevelDefinition, TerrainObject } from '../level';

const COLUMN_WIDTH = 4;
const TOUCHING = 1e-4;

interface SurfaceEntry {
  readonly object: TerrainObject;
  readonly left: number;
  readonly right: number;
  readonly vertices: readonly Point[];
}

/**
 * Buckets terrain into vertical columns so each pointer query only inspects nearby objects. The
 * index is built lazily on the first query after a level change, so ordinary editing pays nothing.
 */
export class SurfaceIndex {
  private readonly source: () => LevelDefinition;
  private columns: Map<number, SurfaceEntry[]> | null = null;
  private buildCount = 0;

  constructor(source: () => LevelDefinition) {
    this.source = source;
  }

  get builds(): number { return this.buildCount; }

  invalidate(): void {
    this.columns = null;
  }

  /**
   * The exposed terrain top on the vertical line through `x` that is nearest to `y`, or null if none
   * lies within `reach`. Tops covered by touching or overlapping terrain are not exposed.
   */
  nearestTop(x: number, y: number, reach: number): number | null {
    const entries = this.index().get(Math.floor(x / COLUMN_WIDTH));
    if (entries === undefined) return null;
    const spans: [number, number][] = [];
    for (const entry of entries) {
      if (x >= entry.left && x <= entry.right) collectSpans(entry, x, spans);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let best: number | null = null;
    const consider = (top: number): void => {
      const distance = Math.abs(top - y);
      if (distance <= reach && (best === null || distance < Math.abs(best - y))) best = top;
    };
    let top = -Infinity;
    for (const [bottom, upper] of spans) {
      if (top !== -Infinity && bottom > top + TOUCHING) consider(top);
      top = Math.max(top, upper);
    }
    if (top !== -Infinity) consider(top);
    return best;
  }

  private index(): Map<number, SurfaceEntry[]> {
    if (this.columns !== null) return this.columns;
    this.buildCount++;
    const columns = new Map<number, SurfaceEntry[]>();
    for (const object of this.source().objects) {
      if (!isTerrainObject(object)) continue;
      const vertices = objectVertices(object);
      let left = Infinity;
      let right = -Infinity;
      for (const point of vertices) {
        left = Math.min(left, point.x);
        right = Math.max(right, point.x);
      }
      const entry: SurfaceEntry = { object, left, right, vertices };
      for (let column = Math.floor(left / COLUMN_WIDTH); column <= Math.floor(right / COLUMN_WIDTH); column++) {
        const list = columns.get(column);
        if (list === undefined) columns.set(column, [entry]);
        else list.push(entry);
      }
    }
    this.columns = columns;
    return columns;
  }
}

/** Appends the solid intervals where the vertical line through `x` crosses one terrain object. */
function collectSpans(entry: SurfaceEntry, x: number, spans: [number, number][]): void {
  const { object, vertices } = entry;
  if (object.shape.type === 'circle') {
    // Physics uses a true circle, so measure it analytically rather than from the render polygon.
    const radius = object.width / 2;
    const dx = x - object.x;
    if (Math.abs(dx) > radius) return;
    const half = Math.sqrt(radius * radius - dx * dx);
    spans.push([object.y - half, object.y + half]);
    return;
  }
  const crossings: number[] = [];
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
    const a = vertices[previous];
    const b = vertices[index];
    // Half-open test: each crossing counts once and vertical edges are skipped.
    if ((a.x > x) === (b.x > x)) continue;
    crossings.push(a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x));
  }
  crossings.sort((p, q) => p - q);
  for (let index = 0; index + 1 < crossings.length; index += 2) spans.push([crossings[index], crossings[index + 1]]);
}
