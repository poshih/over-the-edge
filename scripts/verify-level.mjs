import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SHAPES = ['box', 'platform', 'ramp', 'triangle', 'circle', 'hexagon'];
const terrainObjects = definition => definition.objects.filter(object => object.kind === 'terrain');

export async function observeBrowserPage(target, errors) {
  target.on('pageerror', error => errors.push(error.message));
  target.on('dialog', dialog => dialog.accept());
  const protocol = await target.context().newCDPSession(target);
  await protocol.send('Runtime.enable');
  await protocol.send('Log.enable');
  protocol.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error' || event.type === 'assert') {
      errors.push(event.args.map(arg => 'value' in arg ? String(arg.value) : arg.description).join(' '));
    }
  });
  protocol.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'error') errors.push(entry.text); });
  return protocol;
}

export async function verifyLevel(browser, address, artifacts) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const report = { errors: [], shapes: [] };
  await observeBrowserPage(page, report.errors);
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
  const editNumber = async (control, value) => {
    await control.fill(String(value));
    await control.press('Tab');
    await frames();
  };
  const field = (name, value) => editNumber(page.locator(`#level-${name}`), value);
  const project = (point) => page.evaluate(value => window.gettingOver.project(value), point);
  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    const initial = await state();
    const start = initial.definition.objects.find(object => object.kind === 'start');
    assert.ok(start);
    const initialSpawn = { position: { x: start.x, y: start.y }, angle: start.angle, extension: start.extension };
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
      assert.equal(placed.terrain.bodyCount, terrainObjects(placed.definition).length);
      assert.equal(placed.rendering.terrain.instances, terrainObjects(placed.definition).length);
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
      spawn: initialSpawn,
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
    const authoredIllusion = (await state()).definition;
    assert.equal(authoredIllusion.schemaVersion, 2);
    assert.equal(terrainObjects(authoredIllusion).length, illusion.objects.length);
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
    assert.deepEqual(vanished.definition, authoredIllusion, 'Transient effects must not delete authored objects.');
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
    assert.deepEqual(JSON.parse(await readFile(await download.path(), 'utf8')), authoredIllusion);
    report.illusion = { topLanding: true, solidDuringFade: true, paused: true, removedAfterFade: true, restartRestores: true, authoredExportPreserved: true };

    const creatureStart = { kind: 'start', id: 'creature-start', x: 0, y: 0.53, angle: 0, extension: 0.2 };
    const creatureFloor = { ...floor, kind: 'terrain', width: 30 };
    const emptyCreatureCourse = { schemaVersion: 2, labels: [], objects: [creatureFloor, creatureStart] };
    await importLevel(emptyCreatureCourse);
    for (const [name, x, base, center] of [['Bird', 2.35, 0.8, 1.2], ['Hollow soldier', -4, 0, 0.7]]) {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click();
      const point = await project({ x, y: base });
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(() => window.gettingOver.level().editor.selected?.kind === 'enemy');
      const placedEnemy = (await state()).editor.selected;
      assert.ok(Math.abs(placedEnemy.y - center) < 0.04, 'Enemy placement must anchor the sprite feet/base at the pointer.');
      await field('x', x);
      await field('y', center);
      await editNumber(page.getByRole('spinbutton', { name: /Patrol radius/i }), 0);
      await editNumber(page.getByRole('spinbutton', { name: /Patrol speed/i }), 0);
      await page.getByRole('combobox', { name: /facing|direction/i }).selectOption('left');
    }
    const creatures = (await state()).definition.objects.filter(object => object.kind === 'enemy');
    assert.deepEqual(creatures.map(object => object.species).sort(), ['bird', 'hollow-soldier']);
    assert.ok(creatures.every(object => object.speed === 0 && object.patrolDistance === 0 && object.facing === 'left'));
    assert.equal((await state()).editor.counts.enemies, 2);
    assert.equal((await state()).enemies.bodyCount, 0, 'Editing must not simulate enemy colliders.');
    await frames();
    assert.equal((await state()).rendering.enemies.instances, 2);
    await page.getByRole('textbox', { name: 'Level name', exact: true }).fill('Creature course');
    await page.getByRole('textbox', { name: 'Level name', exact: true }).press('Enter');
    const creatureKey = await page.getByRole('combobox', { name: 'Past levels', exact: true }).inputValue();
    const creatureSave = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), creatureKey);
    const creatureDownloadReady = page.waitForEvent('download');
    await page.locator('.level-export').click();
    const creatureDownload = await creatureDownloadReady;
    const creatureExport = JSON.parse(await readFile(await creatureDownload.path(), 'utf8'));
    assert.deepEqual(creatureExport, creatureSave.level);
    assert.ok(creatureExport.objects.filter(object => object.kind === 'enemy').every(object => !('health' in object) && !('phase' in object)));
    await page.screenshot({ path: fileURLToPath(new URL('enemies-editor.png', artifacts)) });
    const playCreatures = async definition => {
      await edit();
      await importLevel(definition);
      await page.locator('.level-play').click();
      await page.waitForFunction(() => !window.gettingOver.snapshot().paused && window.gettingOver.level().editor.mode === 'inactive');
      if ((await physics()).pointerLocked) {
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !window.gettingOver.snapshot().pointerLocked);
      }
    };
    const aimHammer = async point => {
      const canvas = await page.locator('#game').boundingBox();
      assert.ok(canvas);
      const pointer = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height * 0.45 };
      await page.mouse.move(pointer.x, pointer.y);
      await page.mouse.down();
      let current = await physics();
      const started = current.time;
      const deadline = Date.now() + 10_000;
      // Keep aiming at the opponent as recoil carries the character-relative target.
      while (current.time - started < 0.3) {
        assert.ok(Date.now() < deadline && !current.paused && !current.stopped, 'Combat aiming must advance through live physics.');
        const scale = current.camera.height / current.camera.worldHeight / current.tuning.mouseSensitivity;
        pointer.x += (point.x - current.cursor.x) * scale;
        pointer.y -= (point.y - current.cursor.y) * scale;
        await page.mouse.move(pointer.x, pointer.y);
        await frames();
        current = await physics();
      }
      await page.mouse.up();
    };
    const enemyState = async id => (await state()).enemies.enemies.find(enemy => enemy.id === id);
    report.enemies = { authoring: true, saveAndExport: true, kills: [] };
    for (const species of ['bird', 'hollow-soldier']) {
      const authored = creatures.find(object => object.species === species);
      const opponent = { ...authored, x: 2.35 };
      const encounter = { ...emptyCreatureCourse, objects: [creatureFloor, creatureStart, opponent] };
      await playCreatures(encounter);
      await aimHammer({ x: opponent.x, y: 1.2 });
      if (species === 'hollow-soldier') {
        await page.waitForFunction(id => window.gettingOver.level().enemies.enemies.find(enemy => enemy.id === id)?.health === 1, opponent.id);
        await page.waitForTimeout(350);
        assert.equal((await enemyState(opponent.id)).health, 1, 'A held hammer must not drain enemy health.');
        await aimHammer({ x: 0.6, y: 1.3 });
        await page.waitForTimeout(350);
        const target = await enemyState(opponent.id);
        await aimHammer({ x: target.x, y: target.y + 0.35 });
      }
      await page.waitForFunction(id => window.gettingOver.level().enemies.enemies.find(enemy => enemy.id === id)?.phase === 'dead', opponent.id);
      assert.equal((await enemyState(opponent.id)).defeatedBy, 'hammer');
      assert.equal((await state()).enemies.bodyCount, 0);
      await page.waitForFunction(() => window.gettingOver.level().rendering.enemies.instances === 0);
      assert.deepEqual((await state()).definition, encounter, 'Enemy death must not mutate the saved level.');
      await page.screenshot({ path: fileURLToPath(new URL(`enemy-${species}-defeated.png`, artifacts)) });
      await page.keyboard.press('p');
      await page.keyboard.press('r');
      await frames();
      assert.equal((await enemyState(opponent.id)).health, species === 'bird' ? 1 : 2);
      assert.equal((await state()).rendering.enemies.instances, 1);
      report.enemies.kills.push({ species, hammerHead: true, resetRestored: true, authoredPreserved: true });
    }
    // A soldier pushed off a high ledge must keep falling until its fall defeat, not sleep in mid-air.
    const perch = { ...creatureFloor, id: 'fall-perch', x: -3, y: 49.5, width: 3, height: 1 };
    const faller = {
      ...creatures.find(object => object.species === 'hollow-soldier'), id: 'fall-soldier', x: 2, y: 50.7,
    };
    await playCreatures({ ...emptyCreatureCourse, objects: [perch, { ...creatureStart, y: 50.53, x: -3 }, faller] });
    await page.waitForFunction(id => window.gettingOver.level().enemies.enemies.find(enemy => enemy.id === id)?.defeatedBy === 'fall', faller.id);
    assert.equal((await state()).enemies.bodyCount, 0, 'A fallen soldier must release its collider.');
    report.enemies.fallDefeat = true;
    await edit();
    const crowd = Array.from({ length: 64 }, (_, index) => ({
      ...creatures[index % creatures.length], id: `creature-${index}`,
      x: index % 16 - 7.5, y: 7 + Math.floor(index / 16) * 1.5,
    }));
    const crowded = { ...emptyCreatureCourse, objects: [creatureFloor, creatureStart, ...crowd] };
    await importLevel(crowded);
    const creatureRendering = (await state()).rendering;
    assert.equal(creatureRendering.enemies.instances, 64);
    assert.equal((await state()).enemies.bodyCount, 0);
    await page.waitForTimeout(500);
    assert.deepEqual((await state()).rendering.enemies, creatureRendering.enemies,
      'Paused/static sprites must not rewrite buffers or rebuild resources.');
    const markerOnly = {
      ...crowded, objects: [creatureFloor, creatureStart, ...crowd.map(enemy => ({
        kind: 'trigger', id: enemy.id, name: 'Bounds reference', x: enemy.x, y: enemy.y,
        region: { type: 'box', width: enemy.species === 'bird' ? 1.2 : 1, height: enemy.species === 'bird' ? 0.8 : 1.4 },
        activation: 'once', marker: 'none', events: [{ type: 'stop-timer' }],
      }))],
    };
    await importLevel(markerOnly);
    const creatureBaseline = (await state()).rendering;
    assert.equal(creatureBaseline.enemies.instances, 0);
    assert.equal((await state()).editor.counts.enemies, 0);
    assert.equal(creatureRendering.calls - creatureBaseline.calls, 1, 'Both species must share one draw batch.');
    assert.equal(creatureRendering.triangles - creatureBaseline.triangles, 64 * 2);
    await importLevel(crowded);
    const rejected = (await state()).definition;
    await page.locator('.level-file').setInputFiles({
      name: 'too-many-creatures.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...crowded, objects: [...crowded.objects, { ...crowd[0], id: 'overflow-enemy' }] })),
    });
    await page.waitForFunction(() => document.querySelector('.notice-message').textContent.includes('64'));
    assert.deepEqual((await state()).definition, rejected);
    report.enemies.capacity = { instances: 64, drawCalls: 1, triangles: 128, staticWrites: 0, overflowRejected: true, retyping: true };

    await page.goto('about:blank');
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    });
    const touch = await phone.newPage();
    try {
      const touchProtocol = await observeBrowserPage(touch, report.errors);
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
      assert.equal(terrainObjects(placed.definition).length, 4);
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
      await tap(touch.getByRole('button', { name: 'Workshop', exact: true }));
      await tap(touch.getByRole('tab', { name: 'Level', exact: true }));
      const beforeCreatures = await touch.evaluate(() => window.gettingOver.level().editor.commits);
      await touch.locator('.level-file').setInputFiles({
        name: 'touch-creatures.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
          ...emptyCreatureCourse, objects: [{ ...creatureFloor, width: 8 }, creatureStart],
        })),
      });
      await touch.waitForFunction(before => window.gettingOver.level().editor.commits > before, beforeCreatures);
      await tap(touch.getByRole('button', { name: 'Dismiss notification', exact: true }));
      for (const [name, x, y] of [['Bird', -2, 2.8], ['Hollow soldier', 2, 0]]) {
        await tap(touch.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }));
        const point = await touch.evaluate(position => window.gettingOver.project(position), { x, y });
        await tapPoint(point);
        await touch.waitForFunction(() => window.gettingOver.level().editor.selected?.kind === 'enemy');
        for (const label of [/Patrol radius/i, /Patrol speed/i]) {
          const control = touch.getByRole('spinbutton', { name: label });
          await control.fill('0');
          await control.press('Tab');
          const bounds = await control.boundingBox();
          const panel = await touch.locator('.workshop').boundingBox();
          assert.ok(bounds && bounds.height >= 48 && bounds.x >= panel.x && bounds.x + bounds.width <= panel.x + panel.width);
        }
      }
      const touchCreatures = await touch.evaluate(() => window.gettingOver.level());
      assert.equal(touchCreatures.editor.counts.enemies, 2);
      assert.equal(touchCreatures.rendering.enemies.instances, 2);
      assert.equal(touchCreatures.enemies.bodyCount, 0);
      await touch.getByRole('textbox', { name: 'Level name', exact: true }).fill('Touch creatures');
      await tap(touch.getByRole('button', { name: 'Save level', exact: true }));
      await tap(touch.locator('.level-play'));
      await touch.waitForFunction(() => window.gettingOver.level().enemies.activeCount === 2);
      assert.equal(await touch.evaluate(() => window.gettingOver.snapshot().pointerLocked), false);
      await touch.screenshot({ path: fileURLToPath(new URL('enemies-mobile.png', artifacts)) });
      report.mobile.enemies = { bothPlaceable: true, touchSizedControls: true, saved: true, playtestActive: 2 };
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
