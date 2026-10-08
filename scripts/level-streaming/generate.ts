#!/usr/bin/env node
// npm run generate:streaming -- [all|spread|dense|perspective|slices]
// Open with GAME_PROJECT=artifacts/level-streaming/<case>; every selected project is checked before any output changes.
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Point } from '../../src/config.ts';
import { createEngineServer, loadEngineModule } from '../engine-loader.ts';
import type { EngineModules } from '../engine-loader.ts';
import { CRAMPED, crampedColliders, ENGINE_DEFAULT_REACH, overlaps, reachGraph, reachSuggestions, ventShafts } from '../course-kit/checks.ts';
import { loadCourseEngine } from '../course-kit/engine.ts';
import { CourseError, CourseLevelError } from '../course-kit/errors.ts';
import { createCourseJob } from '../course-kit/job.ts';
import type { CourseSnapshot } from '../course-kit/job.ts';
import { DENSE_TEXTURE_EDGE, REPEATED_MODELS } from './artwork.ts';
import type { ArtLimits } from './artwork.ts';
import { buildCase, CASE_NAMES } from './cases.ts';
import type { BenchmarkCase, CaseName, DecorationLimits } from './cases.ts';

type ModelValidator = EngineModules['/src/course-art-model.ts']['validateCourseModel'];
type ProjectModule = EngineModules['/src/project.ts'];
type ArtModule = EngineModules['/src/art-types.ts'];
interface PreparedProject {
  readonly name: CaseName;
  readonly files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  readonly summary: Readonly<Record<string, number | string | boolean>>;
}
const root = fileURLToPath(new URL('../../', import.meta.url));
// Match six-decimal unit-space construction precision after scaling slice vertices to metres.
const TOLERANCE = 0.0001;

function ensure(condition: boolean, field: string, value: unknown): asserts condition {
  if (!condition) throw new CourseLevelError({ field, value });
}

function selectedCases(args: readonly string[]): readonly CaseName[] {
  const requested = args[0] ?? 'all';
  if (args.length > 1 || (requested !== 'all' && !CASE_NAMES.some((name) => name === requested))) {
    throw new CourseLevelError({ field: 'arguments: use npm run generate:streaming -- [all|spread|dense|perspective|slices]', value: args });
  }
  return requested === 'all' ? CASE_NAMES : CASE_NAMES.filter((name) => name === requested);
}

function checkConstruction(snapshot: CourseSnapshot, benchmark: BenchmarkCase): void {
  const start = snapshot.level.objects.find((object) => object.kind === 'start');
  ensure(start !== undefined && Math.hypot(start.x - benchmark.ground.x,
    start.y - ENGINE_DEFAULT_REACH.startFootOffset - benchmark.ground.y) <= TOLERANCE,
  `${benchmark.name} reset landing`, start);
  const ending = snapshot.level.objects.find((object) => object.kind === 'trigger' && object.events.some((event) => event.type === 'stop-timer'));
  ensure(ending?.kind === 'trigger' && snapshot.engine.level.triggerContains(ending, benchmark.summit),
    `${benchmark.name} summit trigger on the climb`, benchmark.summit);
  const bonfires = snapshot.level.objects.filter((object) => object.kind === 'bonfire');
  ensure(bonfires.length === 1, `${benchmark.name} bonfire`, bonfires.length);
  const landing: Point = { x: (benchmark.fallLane.left + benchmark.fallLane.right) / 2, y: benchmark.ground.y };
  const anchors = [
    { field: 'start landing', point: benchmark.ground }, { field: 'summit', point: benchmark.summit },
    { field: 'fall landing', point: landing }, ...bonfires.map((point) => ({ field: `bonfire ${point.id}`, point })),
  ];
  for (const { field, point } of anchors) {
    const bounds = { left: point.x, right: point.x, bottom: point.y, top: point.y };
    ensure(snapshot.componentCandidates(bounds).some(({ solid }) =>
      snapshot.queries.pointLocation(solid, point) === 'boundary' &&
      snapshot.queries.pointLocation(solid, { x: point.x, y: point.y + TOLERANCE }) === 'outside'),
    `${benchmark.name} supported ${field}`, point);
    ensure(snapshot.inside({ x: point.x, y: point.y + ENGINE_DEFAULT_REACH.clearanceHeights[0] }) === null,
      `${benchmark.name} open air above ${field}`, point);
  }
  const lane = snapshot.queries.rectangle(benchmark.fallLane);
  for (const record of snapshot.componentCandidates(benchmark.fallLane)) {
    ensure(snapshot.queries.intersection(lane, record.solid) === 'disjoint', `${benchmark.name} unobstructed fall lane`, record.object.id);
  }
}

