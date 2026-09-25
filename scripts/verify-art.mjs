import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import { chromium } from 'playwright';
import { modelFixture } from './verify-appearance.mjs';
import { observeBrowserPage } from './verify-level.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const configFile = join(root, 'vite.game.config.ts');
const workshopConfig = join(root, 'vite.config.ts');
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(artifacts, 'art-proof-'));
const report = { status: 'incomplete', sections: {} };
const previousLevel = process.env.GAME_LEVEL;
const previousMode = process.env.GAME_ART_MODE;
let browser;

const dataUri = bytes => `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`;
const terrainObjects = level => level.objects.filter(object => object.kind === 'terrain');
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const closeHttp = server => new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
const closeVite = async server => { try { await server.close(); } catch {} };

function baseTerrain(id, shape, x, y, width, height, extra = {}) {
  return { kind: 'terrain', id, shape, x, y, width, height, angle: 0, depth: 1, color: 0x71817a, illusion: false, ...extra };
}

function smallLevel() {
  return {
    schemaVersion: 2,
    labels: [],
    objects: [
      baseTerrain('floor', { type: 'box' }, 0, -0.5, 20, 1, { depth: 3 }),
      baseTerrain('ledge', { type: 'box' }, 0, 2, 6, 0.5, { depth: 1.5, illusion: true }),
      baseTerrain('ramp', { type: 'ramp' }, 1800, 1200, 4, 1.5, { angle: 0.4, depth: 2 }),
      baseTerrain('circle', { type: 'circle' }, 1830, 1200, 2, 2, { depth: 1.2 }),
      baseTerrain('polygon', { type: 'polygon', vertices: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.35 }, { x: 0.2, y: 0.5 }, { x: -0.45, y: 0.3 }] }, 1860, 1200, 3, 2, { depth: 1.4 }),
      { kind: 'start', id: 'start', x: 0, y: 4, angle: 0.5, extension: 0.3 },
    ],
  };
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function runPack(levelPath, assignmentsPath, outputPath, mode = 'meshes') {
  return exec(process.execPath, [join(root, 'scripts/pack-course.mjs'), levelPath, assignmentsPath, outputPath, `--mode=${mode}`], { cwd: root });
}

function bundleFiles(bundle) {
  return (Array.isArray(bundle) ? bundle : [bundle]).flatMap(entry => entry.output);
}

function bundleModules(bundle) {
  return bundleFiles(bundle).filter(file => file.type === 'chunk').flatMap(file => Object.keys(file.modules));
}

async function expectBuildRejects(pattern, message) {
  let rejected = false;
  try {
    await build({ configFile, logLevel: 'silent', build: { write: false } });
  } catch (error) {
    rejected = true;
    assert.match(error?.message ?? String(error), pattern, message);
  }
  assert.equal(rejected, true, message);
}

async function observeArtDraws(page) {
  await page.addInitScript(() => {
    window.courseArtDraw = { stone: 0, slab: 0, history: [] };
    const prototype = WebGL2RenderingContext.prototype;
    const clear = prototype.clear;
    const draw = prototype.drawElementsInstanced;
    prototype.clear = function (...args) {
      if (this.canvas.id === 'game' && (args[0] & this.COLOR_BUFFER_BIT) !== 0) {
        window.courseArtDraw.stone = 0;
        window.courseArtDraw.slab = 0;
      }
      return clear.apply(this, args);
    };
    prototype.drawElementsInstanced = function (mode, count, type, offset, instances) {
      if (this.canvas.id === 'game') {
        if (count === 9216) window.courseArtDraw.stone += instances;
        if (count === 36) window.courseArtDraw.slab += instances;
        window.courseArtDraw.history.push({ count, instances });
      }
      return draw.call(this, mode, count, type, offset, instances);
    };
  });
}

