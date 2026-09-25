import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { modelFixture } from './verify-appearance.mjs';
import { observeBrowserPage } from './verify-level.mjs';

export async function verifyCourseArt(browser, address, artifacts) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const report = { errors: [], generations: 0, uploads: 0 };
  await observeBrowserPage(page, report.errors);
  const fixture = modelFixture({ textured: true, segments: 16 });
  const resultFixture = modelFixture({ size: [2, 1, 1] });
  const id = data => `asset-${createHash('sha256').update(data).digest('hex')}`;
  const assetId = id(fixture);
  const resultId = id(resultFixture);
  const files = new Map([[assetId, fixture]]);
  const assets = [{ id: assetId, name: 'Shared stone', bytes: fixture.length, owner: 'artist', createdAt: 1 }];
  const variants = [];
  const jobs = [];
  let connected = false;
  let polls = 0;
  await page.route('**/api/art/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/art/'.length);
    let data;
    if (path === 'session') data = { owner: 'proof-owner', connected };
    else if (path === 'connection') {
      const key = request.postDataJSON()?.apiKey;
      if (request.method() === 'PUT') assert.equal(key, 'tsk-proof-editor-123456789');
      connected = request.method() !== 'DELETE'; data = { connected, balance: 500, frozen: 0 };
    } else if (path === 'catalog') data = { assets, variants };
    else if (path === 'variants') { data = request.postDataJSON(); variants.push(data); }
    else if (path === 'assets') {
      const form = await new Request(request.url(), { method: 'POST', headers: request.headers(), body: request.postDataBuffer() }).formData();
      const bytes = Buffer.from(await form.get('file').arrayBuffer()), assetId = id(bytes);
      if (!files.has(assetId)) assets.push({ id: assetId, name: form.get('name'), bytes: bytes.length, owner: 'proof-owner', createdAt: 2 });
      files.set(assetId, bytes); report.uploads++; data = assets.find(asset => asset.id === assetId);
    } else if (path.startsWith('assets/')) {
      const bytes = files.get(path.split('/')[1]);
      assert.ok(bytes, 'Only saved assets may be loaded.');
      await route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: bytes }); return;
    } else if (path === 'jobs' && request.method() === 'POST') {
      const form = await new Request(request.url(), { method: 'POST', headers: request.headers(), body: request.postDataBuffer() }).formData();
      assert.equal(form.get('consent'), 'true');
      assert.equal(form.get('kind'), 'texture');
      assert.equal(form.get('prompt'), 'Warm stylized masonry');
      assert.equal(form.get('seed'), '42');
      const guide = Buffer.from(await form.get('guide').arrayBuffer());
      assert.equal(guide.readUInt32LE(0), 0x46546c67);
      const document = JSON.parse(guide.subarray(20, 20 + guide.readUInt32LE(12)).toString());
      assert.equal(document.meshes.length, 1, 'Generation must export only the selected shape, not the whole level.');
      report.generations++;
      data = { id: crypto.randomUUID(), name: form.get('name'), status: 'queued', task_id: 'task_proof', progress: 0, asset_id: null, error: null };
      jobs.push(data);
    } else if (path === 'jobs') {
      if (jobs.length && ++polls >= 2) {
        const job = jobs[0]; job.status = 'ready'; job.progress = 100; job.asset_id = resultId;
        if (!files.has(resultId)) {
          files.set(resultId, resultFixture);
          assets.push({ id: resultId, name: job.name, bytes: resultFixture.length, owner: 'proof-owner', createdAt: 3 });
        }
      }
      data = jobs;
    } else throw new Error(`Unexpected editor artwork request: ${path}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const state = () => page.evaluate(() => window.gettingOver.level());
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const edit = async () => {
    if ((await page.evaluate(() => window.gettingOver.snapshot())).pointerLocked) await page.keyboard.press('Escape');
    const toggle = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByRole('tab', { name: 'Level', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
  };
  const importLevel = async definition => {
    const commits = (await state()).editor.commits;
    await page.locator('.level-file').setInputFiles({ name: 'art-level.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(definition)) });
    await page.waitForFunction(previous => window.gettingOver.level().editor.commits > previous, commits);
    await frames();
  };
  const open = async selector => { if (!await page.locator(selector).evaluate(node => node.open)) await page.locator(`${selector} > summary`).click(); };
  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    await edit();
    const initial = (await state()).definition;
    const start = { ...initial.objects.find(object => object.kind === 'start'), x: -4, y: 0.8 };
    const floor = { kind: 'terrain', id: 'art-floor', shape: { type: 'box' }, x: 4, y: -0.5, width: 20, height: 1, angle: 0, depth: 2, color: 0x71817a, illusion: false };
    await importLevel({ schemaVersion: 2, labels: [], objects: [floor, start] });
    await page.locator('.art-refresh').click();
    await page.waitForFunction(() => window.gettingOver.level().editor.art.assetCount === 1);
    assert.equal((await state()).editor.art.connected, false, 'Reusing shared assets must not require a Tripo key.');
    await page.locator('[data-set-piece="rising-steps"]').click();
    await open('.art-prefab-edit');
    for (const index of [0, 1, 2]) await page.locator(`[data-art-part="${index}"]`).selectOption(assetId);
    await page.locator('.art-variant-name').fill('Stone stairs');
    await page.locator('.art-save-variant').click();
    await page.waitForFunction(() => window.gettingOver.level().editor.art.variantCount === 1);
    assert.equal(report.generations, 0);
    await page.locator('.art-mode').selectOption('meshes');
    await page.waitForFunction(() => window.gettingOver.level().editor.art.rendering.mode === 'meshes');
    const point = await page.evaluate(() => window.gettingOver.project({ x: 4, y: 0.15 }));
    await page.mouse.click(point.x, point.y);
    await frames();
    let placed = await state();
    const stairs = placed.definition.objects.filter(object => object.id.startsWith('rising-steps-'));
    assert.equal(stairs.length, 3);
    assert.ok(stairs.every(object => object.art.assetId === assetId));
    assert.equal(placed.editor.art.rendering.assets, 1);
    assert.equal(placed.editor.art.rendering.instances, 3);
    assert.equal(placed.terrain.bodyCount, 4);
    assert.equal(placed.rendering.terrain.instances, 1);
    const objectPoint = await page.evaluate(object => window.gettingOver.project(object), stairs[2]);
    await page.mouse.click(objectPoint.x, objectPoint.y);
    await page.waitForFunction(() => window.gettingOver.level().editor.selected?.kind === 'terrain');
    await page.locator('.art-object-asset').selectOption('');
    await page.locator('.art-assign').click();
    assert.equal((await state()).editor.selected.art, undefined);
    await page.locator('.art-object-asset').selectOption(assetId);
    await page.locator('.art-assign').click();
    await page.waitForFunction(id => window.gettingOver.level().editor.selected?.art?.assetId === id, assetId);
    const beforeGeneration = (await state()).definition;
    await open('.art-connection');
    await page.locator('.art-key').fill('tsk-proof-editor-123456789');
    await page.locator('.art-connect').click();
    await page.waitForFunction(() => window.gettingOver.level().editor.art.connected);
    assert.equal(await page.locator('.art-key').inputValue(), '');
    await open('.art-generation');
    await page.locator('.art-name').fill('Warm stone');
    await page.locator('.art-prompt').fill('Warm stylized masonry');
    await page.locator('.art-seed').fill('42');
    assert.equal(await page.locator('.art-generate').isDisabled(), true);
    await page.locator('.art-consent').check();
    await page.locator('.art-generate').click();
    await page.waitForFunction(() => window.gettingOver.level().editor.art.jobs[0]?.status === 'ready');
    assert.equal(report.generations, 1);
    assert.deepEqual((await state()).definition, beforeGeneration, 'Generated results must not overwrite the selected course automatically.');
    await page.getByRole('button', { name: 'Select saved result' }).click();
    await page.waitForFunction(() => !document.querySelector('.art-preview-canvas').hidden);
    assert.equal(await page.locator('.art-assets').inputValue(), resultId);
    await page.locator('.art-release-mode').selectOption('meshes');
    const exporting = page.waitForEvent('download');
    await page.locator('.art-export').click();
    const pack = JSON.parse(await readFile(await (await exporting).path(), 'utf8'));
    assert.equal(pack.mode, 'meshes'); assert.equal(pack.assets.length, 1);
    assert.equal(pack.assets[0].id, assetId);
    assert.ok(!JSON.stringify(pack).includes('tsk-proof') && !JSON.stringify(pack).includes('task_proof'));
    const packagePath = fileURLToPath(new URL('course-art-package.json', artifacts));
    await writeFile(packagePath, JSON.stringify(pack));
    report.packagePath = packagePath;
    await page.reload({ waitUntil: 'networkidle' }); await edit();
    await page.locator('.art-refresh').click();
    await page.waitForFunction(() => window.gettingOver.level().editor.art.assetCount === 2);
    await page.locator('.art-package-file').setInputFiles({ name: 'course.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack)) });
    await page.waitForFunction(() => window.gettingOver.level().definition.objects.some(object => object.art));
    assert.equal(report.generations, 1, 'Import/reuse must never spend generation credits.');
    await page.locator('.art-mode').selectOption('meshes');
    await page.waitForFunction(() => window.gettingOver.level().editor.art.rendering.instances === 3);

    await page.locator('#level-set-piece-category').selectOption('vertical');
    await page.locator('[data-set-piece="orange-hell"]').click();
    await open('.art-prefab-edit');
    await page.locator('[data-art-part="0"]').selectOption(assetId);
    await page.waitForFunction(() => !window.gettingOver.level().editor.art.busy);
    assert.equal(await page.locator('.art-prefab-variant').inputValue(), 'custom');
    await page.locator('#level-set-piece-mirror').check();
    const mirroredPoint = await page.evaluate(() => window.gettingOver.project({ x: 0, y: 0.15 }));
    await page.mouse.click(mirroredPoint.x, mirroredPoint.y);
    await frames();
    assert.equal((await state()).definition.objects.find(object => object.id.startsWith('orange-hell-') && object.art)?.art.mirror, 'diagonal');
    report.mirroredPrefab = true;

    const many = Array.from({ length: 999 }, (_, index) => ({
      ...floor, id: `art-${index}`, x: (index % 20 - 10) * 2, y: (Math.floor(index / 20) + 1) * 12 - 0.45,
      width: 0.9, height: 0.9, depth: 1, art: { assetId, mirror: 'none' },
    }));
    await importLevel({ schemaVersion: 2, labels: [], objects: [floor, start, ...many] });
    const large = await state();
    assert.equal(large.terrain.bodyCount, 1000);
    assert.equal(large.editor.art.rendering.instances, 999);
    assert.ok(large.editor.art.rendering.batches < 100);
    await page.waitForTimeout(250);
    const staticState = await state();
    assert.deepEqual(staticState.editor.art.rendering, large.editor.art.rendering, 'Static art must not upload matrices or update materials each frame.');
    assert.ok(staticState.rendering.calls < 180, `Large course draw calls must stay batched, got ${staticState.rendering.calls}.`);
    assert.ok(staticState.rendering.triangles >= 999 * 3072, 'The large-course proof must draw representative 3,072-triangle assets.');
    const height = Math.max(...many.map(object => object.y + object.height / 2));
    assert.equal(height, 600);
    report.largeLevel = { objects: 1000, height, calls: staticState.rendering.calls,
      triangles: staticState.rendering.triangles, assetTriangles: 3072, ...staticState.editor.art.rendering };
    const editPoint = await page.evaluate(object => window.gettingOver.project(object), many[500]);
    await page.mouse.click(editPoint.x, editPoint.y);
    await page.waitForFunction(id => window.gettingOver.level().editor.selected?.id === id, many[500].id);
    const beforeMove = (await state()).editor.art.rendering;
    await page.locator('#level-x').fill(String(many[500].x + 0.3));
    await page.locator('#level-x').press('Tab');
    await frames();
    const afterMove = (await state()).editor.art.rendering;
    assert.equal(afterMove.matrixWrites - beforeMove.matrixWrites, 1, 'Moving one mesh must update only its instance.');
    assert.equal(afterMove.boundsUpdates - beforeMove.boundsUpdates, 1);
    assert.equal(afterMove.assets, beforeMove.assets);
    report.largeLevel.singleEditMatrixWrites = afterMove.matrixWrites - beforeMove.matrixWrites;

    const ledge = { ...floor, id: 'art-illusion', x: 0, y: 2, width: 6, height: 0.5, illusion: true, art: { assetId, mirror: 'none' } };
    await importLevel({ schemaVersion: 2, labels: [], objects: [floor, { ...start, x: 0, y: 4, angle: 0.5, extension: 0.3 }, ledge] });
    const authored = (await state()).definition;
    await page.locator('.level-play').click();
    await page.waitForFunction(() => window.gettingOver.level().editor.art.rendering.fadingBatches === 1);
    await page.keyboard.press('p');
    const paused = await state();
    await page.waitForTimeout(150);
    assert.equal((await state()).editor.art.rendering.materialUpdates, paused.editor.art.rendering.materialUpdates);
    await page.keyboard.press('p');
    await page.waitForFunction(() => window.gettingOver.level().terrain.disappeared.includes('art-illusion'));
    assert.equal((await state()).editor.art.rendering.instances, 0);
    assert.deepEqual((await state()).definition, authored);
    await page.keyboard.press('p'); await page.keyboard.press('r'); await frames();
    assert.equal((await state()).editor.art.rendering.instances, 1);
    assert.equal((await state()).editor.art.rendering.fadingBatches, 0);
    await edit();
    await page.locator('.art-mode').selectOption('shapes');
    await frames();
    assert.equal((await state()).rendering.terrain.instances, 2);
    assert.equal((await state()).editor.art.rendering.instances, 0);
    assert.equal((await state()).terrain.bodyCount, 2);
    report.illusions = { fading: true, pause: true, reset: true, authoredDataPreserved: true };
    const imageFormats = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
      const context = canvas.getContext('2d'); context.fillStyle = '#cc2299'; context.fillRect(0, 0, 2, 2);
      return ['image/jpeg', 'image/webp'].map(type => ({ type, uri: canvas.toDataURL(type) }));
    });
    for (const image of imageFormats) {
      assert.ok(image.uri.startsWith(`data:${image.type};`));
      const count = (await state()).editor.art.assetCount;
      await page.locator('.art-glb-file').setInputFiles({
        name: 'texture-format.glb', mimeType: 'model/gltf-binary', buffer: modelFixture({ imageUri: image.uri }),
      });
      await page.waitForFunction(count => window.gettingOver.level().editor.art.assetCount === count + 1, count);
    }
    report.textureFormats = ['png', 'jpeg', 'webp'];
    assert.equal(report.generations, 1, 'Sharing existing models must not generate anything.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.art-refresh').scrollIntoViewIfNeeded();
    const width = await page.locator('.course-art').evaluate(node => ({
      width: node.getBoundingClientRect().width, overflow: node.scrollWidth - node.clientWidth,
    }));
    assert.ok(width.width <= 390 && width.overflow <= 1, 'Artwork controls must fit a narrow editor without horizontal scrolling.');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: fileURLToPath(new URL('course-art-editor.png', artifacts)) });
    assert.deepEqual(report.errors, []);
    return report;
  } finally { await context.close(); }
}