function checkWorkload(snapshot: CourseSnapshot, benchmark: BenchmarkCase, decorations: DecorationLimits, artLimits: ArtLimits): void {
  const level = snapshot.level, limits = snapshot.engine.level.LEVEL_LIMITS, expected = benchmark.expected;
  const scenery = level.objects.filter((object) => object.kind === 'decoration');
  const keys = new Set(snapshot.solids.map((record) => snapshot.engine.level.geometryKey(record.object)));
  ensure(snapshot.solids.length === expected.terrain && scenery.length === expected.decorations &&
    benchmark.artwork.length === expected.assets && keys.size === expected.geometries, `${benchmark.name} exact workload`,
  { terrain: snapshot.solids.length, decorations: scenery.length, assets: benchmark.artwork.length, geometries: keys.size, expected });
  for (const record of snapshot.solids) {
    const box = record.bounds;
    ensure(box.left >= -limits.coordinate && box.right <= limits.coordinate && box.bottom >= -limits.coordinate && box.top <= limits.coordinate,
      `${record.object.id} collision within coordinate limits`, box);
    for (const other of snapshot.candidates(box)) {
      if (other.order <= record.order) continue;
      ensure(snapshot.queries.intersection(record.solid, other.solid) !== 'overlapping', 'separate benchmark terrain placements',
        `${record.object.id} overlaps ${other.object.id}`);
    }
  }
  if (benchmark.name === 'spread' || benchmark.name === 'slices') {
    ensure(snapshot.solids.length === limits.objects, `${benchmark.name} maximum terrain count`, snapshot.solids.length);
  }
  if (benchmark.name === 'spread' || benchmark.name === 'perspective') {
    ensure(scenery.every((object) => REPEATED_MODELS.some((model) => model === object.model) &&
      benchmark.manifest.art.decorations[object.model] !== undefined), 'Workshop placeholders and release decoration artwork', benchmark.name);
    const used = new Set<string | undefined>(scenery.map((object) => benchmark.manifest.art.decorations[object.model]));
    ensure(used.size === expected.assets && !used.has(undefined), 'every repeated decoration asset placed', used.size);
  }
  if (benchmark.name === 'spread') {
    ensure(scenery.length === decorations.objects && snapshot.solids.every((record) => record.object.mesh.type === 'asset'),
      'spread repeated mesh terrain and maximum decoration count', scenery.length);
  } else if (benchmark.name === 'dense') {
    const meshes = snapshot.solids.filter(({ object }) => object.mesh.type === 'asset');
    ensure(benchmark.artwork.length === artLimits.assets && scenery.length === 0 && meshes.length === artLimits.assets,
      'dense unique terrain artwork and no decorations', meshes.length);
    ensure(meshes.every(({ object }) => object.mesh.type === 'asset' && object.mesh.collision.type === 'box' &&
      Math.max(object.width, object.height) > CRAMPED.small), 'dense mesh tiles larger than the small-collider limit', benchmark.name);
    const used = new Set(meshes.flatMap(({ object }) => object.mesh.type === 'asset' ? [object.mesh.assetId] : []));
    ensure(used.size === artLimits.assets, 'every dense asset placed as terrain', used.size);
  } else if (benchmark.name === 'perspective') {
    ensure(benchmark.manifest.theme.camera.perspective && benchmark.manifest.theme.fog.far > decorations.back &&
      Math.min(...scenery.map((object) => object.z)) === -decorations.back &&
      Math.max(...scenery.map((object) => object.height)) === decorations.maximumHeight,
    'perspective camera, distant fog and maximum decoration depth and height', benchmark.manifest.theme);
  } else {
    ensure(keys.size === limits.geometryKinds && benchmark.manifest.art.mode === 'shapes', 'slice collision keys and shapes mode', keys.size);
    for (const { object } of snapshot.solids) {
      const mesh = object.mesh;
      ensure(mesh.type === 'asset' && mesh.collision.type === 'slice' && !object.mirror, 'unmirrored mesh slice', object.id);
      ensure(mesh.collision.loops.length === limits.meshLoops &&
        mesh.collision.loops.every((loop) => loop.length === limits.meshPoints / limits.meshLoops),
      'maximum slice loops and vertices', object.id);
    }
  }
}

