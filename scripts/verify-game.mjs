import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import { chromium } from 'playwright';
import { observeBrowserPage } from './verify-level.mjs';
import { dragTouch } from './verify-mobile.mjs';
import { texturePng } from './verify-appearance.mjs';

const TOUCH_DRAG_PIXELS = 40;
const TOUCH_PIXELS_PER_REACH = 100;
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const configFile = join(root, 'vite.game.config.ts');
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(artifacts, 'release-proof-'));
const levelPath = join(temporary, 'level.json');
const spritePath = join(temporary, 'sprites.json');
const customOutput = join(temporary, 'game');
const previousLevel = process.env.GAME_LEVEL;
const previousSprites = process.env.GAME_SPRITES;
const report = { status: 'incomplete', errors: [], entries: [], blocked: [] };
let browser;

const frames = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function minimalHud(page, width) {
  assert.equal(await page.locator('#fatal-error').isHidden(), true);
  assert.equal(await page.evaluate(() => typeof window.gettingOver), 'undefined');
  assert.equal(await page.getByRole('tab').count(), 0);
  assert.equal(await page.getByRole('button').count(), 0);
  assert.equal(await page.locator('input[type="file"], .game-actions, .game-help, .brand, .peak-value').count(), 0);
  assert.deepEqual(await page.locator('.play-hud dt').allTextContents(), ['CURRENT HEIGHT', 'ELAPSED']);
  assert.equal(await page.locator('.play-hud dd').count(), 2);
  const canvas = await page.locator('#game').boundingBox();
  assert.equal(canvas.width, width, 'The release canvas must not reserve an empty editor column.');
  return canvas;
}

async function tracePointerMapping(page, sources) {
  return page.evaluate(async ({ view, config }) => {
    const { GameView } = await import(view);
    const { RIG } = await import(config);
    const original = GameView.prototype.pointerDelta;
    window.releasePointerSamples = [];
    GameView.prototype.pointerDelta = function (pixels, sensitivity, mode) {
      const world = original.call(this, pixels, sensitivity, mode);
      if (pixels.x !== 0 || pixels.y !== 0) {
        window.releasePointerSamples.push({ pixels, world, sensitivity, mode, camera: this.cameraState() });
      }
      return world;
    };
    return RIG.maxReach;
  }, sources);
}

async function touchRelease(browser, address, sources) {
  const results = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    const context = await browser.newContext({ viewport, screen: viewport, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      const protocol = await observeBrowserPage(page, report.errors);
      await page.goto(address, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelector('.elapsed-value')?.textContent !== '00:00');
      await minimalHud(page, viewport.width);
      const reach = await tracePointerMapping(page, sources);
      const metric = await page.locator('.play-hud > div').first().boundingBox();
      const start = { x: metric.x + metric.width / 2, y: metric.y + metric.height / 2 };
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).id, start), 'game',
        'The readouts must not intercept hammer gestures.');
      // Raw coordinates avoid the extra touch slop added by synthesized scrolling.
      await dragTouch(page, protocol, { start, delta: { x: 0, y: TOUCH_DRAG_PIXELS } });
      const samples = await page.evaluate(() => window.releasePointerSamples);
      assert.ok(samples.length > 0 && samples.every(sample => sample.mode === 'touch'));
      const pixels = samples.reduce((total, sample) => total + sample.pixels.y, 0);
      const world = samples.reduce((total, sample) => total + sample.world.y, 0);
      assert.ok(Math.abs(Math.abs(pixels) - TOUCH_DRAG_PIXELS) < 1);
      for (const sample of samples) {
        assert.ok(Math.abs(sample.world.y + sample.pixels.y * reach / TOUCH_PIXELS_PER_REACH * sample.sensitivity) < 1e-9,
          'The release must use the stronger touch mapping, not camera-dependent mouse gain.');
      }
      assert.equal(await page.evaluate(() => document.pointerLockElement), null);
      assert.equal(await page.locator('#fatal-error').isHidden(), true);
      await page.screenshot({ path: join(artifacts, `game-release-${viewport.width < viewport.height ? 'portrait' : 'landscape'}.png`) });
      results.push({ viewport, dragPixels: Math.abs(pixels), targetMovement: Math.abs(world), hudPassesTouch: true });
    } finally { await context.close(); }
  }
  assert.ok(Math.abs(results[0].targetMovement - results[1].targetMovement) < 0.001);
  return results;
}

