import { RIG } from './config';
import { fields, LevelError, number, point } from './level-validation';
import { ENDING_EVENTS } from './trigger-events';

export function upgradeLevelV1(value: unknown, limits: {
  coordinate: number;
  objects: number;
  endingHeight: number;
}): unknown {
  fields(value, ['schemaVersion', 'spawn', 'summit', 'labels', 'objects'], 'Legacy level');
  if (value.schemaVersion !== 1) throw new LevelError('This level format is not supported.');
  fields(value.spawn, ['position', 'angle', 'extension'], 'Player start');
  const position = point(value.spawn.position, limits.coordinate, 'Player start');
  const angle = number(value.spawn.angle, -Math.PI, Math.PI, 'Starting hammer angle');
  const extension = number(value.spawn.extension, RIG.minExtension, RIG.maxExtension, 'Starting extension');
  fields(value.summit, ['xMin', 'xMax', 'y', 'arrivalTolerance'], 'Summit');
  const left = number(value.summit.xMin, -limits.coordinate, limits.coordinate, 'Summit left');
  const right = number(value.summit.xMax, -limits.coordinate, limits.coordinate, 'Summit right');
  const height = number(value.summit.y, -limits.coordinate, limits.coordinate, 'Summit height');
  const tolerance = number(value.summit.arrivalTolerance, 0, 0.25, 'Summit tolerance');
  if (right <= left) throw new LevelError('The summit right edge must be to the right of its left edge.');
  if (!Array.isArray(value.objects) || value.objects.length > limits.objects) {
    throw new LevelError(`A level supports up to ${limits.objects} terrain objects.`);
  }
  const objects = value.objects.map((object) => {
    fields(object, ['id', 'shape', 'x', 'y', 'width', 'height', 'angle', 'depth', 'color', 'illusion'], 'Legacy terrain object');
    return { ...object, id: object.id, kind: 'terrain' };
  });
  const ids = new Set(objects.map((object) => object.id));
  const uniqueId = (base: string): string => {
    let id = base;
    for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`;
    ids.add(id);
    return id;
  };
  return {
    schemaVersion: 2, labels: value.labels,
    objects: [
      ...objects,
      { kind: 'start', id: uniqueId('player-start'), ...position, angle, extension },
      {
        kind: 'trigger', id: uniqueId('ending-trigger'), name: 'Ending',
        x: (left + right) / 2, y: height - tolerance + limits.endingHeight / 2,
        region: { type: 'box', width: right - left, height: limits.endingHeight },
        activation: 'once', marker: 'flag',
        events: ENDING_EVENTS,
      },
    ],
  };
}