function jsonBytes(value: object, pretty = false): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function parseJson(bytes: Uint8Array<ArrayBuffer>): unknown {
  return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
}

function prepareProject(snapshot: CourseSnapshot, benchmark: BenchmarkCase, project: ProjectModule, art: ArtModule, validateModel: ModelValidator): PreparedProject {
  const { ART_LIMITS, artRecord } = art;
  const groups = new Map(snapshot.level.objects.map((object) => [object.id, { group: `${benchmark.name}:${object.id}`, zone: benchmark.name }]));
  const problems = [...crampedColliders(snapshot, groups, []), ...ventShafts(snapshot, groups), ...overlaps(snapshot, groups)];
  ensure(problems.length === 0, `${benchmark.name} course-kit geometry checks`, problems.join('\n'));
  checkConstruction(snapshot, benchmark);
  const reach = benchmark.name === 'slices' ? null : reachGraph(snapshot, groups, [], [], ENGINE_DEFAULT_REACH, benchmark.summit);
  if (reach !== null) {
    const suggestions = reachSuggestions(reach);
    if (suggestions.length > 0) {
      console.warn(`${benchmark.name} reach suggestions (non-blocking): the model cannot prove or disprove physics-based play.`);
      console.warn(suggestions.join('\n'));
    }
  }
  let pixels = 0;
  for (const asset of benchmark.artwork) {
    ensure(asset.id === `asset-${createHash('sha256').update(asset.bytes).digest('hex')}`, 'artwork content hash', asset.id);
    const { pixels: assetPixels } = validateModel(asset.bytes.buffer.slice(asset.bytes.byteOffset, asset.bytes.byteOffset + asset.bytes.byteLength));
    pixels += assetPixels;
    ensure(pixels <= ART_LIMITS.texturePixels, 'total decoded texture pixels', pixels);
    if (benchmark.name === 'dense') {
      const header = new DataView(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength);
      const json = artRecord(parseJson(asset.bytes.subarray(20, 20 + header.getUint32(12, true))), 'Dense benchmark GLB');
      ensure(Array.isArray(json.meshes) && json.meshes.length === ART_LIMITS.meshes &&
        Array.isArray(json.nodes) && json.nodes.length === ART_LIMITS.meshes &&
        Array.isArray(json.images) && json.images.length === 1 && assetPixels === DENSE_TEXTURE_EDGE ** 2,
      'dense static parts and embedded procedural texture', asset.name);
      const meshes: readonly unknown[] = json.meshes;
      for (const entry of meshes) {
        const mesh = artRecord(entry, 'Dense benchmark mesh');
        ensure(Array.isArray(mesh.primitives) && mesh.primitives.length === 1, 'one primitive per dense part', asset.name);
        const primitives: readonly unknown[] = mesh.primitives;
        const attributes = artRecord(artRecord(primitives[0], 'Dense benchmark primitive').attributes, 'Dense benchmark attributes');
        ensure(typeof attributes.TEXCOORD_0 === 'number', 'dense texture coordinates', asset.name);
      }
    }
  }
  const manifest = project.validateProjectManifest(benchmark.manifest);
  project.checkProjectReferences(manifest, snapshot.level);
  const files = new Map<string, Uint8Array<ArrayBuffer>>([
    ['project.json', jsonBytes(manifest, true)],
    [manifest.level, jsonBytes(snapshot.level)],
    ...benchmark.artwork.map((asset): [string, Uint8Array<ArrayBuffer>] => [`art/${asset.id}.glb`, asset.bytes]),
  ]);
  ensure(files.get('project.json')!.byteLength <= project.PROJECT_LIMITS.manifestBytes,
    'serialized project manifest bytes', files.get('project.json')!.byteLength);
  // Check the serialized documents and every file's real bytes, not estimates or pre-serialization object sizes.
  const storedManifest = project.validateProjectManifest(parseJson(files.get('project.json')!));
  const content = project.loadProjectContent(storedManifest, (ref) => {
    const bytes = files.get(ref.path);
    if (bytes === undefined) throw new CourseLevelError({ field: 'generated project file', value: ref.path });
    ensure(bytes.byteLength > 0 && bytes.byteLength <= ref.maxBytes, `${ref.path} serialized bytes`, bytes.byteLength);
    return ref.binary ? bytes : parseJson(bytes);
  });
  const artBytes = [...content.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  return {
    name: benchmark.name, files,
    summary: {
      case: benchmark.name, seed: benchmark.seed, terrain: snapshot.solids.length,
      decorations: benchmark.expected.decorations, collisionKeys: benchmark.expected.geometries, climbRungs: benchmark.routeRungs,
      reachModel: reach === null ? 'no reach claim: same-mesh slice rungs' : reach.model,
      modelledEnding: reach === null ? 'not modelled' : reach.ending,
      modelledClimbRungs: reach === null ? 'not modelled' : new Set(reach.points
        .filter((point) => reach.seen[point.id] && benchmark.routeIds.has(point.object.id)).map((point) => point.object.id)).size,
      assets: content.files.size, artBytes, texturePixels: pixels,
      levelBytes: files.get(manifest.level)!.byteLength, manifestBytes: files.get('project.json')!.byteLength,
    },
  };
}

async function writeProject(prepared: PreparedProject): Promise<void> {
  const relative = `artifacts/level-streaming/${prepared.name}`, directory = join(root, relative), art = join(directory, 'art');
  await mkdir(art, { recursive: true });
  for (const name of await readdir(art)) {
    if (/^asset-[a-f0-9]{64}\.glb$/.test(name) && !prepared.files.has(`art/${name}`)) await rm(join(art, name));
  }
  for (const [path, bytes] of prepared.files) await writeFile(join(directory, path), bytes);
  console.log(`Wrote ${relative}: ${JSON.stringify(prepared.summary)}`);
}

async function main(): Promise<void> {
  const names = selectedCases(process.argv.slice(2));
  const server = await createEngineServer(root);
  try {
    const engine = await loadCourseEngine(server);
    const project = await loadEngineModule(server, '/src/project.ts');
    const { validateCourseModel } = await loadEngineModule(server, '/src/course-art-model.ts');
    const decorations = engine.level.DECORATION_LIMITS, artLimits = engine.art.ART_LIMITS;
    const prepared: PreparedProject[] = [];
    for (const name of names) {
      const job = createCourseJob(engine, { workLimits: { geometry: 80_000_000, spatialVisits: 40_000_000 } });
      const benchmark = buildCase(name, job, decorations, artLimits, project.defaultProjectManifest(`Streaming benchmark: ${name}`));
      const snapshot = job.prepare(benchmark.level);
      checkWorkload(snapshot, benchmark, decorations, artLimits);
      prepared.push(prepareProject(snapshot, benchmark, project, engine.art, validateCourseModel));
    }
    for (const output of prepared) await writeProject(output);
  } finally {
    await server.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof CourseError) {
    console.error(`${error.code}: ${error.message}\nRepair: ${error.repair}`);
    console.error(error.cause);
  } else {
    console.error(`Streaming benchmark generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
