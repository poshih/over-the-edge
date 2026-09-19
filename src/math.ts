import type { Point } from './config';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampLength(point: Readonly<Point>, maximum: number): Point {
  // Normalize before measuring so finite, very large input cannot overflow.
  const scale = Math.max(Math.abs(point.x), Math.abs(point.y), maximum);
  const x = point.x / scale;
  const y = point.y / scale;
  const length = Math.hypot(x, y);
  if (length <= maximum / scale) return { x: point.x, y: point.y };
  const radius = maximum / length;
  return { x: x * radius, y: y * radius };
}

export function angleDifference(target: number, current: number): number {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

export function transformPoint(point: Point, position: Point, angle: number): Point {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: position.x + point.x * cosine - point.y * sine,
    y: position.y + point.x * sine + point.y * cosine,
  };
}
