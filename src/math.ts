import type { Point } from './config';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
