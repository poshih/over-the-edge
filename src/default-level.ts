import { COURSE, COURSE_LABELS, START_SPAWN, ENDING_ZONE } from './course';
import { TRIGGER_LIMITS, validateLevel } from './level';
import type { LevelDefinition } from './level';
import { ENDING_EVENTS } from './trigger-events';

export const DEFAULT_LEVEL: LevelDefinition = validateLevel({
  schemaVersion: 2,
  labels: COURSE_LABELS,
  objects: [...COURSE.map((terrain) => {
    const minX = Math.min(...terrain.vertices.map((point) => point.x));
    const maxX = Math.max(...terrain.vertices.map((point) => point.x));
    const minY = Math.min(...terrain.vertices.map((point) => point.y));
    const maxY = Math.max(...terrain.vertices.map((point) => point.y));
    const x = (minX + maxX) / 2;
    const y = (minY + maxY) / 2;
    const width = maxX - minX;
    const height = maxY - minY;
    return {
      kind: 'terrain', id: terrain.id,
      shape: { type: 'polygon', vertices: terrain.vertices.map((point) => ({
        x: (point.x - x) / width, y: (point.y - y) / height,
      })) },
      x, y, width, height, angle: 0, color: terrain.color, depth: terrain.depth, illusion: false,
    };
  }),
  {
    kind: 'start', id: 'player-start', ...START_SPAWN.position,
    angle: START_SPAWN.angle, extension: START_SPAWN.extension,
  },
  {
    kind: 'trigger', id: 'ending-trigger', name: 'Ending',
    x: (ENDING_ZONE.xMin + ENDING_ZONE.xMax) / 2,
    y: ENDING_ZONE.y - ENDING_ZONE.arrivalTolerance + TRIGGER_LIMITS.endingHeight / 2,
    region: { type: 'box', width: ENDING_ZONE.xMax - ENDING_ZONE.xMin, height: TRIGGER_LIMITS.endingHeight },
    activation: 'once', marker: 'flag', events: ENDING_EVENTS,
  }],
});
