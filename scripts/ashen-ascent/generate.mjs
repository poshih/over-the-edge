#!/usr/bin/env node
// Builds the Ashen Ascent example: node scripts/ashen-ascent/generate.mjs [--preview]
// It places every set piece of the Workshop's library once, along a continuous route checked for
// reach, and writes examples/projects/ashen-ascent/ and docs/ashen-ascent-map.svg.
// --preview also writes map crops and the reach overlay to artifacts/ashen-ascent/.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { CourseBuilder } from '../course-kit/course.mjs';
import { budget, crampedColliders, ENGINE_DEFAULT_REACH, keepOut, overlaps, reachGraph, ventShafts } from '../course-kit/checks.mjs';
import { courseMap, renderCrops } from '../course-kit/map.mjs';
import { buildCourse } from './zones.mjs';
import { projectManifest, TITLE } from './project.mjs';
import { ashenAscentMedia } from '../project-fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// The map's background, from the valley floor to the sky above the keep.
const MAP_SKY = ['#1d1b1f', '#2b2a33', '#4a3f3a'];
const flags = new Set(process.argv.slice(2));
const server = await createServer({ configFile: false, root, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
try {
  const library = await server.ssrLoadModule('/src/editor/set-pieces.ts');
  const { LEVEL_SCHEMA_VERSION, validateLevel, validateLevelObject } = await server.ssrLoadModule('/src/level.ts');
  const project = await server.ssrLoadModule('/src/project.ts');
  const builder = new CourseBuilder(library);
  const trail = buildCourse(builder);
  for (const object of builder.objects) {
    try {
      validateLevelObject(object);
    } catch (error) {
      throw new Error(`${object.id}: ${error.message} ${JSON.stringify(object)}`);
    }
  }
  const level = validateLevel(builder.level(LEVEL_SCHEMA_VERSION));
  const problems = [];
  const used = new Set(builder.pieces.map((piece) => piece.id));
  const missing = library.SET_PIECES.filter((piece) => !used.has(piece.id)).map((piece) => piece.id);
  const repeated = builder.pieces.map((piece) => piece.id).filter((id, index, all) => all.indexOf(id) !== index);
  if (missing.length > 0) problems.push(`Set pieces not placed: ${missing.join(', ')}`);
  if (repeated.length > 0) problems.push(`Set pieces placed twice: ${repeated.join(', ')}`);
  problems.push(...overlaps(level, builder.groups, builder.supports), ...keepOut(level, builder.groups, builder.pieces, builder.allowed),
    ...ventShafts(level, builder.groups), ...crampedColliders(level, builder.groups));
  const reach = reachGraph(level, builder.groups, builder.pieces, builder.links, ENGINE_DEFAULT_REACH, { x: trail.x, y: trail.y });
  if (!reach.ending) {
    problems.push(`The ending is not reachable; the highest reached point is (${reach.highest.x.toFixed(1)}, ${reach.highest.y.toFixed(1)}) in ${reach.highest.group}.`);
  }
  if (reach.unreachedPieces.length > 0) problems.push(`Pieces never reached: ${reach.unreachedPieces.join(', ')}`);
  if (reach.traps.length > 0) {
    problems.push(`Traps (reachable, but the ending is not reachable from them): ${reach.traps.map((trap) =>
      `${trap.group} x${trap.count} near (${trap.x.toFixed(1)}, ${trap.y.toFixed(1)})`).join('; ')}`);
  }
  const totals = budget(level);
  console.log(JSON.stringify({ budget: totals, pieces: builder.pieces.length, reach: { reached: reach.reached, total: reach.total, ending: reach.ending } }));
  const zones = builder.zones.map((zone) => ({ name: zone.name, from: zone.from }));
  if (flags.has('--preview')) {
    const directory = join(root, 'artifacts/ashen-ascent');
    await mkdir(directory, { recursive: true });
    const map = courseMap(level, { zones, scale: 8, reach, sky: MAP_SKY });
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
  const outputs = new Map([
    [`${example}/project.json`, `${JSON.stringify(manifest, null, 2)}\n`],
    [`${example}/level.json`, `${JSON.stringify(level)}\n`],
    ...Object.entries(media).map(([name, bytes]) => [`${example}/media/${name}`, bytes]),
    ['docs/ashen-ascent-map.svg', `${courseMap(level, { zones, scale: 6, sky: MAP_SKY }).svg}\n`],
  ]);
  const strays = (await readdir(join(root, example, 'media')).catch(() => []))
    .map((name) => `${example}/media/${name}`).filter((path) => !outputs.has(path));
  // Nothing is written while the course has problems.
  if (problems.length === 0) {
    await mkdir(join(root, example, 'media'), { recursive: true });
    for (const path of strays) await rm(join(root, path));
    for (const [path, data] of outputs) await writeFile(join(root, path), data);
  }
} finally {
  await server.close();
}
