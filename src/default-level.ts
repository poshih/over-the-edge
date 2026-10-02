import { COURSE, COURSE_LABELS, START_SPAWN, ENDING_ZONE } from './course';
import { DEFAULT_SURFACE } from './surfaces';
import { LEVEL_SCHEMA_VERSION, terrainFromOutline, TRIGGER_LIMITS, validateLevel } from './level';
import type { LevelDefinition } from './level';
import { ENDING_EVENTS } from './trigger-events';

export const DEFAULT_LEVEL: LevelDefinition = validateLevel({
  schemaVersion: LEVEL_SCHEMA_VERSION,
  labels: COURSE_LABELS,
  objects: [...COURSE.map((terrain) => terrainFromOutline({ ...terrain, surface: DEFAULT_SURFACE })),
  {
    kind: 'start', id: 'player-start', ...START_SPAWN.position,
    angle: START_SPAWN.angle, reach: START_SPAWN.reach,
  },
  {
    kind: 'trigger', id: 'ending-trigger', name: 'Ending',
    x: (ENDING_ZONE.xMin + ENDING_ZONE.xMax) / 2,
    y: ENDING_ZONE.y - ENDING_ZONE.arrivalTolerance + TRIGGER_LIMITS.endingHeight / 2,
    region: { type: 'box', width: ENDING_ZONE.xMax - ENDING_ZONE.xMin, height: TRIGGER_LIMITS.endingHeight },
    activation: 'once', marker: 'flag', events: ENDING_EVENTS,
  }],
});
