// What shapes play on a level: its colliders and surfaces, enemies, traps, bonfires, pools and platforms, its triggers'
// launches, trap bursts and platform moves, its start, and the physics the game runs with. Phantom recordings belong
// to a course, the SHA-256 of this text. Decorations, labels, colours, depth, swapping a mesh for one that collides
// alike, message text, control sensitivity or the cursor leave it alone, keeping recordings. See docs/phantoms.md.
//
// It uses no DOM or three.js.
import { RIG_FIELDS, TUNING_FIELDS } from './game-settings';
import type { GameSettings } from './game-settings';
import { terrainCollision } from './level';
import type { LevelDefinition, PlatformObject, ShooterObject } from './level';

// Changes whenever what counts toward a course does, so every course changes with it.
export const PHANTOM_COURSE_FORMAT = 9;

// The physics settings that move the player: every tuning field but the controls', and the hammer rig with the default
// hammer's head and the jar. A library hammer's own head is a cosmetic's: recordings made with it join the course.
const PHYSICS_FIELDS = TUNING_FIELDS.filter((field) => field.group !== 'Input').map((field) => field.key).sort();
const RIG_KEYS = RIG_FIELDS.map((field) => field.key).sort();

function shooterEntry(object: ShooterObject) {
  return ['shooter', object.firing, object.x, object.y, object.angle, object.interval, object.delay, object.speed, object.damage];
}

function platformEntry(object: PlatformObject) {
  return ['platform', object.x, object.y, object.ride, object.travelX, object.travelY, object.width, object.height, object.speed, object.surface];
}

function targetEntry(entries: ReadonlyMap<string, string>, id: string): string {
  const entry = entries.get(id);
  if (entry === undefined) throw new Error(`Validated levels must contain trigger target "${id}".`);
  return entry;
}

/**
 * The level's play layout and physics as canonical JSON: per object, only what moves the player, without IDs, in a
 * fixed order, so neither renaming nor reordering objects changes it; then the physics and hammer rig settings, by
 * name. A course is this text's SHA-256.
 */
export function phantomCourseText(level: LevelDefinition, settings: GameSettings): string {
  const entries: string[] = [];
  const shooters = new Map<string, string>();
  const platforms = new Map<string, string>();
  for (const object of level.objects) {
    if (object.kind === 'shooter') {
      shooters.set(object.id, JSON.stringify(shooterEntry(object)));
    } else if (object.kind === 'platform') {
      platforms.set(object.id, JSON.stringify(platformEntry(object)));
    }
  }
  for (const object of level.objects) {
    let entry: unknown = null;
    switch (object.kind) {
      case 'terrain':
        // Its collision as placed, mirrored or not: meshes that collide alike count alike.
        entry = ['terrain', terrainCollision(object), object.x, object.y, object.width, object.height, object.angle, object.illusion, object.surface];
        break;
      case 'enemy':
        entry = ['enemy', object.species, object.x, object.y, object.facing, object.patrolDistance, object.speed];
        break;
      case 'start':
        entry = ['start', object.x, object.y, object.angle, object.reach];
        break;
      case 'trigger': {
        // Only actions that move the player or alter moving hazards/platforms count toward the course.
        const events = object.events.flatMap((event) => {
          if (event.type === 'launch-player') return [['launch-player', event.height, event.strength]];
          if (event.type === 'fire-trap') return [['fire-trap', targetEntry(shooters, event.trap), event.shots]];
          if (event.type === 'move-platform') return [['move-platform', targetEntry(platforms, event.platform), event.to]];
          return [];
        });
        if (events.length > 0) entry = ['trigger', object.region, object.x, object.y, object.activation, events];
        break;
      }
      case 'bonfire':
        entry = ['bonfire', object.x, object.y];
        break;
      case 'shooter':
        entry = shooterEntry(object);
        break;
      case 'axe':
        entry = ['axe', object.x, object.y, object.length, object.period, object.offset, object.damage];
        break;
      case 'pool':
        // Its liquid's box; its depth is only drawn.
        entry = ['pool', object.liquid, object.x, object.y, object.width, object.height];
        break;
      case 'platform':
        // Its depth is only drawn.
        entry = platformEntry(object);
        break;
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
  const physics = Object.fromEntries(PHYSICS_FIELDS.map((key) => [key, settings.physics[key]]));
  const rig = { ...Object.fromEntries(RIG_KEYS.map((key) => [key, settings.rig[key]])), head: settings.rig.head, pot: settings.rig.pot };
  return `[${PHANTOM_COURSE_FORMAT},[${entries.join(',')}],${JSON.stringify(physics)},${JSON.stringify(rig)}]`;
}
