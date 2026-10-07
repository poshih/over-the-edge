#!/usr/bin/env node
// Usage: npm run pack:course -- <level.json> <assets.json> <output.json> [--mode=meshes|shapes]
// Packs a level and the GLBs it draws into one self-contained course package. assets.json lists GLB files, relative to
// it: "meshes", the GLBs the level's terrain meshes place, matched to them by content; and "decorations", the GLB that
// draws each decoration model in mesh releases.
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { ArtMode, ArtResource } from '../src/art-types.ts';
import type { CoursePackage } from '../src/course-package.ts';

const LIMITS = { fileBytes: 20 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, assets: 64 };
const SECTIONS = ['meshes', 'decorations'];

function fail(message: unknown): never {
  console.error(`pack-course: ${message}`);
  process.exit(1);
}

function usage(): never {
  fail('Usage: npm run pack:course -- <level.json> <assets.json> <output.json> [--mode=meshes|shapes]');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function levelObjects(level: unknown, kind: string) {
  if (!record(level) || !Array.isArray(level.objects)) fail('Level JSON must contain an objects array.');
  const objects: unknown[] = level.objects;
  return objects.filter((object): object is Record<string, unknown> => record(object) && object.kind === kind);
}

const args = process.argv.slice(2);
if (args.length < 3 || args.length > 4) usage();
const [levelFile, assetsFile, outputFile, option] = args;
let mode: ArtMode = 'meshes';
if (option !== undefined) {
  const match = /^--mode=(shapes|meshes)$/.exec(option);
  if (!match) usage();
  mode = match[1] as ArtMode;
}

try {
  // JSON stays unknown until the same structural checks the packer has always performed.
  const level: unknown = JSON.parse(await readFile(levelFile, 'utf8'));
  if (record(level) && level.format === 'over-the-edge-course') fail('Pass the plain level JSON, not an over-the-edge course package.');
  const files: unknown = JSON.parse(await readFile(assetsFile, 'utf8'));
  if (!record(files) || Array.isArray(files)) fail('The assets JSON must be an object.');
  for (const key of Object.keys(files)) if (!SECTIONS.includes(key)) fail(`The assets JSON has "meshes" and "decorations" sections, not "${key}".`);
  const meshFiles = files.meshes ?? [];
  if (!Array.isArray(meshFiles)) fail('"meshes" must list GLB files.');
  const decorationFiles = files.decorations ?? {};
  if (!record(decorationFiles) || Array.isArray(decorationFiles)) {
    fail('"decorations" must map decoration models to GLB files.');
  }
  const placed = new Set(levelObjects(level, 'terrain').flatMap(object => record(object.mesh) && object.mesh.type === 'asset' ? [object.mesh.assetId] : []));
  const models = new Set(levelObjects(level, 'decoration').map(object => object.model));
  for (const model of Object.keys(decorationFiles)) {
    if (!models.has(model)) fail(`"decorations" names model "${model}", which no decoration in the level uses.`);
  }

  const base = dirname(resolve(assetsFile));
  const assets = new Map<string, ArtResource>();
  let totalBytes = 0;

  // Packs the GLB at `file` once, by content hash, and returns its asset ID.
  const pack = async (file: unknown, owner: string) => {
    if (typeof file !== 'string' || file.length === 0) fail(`${owner} needs a GLB file path.`);
    const path = resolve(base, file);
    let info: Stats;
    try { info = await stat(path); }
    catch { fail(`The GLB of ${owner} does not exist: ${file}`); }
    if (!info.isFile()) fail(`The GLB path of ${owner} is not a file: ${file}`);
    if (info.size > LIMITS.fileBytes) fail(`The GLB of ${owner} is over 20 MiB: ${file}`);
    const bytes = await readFile(path);
    if (bytes.length < 12 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) {
      fail(`The GLB of ${owner} is not a GLB v2 file: ${file}`);
    }
    const id = `asset-${createHash('sha256').update(bytes).digest('hex')}`;
    if (!assets.has(id)) {
      totalBytes += bytes.length;
      if (totalBytes > LIMITS.totalBytes) fail('The GLBs exceed the 64 MiB total budget.');
      if (assets.size + 1 > LIMITS.assets) fail('A course can package at most 64 unique GLBs.');
      assets.set(id, {
        id,
        name: basename(file).trim().slice(0, 80) || 'asset.glb',
        source: `data:model/gltf-binary;base64,${bytes.toString('base64')}`,
      });
    }
    return id;
  };

  for (const file of meshFiles as unknown[]) {
    if (!placed.has(await pack(file, `mesh ${file}`))) fail(`${file} is not a mesh the level places.`);
  }
  const unmatched = [...placed].filter(id => typeof id !== 'string' || !assets.has(id));
  if (unmatched.length > 0) fail(`No listed GLB has the content of the placed mesh${unmatched.length === 1 ? '' : 'es'} ${unmatched.join(', ')}.`);
  const decorations: Record<string, string> = {};
  for (const model of Object.keys(decorationFiles).sort()) {
    decorations[model] = await pack(decorationFiles[model], `decoration model "${model}"`);
  }

  const course: Omit<CoursePackage, 'level'> & { level: unknown } = {
    format: 'over-the-edge-course', schemaVersion: 2, mode, level, assets: [...assets.values()], decorations,
  };
  const output = JSON.stringify(course);
  await writeFile(outputFile, output);
  const replaced = Object.keys(decorations).length;
  console.log(`Packed ${placed.size} placed mesh${placed.size === 1 ? '' : 'es'}, ${replaced} decoration model${replaced === 1 ? '' : 's'}, ` +
    `${assets.size} unique GLBs, ${outputFile}, ${Buffer.byteLength(output)} bytes.`);
} catch (error) {
  if (error instanceof SyntaxError) fail(`Invalid JSON: ${error.message}`);
  const message: unknown = error == null ? undefined : Reflect.get(Object(error), 'message');
  fail(message ?? String(error));
}
