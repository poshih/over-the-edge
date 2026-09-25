#!/usr/bin/env node
// Usage: node scripts/pack-course.mjs <level.json> <assignments.json> <output.json> [--mode=meshes|shapes]
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';

const LIMITS = { fileBytes: 20 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, assets: 64 };
const mirrors = new Set(['none', 'x', 'diagonal']);

function fail(message) {
  console.error(`pack-course: ${message}`);
  process.exit(1);
}

function usage() {
  fail('Usage: node scripts/pack-course.mjs <level.json> <assignments.json> <output.json> [--mode=meshes|shapes]');
}

function terrainObjects(level) {
  if (!level || typeof level !== 'object' || !Array.isArray(level.objects)) fail('Level JSON must contain an objects array.');
  return level.objects.filter(object => object && typeof object === 'object' && object.kind === 'terrain');
}

const args = process.argv.slice(2);
if (args.length < 3 || args.length > 4) usage();
const [levelFile, assignmentsFile, outputFile, option] = args;
let mode = 'meshes';
if (option !== undefined) {
  const match = /^--mode=(shapes|meshes)$/.exec(option);
  if (!match) usage();
  mode = match[1];
}

try {
  const level = JSON.parse(await readFile(levelFile, 'utf8'));
  if (level?.format === 'over-the-edge-course') fail('Pass the plain level JSON, not an over-the-edge course package.');
  const assignments = JSON.parse(await readFile(assignmentsFile, 'utf8'));
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) fail('Assignments JSON must be an object.');

  const terrain = terrainObjects(level);
  const terrainIds = new Set(terrain.map(object => object.id));
  for (const id of Object.keys(assignments)) if (!terrainIds.has(id)) fail(`Assignment names unknown terrain object "${id}".`);

  const base = dirname(resolve(assignmentsFile));
  const assets = new Map();
  const packageAssets = [];
  let assigned = 0;
  let totalBytes = 0;

  for (const object of terrain) {
    const raw = assignments[object.id];
    if (raw === undefined) {
      delete object.art;
      continue;
    }
    const file = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.file : undefined;
    const mirror = typeof raw === 'string' || !raw || typeof raw !== 'object' || raw.mirror === undefined ? 'none' : raw.mirror;
    if (typeof file !== 'string' || file.length === 0) fail(`Assignment for "${object.id}" needs a GLB file path.`);
    if (!mirrors.has(mirror)) fail(`Assignment for "${object.id}" uses unknown mirror "${mirror}".`);
    const path = resolve(base, file);
    let info;
    try { info = await stat(path); }
    catch { fail(`GLB file for "${object.id}" does not exist: ${file}`); }
    if (!info.isFile()) fail(`GLB path for "${object.id}" is not a file: ${file}`);
    if (info.size > LIMITS.fileBytes) fail(`GLB file for "${object.id}" is over 20 MiB: ${file}`);
    const bytes = await readFile(path);
    if (bytes.length < 12 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) {
      fail(`GLB file for "${object.id}" is not a GLB v2 file: ${file}`);
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const id = `asset-${hash}`;
    if (!assets.has(id)) {
      totalBytes += bytes.length;
      if (totalBytes > LIMITS.totalBytes) fail('Assigned unique GLBs exceed the 64 MiB total budget.');
      if (assets.size + 1 > LIMITS.assets) fail('A course can package at most 64 unique GLBs.');
      const asset = {
        id,
        name: basename(file).trim().slice(0, 80) || 'asset.glb',
        source: `data:model/gltf-binary;base64,${bytes.toString('base64')}`,
      };
      assets.set(id, asset);
      packageAssets.push(asset);
    }
    object.art = { assetId: id, mirror };
    assigned++;
  }

  const course = { format: 'over-the-edge-course', schemaVersion: 1, mode, level, assets: packageAssets };
  const output = JSON.stringify(course);
  await writeFile(outputFile, output);
  console.log(`Packed ${assigned} terrain objects, ${packageAssets.length} unique GLBs, ${outputFile}, ${Buffer.byteLength(output)} bytes.`);
} catch (error) {
  if (error instanceof SyntaxError) fail(`Invalid JSON: ${error.message}`);
  fail(error?.message ?? String(error));
}