async function makePackageProof() {
  const levelPath = join(temporary, 'level.json');
  const assignmentsPath = join(temporary, 'assignments.json');
  const outputPath = join(temporary, 'course.json');
  const slabPath = join(temporary, 'slab.glb');
  const stonePath = join(temporary, 'stone.glb');
  await writeFile(slabPath, modelFixture({ size: [2, 1, 3] }));
  await writeFile(stonePath, modelFixture({ textured: true, segments: 16 }));
  await writeJson(levelPath, smallLevel());
  await writeJson(assignmentsPath, {
    floor: 'slab.glb',
    ledge: 'stone.glb',
    ramp: { file: 'slab.glb', mirror: 'x' },
    circle: 'stone.glb',
    polygon: 'slab.glb',
  });
  const { stdout } = await runPack(levelPath, assignmentsPath, outputPath);
  const pack = await readJson(outputPath);
  assert.equal(pack.format, 'over-the-edge-course');
  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.mode, 'meshes');
  assert.equal(pack.assets.length, 2, 'The CLI must deduplicate assets by hash.');
  assert.ok(stdout.includes('5 terrain objects'));
  const objects = Object.fromEntries(terrainObjects(pack.level).map(object => [object.id, object]));
  assert.equal(objects.floor.art.assetId, pack.assets[0].id);
  assert.equal(objects.floor.art.mirror, 'none');
  assert.equal(objects.ramp.art.assetId, pack.assets[0].id);
  assert.equal(objects.ramp.art.mirror, 'x');
  assert.equal(objects.ledge.art.assetId, pack.assets[1].id);

  const badAssignments = join(temporary, 'assignments-bad-id.json');
  const badOutput = join(temporary, 'bad-id-course.json');
  await writeJson(badAssignments, { missing: 'slab.glb' });
  await assert.rejects(runPack(levelPath, badAssignments, badOutput), /unknown terrain object/);
  await assert.rejects(readFile(badOutput), /ENOENT/);
  const textPath = join(temporary, 'not-glb.txt');
  await writeFile(textPath, 'not a glb');
  const badGlb = join(temporary, 'assignments-bad-glb.json');
  await writeJson(badGlb, { floor: 'not-glb.txt' });
  await assert.rejects(runPack(levelPath, badGlb, join(temporary, 'bad-glb-course.json')), /not a GLB v2/);
  report.sections.packCli = { assigned: 5, assets: pack.assets.length, outputPath };
  return { packagePath: outputPath, pack, slabPath, stonePath };
}

async function verifyRelease(packagePath, uniqueAssets) {
  report.sections.release = [];
  process.env.GAME_LEVEL = relative(root, packagePath);
  for (const mode of ['shapes', 'meshes']) {
    process.env.GAME_ART_MODE = mode;
    const output = join(temporary, `release-${mode}`);
    const bundle = await build({ configFile, logLevel: 'silent', build: { outDir: output } });
    const modules = bundleModules(bundle);
    assert.ok(!modules.some(id => id.includes('/src/editor/') || id.includes('/worker/') || id.includes('GLTFExporter')),
      'Game releases must not include editor modules or exporters.');
    assert.equal(modules.some(id => id.includes('GLTFLoader')), mode === 'meshes');
    const glbs = bundleFiles(bundle).filter(file => file.type === 'asset' && file.fileName.endsWith('.glb'));
    assert.equal(glbs.length, mode === 'meshes' ? uniqueAssets : 0);
    const release = await preview({ configFile, logLevel: 'silent', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
    const page = await browser.newPage();
    const errors = [];
    const glbRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('.glb')) glbRequests.push(request.url()); });
    await observeArtDraws(page);
    try {
      const address = `http://127.0.0.1:${release.httpServer.address().port}/`;
      assert.equal((await fetch(address)).status, 200);
      await page.goto(address, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelector('.elapsed-value')?.textContent !== '00:00');
      assert.equal(await page.evaluate(() => typeof window.gettingOver), 'undefined');
      assert.equal(await page.getByRole('tab').count(), 0);
      assert.equal(await page.locator('#fatal-error').isHidden(), true);
      assert.equal(glbRequests.length, mode === 'meshes' ? uniqueAssets : 0);
      if (mode === 'meshes') {
        await page.waitForFunction(() => window.courseArtDraw.stone >= 1 && window.courseArtDraw.slab >= 1);
        const first = await page.evaluate(() => ({ ...window.courseArtDraw }));
        await page.waitForFunction(() => window.courseArtDraw.stone === 0 && window.courseArtDraw.slab >= 1, null, { timeout: 10000 });
        await page.keyboard.press('r');
        await page.waitForFunction(() => window.courseArtDraw.stone >= 1);
        report.sections.release.push({ mode, glbs: glbs.length, requests: glbRequests.length, firstStone: first.stone });
      } else {
        await frames(page);
        assert.equal(await page.evaluate(() => window.courseArtDraw.stone), 0);
        report.sections.release.push({ mode, glbs: glbs.length, requests: glbRequests.length });
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
      await closeHttp(release);
    }
  }
  delete process.env.GAME_ART_MODE;
  const defaultBundle = await build({ configFile, logLevel: 'silent', build: { write: false } });
  assert.equal(bundleModules(defaultBundle).some(id => id.includes('GLTFLoader')), true, 'The package mode must default to meshes.');
}

