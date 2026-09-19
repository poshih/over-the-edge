import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { modelFixture } from './verify-appearance.mjs';

const TOUCH_DRAG_PIXELS = 40;
const TOUCH_PIXELS_PER_REACH = 100;
const clampLength = (point, max) => {
  const length = Math.hypot(point.x, point.y);
  if (length <= max || length === 0) return point;
  const scale = max / length;
  return { x: point.x * scale, y: point.y * scale };
};

export async function dragTouch(page, protocol, { start, delta }) {
  await protocol.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ ...start, id: 1, radiusX: 6, radiusY: 6, force: 1 }],
  });
  for (let step = 1; step <= 5; step++) {
    await protocol.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{
        x: start.x + delta.x * step / 5, y: start.y + delta.y * step / 5,
        id: 1, radiusX: 6, radiusY: 6, force: 1,
      }],
    });
    await page.waitForTimeout(20);
  }
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function monitorInput(page) {
  const protocol = await page.context().newCDPSession(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await protocol.send('Runtime.enable');
  await protocol.send('Log.enable');
  protocol.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error' || event.type === 'assert') {
      errors.push(event.args.map((arg) => 'value' in arg ? String(arg.value) : arg.description).join(' '));
    }
  });
  protocol.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'error') errors.push(entry.text); });
  await page.addInitScript(() => {
    window.captureAttempts = 0;
    window.touchMoves = 0;
    document.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch') window.touchMoves++;
    }, true);
    const original = Element.prototype.requestPointerLock;
    Element.prototype.requestPointerLock = function (...args) {
      window.captureAttempts++;
      return original.apply(this, args);
    };
  });
  return { protocol, errors };
}

