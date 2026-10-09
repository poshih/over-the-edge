#!/usr/bin/env node
// Builds the special-object showcase: npm run generate:showcase
// Open showcase in Workshop / Level / Server levels, or use GAME_LEVEL=levels/showcase.json.
// Change this authored layout, not the generated JSON; engine validation and geometry gates run before writing.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createEngineServer } from '../engine-loader.ts';
import { loadCourseEngine } from '../course-kit/engine.ts';
import type { CourseEngine } from '../course-kit/engine.ts';
import { createCourseJob } from '../course-kit/job.ts';
import type { CourseSnapshot } from '../course-kit/job.ts';
import type { DecorationObject, LevelDefinition, LevelLabel, LevelObject, TerrainObject, TriggerObject } from '../../src/level.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('../../levels/showcase.json', import.meta.url);
const tidy = (value: number) => Number(value.toFixed(4)) + 0;

// The surfaces heading shares Rock's label, and the two traps share one, to fit the engine's 16-label limit.
const LABELS = [
  { x: 0, y: 2.2, text: '01 / SHOWCASE - HEAD RIGHT' },
  { x: 6, y: 1.9, text: '02 / SURFACES: ROCK' },
  { x: 9.6, y: 1.9, text: 'WOOD' },
  { x: 13.2, y: 1.9, text: 'METAL' },
  { x: 16.8, y: 1.9, text: 'ICE' },
  { x: 20.4, y: 1.9, text: 'RUBBER' },
  { x: 30, y: 2.2, text: '03 / ILLUSION: WAIT; THEN DROP' },
  { x: 37, y: 2.2, text: '04 / BONFIRE: CHECKPOINT' },
  { x: 50.8, y: 3, text: '05 / TRAPS: TIMER; SWITCH BURST' },
  { x: 64, y: 4.2, text: '06 / AXE: TIME YOUR CROSSING' },
  { x: 73.5, y: 2.2, text: '07 / SWAMP; LAVA AHEAD - DANGER' },
  { x: 92, y: 3.5, text: '08 / BIRD, SOLDIER & ARCHER' },
  { x: 101.5, y: 2.5, text: '09 / UPDRAFT: REACH THE LEDGE' },
  { x: 109.3, y: 2.8, text: '10 / LIFT: STEP ON; SWITCHES CALL' },
  { x: 124.5, y: 8.3, text: '11 / SWITCH BRIDGE; FERRY' },
  { x: 140, y: 8.3, text: '12 / FINISH: TIMER STOPPED' },
] satisfies readonly LevelLabel[];

const SURFACES = [
  { surface: 'rock', x: 6, color: 0x71817a },
  { surface: 'wood', x: 9.6, color: 0x876447 },
  { surface: 'metal', x: 13.2, color: 0x8b94a0 },
  { surface: 'ice', x: 16.8, color: 0x9fd8e6 },
  { surface: 'rubber', x: 20.4, color: 0x766596 },
] satisfies readonly Pick<TerrainObject, 'surface' | 'x' | 'color'>[];