async function verifyNegativeBuilds(packagePath, pack) {
  process.env.GAME_LEVEL = relative(root, packagePath);
  const tampered = structuredClone(pack);
  tampered.assets[0].id = `asset-${'0'.repeat(64)}`;
  for (const object of terrainObjects(tampered.level)) if (object.art?.assetId === pack.assets[0].id) object.art.assetId = tampered.assets[0].id;
  const tamperedPath = join(temporary, 'tampered-course.json');
  await writeJson(tamperedPath, tampered);
  process.env.GAME_LEVEL = relative(root, tamperedPath);
  delete process.env.GAME_ART_MODE;
  await expectBuildRejects(/content hash/, 'Tampered asset IDs must be rejected by content hash.');

  const plain = structuredClone(pack.level);
  const plainPath = join(temporary, 'plain-art-level.json');
  await writeJson(plainPath, plain);
  process.env.GAME_LEVEL = relative(root, plainPath);
  process.env.GAME_ART_MODE = 'meshes';
  await expectBuildRejects(/self-contained course package/, 'Plain level art refs must not build in mesh mode.');

  process.env.GAME_LEVEL = relative(root, packagePath);
  process.env.GAME_ART_MODE = 'bogus';
  await expectBuildRejects(/GAME_ART_MODE/, 'Unknown GAME_ART_MODE must be rejected.');
  report.sections.negativeBuilds = true;
}

async function verifyLargeCourse(stonePath) {
  const levelPath = join(temporary, 'large-level.json');
  const assignmentsPath = join(temporary, 'large-assignments.json');
  const packagePath = join(temporary, 'large-course.json');
  const level = {
    schemaVersion: 2,
    labels: [],
    objects: [
      baseTerrain('floor', { type: 'box' }, 0, -0.5, 20, 1, { depth: 1 }),
      ...Array.from({ length: 999 }, (_, index) => baseTerrain(`box-${index}`, { type: 'box' },
        (index % 20 - 10) * 2, (Math.floor(index / 20) + 1) * 12 - 0.45, 0.9, 0.9, { depth: 1 })),
      { kind: 'start', id: 'start', x: 0, y: 4, angle: 0.5, extension: 0.3 },
    ],
  };
  await writeJson(levelPath, level);
  await writeJson(assignmentsPath, Object.fromEntries(terrainObjects(level).map(object => [object.id, relative(temporary, stonePath)])));
  await runPack(levelPath, assignmentsPath, packagePath);
  const pack = await readJson(packagePath);
  assert.equal(pack.assets.length, 1);
  process.env.GAME_LEVEL = relative(root, packagePath);
  process.env.GAME_ART_MODE = 'meshes';
  const bundle = await build({ configFile, logLevel: 'silent', build: { write: false } });
  const glbs = bundleFiles(bundle).filter(file => file.type === 'asset' && file.fileName.endsWith('.glb'));
  assert.equal(glbs.length, 1);
  report.sections.largeCourse = { objects: terrainObjects(pack.level).length, assets: pack.assets.length, emittedGlbs: glbs.length };
}

async function withGameDev(inspect) {
  const server = await createServer({ configFile, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true } });
  try {
    await server.listen();
    const address = `http://127.0.0.1:${server.httpServer.address().port}/`;
    return await inspect(address);
  } finally { await closeVite(server); }
}