export async function verifyMobile(browser, address, artifacts) {
  const results = [];
  for (const [name, width, height] of [['portrait', 390, 844], ['landscape', 844, 390]]) {
    const context = await browser.newContext({
      viewport: { width, height }, screen: { width, height },
      isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    });
    try {
      const page = await context.newPage();
      const { protocol, errors } = await monitorInput(page);
      await page.goto(address, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.gettingOver && window.gettingOver.snapshot().time >= 1);
      const snapshot = () => page.evaluate(() => window.gettingOver.snapshot());
      const frames = () => page.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const drag = (dx, dy, start = { x: width * 0.48, y: height * 0.65 }) =>
        dragTouch(page, protocol, { start, delta: { x: dx, y: dy } });
      const visibleRig = async () => {
        const info = await page.evaluate(() => {
          const state = window.gettingOver.snapshot();
          const rect = document.querySelector('#game').getBoundingClientRect();
          const corners = state.parts.filter((part) => part.id === 'head' || part.id === 'pot')
            .flatMap((part) => part.vertices.map((vertex) => window.gettingOver.project({
              x: part.x + vertex.x * Math.cos(part.angle) - vertex.y * Math.sin(part.angle),
              y: part.y + vertex.x * Math.sin(part.angle) + vertex.y * Math.cos(part.angle),
            })));
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, corners };
        });
        assert.ok(info.corners.every((point) => point.x >= info.left - 1 && point.x <= info.right + 1 &&
          point.y >= info.top - 1 && point.y <= info.bottom + 1), 'Compact framing must keep the pot and head on the canvas.');
      };
      const initial = await snapshot();
      assert.equal(initial.inputMode, 'touch');
      assert.equal(initial.camera.compact, true);
      const reach = await page.evaluate(() => {
        const state = window.gettingOver.snapshot();
        const pivot = state.parts.find((part) => part.id === 'carrier');
        return [-1, 1].map((side) => window.gettingOver.project({ x: pivot.x + side * state.maxReach, y: pivot.y }));
      });
      assert.ok(reach.every((point) => point.x >= 0 && point.x <= width), 'Both horizontal reach extremes must fit on a phone.');
      const targets = await page.locator('.game-actions button').evaluateAll((buttons) =>
        buttons.map((button) => ({ name: button.textContent.trim(), height: button.getBoundingClientRect().height })));
      assert.ok(targets.every((target) => target.height >= 48), 'Mobile game buttons must have 48px touch targets.');
      assert.doesNotMatch(await page.locator('.game-help').innerText(), /mouse|escape|\besc\b|space/i);
      await page.getByRole('button', { name: 'Play', exact: true }).tap();
      await frames();
      assert.equal(await page.evaluate(() => window.captureAttempts), 0, 'Touch Play must never request mouse capture.');
      assert.equal((await snapshot()).pointerLocked, false);
      const beforeDrag = await snapshot();
      const dragGain = initial.maxReach * TOUCH_DRAG_PIXELS / TOUCH_PIXELS_PER_REACH;
      const expectedAfterDrag = clampLength({
        x: beforeDrag.cursorOffset.x,
        y: beforeDrag.cursorOffset.y + dragGain,
      }, initial.maxReach);
      await drag(0, -TOUCH_DRAG_PIXELS);
      const afterDrag = await snapshot();
      const movedOffset = Math.hypot(
        afterDrag.cursorOffset.x - beforeDrag.cursorOffset.x,
        afterDrag.cursorOffset.y - beforeDrag.cursorOffset.y,
      );
      assert.ok(Math.hypot(
        afterDrag.cursorOffset.x - expectedAfterDrag.x,
        afterDrag.cursorOffset.y - expectedAfterDrag.y,
      ) < 0.001, 'Finger movement must apply touch gain to the stored cursor offset, with radius clipping when needed.');
      assert.ok(movedOffset > 0.3, 'Finger movement must drive the hammer target.');
      await page.waitForFunction((time) => window.gettingOver.snapshot().time >= time, afterDrag.time + 1);
      const beforeClutch = await snapshot();
      await protocol.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: width * 0.25, y: height * 0.4, id: 2 }],
      });
      await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await frames();
      assert.deepEqual((await snapshot()).cursorOffset, beforeClutch.cursorOffset,
        'Lifting and repositioning a finger must not snap the stored target offset.');

      const aim = await snapshot();
      const pixelsPerWorld = TOUCH_PIXELS_PER_REACH / aim.maxReach;
      const targetOffset = { x: -aim.maxReach * 0.98, y: 0 };
      await drag((targetOffset.x - aim.cursorOffset.x) * pixelsPerWorld,
        -(targetOffset.y - aim.cursorOffset.y) * pixelsPerWorld, { x: width - 25, y: height * 0.6 });
      const aimedTime = (await snapshot()).time;
      await page.waitForFunction((time) => window.gettingOver.snapshot().time >= time, aimedTime + 1.5);
      const aimed = await snapshot();
      assert.ok(Math.hypot(aimed.cursorOffset.x - targetOffset.x, aimed.cursorOffset.y - targetOffset.y) < 0.05,
        'Touch aiming must land at the requested stored offset.');
      await visibleRig();
      await page.screenshot({ path: fileURLToPath(new URL(`mobile-${name}.png`, artifacts)) });

      await page.getByRole('button', { name: 'Workshop', exact: true }).tap();
      await frames();
      const opened = await snapshot();
      assert.equal(opened.paused, true);
      assert.deepEqual(opened.pauseReasons, ['workshop']);
      await page.waitForTimeout(200);
      assert.equal((await snapshot()).time, opened.time, 'The mobile editor must pause the simulation.');
      const canvasBox = await page.locator('#game').boundingBox();
      const panelBox = await page.locator('.workshop').boundingBox();
      assert.ok(canvasBox && panelBox);
      if (name === 'portrait') {
        assert.ok(canvasBox.height >= 300 && panelBox.y >= canvasBox.y + canvasBox.height - 1,
          'The portrait bottom sheet must reserve a visible game preview.');
      } else {
        assert.ok(canvasBox.width >= width / 2 && panelBox.x >= canvasBox.x + canvasBox.width - 1,
          'The landscape editor must leave at least half the width for the game.');
      }
      await visibleRig();
      const mass = (await snapshot()).tuning.playerMass;
      const increase = page.getByRole('button', { name: 'Increase Player mass', exact: true });
      await increase.tap();
      assert.equal((await snapshot()).tuning.playerMass, mass + 0.5);
      await page.getByRole('button', { name: 'Decrease Player mass', exact: true }).tap();
      assert.equal((await snapshot()).tuning.playerMass, mass);
      const stepBox = await increase.boundingBox();
      assert.ok(stepBox && stepBox.width >= 48 && stepBox.height >= 48);
      const tuningName = page.getByRole('textbox', { name: 'Game settings name', exact: true });
      const pastTuning = page.getByRole('combobox', { name: 'Past game settings', exact: true });
      await tuningName.fill(`Touch ${name}`);
      const savedSettings = await page.evaluate(() => window.gettingOver.settings());
      await page.getByRole('button', { name: 'Save game settings', exact: true }).tap();
      const savedKey = await pastTuning.inputValue();
      assert.ok(savedKey.startsWith('over-the-edge:game-settings:snapshot:v2:'));
      const savedRecord = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), savedKey));
      assert.equal(savedRecord.schemaVersion, 2);
      assert.equal(savedRecord.settings.schemaVersion, 2);
      const noticeBox = await page.locator('.ui-notice').boundingBox();
      assert.ok(noticeBox && (noticeBox.y + noticeBox.height <= panelBox.y || noticeBox.x + noticeBox.width <= panelBox.x),
        'Save feedback must not cover the workshop controls.');
      await increase.tap();
      await pastTuning.selectOption(savedKey);
      await page.getByRole('button', { name: 'Load game settings', exact: true }).tap();
      assert.deepEqual(await page.evaluate(() => window.gettingOver.settings()), savedSettings);
      await tuningName.scrollIntoViewIfNeeded();
      for (const control of [tuningName, pastTuning]) {
        const box = await control.boundingBox();
        assert.ok(box && box.height >= 48 && box.x >= panelBox.x && box.x + box.width <= panelBox.x + panelBox.width,
          'Named tuning controls must fit the mobile workshop and retain touch-sized targets.');
      }
      assert.equal(await page.locator('#app').evaluate((app) => app.scrollTop), 0,
        'Moving between saved tuning and deep physics controls must scroll only the workshop, never the game.');
      assert.ok((await page.locator('#game').boundingBox()).y >= 0);
      await page.screenshot({ path: fileURLToPath(new URL(`mobile-${name}-workshop.png`, artifacts)) });
      await page.getByRole('button', { name: 'Close workshop', exact: true }).tap();
      assert.equal((await snapshot()).paused, false, 'Closing the editor must resume a previously running game.');
      await page.getByRole('button', { name: 'Pause', exact: true }).tap();
      await page.getByRole('button', { name: 'Workshop', exact: true }).tap();
      await page.getByRole('button', { name: 'Close workshop', exact: true }).tap();
      assert.equal((await snapshot()).paused, true, 'Closing the editor must preserve a pre-existing manual pause.');
      assert.deepEqual((await snapshot()).pauseReasons, ['user']);
      await page.getByRole('button', { name: 'Play', exact: true }).tap();
      await page.getByRole('button', { name: 'Workshop', exact: true }).tap();
      await page.getByRole('button', { name: 'Play', exact: true }).tap();
      assert.equal((await snapshot()).paused, false, 'Play must close the compact editor and resume.');
      assert.equal(await page.locator('.workshop').isVisible(), false);

      await page.getByRole('button', { name: 'Workshop', exact: true }).tap();
      await page.getByRole('tab', { name: 'Appearance', exact: true }).tap();
      await page.waitForFunction(() => !window.gettingOver.appearance().restoring);
      const beforeArmEdit = await snapshot();
      const originalHints = await page.evaluate(() => window.gettingOver.appearance().armIk.settings);
      await page.getByRole('button', { name: 'Increase Left elbow hint X', exact: true }).tap();
      await page.getByRole('button', { name: 'Decrease Right elbow hint Y', exact: true }).tap();
      const editedHints = await page.evaluate(() => window.gettingOver.appearance().armIk.settings);
      assert.deepEqual(editedHints, { ...originalHints, leftHintX: -0.54, rightHintY: 0.14 });
      const ikName = page.getByRole('textbox', { name: 'IK profile name', exact: true });
      const pastIk = page.getByRole('combobox', { name: 'Past IK profiles', exact: true });
      await ikName.fill(`Touch ${name} pose`);
      await page.getByRole('button', { name: 'Save IK profile', exact: true }).tap();
      const savedIk = await pastIk.inputValue();
      assert.equal(await page.evaluate(() => window.gettingOver.appearance().armIk.dirty), false);
      await page.getByRole('button', { name: 'Reset arm IK', exact: true }).tap();
      assert.deepEqual(await page.evaluate(() => window.gettingOver.appearance().armIk.settings), originalHints);
      await pastIk.selectOption(savedIk);
      await page.getByRole('button', { name: 'Load IK profile', exact: true }).tap();
      assert.deepEqual(await page.evaluate(() => window.gettingOver.appearance().armIk.settings), editedHints);
      assert.deepEqual((await snapshot()).root, beforeArmEdit.root);
      assert.deepEqual((await snapshot()).tuning, beforeArmEdit.tuning);
      assert.equal(await page.locator('#app').evaluate((app) => app.scrollTop), 0);
      for (const control of [ikName, pastIk]) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(box && box.height >= 48 && box.x >= panelBox.x && box.x + box.width <= panelBox.x + panelBox.width);
      }
      const hintSlider = page.getByRole('slider', { name: 'Left elbow hint X', exact: true });
      await hintSlider.scrollIntoViewIfNeeded();
      const armControls = await hintSlider.boundingBox();
      assert.ok(armControls && armControls.height >= 48, 'Arm IK sliders must retain touch-sized targets.');
      await page.screenshot({ path: fileURLToPath(new URL(`mobile-${name}-arm-ik.png`, artifacts)) });

      await page.getByRole('tab', { name: 'Level', exact: true }).tap();
      const commits = await page.evaluate(() => window.gettingOver.level().editor.commits);
      await page.locator('.level-file').setInputFiles({
        name: 'touch-updraft.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
          schemaVersion: 2, labels: [],
          objects: [{ kind: 'start', id: 'touch-start', x: 0, y: 4, angle: 0, extension: 0.2 }],
        })),
      });
      await page.waitForFunction(before => window.gettingOver.level().editor.commits > before, commits);
      await page.locator('.ui-notice').getByRole('button').tap();
      await page.locator('[data-level-preset="updraft"]').tap();
      await frames();
      const ventBase = await page.evaluate(() => window.gettingOver.project({ x: 0, y: 3.3 }));
      await page.touchscreen.tap(ventBase.x, ventBase.y);
      const liftHeight = page.getByRole('spinbutton', { name: 'Lift height (m)', exact: true });
      const launchStrength = page.getByRole('spinbutton', { name: 'Launch strength (x)', exact: true });
      await liftHeight.fill('6');
      await launchStrength.fill('1.1');
      for (const control of [liftHeight, launchStrength]) {
        const box = await control.boundingBox();
        assert.ok(box && box.height >= 48 && box.x >= panelBox.x && box.x + box.width <= panelBox.x + panelBox.width,
          'Updraft controls must fit the mobile workshop and retain touch-sized targets.');
      }
      await page.getByRole('button', { name: 'Apply events', exact: true }).tap();
      const vent = await page.evaluate(() => window.gettingOver.level().definition.objects.find(object => object.kind === 'trigger'));
      assert.equal(vent.marker, 'updraft');
      assert.deepEqual(vent.events, [{ type: 'launch-player', height: 6, strength: 1.1 }]);
      await page.getByRole('textbox', { name: 'Level name', exact: true }).fill(`Touch updraft ${name}`);
      await page.getByRole('button', { name: 'Save level', exact: true }).tap();
      await page.getByRole('button', { name: 'Playtest', exact: true }).tap();
      await page.waitForFunction(() => window.gettingOver.snapshot().height > 8);
      assert.equal(await page.evaluate(id => window.gettingOver.events().triggers.triggers
        .find(trigger => trigger.id === id).activationCount, vent.id), 1);
      await page.screenshot({ path: fileURLToPath(new URL(`mobile-${name}-updraft.png`, artifacts)) });
      await page.getByRole('button', { name: 'Workshop', exact: true }).tap();
      await page.getByRole('tab', { name: 'Appearance', exact: true }).tap();

      if (name === 'portrait') {
        assert.equal(await page.getByRole('button', { name: 'Increase Visual scale', exact: true }).isDisabled(), true);
        await page.getByLabel('GLB model', { exact: true }).setInputFiles({
          name: 'touch-pot.glb', mimeType: 'model/gltf-binary', buffer: modelFixture(),
        });
        await page.waitForFunction(() => {
          const part = window.gettingOver.appearance().parts.find((part) => part.id === 'pot');
          return part.custom && !part.busy;
        });
        await page.getByRole('button', { name: 'Increase Rotate Z', exact: true }).tap();
        assert.equal(await page.evaluate(() => window.gettingOver.appearance().parts.find((part) => part.id === 'pot').alignment.rotationZ), 1);
        await page.getByRole('button', { name: 'Save alignment', exact: true }).tap();
        await page.waitForFunction(() => !window.gettingOver.appearance().parts.find((part) => part.id === 'pot').busy);
        const beforeRotate = await snapshot();
        await page.setViewportSize({ width: height, height: width });
        await frames();
        const afterRotate = await snapshot();
        assert.equal(afterRotate.paused, true);
        assert.deepEqual(afterRotate.cursor, beforeRotate.cursor, 'Rotating the phone must not inject target movement.');
        assert.deepEqual(afterRotate.cursorOffset, beforeRotate.cursorOffset);
        assert.deepEqual(afterRotate.root, beforeRotate.root);
        await visibleRig();
      }
      assert.equal(await page.evaluate(() => window.captureAttempts), 0);
      assert.deepEqual(errors, []);
      results.push({ name, dragPixels: TOUCH_DRAG_PIXELS, targetMovement: movedOffset, worldHeight: initial.camera.worldHeight,
        gamePreview: { width: canvasBox.width, height: canvasBox.height }, autoPause: true, captureAttempts: 0,
        updraft: { placed: true, tuned: true, saved: true, launched: true } });
    } finally {
      await context.close();
    }
  }
  assert.ok(Math.abs(results[0].targetMovement - results[1].targetMovement) < 0.001,
    'Touch sensitivity must stay the same in portrait and landscape.');

  const hybrid = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  try {
    const page = await hybrid.newPage();
    const { protocol, errors } = await monitorInput(page);
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.snapshot().pointerLocked);
    assert.equal(await page.evaluate(() => window.gettingOver.snapshot().inputMode), 'mouse');
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 300, id: 1 }] });
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => !window.gettingOver.snapshot().pointerLocked);
    await page.getByRole('button', { name: 'Play', exact: true }).tap();
    await page.waitForFunction(() => !window.gettingOver.snapshot().pointerLocked &&
      window.gettingOver.snapshot().inputMode === 'touch');
    assert.equal(await page.evaluate(() => window.captureAttempts), 1, 'Switching to touch must not request another mouse capture.');
    assert.deepEqual(errors, []);
    results.push({ name: 'hybrid', mouseCapturePreserved: true, touchSwitchReleasesCapture: true });
  } finally {
    await hybrid.close();
  }

  const cancelled = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await cancelled.newPage();
    const { protocol, errors } = await monitorInput(page);
    const start = new Date('2026-01-01T00:00:00Z');
    await page.clock.install({ time: start });
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver);
    await page.clock.pauseAt(new Date(start.getTime() + 10_000));
    const before = await page.evaluate(() => window.gettingOver.snapshot());
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 190, y: 420, id: 1 }] });
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 230, y: 420, id: 1 }] });
    assert.ok(await page.evaluate(() => window.touchMoves > 0));
    assert.deepEqual(await page.evaluate(() => window.gettingOver.snapshot().cursorOffset), before.cursorOffset);
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.clock.runFor(50);
    assert.deepEqual(await page.evaluate(() => window.gettingOver.snapshot().cursorOffset), before.cursorOffset,
      'A cancelled gesture must discard movement queued before the next animation frame.');
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 190, y: 420, id: 2 }] });
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 210, y: 420, id: 2 }] });
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.clock.runFor(50);
    const after = await page.evaluate(() => window.gettingOver.snapshot());
    const expected = clampLength({
      x: before.cursorOffset.x + before.maxReach * 20 / TOUCH_PIXELS_PER_REACH,
      y: before.cursorOffset.y,
    }, before.maxReach);
    assert.ok(Math.hypot(after.cursorOffset.x - expected.x, after.cursorOffset.y - expected.y) < 0.001,
      'A normal release must retain the last drag movement, clipped only by the target radius.');
    assert.deepEqual(errors, []);
    results.push({ name: 'cancellation', queuedMovementDiscarded: true, normalReleasePreserved: true });
  } finally {
    await cancelled.close();
  }
  return results;
}
