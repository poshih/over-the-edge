import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import { verifyCourseArt } from './verify-course-art.mjs';
import { verifyArtService } from './verify-art-service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = new URL('../artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(fileURLToPath(artifacts), 'art-proof-'));
const report = { status: 'incomplete' };
const previousLevel = process.env.GAME_LEVEL, previousMode = process.env.GAME_ART_MODE;
let browser, editor;
try {
  report.service = await verifyArtService(temporary);
  editor = await preview({ logLevel: 'silent', preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  const address = `http://127.0.0.1:${editor.httpServer.address().port}/`;
  assert.equal((await fetch(address)).status, 200);
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  report.editor = await verifyCourseArt(browser, address, artifacts);
  process.env.GAME_LEVEL = relative(root, report.editor.packagePath);
  report.releases = [];
  for (const mode of ['shapes', 'meshes']) {
    process.env.GAME_ART_MODE = mode;
    const output = join(temporary, mode);
    const bundle = await build({
      configFile: join(root, 'vite.game.config.ts'), logLevel: 'silent', build: { outDir: output },
    });
    const files = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(entry => entry.output);
    const modules = files.filter(file => file.type === 'chunk').flatMap(file => Object.keys(file.modules));
    assert.ok(!modules.some(id => id.includes('/src/editor/') || id.includes('/worker/') || id.includes('GLTFExporter')));
    assert.equal(modules.some(id => id.includes('GLTFLoader')), mode === 'meshes');
    const glbs = files.filter(file => file.type === 'asset' && file.fileName.endsWith('.glb'));
    assert.equal(glbs.length, mode === 'meshes' ? 1 : 0);
    const release = await preview({
      configFile: join(root, 'vite.game.config.ts'), logLevel: 'silent', build: { outDir: output },
      preview: { host: '127.0.0.1', port: 0, strictPort: true },
    });
    const page = await browser.newPage();
    const errors = [], assetRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('.glb')) assetRequests.push(request.url()); });
    try {
      const address = `http://127.0.0.1:${release.httpServer.address().port}/`;
      await page.goto(address, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelector('.elapsed-value')?.textContent !== '00:00');
      assert.equal(await page.evaluate(() => typeof window.gettingOver), 'undefined');
      assert.equal(await page.getByRole('tab').count(), 0);
      assert.equal(await page.locator('#fatal-error').isHidden(), true);
      assert.equal(assetRequests.length, mode === 'meshes' ? 1 : 0);
      assert.deepEqual(errors, []);
      report.releases.push({ mode, meshes: glbs.length, editorFree: true });
    } finally {
      await page.close();
      await new Promise((resolve, reject) => release.httpServer.close(error => error ? reject(error) : resolve()));
    }
  }
  const malformed = JSON.parse(await readFile(report.editor.packagePath, 'utf8'));
  malformed.assets[0].id = `asset-${'0'.repeat(64)}`;
  for (const object of malformed.level.objects) if (object.art) object.art.assetId = malformed.assets[0].id;
  malformed.variants = [];
  const invalid = join(temporary, 'invalid.json');
  await writeFile(invalid, JSON.stringify(malformed));
  process.env.GAME_LEVEL = relative(root, invalid);
  await assert.rejects(build({ configFile: join(root, 'vite.game.config.ts'), logLevel: 'silent', build: { write: false } }), /content hash/);
  report.status = 'passed';
  console.log('Shared artwork service, editor reuse, large course, illusions, and both release modes passed.');
} catch (error) {
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  if (previousLevel === undefined) delete process.env.GAME_LEVEL; else process.env.GAME_LEVEL = previousLevel;
  if (previousMode === undefined) delete process.env.GAME_ART_MODE; else process.env.GAME_ART_MODE = previousMode;
  await browser?.close();
  if (editor) await new Promise((resolve, reject) => editor.httpServer.close(error => error ? reject(error) : resolve()));
  await writeFile(new URL('art-report.json', artifacts), JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true });
}