async function verifyRuntimeView(fixtures) {
  await withGameDev(async address => {
    const page = await browser.newPage();
    try {
      await page.goto(`${address}src/course-art-view.ts`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      const runtimeProof = () => page.evaluate(async ({ slab, stone, png }) => {
        const assert = {
          ok(value, message = 'Assertion failed.') { if (!value) throw new Error(message); },
          equal(actual, expected, message = `Expected ${actual} to equal ${expected}.`) {
            if (actual !== expected) throw new Error(message);
          },
          deepEqual(actual, expected, message = 'Expected values to be deeply equal.') {
            if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
          },
          throws(callback, pattern) {
            try { callback(); } catch (error) {
              if (pattern.test(error?.message ?? String(error))) return;
              throw error;
            }
            throw new Error('Expected function to throw.');
          },
        };
        const { CourseArtView } = await import('/src/course-art-view.ts');
        const resource = (id, source) => ({ id, name: `${id}.glb`, source });
        const makeHarness = async (resources, objects = []) => {
          const hidden = [];
          let listener;
          const view = new CourseArtView({
            terrain: { setHidden: (id, value) => hidden.push({ id, value }) },
            subscribe: next => { listener = next; return () => {}; },
            onMissing: message => { throw new Error(message); },
          });
          await view.load(resources);
          if (objects.length > 0) listener({ type: 'reset', objects });
          return { view, hidden, listener };
        };
        const corners = box => [
          [box.min.x, box.min.y, box.min.z], [box.min.x, box.min.y, box.max.z],
          [box.min.x, box.max.y, box.min.z], [box.min.x, box.max.y, box.max.z],
          [box.max.x, box.min.y, box.min.z], [box.max.x, box.min.y, box.max.z],
          [box.max.x, box.max.y, box.min.z], [box.max.x, box.max.y, box.max.z],
        ];
        const sort = points => points.map(point => point.map(value => Math.round(value * 1e9) / 1e9)).sort((a, b) =>
          a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
        const applyMatrix = (point, matrix) => {
          const e = matrix.elements;
          return [
            e[0] * point[0] + e[4] * point[1] + e[8] * point[2] + e[12],
            e[1] * point[0] + e[5] * point[1] + e[9] * point[2] + e[13],
            e[2] * point[0] + e[6] * point[1] + e[10] * point[2] + e[14],
          ];
        };
        const expected = object => {
          const c = Math.cos(object.angle), s = Math.sin(object.angle);
          const points = [];
          for (const x of [-object.width / 2, object.width / 2]) for (const y of [-object.height / 2, object.height / 2]) for (const z of [-object.depth, 0]) {
            points.push([object.x + c * x - s * y, object.y + s * x + c * y, z]);
          }
          return sort(points);
        };
        const shapeTypes = [
          { type: 'box' }, { type: 'ramp' }, { type: 'triangle' }, { type: 'circle' }, { type: 'hexagon' },
          { type: 'polygon', vertices: [{ x: -0.5, y: -0.4 }, { x: 0.35, y: -0.5 }, { x: 0.5, y: 0.25 }, { x: -0.2, y: 0.5 }] },
        ];
        const mirrors = ['none', 'x', 'diagonal'];
        const angles = [0, 0.4, -1.2];
        const objects = shapeTypes.flatMap((shape, shapeIndex) => angles.flatMap((angle, angleIndex) => mirrors.map((mirror, mirrorIndex) => ({
          kind: 'terrain', id: `fit-${shapeIndex}-${angleIndex}-${mirrorIndex}`, shape,
          x: (shapeIndex * angles.length * mirrors.length + angleIndex * mirrors.length + mirrorIndex) * 40,
          y: shapeIndex * 0.1, width: 1.2 + shapeIndex * 0.2, height: 0.9 + angleIndex * 0.3,
          angle, depth: 0.7 + mirrorIndex * 0.4, color: 0x71817a, illusion: false,
          art: { assetId: 'slab', mirror },
        }))));
        let harness = await makeHarness([resource('slab', slab)], objects);
        harness.view.setMode('meshes');
        harness.view.update({ time: 0, parts: [], cursor: {}, enemies: [] });
        assert.equal(harness.view.inspect().instances, objects.length);
        for (const object of objects) {
          assert.ok(harness.hidden.some(entry => entry.id === object.id && entry.value === true));
        }
        const batches = harness.view.root.children;
        assert.equal(batches.length, objects.length);
        for (const mesh of batches) {
          mesh.geometry.computeBoundingBox();
          const matrix = mesh.matrixWorld.clone();
          mesh.getMatrixAt(0, matrix);
          const actual = sort(corners(mesh.geometry.boundingBox).map(point => applyMatrix(point, matrix)));
          const centerX = matrix.elements[12];
          const object = objects.find(candidate => Math.abs(candidate.x - centerX) < 1e-6);
          assert.ok(object, 'Every one-instance batch must map back to one object.');
          const target = expected(object);
          for (let index = 0; index < actual.length; index++) for (let axis = 0; axis < 3; axis++) {
            assert.ok(Math.abs(actual[index][axis] - target[index][axis]) <= 1e-6,
              `Bounds mismatch for ${object.id}: ${JSON.stringify(actual)} vs ${JSON.stringify(target)}.`);
          }
        }
        harness.view.setMode('shapes');
        for (const object of objects) assert.ok(harness.hidden.some(entry => entry.id === object.id && entry.value === false));
        assert.equal(harness.view.inspect().instances, 0);
        harness.view.dispose();

        const many = Array.from({ length: 999 }, (_, index) => ({
          kind: 'terrain', id: `many-${index}`, shape: { type: 'box' }, x: index % 20, y: Math.floor(index / 20),
          width: 0.8, height: 0.8, angle: 0, depth: 1, color: 0x71817a, illusion: false,
          art: { assetId: 'stone', mirror: 'none' },
        }));
        harness = await makeHarness([resource('stone', stone)], many);
        harness.view.setMode('meshes');
        harness.view.update({ time: 1, parts: [], cursor: {}, enemies: [] });
        let before = harness.view.inspect();
        assert.equal(before.assets, 1);
        assert.equal(before.instances, 999);
        assert.ok(before.batches < 100, `Expected fewer than 100 batches, got ${before.batches}.`);
        harness.view.update({ time: 1, parts: [], cursor: {}, enemies: [] });
        harness.view.update({ time: 1, parts: [], cursor: {}, enemies: [] });
        let after = harness.view.inspect();
        assert.equal(after.matrixWrites, before.matrixWrites);
        assert.equal(after.materialUpdates, before.materialUpdates);
        const moved = { ...many[123], x: many[123].x + 0.25 };
        before = harness.view.inspect();
        harness.listener({ type: 'upsert', object: moved });
        harness.view.update({ time: 2, parts: [], cursor: {}, enemies: [] });
        after = harness.view.inspect();
        assert.equal(after.matrixWrites, before.matrixWrites + 1);
        assert.equal(after.boundsUpdates, before.boundsUpdates + 1);
        harness.view.dispose();

        const illusion = { ...many[0], id: 'illusion', illusion: true };
        harness = await makeHarness([resource('stone', stone)], [illusion]);
        harness.view.setMode('meshes');
        harness.listener({ type: 'fade', id: 'illusion', startedAt: 10 });
        assert.equal(harness.view.inspect().fadingBatches, 1);
        before = harness.view.inspect();
        harness.view.update({ time: 10.4, parts: [], cursor: {}, enemies: [] });
        after = harness.view.inspect();
        assert.ok(after.materialUpdates > before.materialUpdates);
        harness.view.update({ time: 10.4, parts: [], cursor: {}, enemies: [] });
        assert.equal(harness.view.inspect().materialUpdates, after.materialUpdates);
        harness.listener({ type: 'disappear', id: 'illusion' });
        assert.equal(harness.view.inspect().instances, 0);
        harness.listener({ type: 'reset', objects: [illusion] });
        assert.equal(harness.view.inspect().instances, 1);
        assert.equal(harness.view.inspect().fadingBatches, 0);
        harness.view.dispose();

        harness = await makeHarness([], [{ ...illusion, id: 'missing', art: { assetId: 'absent', mirror: 'none' } }]);
        assert.throws(() => harness.view.setMode('meshes'), /missing/);
        harness.view.dispose();

        for (const [id, source] of [['png', png.png], ['jpeg', png.jpeg], ['webp', png.webp]]) {
          harness = await makeHarness([resource(id, source)]);
          assert.equal(harness.view.inspect().assets, 1);
          harness.view.dispose();
        }
      }, fixtures);
      for (let attempt = 0; ; attempt++) {
        try {
          await runtimeProof();
          break;
        } catch (error) {
          if (attempt >= 2 || !/Execution context was destroyed/.test(error?.message ?? String(error))) throw error;
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(1000);
        }
      }
      report.sections.runtimeView = true;
    } finally { await page.close(); }
  });
}

async function verifyTextures() {
  const browserPage = await browser.newPage();
  try {
    await browserPage.goto('about:blank');
    return await browserPage.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const context = canvas.getContext('2d');
      context.fillStyle = '#f005d2';
      context.fillRect(0, 0, 2, 2);
      return { jpeg: canvas.toDataURL('image/jpeg'), webp: canvas.toDataURL('image/webp') };
    });
  } finally { await browserPage.close(); }
}

