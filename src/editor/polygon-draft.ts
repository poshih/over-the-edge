import type { Point } from '../config';
import { LEVEL_LIMITS, LevelError } from '../level';
import { clamp } from '../math';

export const DRAWING = {
  samplePixels: 4,
  tolerancePixels: 2,
  closePixels: 14,
  vertexPixels: 3,
  samples: 2048,
} as const;

function segmentDistanceSquared(point: Readonly<Point>, a: Readonly<Point>, b: Readonly<Point>): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length, 0, 1);
  return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
}

function simplifyStroke(points: readonly Readonly<Point>[], tolerance: number): readonly Readonly<Point>[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const sections = [{ first: 0, last: points.length - 1 }];
  for (let index = 0; index < sections.length; index++) {
    const { first, last } = sections[index];
    let farthest = -1;
    let distance = tolerance * tolerance;
    for (let point = first + 1; point < last; point++) {
      const next = segmentDistanceSquared(points[point], points[first], points[last]);
      if (next > distance) { distance = next; farthest = point; }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      sections.push({ first, last: farthest }, { first: farthest, last });
    }
  }
  return points.filter((_point, index) => keep[index] === 1);
}

export class PolygonDraft {
  private points: readonly Readonly<Point>[] = [];
  private readonly history: number[] = [];

  get vertices(): readonly Readonly<Point>[] { return this.points; }

  append(
    samples: readonly Readonly<Point>[],
    options: { tolerance: number; closeDistance: number },
  ): 'open' | 'closed' {
    if (samples.length === 0) throw new Error('A drawing stroke needs an initial point.');
    let addition = simplifyStroke(samples, options.tolerance);
    const previous = this.points.at(-1);
    if (previous !== undefined && Math.hypot(previous.x - addition[0].x, previous.y - addition[0].y) <= options.tolerance) {
      addition = addition.slice(1);
    }
    const next = [...this.points, ...addition];
    const first = next[0];
    const last = next.at(-1);
    const closed = next.length >= 4 && last !== undefined &&
      Math.hypot(first.x - last.x, first.y - last.y) <= options.closeDistance;
    if (closed) next.pop();
    if (next.length > LEVEL_LIMITS.polygonVertices) {
      throw new LevelError(`The outline exceeds ${LEVEL_LIMITS.polygonVertices} points. This stroke was not added; draw a simpler outline.`);
    }
    if (next.length > this.points.length) {
      this.history.push(this.points.length);
      this.points = next;
    }
    return closed ? 'closed' : 'open';
  }

  undo(): void {
    const start = this.history.pop();
    if (start !== undefined) this.points = this.points.slice(0, start);
  }

  clear(): void {
    this.points = [];
    this.history.length = 0;
  }
}
