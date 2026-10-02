// What of a level shapes play: its colliders and their surfaces, its enemies, its updrafts and its start. Phantom
// recordings belong to a play layout, so edits that leave it alone, such as decorations, labels, colours, depth,
// course artwork or message text, keep a level's recordings. See docs/phantoms.md.
//
// It uses no DOM or three.js, and its imports carry extensions, like the phantom format.
import type { LevelDefinition } from './level.ts';

// Changes whenever what counts as the play layout does, so every course changes with it.
export const PHANTOM_LAYOUT_FORMAT = 1;

/**
 * The level's play layout as canonical JSON: per object, only what moves the player, without IDs, in a fixed order,
 * so neither renaming nor reordering objects changes it. A course is this text's SHA-256.
 */
export function phantomLayout(level: LevelDefinition): string {
  const entries: string[] = [];
  for (const object of level.objects) {
    let entry: unknown = null;
    switch (object.kind) {
      case 'terrain':
        entry = ['terrain', object.shape, object.x, object.y, object.width, object.height, object.angle, object.illusion, object.surface];
        break;
      case 'enemy':
        entry = ['enemy', object.species, object.x, object.y, object.facing, object.patrolDistance, object.speed];
        break;
      case 'start':
        entry = ['start', object.x, object.y, object.angle, object.reach];
        break;
      case 'trigger': {
        // Only launches move the player; messages, sounds, videos and the timer do not.
        const launches = object.events.flatMap((event) => event.type === 'launch-player' ? [[event.height, event.strength]] : []);
        if (launches.length > 0) entry = ['updraft', object.region, object.x, object.y, object.activation, launches];
        break;
      }
      case 'decoration':
        break;
      default: {
        // A new kind must say here whether it moves the player.
        const unknown: never = object;
        throw new Error(`Unknown level object ${JSON.stringify(unknown)}.`);
      }
    }
    if (entry !== null) entries.push(JSON.stringify(entry));
  }
  entries.sort();
  return `[${PHANTOM_LAYOUT_FORMAT},[${entries.join(',')}]]`;
}