async function verifyTextureBuild(fixtures) {
  const names = Object.keys(fixtures);
  const level = {
    schemaVersion: 2,
    labels: [],
    objects: [
      ...names.map((name, index) => baseTerrain(`texture-${name}`, { type: 'box' }, index * 4, -0.5, 2, 1)),
      { kind: 'start', id: 'start', x: 0, y: 1, angle: 0, extension: 0.2 },
    ],
  };
  const assignments = {};
  for (const [name, bytes] of Object.entries(fixtures)) {
    await writeFile(join(temporary, `texture-${name}.glb`), bytes);
    assignments[`texture-${name}`] = `texture-${name}.glb`;
  }
  const levelPath = join(temporary, 'texture-level.json');
  const assignmentsPath = join(temporary, 'texture-assignments.json');
  const packagePath = join(temporary, 'texture-course.json');
  await writeJson(levelPath, level);
  await writeJson(assignmentsPath, assignments);
  await runPack(levelPath, assignmentsPath, packagePath);
  process.env.GAME_LEVEL = relative(root, packagePath);
  process.env.GAME_ART_MODE = 'meshes';
  const bundle = await build({ configFile, logLevel: 'silent', build: { write: false } });
  const glbs = bundleFiles(bundle).filter(file => file.type === 'asset' && file.fileName.endsWith('.glb'));
  assert.equal(glbs.length, names.length, 'PNG, JPEG, and WebP textured GLBs must pass build-time validation.');
  delete process.env.GAME_LEVEL;
  delete process.env.GAME_ART_MODE;
  report.sections.textureBuild = names;
}

