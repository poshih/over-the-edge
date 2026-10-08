#!/usr/bin/env node
// Builds the Ashen Ascent example: npm run generate:ashen-ascent -- [--preview]
// It places every set piece of the Workshop's library once along a continuous route,
// checks geometry, reports reach suggestions and writes examples/projects/ashen-ascent/
// and docs/ashen-ascent-map.svg.
// --preview also writes map crops and the reach overlay to artifacts/ashen-ascent/.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineServer, loadEngineModule } from '../engine-loader.ts';
import { CourseBuilder } from '../course-kit/course.ts';
import { loadCourseEngine } from '../course-kit/engine.ts';
import { createCourseJob } from '../course-kit/job.ts';
import { CourseError } from '../course-kit/errors.ts';
import { courseMap, renderCrops } from '../course-kit/map.ts';
import { buildCourse } from './zones.ts';
import type { AscentZone } from './zones.ts';
import { projectManifest, TITLE } from './project.ts';
import { ashenAscentMedia } from '../project-fixtures.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
// The map's background, from the valley floor to the sky above the keep.
const MAP_SKY = ['#1d1b1f', '#2b2a33', '#4a3f3a'];
const flags = new Set(process.argv.slice(2));
const server = await createEngineServer(root);
try {
  const library = await loadEngineModule(server, '/src/editor/set-pieces.ts');
  const engine = await loadCourseEngine(server);
  const job = createCourseJob(engine);
  const { budget, crampedColliders, ENGINE_DEFAULT_REACH, keepOut, overlaps, reachGraph, reachSuggestions, ventShafts } = engine.checks;
  const project = await loadEngineModule(server, '/src/project.ts');
  const builder = new CourseBuilder<AscentZone>(library, job);
  const trail = buildCourse(builder);
  const snapshot = job.prepare(builder.level(engine.level.LEVEL_SCHEMA_VERSION));
  const level = snapshot.level;
  const problems: string[] = [];
  const used = new Set(builder.pieces.map((piece) => piece.id));
  const missing = library.SET_PIECES.filter((piece) => !used.has(piece.id)).map((piece) => piece.id);
  const repeated = builder.pieces.map((piece) => piece.id).filter((id, index, all) => all.indexOf(id) !== index);
  if (missing.length > 0) problems.push(`Set pieces not placed: ${missing.join(', ')}`);
  if (repeated.length > 0) problems.push(`Set pieces placed twice: ${repeated.join(', ')}`);
  problems.push(...[...overlaps(snapshot, builder.groups, builder.supports), ...keepOut(snapshot, builder.groups, builder.pieces, builder.allowed),
    ...ventShafts(snapshot, builder.groups), ...crampedColliders(snapshot, builder.groups, builder.pieces)].map((finding) => finding.message));
  const reach = reachGraph(snapshot, builder.groups, builder.pieces, builder.links, ENGINE_DEFAULT_REACH, { x: trail.x, y: trail.y });
  const totals = budget(snapshot);
  console.log(JSON.stringify({ budget: totals, pieces: builder.pieces.length, reach: { reached: reach.reached, total: reach.total, ending: reach.ending } }));
  const suggestions = reachSuggestions(reach);
  if (suggestions.length > 0) {
    console.warn('Reach suggestions (non-blocking): the model cannot prove or disprove physics-based play.');
    console.warn(suggestions.map((finding) => finding.message).join('\n'));
  }
  const zones = builder.zones.map((zone) => ({ name: zone.name, from: zone.from }));
  if (flags.has('--preview')) {
    const directory = join(root, 'artifacts/ashen-ascent');
    await mkdir(directory, { recursive: true });
    const map = courseMap(snapshot, { zones, scale: 8, reach, sky: MAP_SKY });
    await writeFile(join(directory, 'reach.svg'), map.svg);
    const crops = builder.zones.map((zone) => ({ name: zone.code, left: zone.view?.left ?? map.left, right: zone.view?.right ?? map.right,
      bottom: zone.from - 4, top: zone.to + 8 }));
    const files = await renderCrops(map, crops, directory);
    console.log(files.join('\n'));
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
  // The whole project, checked as a release build checks it.
  const manifest = project.validateProjectManifest(projectManifest(project.defaultProjectManifest(TITLE)));
  project.checkProjectReferences(manifest, level);
  const media = ashenAscentMedia();
  project.loadProjectContent(manifest, (ref) => ref.kind === 'level' ? level : media[ref.path.slice('media/'.length)]);
  const example = 'examples/projects/ashen-ascent';
  const outputs = new Map<string, string | Uint8Array>([
    [`${example}/project.json`, `${JSON.stringify(manifest, null, 2)}\n`],
    [`${example}/level.json`, `${JSON.stringify(level)}\n`],
    ...Object.entries(media).map(([name, bytes]): [string, Uint8Array] => [`${example}/media/${name}`, bytes]),
    ['docs/ashen-ascent-map.svg', `${courseMap(snapshot, { zones, scale: 6, sky: MAP_SKY }).svg}\n`],
  ]);
  const strays = (await readdir(join(root, example, 'media')).catch(() => []))
    .map((name) => `${example}/media/${name}`).filter((path) => !outputs.has(path));
  // Nothing is written while the course has problems.
  if (problems.length === 0) {
    await mkdir(join(root, example, 'media'), { recursive: true });
    for (const path of strays) await rm(join(root, path));
    for (const [path, data] of outputs) await writeFile(join(root, path), data);
  }
} catch (error) {
  if (error instanceof CourseError) console.error(`${error.code}: ${error.message}\nRepair: ${error.repair}`);
  throw error;
} finally {
  await server.close();
}