function bundleModules(bundle) {
  const results = Array.isArray(bundle) ? bundle : [bundle];
  return results.flatMap(result => result.output.filter(file => file.type === 'chunk')
    .flatMap(file => Object.keys(file.modules)));
}

function customLevel(lift) {
  return {
    schemaVersion: 1,
    spawn: { position: { x: 11, y: lift + 6 }, angle: -0.4, extension: 0.3 },
    summit: { xMin: 8, xMax: 15, y: lift + 8, arrivalTolerance: 0.1 },
    labels: [{ x: 10, y: lift + 7, text: 'RELEASE_LEVEL_SENTINEL' }],
    objects: [{
      id: 'release-floor', shape: { type: 'box' }, x: 11, y: lift + 3,
      width: 20, height: 2, angle: 0, depth: 2, color: 0x71817a, illusion: false,
    }],
  };
}

try {
  const bundle = await build({ configFile, logLevel: 'silent', build: { write: false } });
  const modules = bundleModules(bundle);
  assert.ok(modules.some(id => id.endsWith('/src/play.ts')));
  assert.ok(!modules.some(id => id.includes('/src/editor/') || id.includes('GLTFLoader')));
  const results = Array.isArray(bundle) ? bundle : [bundle];
  const styles = results.flatMap(result => result.output.filter(file =>
    file.type === 'asset' && file.fileName.endsWith('.css')));
  assert.ok(styles.every(asset => !/workshop|tuning-group|appearance-editor|level-editor|game-actions|game-help|brand-mark/.test(String(asset.source))),
    'Game-only styles must not include authoring UI or its controls/help.');
  report.modules = modules.length;

  for (const target of [
    'tuning-schema.ts', 'style.css', 'workshop.html?raw', 'game-ui.ts', 'game-ui.css',
    'sprite-editor.ts', 'sprite-editor.css', 'visual-store.ts',
  ]) {
    await assert.rejects(build({
      configFile, logLevel: 'silent', build: { write: false },
      plugins: [{
        name: 'release-boundary-probe', enforce: 'pre',
        transform(code, id) {
          if (id.endsWith('/src/play.ts')) return `${code}\nimport './editor/${target}';`;
        },
      }],
    }), /Editor code\/assets reached the game-only build/);
    report.blocked.push(target);
  }

  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await observeBrowserPage(page, report.errors);
  const ready = () => page.waitForFunction(() => {
    const elapsed = document.querySelector('.elapsed-value');
    return elapsed !== null && elapsed.textContent !== '00:00';
  });

  for (const mode of ['preview', 'development', 'custom', 'sprites']) {
    if (mode === 'custom') {
      await writeFile(levelPath, JSON.stringify(customLevel(0)));
      process.env.GAME_LEVEL = levelPath;
      const custom = await build({ configFile, logLevel: 'silent', build: { outDir: customOutput } });
      assert.ok(!bundleModules(custom).some(id => id.endsWith('/src/course.ts') || id.endsWith('/src/default-level.ts')));
      const outputs = Array.isArray(custom) ? custom : [custom];
      const code = outputs.flatMap(result => result.output.filter(file => file.type === 'chunk').map(file => file.code)).join('\n');
      assert.ok(code.includes('RELEASE_LEVEL_SENTINEL'));
      assert.ok(!/["']ascent["']/.test(code), 'A custom release must replace the built-in course.');
    }
    if (mode === 'sprites') {
      const source = `data:image/png;base64,${texturePng().toString('base64')}`;
      await writeFile(spritePath, JSON.stringify({
        schemaVersion: 1,
        images: [{ id: 'body', name: 'Generated body', source }, { id: 'alias', name: 'Shared source', source }],
        layers: [
          { id: 'body-card', name: 'Body card', anchor: 'pot', image: 'body', width: 1.2, height: 1,
            offset: { x: 0, y: 0, z: 0.6 }, rotation: 0, underlay: 'replace' },
          { id: 'head-card', name: 'Head card', anchor: 'character-head', image: 'alias', width: 0.4, height: 0.4,
            offset: { x: 0, y: 1.1, z: 0.6 }, rotation: 0, underlay: 'replace' },
        ],
      }));
      process.env.GAME_SPRITES = spritePath;
      const skin = await build({ configFile, logLevel: 'silent', build: { outDir: customOutput } });
      const outputs = (Array.isArray(skin) ? skin : [skin]).flatMap(result => result.output);
      assert.equal(outputs.filter(file => file.type === 'asset' && file.fileName.endsWith('.png')).length, 1,
        'Repeated PNG contents must share one hashed release asset.');
      assert.ok(outputs.filter(file => file.type === 'chunk').every(file => !file.code.includes(source)),
        'Uploaded PNG bytes must not be in executable JavaScript.');
      assert.ok(!bundleModules(skin).some(id => id.includes('/src/editor/') || id.includes('GLTFLoader')));
    }
    const development = mode === 'development';
    const server = development
      ? await createServer({ configFile, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true } })
      : await preview({
        configFile, logLevel: 'silent',
        ...(['custom', 'sprites'].includes(mode) ? { build: { outDir: customOutput } } : {}),
        preview: { host: '127.0.0.1', port: 0, strictPort: true },
      });
    try {
      if (development) await server.listen();
      const address = `http://127.0.0.1:${server.httpServer.address().port}/`;
      assert.equal((await fetch(address)).status, 200);
      await page.goto(address, { waitUntil: 'networkidle' });
      await ready();
      const canvas = await minimalHud(page, 1440);
      if (mode === 'custom' || mode === 'sprites') {
        const height = Number(await page.locator('.height-value').textContent());
        const floor = customLevel(0).objects[0];
        assert.ok(Math.abs(height - (floor.y + floor.height / 2)) < 0.2,
          `The custom course must support the pot at its authored floor, not the built-in floor (${height}m).`);
      }
      await page.locator('#game').focus();
      await page.keyboard.press('p');
      await frames(page);
      const elapsed = await page.locator('.elapsed-value').textContent();
      await page.keyboard.press('1');
      await page.keyboard.press('d');
      await page.waitForTimeout(1200);
      assert.equal(await page.locator('.elapsed-value').textContent(), elapsed);
      if (mode === 'preview') await page.screenshot({ path: join(artifacts, 'game-release.png') });
      await page.keyboard.press('r');
      await page.waitForFunction(() => document.querySelector('.elapsed-value').textContent === '00:00');
      if (development) {
        await page.keyboard.press('p');
        await ready();
        // Import the loaded modules, not aliases that instantiate a second copy.
        const viewModule = server.moduleGraph.getModuleById(join(root, 'src/view.ts'));
        const configModule = server.moduleGraph.getModuleById(join(root, 'src/config.ts'));
        assert.ok(viewModule && configModule);
        const sources = { view: viewModule.url, config: configModule.url };
        await tracePointerMapping(page, sources);
        const start = { x: canvas.width / 2, y: canvas.height / 2 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 24, start.y - 12, { steps: 4 });
        await page.mouse.up();
        await frames(page);
        const samples = await page.evaluate(() => window.releasePointerSamples);
        assert.ok(samples.length > 0 && samples.every(sample => sample.mode === 'mouse'));
        assert.equal(samples.reduce((total, sample) => total + sample.pixels.x, 0), 24);
        for (const sample of samples) {
          const scale = sample.camera.worldHeight / sample.camera.height * sample.sensitivity;
          assert.ok(Math.abs(sample.world.x - sample.pixels.x * scale) < 1e-9);
          assert.ok(Math.abs(sample.world.y + sample.pixels.y * scale) < 1e-9);
        }
        report.mouseMappingPreserved = true;
        report.touch = await touchRelease(browser, address, sources);
      }
      report.entries.push({ mode, canvas, keyboardPauseAndReset: true, heightAndTimeOnly: true });
    } finally {
      await page.goto('about:blank');
      if (development) await server.close();
      else await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    }
  }

  const development = await createServer({
    configFile, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  try {
    await development.listen();
    await page.goto(`http://127.0.0.1:${development.httpServer.address().port}/`, { waitUntil: 'networkidle' });
    await ready();
    await writeFile(levelPath, JSON.stringify(customLevel(100)));
    await page.waitForFunction(() => Number(document.querySelector('.height-value')?.textContent) > 100);
    report.customReload = true;
  } finally {
    await page.goto('about:blank');
    await development.close();
  }
  assert.deepEqual(report.errors, [], 'Release browser errors are not allowed.');
  report.status = 'passed';
  console.log('Game-only release, sprite assets, dependency boundary, custom level, and development scenarios passed.');
} finally {
  if (previousLevel === undefined) delete process.env.GAME_LEVEL;
  else process.env.GAME_LEVEL = previousLevel;
  if (previousSprites === undefined) delete process.env.GAME_SPRITES;
  else process.env.GAME_SPRITES = previousSprites;
  await writeFile(join(artifacts, 'game-release-report.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  await rm(temporary, { recursive: true });
}