async function verifyEditorRoundTrip(pack) {
  const server = await createServer({ configFile: workshopConfig, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  try {
    await server.listen();
    await observeBrowserPage(page, errors);
    const address = `http://127.0.0.1:${server.httpServer.address().port}/`;
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    assert.equal(await page.locator('.course-art').count(), 0);
    const toggle = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByRole('tab', { name: 'Level', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
    const before = {
      ...structuredClone(pack.level),
      objects: pack.level.objects.filter(object => ['floor', 'ledge', 'start'].includes(object.id)).map(object => structuredClone(object)),
    };
    await page.locator('.level-file').setInputFiles({ name: 'level.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(before)) });
    await page.waitForFunction(() => window.gettingOver.level().definition.objects.some(object => object.id === 'floor' && object.art));
    await frames(page);
    await page.locator('[data-level-tool="select"]').click();
    const point = await page.evaluate(() => window.gettingOver.project(window.gettingOver.level().definition.objects.find(object => object.id === 'ledge')));
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => window.gettingOver.level().editor.selected?.id === 'ledge');
    await page.locator('#level-x').fill('1.25');
    await page.locator('#level-x').press('Tab');
    await page.waitForFunction(() => window.gettingOver.level().editor.selected?.x === 1.25);
    await frames(page);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.level-export').click();
    const download = await downloadPromise;
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    const originalArt = Object.fromEntries(terrainObjects(before).map(object => [object.id, object.art]));
    const exportedArt = Object.fromEntries(terrainObjects(exported).map(object => [object.id, object.art]));
    assert.deepEqual(exportedArt, originalArt);
    assert.equal(exported.objects.find(object => object.id === 'ledge').x, 1.25);
    assert.deepEqual(errors, []);
    report.sections.editorRoundTrip = true;
  } finally {
    await context.close();
    await closeVite(server);
  }
}

try {
  const proof = await makePackageProof();
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  await verifyRelease(proof.packagePath, proof.pack.assets.length);
  await verifyNegativeBuilds(proof.packagePath, proof.pack);
  await verifyLargeCourse(proof.stonePath);
  delete process.env.GAME_LEVEL;
  delete process.env.GAME_ART_MODE;
  const textureUris = await verifyTextures();
  const pngFixture = modelFixture({ textured: true });
  const jpegFixture = modelFixture({ imageUri: textureUris.jpeg });
  const webpFixture = modelFixture({ imageUri: textureUris.webp });
  await verifyTextureBuild({ png: pngFixture, jpeg: jpegFixture, webp: webpFixture });
  await verifyRuntimeView({
    slab: dataUri(modelFixture({ size: [2, 1, 3] })),
    stone: dataUri(modelFixture({ textured: true, segments: 16 })),
    png: { png: dataUri(pngFixture), jpeg: dataUri(jpegFixture), webp: dataUri(webpFixture) },
  });
  await verifyEditorRoundTrip(proof.pack);
  report.status = 'passed';
  console.log('Course mesh pipeline, runtime fitting, large course, illusions, editor round trip, and both release modes passed.');
} catch (error) {
  report.status = 'failed';
  report.error = error?.stack ?? String(error);
  throw error;
} finally {
  if (previousLevel === undefined) delete process.env.GAME_LEVEL; else process.env.GAME_LEVEL = previousLevel;
  if (previousMode === undefined) delete process.env.GAME_ART_MODE; else process.env.GAME_ART_MODE = previousMode;
  await browser?.close();
  await writeFile(join(artifacts, 'art-report.json'), JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true });
}
