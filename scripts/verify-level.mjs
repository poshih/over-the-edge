import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SHAPES = ['box', 'platform', 'ramp', 'triangle', 'circle', 'hexagon'];

export async function verifyLevel(browser, address, artifacts) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const report = { errors: [], shapes: [] };
  const observePage = async (target) => {
    target.on('pageerror', error => report.errors.push(error.message));
    target.on('dialog', dialog => dialog.accept());
    const protocol = await target.context().newCDPSession(target);
    await protocol.send('Runtime.enable');
    await protocol.send('Log.enable');
    protocol.on('Runtime.consoleAPICalled', event => {
      if (event.type === 'error' || event.type === 'assert') {
        report.errors.push(event.args.map(arg => 'value' in arg ? String(arg.value) : arg.description).join(' '));
      }
    });
    protocol.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'error') report.errors.push(entry.text); });
    return protocol;
  };
  await observePage(page);
  const state = () => page.evaluate(() => window.gettingOver.level());
  const physics = () => page.evaluate(() => window.gettingOver.snapshot());
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const edit = async () => {
    if ((await physics()).pointerLocked) {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.gettingOver.snapshot().pointerLocked);
    }
    const toggle = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByRole('tab', { name: 'Level', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
    await frames();
  };
  const importLevel = async (definition) => {
    const commits = (await state()).editor.commits;
    await page.locator('.level-file').setInputFiles({
      name: 'course.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(definition)),
    });
    await page.waitForFunction(previous => window.gettingOver.level().editor.commits > previous, commits);
    await frames();
  };
  const field = async (name, value) => {
    await page.locator(`#level-${name}`).fill(String(value));
    await page.locator(`#level-${name}`).press('Tab');
    await frames();
  };
  const project = (point) => page.evaluate(value => window.gettingOver.project(value), point);
  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    const initial = await state();
    await edit();
    const paused = await physics();
    assert.ok(paused.pauseReasons.includes('level-editor'));
    assert.equal((await state()).rendering.terrain.matrixWrites, initial.rendering.terrain.matrixWrites,
      'Entering the editor without effects must not re-upload unchanged terrain.');
    const box = await page.locator('.level-overlay').boundingBox();
    for (const [index, shape] of SHAPES.entries()) {
      await page.locator(`[data-level-preset="${shape}"]`).click();
      const before = await state();
      const point = { x: box.x + box.width * (0.25 + index % 3 * 0.21), y: box.y + box.height * (0.3 + Math.floor(index / 3) * 0.24) };
      await page.mouse.move(point.x, point.y, { steps: 5 });
      assert.deepEqual((await state()).definition, before.definition, 'Placement previews must not author colliders.');
      await page.mouse.click(point.x, point.y);
      const placed = await state();
      assert.equal(placed.definition.objects.length, initial.definition.objects.length + index + 1);
      assert.equal(placed.terrain.bodyCount, placed.definition.objects.length);
      assert.equal(placed.rendering.terrain.instances, placed.definition.objects.length);
      assert.equal(placed.definition.objects.at(-1).shape.type, shape === 'platform' ? 'box' : shape);
      report.shapes.push(shape);
    }
    assert.equal((await physics()).time, paused.time);
    assert.deepEqual((await physics()).cursor, paused.cursor, 'Placement gestures must not move the hammer.');

    await page.locator('[data-level-tool="select"]').click();
    const last = (await state()).definition.objects.at(-1);
    const point = await project(last);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    const beforeDrag = await state();
    await page.mouse.move(point.x + 70, point.y - 35, { steps: 12 });
    const preview = await state();
    assert.equal(preview.editor.dragging, 'move');
    assert.deepEqual(preview.definition, beforeDrag.definition);
    assert.equal(preview.rendering.terrain.matrixWrites, beforeDrag.rendering.terrain.matrixWrites);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.deepEqual((await state()).definition, beforeDrag.definition);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 70, point.y - 35, { steps: 12 });
    await page.mouse.up();
    const moved = await state();
    assert.equal(moved.editor.commits, beforeDrag.editor.commits + 1);
    assert.equal(moved.rendering.terrain.geometriesBuilt, beforeDrag.rendering.terrain.geometriesBuilt);
    assert.equal((await physics()).time, paused.time);
    await field('angle', 25);
    await field('width', 3);
    await page.locator('#level-illusion').check();
    assert.equal((await state()).editor.selected.illusion, true);

    const name = page.getByRole('textbox', { name: 'Level name', exact: true });
    const history = page.getByRole('combobox', { name: 'Past levels', exact: true });
    await name.fill('Course <draft>');
    await name.press('Enter');
    const first = await history.inputValue();
    const firstLevel = (await state()).definition;
    await field('x', (await state()).editor.selected.x + 1);
    await name.press('Enter');
    const second = await history.inputValue();
    assert.notEqual(first, second);
    const secondLevel = (await state()).definition;
    await history.selectOption(first);
    assert.deepEqual((await state()).definition, secondLevel, 'History selection must not auto-load.');
    await page.locator('.load-level').click();
    assert.deepEqual((await state()).definition, firstLevel);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    await edit();
    assert.deepEqual((await state()).definition, initial.definition, 'Reload must not auto-load an authored level.');
    await history.selectOption(first);
    await page.locator('.load-level').click();
    assert.deepEqual((await state()).definition, firstLevel);
    report.history = { repeatedNames: true, explicitLoad: true, survivedReload: true };

    const unchanged = (await state()).definition;
    await page.locator('.level-file').setInputFiles({
      name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken'),
    });
    await page.waitForFunction(() => document.querySelector('.notice-message').textContent.includes('malformed'));
    assert.deepEqual((await state()).definition, unchanged);
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();

    const floor = {
      id: 'floor', shape: { type: 'box' }, x: 0, y: -1, width: 100, height: 2,
      angle: 0, depth: 1.5, color: 0x71817a, illusion: false,
    };
    const large = {
      schemaVersion: 1,
      spawn: initial.definition.spawn,
      summit: { xMin: 26, xMax: 29, y: 42, arrivalTolerance: 0.1 }, labels: [],
      objects: [floor, ...Array.from({ length: 999 }, (_, index) => ({
        ...floor, id: `rock-${index}`, shape: { type: ['box', 'ramp', 'triangle', 'circle', 'hexagon'][index % 5] },
        x: (index % 40 - 20) * 1.5, y: 3 + Math.floor(index / 40) * 1.5, width: 0.8, height: 0.8,
      }))],
    };
    await importLevel(large);
    const loaded = await state();
    assert.equal(loaded.terrain.bodyCount, 1000);
    assert.equal(loaded.rendering.terrain.instances, 1000);
    assert.ok(loaded.rendering.calls < 100, `A representative 1,000-object course used ${loaded.rendering.calls} draw calls.`);
    await page.waitForTimeout(600);
    const idle = await state();
    for (const key of ['matrixWrites', 'colorWrites', 'boundsUpdates', 'geometriesBuilt', 'phaseUpdates']) {
      assert.equal(idle.rendering.terrain[key], loaded.rendering.terrain[key], `Static frames must not change ${key}.`);
    }
    assert.equal(idle.editor.draws, loaded.editor.draws, 'The editor must not run a whole-level redraw loop.');
    const rock = large.objects[1];
    const rockPoint = await project(rock);
    await page.mouse.move(rockPoint.x, rockPoint.y);
    await page.mouse.down();
    const startDrag = await state();
    await page.mouse.move(rockPoint.x + 30, rockPoint.y - 20, { steps: 20 });
    const drag = await state();
    assert.equal(drag.editor.commits, startDrag.editor.commits);
    assert.equal(drag.editor.hitTests, startDrag.editor.hitTests);
    assert.equal(drag.rendering.terrain.matrixWrites, startDrag.rendering.terrain.matrixWrites);
    await page.mouse.up();
    await frames();
    const edited = await state();
    assert.equal(edited.editor.commits, startDrag.editor.commits + 1);
    assert.equal(edited.rendering.terrain.geometriesBuilt, startDrag.rendering.terrain.geometriesBuilt);
    assert.ok(edited.rendering.terrain.matrixWrites - startDrag.rendering.terrain.matrixWrites <= 4);
    report.largeLevel = { objects: 1000, calls: loaded.rendering.calls, batches: loaded.rendering.terrain.batches, staticUploads: 0, singleEditMatrixWrites: edited.rendering.terrain.matrixWrites - startDrag.rendering.terrain.matrixWrites };
    await page.screenshot({ path: fileURLToPath(new URL('level-large.png', artifacts)) });

    const illusion = {
      schemaVersion: 1,
      spawn: { position: { x: 0, y: 4 }, angle: 0.5, extension: 0.3 },
      summit: { xMin: 8, xMax: 10, y: 5, arrivalTolerance: 0.1 }, labels: [],
      objects: [
        floor,
        { ...floor, id: 'vanishing-ledge', x: 0, y: 2, width: 6, height: 0.5, illusion: true },
      ],
    };
    await importLevel(illusion);
    await page.locator('.level-play').click();
    await page.waitForFunction(() => !window.gettingOver.snapshot().paused && window.gettingOver.level().editor.mode === 'inactive');
    await page.waitForFunction(() => window.gettingOver.level().terrain.fading.some(item => item.id === 'vanishing-ledge'));
    const fadeStart = (await state()).terrain.fading[0].startedAt;
    await page.waitForFunction(time => window.gettingOver.snapshot().time >= time, fadeStart + 0.25);
    await page.keyboard.press('p');
    await page.waitForFunction(() => window.gettingOver.snapshot().paused);
    const held = await state();
    assert.equal(held.terrain.bodyCount, 2, 'Illusions must stay solid during the fade.');
    assert.equal(held.rendering.terrain.fadingInstances, 1);
    const heldTime = (await physics()).time;
    await page.waitForTimeout(900);
    assert.equal((await physics()).time, heldTime);
    assert.deepEqual((await state()).terrain, held.terrain, 'Pauses must freeze disappearance.');
    await page.screenshot({ path: fileURLToPath(new URL('level-illusion-fading.png', artifacts)) });
    await page.keyboard.press('p');
    await page.waitForFunction(() => window.gettingOver.level().terrain.disappeared.includes('vanishing-ledge'));
    await frames();
    const vanished = await state();
    assert.equal(vanished.terrain.bodyCount, 1);
    assert.equal(vanished.rendering.terrain.instances, 1);
    assert.deepEqual(vanished.definition, illusion, 'Transient effects must not delete authored objects.');
    await page.keyboard.press('p');
    await page.keyboard.press('r');
    await frames();
    const reset = await state();
    assert.equal(reset.terrain.bodyCount, 2);
    assert.equal(reset.rendering.terrain.instances, 2);
    assert.equal(reset.rendering.terrain.activePhases, 0);
    assert.deepEqual(reset.terrain.disappeared, []);
    const writes = reset.rendering.terrain.matrixWrites;
    await page.keyboard.press('r');
    await frames();
    assert.equal((await state()).rendering.terrain.matrixWrites, writes, 'Restart must leave unaffected terrain buffers alone.');
    await edit();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.level-export').click();
    const download = await downloadPromise;
    assert.deepEqual(JSON.parse(await readFile(await download.path(), 'utf8')), illusion);
    report.illusion = { topLanding: true, solidDuringFade: true, paused: true, removedAfterFade: true, restartRestores: true, authoredExportPreserved: true };
    await page.goto('about:blank');
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    });
    const touch = await phone.newPage();
    try {
      const touchProtocol = await observePage(touch);
      const touchEvent = (type, point) => touchProtocol.send('Input.dispatchTouchEvent', {
        type, touchPoints: point === undefined ? [] : [{ ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
      });
      const tapPoint = async (point) => {
        await touchEvent('touchStart', point);
        await touchEvent('touchEnd');
      };
      const tap = async (locator) => {
        await locator.scrollIntoViewIfNeeded();
        const bounds = await locator.boundingBox();
        assert.ok(bounds, 'Touch controls must be visible.');
        await tapPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
      };
      await touch.goto(address, { waitUntil: 'networkidle' });
      await touch.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
      await tap(touch.getByRole('button', { name: 'Workshop', exact: true }));
      await tap(touch.getByRole('tab', { name: 'Level', exact: true }));
      await touch.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
      const frozen = await touch.evaluate(() => window.gettingOver.snapshot());
      await tap(touch.locator('[data-level-preset="circle"]'));
      const overlay = await touch.locator('.level-overlay').boundingBox();
      const spot = { x: overlay.x + overlay.width * 0.7, y: overlay.y + overlay.height * 0.55 };
      await tapPoint(spot);
      const placed = await touch.evaluate(() => window.gettingOver.level());
      assert.equal(placed.definition.objects.length, 4);
      assert.equal(placed.terrain.bodyCount, 4);
      assert.equal(placed.definition.objects.at(-1).shape.type, 'circle');
      await tap(touch.locator('[data-level-tool="select"]'));
      await touchEvent('touchStart', spot);
      await touchEvent('touchMove', { x: spot.x - 25, y: spot.y - 25 });
      assert.deepEqual((await touch.evaluate(() => window.gettingOver.level())).definition, placed.definition);
      await touchEvent('touchCancel');
      assert.deepEqual((await touch.evaluate(() => window.gettingOver.level())).definition, placed.definition);
      // A one-step move/release generates a native fling that consumes the next tap.
      await touchProtocol.send('Input.synthesizeScrollGesture', {
        x: spot.x, y: spot.y, xDistance: -25, yDistance: -25,
        gestureSourceType: 'touch', preventFling: true,
      });
      const moved = await touch.evaluate(() => window.gettingOver.level());
      assert.equal(moved.editor.commits, placed.editor.commits + 1);
      const unchangedPlayer = await touch.evaluate(() => window.gettingOver.snapshot());
      assert.equal(unchangedPlayer.time, frozen.time);
      assert.deepEqual(unchangedPlayer.cursor, frozen.cursor);
      assert.equal(unchangedPlayer.inputMode, 'touch');
      assert.equal(unchangedPlayer.pointerLocked, false);
      assert.equal(await touch.evaluate(() => document.querySelector('#app').scrollTop), 0);
      await tap(touch.locator('.level-play'));
      await touch.waitForFunction(() => !window.gettingOver.snapshot().paused && window.gettingOver.level().editor.mode === 'inactive');
      assert.equal(await touch.evaluate(() => window.gettingOver.snapshot().pointerLocked), false);
      await touch.screenshot({ path: fileURLToPath(new URL('level-mobile-playtest.png', artifacts)) });
      report.mobile = { touchPlacement: true, cancelPreserved: true, oneDragCommit: true, inputSeparated: true, playtestResumed: true };
    } finally {
      await phone.close();
    }
    assert.deepEqual(report.errors, []);
    return report;
  } finally {
    await writeFile(new URL('level-report.json', artifacts), JSON.stringify(report, null, 2));
    await context.close();
  }
}
