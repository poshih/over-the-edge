import { COURSE, COURSE_LABELS, START_SPAWN, SUMMIT } from './course';
import { validateLevel } from './level';
import type { LevelDefinition } from './level';

export const DEFAULT_LEVEL: LevelDefinition = validateLevel({
  schemaVersion: 1,
  spawn: START_SPAWN,
  summit: SUMMIT,
  labels: COURSE_LABELS,
  objects: COURSE.map((terrain) => {
    const minX = Math.min(...terrain.vertices.map((point) => point.x));
    const maxX = Math.max(...terrain.vertices.map((point) => point.x));
    const minY = Math.min(...terrain.vertices.map((point) => point.y));
    const maxY = Math.max(...terrain.vertices.map((point) => point.y));
    const x = (minX + maxX) / 2;
    const y = (minY + maxY) / 2;
    const width = maxX - minX;
    const height = maxY - minY;
    return {
      id: terrain.id,
      shape: { type: 'polygon', vertices: terrain.vertices.map((point) => ({
        x: (point.x - x) / width, y: (point.y - y) / height,
      })) },
      x, y, width, height, angle: 0, color: terrain.color, depth: terrain.depth, illusion: false,
    };
  }),
});