function showcase({ shapeMesh, LEVEL_SCHEMA_VERSION }: Pick<CourseEngine['level'], 'shapeMesh' | 'LEVEL_SCHEMA_VERSION'>): LevelDefinition {
  const mesh = shapeMesh('box');
  const block = (id: string, left: number, right: number, bottom: number, top: number, {
    surface = 'rock', color = 0x56684c, illusion = false, depth = 3,
  }: Partial<Pick<TerrainObject, 'surface' | 'color' | 'illusion' | 'depth'>> = {}): TerrainObject => ({
    kind: 'terrain', id, mesh,
    x: tidy((left + right) / 2), y: tidy((bottom + top) / 2),
    width: tidy(right - left), height: tidy(top - bottom),
    angle: 0, depth, mirror: false, color, illusion, surface,
  });
  const trigger = (id: string, name: string, x: number, floor: number, width: number, height: number,
    marker: TriggerObject['marker'], events: TriggerObject['events'], activation: TriggerObject['activation'] = 'on-enter'): TriggerObject => ({
    kind: 'trigger', id, name, x, y: tidy(floor + height / 2),
    region: { type: 'box', width, height }, activation, marker, events,
  });
  const decoration = (id: string, model: string, x: number, y: number, height: number): DecorationObject => ({
    kind: 'decoration', id, model, x, y, z: -0.8,
    height, angle: 0, mirror: false, tint: 0xffffff,
  });

  const objects: LevelObject[] = [
    block('start-ground', -4, 28, -2, 0),
    { kind: 'start', id: 'player-start', x: 0, y: 0.65, angle: -0.42, reach: 1.7 },
    trigger('welcome', 'Welcome to the showcase', 0.5, 0, 3, 1.8, 'none', [{
      type: 'message', title: 'Special-object showcase',
      message: 'Head right through twelve labelled stations. Try each surface, let the illusion give way, and light the bonfire. The hammer head can shield trap bolts and arrows. Wait for the axe, keep the pot out of lava, take the updraft and the lift, then raise the bridge and ride the ferry to the finish.',
    }], 'once'),
    decoration('start-lantern', 'lantern-post', 2, 0, 2.6),

    // Each surface block is 2.2 m wide, with 1.4 m of open ground between blocks.
    ...SURFACES.map(({ surface, x, color }) =>
      block(`surface-${surface}`, x - 1.1, x + 1.1, 0, 0.7, { surface, color, depth: 2.4 })),

    // The bridge disappears onto a floor only 1 m below; either bank remains reachable.
    block('illusion-basin-floor', 28, 32, -2, -1),
    block('illusion-bridge', 28, 32, -0.35, 0, { illusion: true, color: 0x71817a, depth: 2.4 }),
    block('middle-ground', 32, 69, -2, 0),

    // The next raised collider starts at x = 42, leaving 5 m clear to the bonfire's right.
    { kind: 'bonfire', id: 'showcase-bonfire', x: 37, y: 0 },
    decoration('checkpoint-brazier', 'brazier', 35.5, 0, 1.4),

    // Muzzles sit just inside wall faces; the opposite wall contains each lane's bolts.
    block('timer-trap-wall', 42, 43.8, 0, 1.8, { color: 0x686f75 }),
    {
      kind: 'shooter', id: 'timer-trap', firing: 'timer',
      x: 43.78, y: 1.15, angle: 0, interval: 3, delay: 1, speed: 7, damage: 20,
    },
    block('timer-trap-stop', 47.8, 49.6, 0, 1.8, { color: 0x686f75 }),

    block('burst-trap-stop', 52, 53.8, 0, 1.8, { color: 0x686f75 }),
    trigger('burst-switch', 'Three-shot shield practice', 55.8, 0, 1.2, 0.5, 'switch', [
      { type: 'fire-trap', trap: 'burst-trap', shots: 3 },
    ]),
    block('burst-trap-wall', 57.8, 59.6, 0, 1.8, { color: 0x686f75 }),
    {
      kind: 'shooter', id: 'burst-trap', firing: 'trigger',
      x: 57.82, y: 1.15, angle: Math.PI, interval: 0.7, delay: 0.75, speed: 6, damage: 20,
    },

    { kind: 'axe', id: 'walkway-axe', x: 64, y: 3.75, length: 2.6, period: 4, offset: 0.5, damage: 20 },

    // Banks and lower floors contain both pools; only the 1.8 m lava crossing needs a vault.
    block('swamp-basin-floor', 69, 73, -2, -0.8),
    { kind: 'pool', id: 'swamp-pool', liquid: 'swamp', x: 71, y: -0.425, width: 4, height: 0.75, depth: 2.4 },
    block('pool-bank', 73, 77, -2, 0),
    decoration('pool-brazier', 'brazier', 75.5, 0, 1.4),
    block('lava-basin-floor', 77, 78.8, -2, -0.8),
    { kind: 'pool', id: 'lava-pool', liquid: 'lava', x: 77.9, y: -0.45, width: 1.8, height: 0.7, depth: 2.4 },
    trigger('lava-warning', 'Lava crossing', 76.2, 0, 1.2, 1.4, 'none', [{
      type: 'message', title: 'Lava ahead',
      message: 'Lava burns the pot. Hook the far bank with the hammer to cross the 1.8 m gap without dipping in.',
    }], 'once'),
    block('enemy-ground', 78.8, 103, -2, 0),

    // Separate patrols on an open apron leave room to retreat or hammer over the soldier. The archer holds the
    // apron's far end, short of the updraft, and arcs arrows at a player crossing it; the head can shield them.
    { kind: 'enemy', id: 'showcase-bird', species: 'bird', x: 87, y: 2.4, facing: 'right', patrolDistance: 1, speed: 0.8 },
    { kind: 'enemy', id: 'showcase-soldier', species: 'hollow-soldier', x: 94, y: 0.71, facing: 'left', patrolDistance: 1.5, speed: 0.5 },
    { kind: 'enemy', id: 'showcase-archer', species: 'hollow-archer', x: 99.6, y: 0.71, facing: 'left', patrolDistance: 0, speed: 0.6 },

    // The draft's column ends at x = 102.5; its ledge starts at 103, outside the shaft.
    trigger('ledge-updraft', 'Updraft to the ledge', 101.9, 0, 1.2, 1.4, 'updraft', [
      { type: 'launch-player', height: 5.5, strength: 1 },
    ]),
    block('updraft-ledge', 103, 106, -2, 3.6, { color: 0x71817a }),
    block('ledge-down-step', 106, 108, -2, 1.8),
    block('lift-bottom-landing', 108, 110.4, -2, 0),

    // The deck has 0.4 m side gaps, 0.6 m beneath it at rest, and arrives flush at y = 6.2.
    block('lift-shaft-floor', 110.4, 113.6, -2, -0.8),
    {
      kind: 'platform', id: 'showcase-lift', ride: true,
      x: 112, y: 0, travelX: 0, travelY: 6,
      width: 2.4, height: 0.4, depth: 2.4, speed: 1.2, surface: 'metal',
    },
    block('lift-top-landing', 113.6, 120, -2, 6.2, { color: 0x71817a }),
    trigger('lift-bottom-call', 'Call lift to bottom', 109.5, 0, 1.2, 0.5, 'switch', [
      { type: 'move-platform', platform: 'showcase-lift', to: 'start' },
    ]),
    trigger('lift-top-call', 'Call lift to top', 115.4, 6.2, 1.2, 0.5, 'switch', [
      { type: 'move-platform', platform: 'showcase-lift', to: 'end' },
    ]),
    trigger('lift-instructions', 'How to ride the lift', 109.2, 0, 2, 1.8, 'none', [{
      type: 'message', title: 'Ride the lift',
      message: 'Step on the lift to ride; landing switches call it. The bottom switch calls it down and the top switch calls it up. Step off briefly before boarding again to return.',
    }], 'once'),

    // A switch on either bank raises the bridge flush with the banks, 0.4 m clear of each pit wall, or lowers it again
    // to 0.6 m above the pit floor; standing on it never moves it. Each switch sits clear of the edge, so the pot is
    // off the bridge before it can lower it, and the pit is 2 m deep, so a fall can climb back out.
    trigger('platform-instructions', 'How the bridge and ferry work', 116.9, 6.2, 1.4, 1.8, 'none', [{
      type: 'message', title: 'Switch bridge and ferry',
      message: 'Either switch raises the bridge or lowers it again; standing on the bridge never moves it. Step on the ferry to ride across, and step off briefly before boarding again to ride back.',
    }], 'once'),
    trigger('bridge-near-switch', 'Raise or lower the bridge', 118.6, 6.2, 1.2, 0.5, 'switch', [
      { type: 'move-platform', platform: 'switch-bridge', to: 'toggle' },
    ]),
    block('bridge-pit-floor', 120, 123, -2, 4.2),
    {
      kind: 'platform', id: 'switch-bridge', ride: false,
      x: 121.5, y: 5, travelX: 0, travelY: 1,
      width: 2.2, height: 0.4, depth: 2.4, speed: 1, surface: 'wood',
    },
    block('bridge-far-bank', 123, 126, -2, 6.2, { color: 0x71817a }),
    trigger('bridge-far-switch', 'Raise or lower the bridge', 124.8, 6.2, 1.2, 0.5, 'switch', [
      { type: 'move-platform', platform: 'switch-bridge', to: 'toggle' },
    ]),

    // The ferry's deck runs flush with both banks, 0.4 m clear of each, 1.6 m above a chasm floor 2 m down.
    block('ferry-chasm-floor', 126, 134, -2, 4.2),
    {
      kind: 'platform', id: 'showcase-ferry', ride: true,
      x: 127.6, y: 6, travelX: 4.8, travelY: 0,
      width: 2.4, height: 0.4, depth: 2.4, speed: 1.5, surface: 'wood',
    },
    block('finish-ground', 134, 146, -2, 6.2, { color: 0x71817a }),

    trigger('finish-flag', 'Showcase complete', 140, 6.2, 2.6, 3, 'flag', [
      { type: 'stop-timer' },
      { type: 'message', title: 'Showcase complete', message: 'You have tried every special-object station. The timer is stopped; explore back along the route or restart to try them again.' },
    ], 'once'),
    decoration('finish-banner', 'banner', 142.5, 6.2, 2.4),
  ];
  return { schemaVersion: LEVEL_SCHEMA_VERSION, name: 'Showcase', labels: LABELS, objects };
}

