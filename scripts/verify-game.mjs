import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const configFile = join(root, 'vite.game.config.ts');
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(artifacts, 'release-proof-'));
const levelPath = join(temporary, 'level.json');
const customOutput = join(temporary, 'game');
const previousLevel = process.env.GAME_LEVEL;
const report = { status: 'incomplete', errors: [], entries: [], blocked: [] };
let browser;

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
  assert.ok(styles.every(asset => !/workshop|tuning-group|appearance-editor|level-editor/.test(String(asset.source))),
    'Game-only styles must not include authoring UI.');
  report.modules = modules.length;

  for (const target of ['tuning-schema.ts', 'style.css', 'workshop.html?raw']) {
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
  page.on('pageerror', error => report.errors.push(error.message));
  const protocol = await page.context().newCDPSession(page);
  await protocol.send('Runtime.enable');
  await protocol.send('Log.enable');
  protocol.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error' || event.type === 'assert') {
      report.errors.push(event.args.map(arg => 'value' in arg ? String(arg.value) : arg.description).join(' '));
    }
  });
  protocol.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'error') report.errors.push(entry.text); });
  const ready = () => page.waitForFunction(() => {
    const elapsed = document.querySelector('.elapsed-value');
    return elapsed !== null && elapsed.textContent !== '00:00';
  });

  for (const mode of ['preview', 'development', 'custom']) {
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
    const development = mode === 'development';
    const server = development
      ? await createServer({ configFile, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true } })
      : await preview({
        configFile, logLevel: 'silent',
        ...(mode === 'custom' ? { build: { outDir: customOutput } } : {}),
        preview: { host: '127.0.0.1', port: 0, strictPort: true },
      });
    try {
      if (development) await server.listen();
      const address = `http://127.0.0.1:${server.httpServer.address().port}/`;
      assert.equal((await fetch(address)).status, 200);
      await page.goto(address, { waitUntil: 'networkidle' });
      await ready();
      assert.equal(await page.locator('#fatal-error').isHidden(), true);
      assert.equal(await page.evaluate(() => typeof window.gettingOver), 'undefined');
      assert.equal(await page.getByRole('tab').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Workshop', exact: true }).count(), 0);
      assert.equal(await page.locator('input[type="file"]').count(), 0);
      const canvas = await page.locator('#game').boundingBox();
      assert.equal(canvas.width, 1440, 'The release canvas must not reserve an empty editor column.');
      if (mode === 'custom') {
        const height = Number(await page.locator('.height-value').textContent());
        const floor = customLevel(0).objects[0];
        assert.ok(Math.abs(height - (floor.y + floor.height / 2)) < 0.2,
          `The custom course must support the pot at its authored floor, not the built-in floor (${height}m).`);
      }
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.pause-label').textContent === 'Resume');
      const elapsed = await page.locator('.elapsed-value').textContent();
      await page.locator('#game').focus();
      await page.keyboard.press('1');
      await page.keyboard.press('d');
      await page.waitForTimeout(1200);
      assert.equal(await page.locator('.elapsed-value').textContent(), elapsed);
      if (mode === 'preview') await page.screenshot({ path: join(artifacts, 'game-release.png') });
      await page.getByRole('button', { name: 'Reset', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.elapsed-value').textContent === '00:00');
      report.entries.push({ mode, canvas, pauseAndReset: true, noEditorUI: true });
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
  console.log('Game-only release, dependency boundary, custom level, and development scenarios passed.');
} finally {
  if (previousLevel === undefined) delete process.env.GAME_LEVEL;
  else process.env.GAME_LEVEL = previousLevel;
  await writeFile(join(artifacts, 'game-release-report.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  await rm(temporary, { recursive: true });
}
