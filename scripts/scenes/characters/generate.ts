#!/usr/bin/env node
// Builds the characters example scene: npm run generate:characters
// Open it in Workshop / Project / Example scenes. Scenes stay in the Workshop: game builds refuse the scenes folder.
// Change this generator and the figures in models.ts, not the files it writes. The engine checks the level, each model
// and the whole project, and bakes each model's root motion, before anything is written.
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineServer, loadEngineModule } from '../../engine-loader.ts';
import { loadCourseEngine } from '../../course-kit/engine.ts';
import type { CourseEngine } from '../../course-kit/engine.ts';
import { createCourseJob } from '../../course-kit/job.ts';
import type { EnemyClipRole } from '../../../src/enemy-motion-data.ts';
import type { EnemySpecies } from '../../../src/enemy-types.ts';
import type { DecorationObject, EnemyObject, LevelDefinition, LevelLabel, LevelObject, TerrainObject, TriggerObject } from '../../../src/level.ts';
import { ARCHER_CLIPS, carrionCrow, CROW_CLIPS, hollowArcher, hollowSoldier, SOLDIER_CLIPS } from './models.ts';
import { skinnedGlb } from './rig.ts';
import type { Rig } from './rig.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const SCENE = 'scenes/characters';
const TITLE = 'Characters demo';
const tidy = (value: number) => Number(value.toFixed(4)) + 0;
// Indented JSON with each array of numbers, such as a clip's baked travel, on one line.
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)
  .replace(/\[\s+(-?[\d.e+]+(?:,\s+-?[\d.e+]+)*)\s+\]/g, (_, list: string) => `[${list.split(/,\s+/).join(', ')}]`)}\n`;

// Each species, drawn by its figure, playing its clips. A ground enemy stands with its collider on the ground.
const FIGURES: readonly { species: EnemySpecies; rig: () => Rig; clips: Readonly<Partial<Record<EnemyClipRole, string>>> }[] = [
  { species: 'hollow-soldier', rig: hollowSoldier, clips: SOLDIER_CLIPS },
  { species: 'hollow-archer', rig: hollowArcher, clips: ARCHER_CLIPS },
  { species: 'bird', rig: carrionCrow, clips: CROW_CLIPS },
];

const LABELS = [
  { x: 0, y: 2.6, text: '01 / CHARACTERS - HEAD RIGHT' },
  { x: 4.5, y: 2, text: 'REST HERE TO BRING EVERY ENEMY BACK' },
  { x: 13, y: 3, text: '02 / SOLDIER: EACH STEP LANDS WHERE IT WALKS' },
  { x: 25, y: 3, text: '03 / FASTER PATROL, FASTER STRIDE' },
  { x: 38, y: 3, text: '04 / ARCHER: DRAW, LOOSE, RELOAD' },
  { x: 50, y: 3, text: '05 / ARCHER ON PATROL' },
  { x: 62, y: 4.4, text: '06 / CROW: HOVER, DIVE, FLY HOME' },
  { x: 70, y: 3.6, text: '07 / FINISH' },
] satisfies readonly LevelLabel[];

function characters({ shapeMesh, LEVEL_SCHEMA_VERSION }: Pick<CourseEngine['level'], 'shapeMesh' | 'LEVEL_SCHEMA_VERSION'>): LevelDefinition {
  const mesh = shapeMesh('box');
  const block = (id: string, left: number, right: number, bottom: number, top: number, color = 0x56684c): TerrainObject => ({
    kind: 'terrain', id, mesh,
    x: tidy((left + right) / 2), y: tidy((bottom + top) / 2), width: tidy(right - left), height: tidy(top - bottom),
    angle: 0, depth: 3, mirror: false, color, illusion: false, surface: 'rock',
  });
  const trigger = (id: string, name: string, x: number, width: number, height: number, marker: TriggerObject['marker'],
    events: TriggerObject['events']): TriggerObject => ({
    kind: 'trigger', id, name, x, y: tidy(height / 2), region: { type: 'box', width, height }, activation: 'once', marker, events,
  });
  // Ground enemies stand on the ground, their colliders 1.4 m tall.
  const enemy = (id: string, species: EnemySpecies, x: number, y: number, patrolDistance: number, speed: number): EnemyObject => ({
    kind: 'enemy', id, species, x, y, facing: 'left', patrolDistance, speed,
  });
  const decoration = (id: string, model: string, x: number, height: number): DecorationObject => ({
    kind: 'decoration', id, model, x, y: 0, z: -0.8, height, angle: 0, turn: 0, mirror: false, tint: 0xffffff,
  });
  const objects: LevelObject[] = [
    block('ground', -10, 74, -2, 0),
    block('west-wall', -12, -10, -2, 8, 0x4b5a47),
    block('east-wall', 74, 76, -2, 8, 0x4b5a47),
    { kind: 'start', id: 'player-start', x: 0, y: 0.65, angle: -0.42, reach: 1.7 },
    trigger('welcome', 'Characters demo', 0.5, 3, 1.8, 'none', [{
      type: 'message', title: 'Characters demo',
      message: 'Every enemy here is a 3D character playing its own animation clips. Soldiers and archers walk as far as '
        + 'their clips step, so their feet land as they go; strike one with the hammer and it reels away from the blow, '
        + 'then falls. Rest at the bonfire to bring every enemy back. Example scenes stay in the Workshop: save this one as '
        + 'your own project to build a game from it.',
    }]),
    { kind: 'bonfire', id: 'rest-bonfire', x: 4.5, y: 0 },
    enemy('soldier-patrol', 'hollow-soldier', 13, 0.71, 3, 0.8),
    enemy('soldier-march', 'hollow-soldier', 25, 0.71, 3, 1.6),
    enemy('archer-post', 'hollow-archer', 38, 0.71, 0, 0.6),
    enemy('archer-patrol', 'hollow-archer', 50, 0.71, 2.5, 0.6),
    enemy('crow', 'bird', 62, 2.6, 2, 1.2),
    trigger('finish-flag', 'Demo complete', 70, 2.6, 3, 'flag', [
      { type: 'stop-timer' },
      { type: 'message', title: 'Demo complete', message: 'Head back to watch them again, or rest at the bonfire to bring them back.' },
    ]),
    decoration('lantern-soldiers', 'lantern-post', 8, 2.6),
    decoration('lantern-march', 'lantern-post', 19.5, 2.6),
    decoration('lantern-archers', 'lantern-post', 31.5, 2.6),
    decoration('lantern-patrol', 'lantern-post', 44, 2.6),
    decoration('lantern-crow', 'lantern-post', 56, 2.6),
    decoration('finish-banner', 'banner', 72.5, 2.4),
  ];
  return { schemaVersion: LEVEL_SCHEMA_VERSION, name: TITLE, labels: LABELS, objects };
}

const server = await createEngineServer(root);
try {
  const engine = await loadCourseEngine(server);
  const project = await loadEngineModule(server, '/src/project.ts');
  const { ENEMY_SPECS } = await loadEngineModule(server, '/src/enemy-types.ts');
  const { bakeEnemyMotion, readEnemyModel } = await loadEngineModule(server, '/src/enemy-motion.ts');
  const { validateEnemyModelAsset } = await loadEngineModule(server, '/src/enemy-model-check.ts');
  const snapshot = createCourseJob(engine).prepare(characters(engine.level));
  const level = snapshot.level;
  const groups = new Map(level.objects.map((object) => [object.id, { group: object.id, zone: 'characters' }]));
  const { crampedColliders, overlaps } = engine.checks;
  const problems = [...crampedColliders(snapshot, groups, []), ...overlaps(snapshot, groups)].map((finding) => finding.message);

  // Each figure as the engine checks an enemy model, its motion baked as the Workshop bakes it.
  const files = new Map<string, Uint8Array>();
  const assets: { id: string; name: string }[] = [];
  const enemies: Record<string, unknown> = {};
  for (const figure of FIGURES) {
    const rig = figure.rig();
    const bytes = skinnedGlb(rig);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    validateEnemyModelAsset(data);
    const { clips, height } = readEnemyModel(data);
    const missing = Object.values(figure.clips).filter((name) => !clips.some((clip) => clip.name === name));
    if (missing.length > 0) problems.push(`${rig.name} has no clip ${missing.join(', ')}.`);
    // A ground figure is as tall as its species, so it stands on its collider at its own size.
    if (figure.species !== 'bird' && Math.abs(height - ENEMY_SPECS[figure.species].height) > 1e-6) {
      problems.push(`${rig.name} stands ${height} m tall, not ${ENEMY_SPECS[figure.species].height} m.`);
    }
    const id = `asset-${createHash('sha256').update(bytes).digest('hex')}`;
    const motion = bakeEnemyMotion(data, figure.clips);
    files.set(`art/${id}.glb`, bytes);
    assets.push({ id, name: rig.name });
    enemies[figure.species] = { type: 'model', asset: id, clips: figure.clips, motion };
    const walk = motion.walk;
    const speed = walk === undefined ? 0 : walk.travel[walk.travel.length - 1]! / 10_000 * ENEMY_SPECS[figure.species].height / walk.duration;
    console.log(`${rig.name}: ${bytes.byteLength} bytes, ${clips.length} clips, walk ${speed.toFixed(2)} m/s.`);
  }

  // The whole project, checked as the Workshop checks one it opens.
  const defaults = project.defaultProjectManifest(TITLE);
  const manifest = project.validateProjectManifest({
    ...defaults,
    art: { assets, decorations: defaults.art.decorations },
    enemies,
    // A perspective camera shows the figures' depth as they turn.
    theme: { ...defaults.theme, camera: { ...defaults.theme.camera, perspective: true, fieldOfView: 35 } },
  });
  project.checkProjectReferences(manifest, level);
  project.loadProjectContent(manifest, (ref) => ref.kind === 'level' ? level : files.get(ref.path));

  if (problems.length > 0) {
    console.error(`The characters scene failed its checks; nothing was written:\n${problems.join('\n')}`);
    process.exitCode = 1;
  } else {
    const outputs = new Map<string, string | Uint8Array>([
      [`${SCENE}/project.json`, json(manifest)],
      [`${SCENE}/level.json`, json(level)],
      ...[...files].map(([path, bytes]): [string, Uint8Array] => [`${SCENE}/${path}`, bytes]),
    ]);
    // Models the figures no longer make are removed.
    const strays = (await readdir(join(root, SCENE, 'art')).catch(() => [] as string[]))
      .map((name) => `${SCENE}/art/${name}`).filter((path) => !outputs.has(path));
    await mkdir(join(root, SCENE, 'art'), { recursive: true });
    for (const path of strays) await rm(join(root, path));
    for (const [path, data] of outputs) await writeFile(join(root, path), data);
    console.log(`Wrote ${SCENE}: ${level.objects.length} objects, ${assets.length} models.`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();
}