// The kit indexes terrain, not platforms. Check every platform's whole sweep explicitly.
function platformClearance(snapshot: CourseSnapshot) {
  return snapshot.level.objects.filter((object) => object.kind === 'platform').flatMap((platform) => {
    const bounds = {
      left: Math.min(platform.x, platform.x + platform.travelX) - platform.width / 2,
      right: Math.max(platform.x, platform.x + platform.travelX) + platform.width / 2,
      bottom: Math.min(platform.y, platform.y + platform.travelY) - platform.height / 2,
      top: Math.max(platform.y, platform.y + platform.travelY) + platform.height / 2,
    };
    const sweep = snapshot.queries.rectangle(bounds);
    return snapshot.candidates(bounds)
      .filter((record) => snapshot.queries.intersection(sweep, record.solid) === 'overlapping')
      .map((record) => `${platform.id} travels through ${record.object.id}`);
  });
}

const server = await createEngineServer(root);
try {
  const engine = await loadCourseEngine(server);
  const { crampedColliders, overlaps, ventShafts } = engine.checks;
  const snapshot = createCourseJob(engine).prepare(showcase(engine.level));
  const groups = new Map(snapshot.level.objects.map((object) => [
    object.id, { group: object.id, zone: 'showcase' },
  ]));
  const problems = [
    ...[...crampedColliders(snapshot, groups, []), ...ventShafts(snapshot, groups), ...overlaps(snapshot, groups)]
      .map((finding) => finding.message),
    ...platformClearance(snapshot),
  ];
  if (problems.length > 0) {
    console.error(`Showcase geometry failed; no level written:\n${problems.join('\n')}`);
    process.exitCode = 1;
  } else {
    await writeFile(output, `${JSON.stringify(snapshot.level, null, 2)}\n`);
    const counts: Partial<Record<LevelObject['kind'], number>> = {};
    for (const object of snapshot.level.objects) counts[object.kind] = (counts[object.kind] ?? 0) + 1;
    console.log(`Wrote levels/showcase.json: schema ${snapshot.level.schemaVersion}, ${snapshot.level.objects.length} objects, ${snapshot.level.labels.length} labels.`);
    console.log(Object.entries(counts).map(([kind, count]) => `${kind}: ${count}`).join(', '));
    console.log('Passed engine validation, cramped colliders, vent shafts, overlaps and platform clearance.');
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();
}
