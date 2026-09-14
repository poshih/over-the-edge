import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { verifyAppearance } from './verify-appearance.mjs';
import { verifyMobile } from './verify-mobile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = new URL('../artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const server = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '0', '--strictPort',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

function serverAddress() {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Preview did not start:\n${output}`)), 30_000);
    const fail = (error) => { clearTimeout(timeout); reject(error); };
    server.once('error', fail);
    server.once('exit', (code) => fail(new Error(`Preview exited (${code}):\n${output}`)));
    const read = (chunk) => {
      output = (output + chunk.toString()).slice(-20_000);
      const address = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (address) { clearTimeout(timeout); resolve(address[0]); }
    };
    server.stdout.on('data', read);
    server.stderr.on('data', read);
  });
}

const report = { status: 'incomplete', errors: [], scenarios: {} };
let browser;
try {
  const address = await serverAddress();
  const response = await fetch(address);
  assert.equal(response.status, 200, 'The owned preview process must serve the game.');
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('requestfailed', (request) => report.errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  const protocol = await context.newCDPSession(page);
  await protocol.send('Runtime.enable');
  await protocol.send('Log.enable');
  protocol.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error' || event.type === 'assert') {
      report.errors.push(event.args.map((arg) => 'value' in arg ? String(arg.value) : arg.description).join(' '));
    }
  });
  protocol.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') report.errors.push(entry.text);
  });
  const snapshot = () => page.evaluate(() => window.gettingOver.snapshot());
  const ready = () => page.waitForFunction(() => window.gettingOver && window.gettingOver.snapshot().time > 0);
  const focusGame = () => page.locator('#game').focus();
  const practice = async (key) => {
    await focusGame();
    await page.keyboard.press(key);
    await page.waitForFunction(() => window.gettingOver.snapshot().time >= 2);
  };
  const observe = (seconds) => page.evaluate((duration) => new Promise((resolve, reject) => {
    const first = window.gettingOver.snapshot();
    let maxDrift = 0;
    let maxSpeed = 0;
    let maxRootAngle = 0;
    let maxPotAngle = 0;
    const deadline = setTimeout(() => reject(new Error('Simulation observation timed out.')), 60_000);
    function sample() {
      const state = window.gettingOver.snapshot();
      if (state.stopped) { clearTimeout(deadline); reject(new Error('The game stopped during observation.')); return; }
      maxDrift = Math.max(maxDrift, Math.hypot(state.root.x - first.root.x, state.root.y - first.root.y));
      maxSpeed = Math.max(maxSpeed, Math.hypot(state.rootVelocity.x, state.rootVelocity.y));
      maxRootAngle = Math.max(maxRootAngle, Math.abs(state.root.angle));
      maxPotAngle = Math.max(maxPotAngle, Math.abs(state.potAngle));
      if (state.time - first.time >= duration) {
        clearTimeout(deadline);
        resolve({ first, end: state, maxDrift, maxSpeed, maxRootAngle, maxPotAngle });
      } else {
        requestAnimationFrame(sample);
      }
    }
    sample();
  }), seconds);
  const dragInput = async (seconds, movementForState) => {
    const box = await page.locator('#game').boundingBox();
    assert.ok(box, 'Canvas must be visible.');
    const initial = await snapshot();
    const scale = initial.camera.height / initial.camera.worldHeight / initial.tuning.mouseSensitivity;
    const pointer = { x: box.x + box.width * 0.43, y: box.y + box.height * 0.32 };
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    const started = (await snapshot()).time;
    const deadline = Date.now() + 30_000;
    let progress = 0;
    while (progress < 1) {
      assert.ok(Date.now() < deadline, 'Drag must advance through real simulation time.');
      const state = await snapshot();
      const nextProgress = Math.min(1, (state.time - started) / seconds);
      const delta = movementForState(state, nextProgress, progress);
      progress = nextProgress;
      pointer.x += delta.x * scale;
      pointer.y -= delta.y * scale;
      await page.mouse.move(pointer.x, pointer.y);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  };
  const dragWorld = (delta, seconds) => dragInput(seconds, (_state, progress, previous) => ({
    x: delta.x * (progress - previous), y: delta.y * (progress - previous),
  }));

  await page.goto(address, { waitUntil: 'networkidle' });
  await ready();
  await practice('1');
  const rest = await observe(3);
  report.scenarios.rest = rest;
  assert.equal(rest.end.jointCount, 7);
  assert.equal(rest.end.parts.length, 8);
  assert.equal(rest.maxRootAngle, 0, 'The root rotation must stay locked.');
  assert.ok(rest.maxDrift < 0.03, `Idle start drifted ${rest.maxDrift} m.`);
  assert.ok(rest.end.parts.filter((part) => part.kind === 'handle').every((part) => !part.collides),
    'All shaft segments must be non-colliding.');
  assert.ok(rest.end.parts.filter((part) => part.kind === 'head' || part.kind === 'pot').every((part) => part.collides),
    'The hammer head and pot must retain their terrain collisions.');
  await page.screenshot({ path: fileURLToPath(new URL('playground.png', artifacts)) });

  await practice('3');
  const maxReach = (await snapshot()).maxReach;
  const aiming = [];
  report.scenarios.aiming = aiming;
  const goals = [
    { name: 'hinge', radius: 0, angle: 0 },
    { name: 'near-right', radius: 0.15, angle: 0 },
    { name: 'near-up', radius: 0.15, angle: Math.PI / 2 },
    { name: 'near-left', radius: 0.15, angle: Math.PI },
    { name: 'near-down', radius: 0.15, angle: -Math.PI / 2 },
    { name: 'outer-right', radius: maxReach - 0.05, angle: 0 },
    { name: 'outer-left', radius: maxReach - 0.05, angle: Math.PI },
    { name: 'outer-up', radius: maxReach - 0.05, angle: Math.PI / 2 },
  ];
  for (const goal of goals) {
    await dragInput(1.2, (state) => {
      const pivot = state.parts.find((part) => part.id === 'carrier');
      assert.ok(pivot);
      return {
        x: pivot.x + goal.radius * Math.cos(goal.angle) - state.cursor.x,
        y: pivot.y + goal.radius * Math.sin(goal.angle) - state.cursor.y,
      };
    });
    const before = await snapshot();
    await page.waitForFunction((time) => window.gettingOver.snapshot().time >= time, before.time + 0.6);
    const aimed = await snapshot();
    const error = Math.hypot(aimed.tip.x - aimed.cursor.x, aimed.tip.y - aimed.cursor.y);
    aiming.push({ goal, error, headContacts: aimed.headContacts, tip: aimed.tip, cursor: aimed.cursor });
    assert.equal(aimed.headContacts, 0, `${goal.name} must be a free-space aiming scenario.`);
    assert.ok(error < 0.03, `${goal.name} missed the drag target by ${error} m.`);
    if (goal.name === 'near-up') {
      assert.deepEqual(aimed.cursor, before.cursor, 'Free-space targets must not drift toward the lagging head.');
    }
  }
  await dragWorld({ x: 0, y: 1 }, 0.5);
  const overreachTime = (await snapshot()).time;
  await page.waitForFunction((time) => window.gettingOver.snapshot().time >= time, overreachTime + 1);
  const capped = await snapshot();
  const capPivot = capped.parts.find((part) => part.id === 'carrier');
  assert.ok(capPivot);
  const cappedRadius = Math.hypot(capped.cursor.x - capPivot.x, capped.cursor.y - capPivot.y);
  assert.ok(Math.abs(cappedRadius - maxReach) < 0.02, 'The cursor must clamp to the physical maximum reach.');
  assert.ok(Math.hypot(capped.tip.x - capped.cursor.x, capped.tip.y - capped.cursor.y) < 0.03,
    'The head must reach the clamped outer target.');
  report.scenarios.reachLimit = { maxReach, cappedRadius };

  await practice('2');
  const hold = await observe(10);
  report.scenarios.ledge = hold;
  assert.ok(hold.maxDrift < 0.03, `Ledge hold drifted ${hold.maxDrift} m.`);
  assert.ok(hold.end.height > 0.8, 'The ledge pose must remain suspended, not settle on the floor.');
  assert.ok(hold.maxPotAngle < 0.31, 'The pot must respect its limited hinge.');

  await practice('3');
  const beforePush = await snapshot();
  await dragWorld({ x: 0, y: -0.5 }, 2);
  const afterPush = await snapshot();
  const pushed = await observe(2);
  report.scenarios.groundPush = { beforePush, afterPush, ...pushed };
  assert.ok(afterPush.root.y > beforePush.root.y + 0.35, 'Real mouse input must lift the player through the slider motor.');
  assert.ok(pushed.end.headContacts > 0, 'The head, not the shaft, must support the ground push.');
  assert.ok(Math.abs(pushed.end.rootVelocity.y) < 0.2, 'The slow ground push must settle without continuing to bounce.');

  await practice('3');
  const beforePogo = await snapshot();
  await dragWorld({ x: 0, y: -1 }, 0.2);
  await focusGame();
  await page.keyboard.press('p');
  const beforeCamera = await snapshot();
  await page.keyboard.press('c');
  await page.waitForTimeout(100);
  const afterCamera = await snapshot();
  assert.deepEqual(afterCamera.cursor, beforeCamera.cursor, 'Camera recentering must not move the virtual cursor.');
  assert.deepEqual(afterCamera.root, beforeCamera.root, 'Camera recentering must not move the player.');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(100);
  assert.deepEqual((await snapshot()).cursor, beforeCamera.cursor, 'Canvas resizing must not move the cursor.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('p');
  const pogo = await observe(4);
  report.scenarios.pogo = { beforePogo, ...pogo };
  report.scenarios.camera = { before: beforeCamera.camera, after: afterCamera.camera, cursor: afterCamera.cursor };
  assert.ok(pogo.end.bestHeight > beforePogo.bestHeight + 1, 'A fast motor-driven push must produce a useful launch.');
  assert.equal(pogo.maxRootAngle, 0);
  assert.ok(pogo.end.parts.every((part) => [part.x, part.y, part.angle].every(Number.isFinite)));

  await practice('4');
  await dragInput(2, (state, progress) => {
    const pivot = state.parts.find((part) => part.id === 'carrier');
    assert.ok(pivot);
    const angle = 0.14 + (-3.1 - 0.14) * progress;
    const reach = 1.7;
    return {
      x: pivot.x + reach * Math.cos(angle) - state.cursor.x,
      y: pivot.y + reach * Math.sin(angle) - state.cursor.y,
    };
  });
  const vault = await observe(3);
  report.scenarios.vault = vault;
  assert.ok(vault.end.root.x > -7.7, 'The pot must clear the far side of the vault through mouse-driven motors.');
  assert.ok(vault.end.bestHeight > 1.2, 'The vault must lift the pot above the block, not pass through it.');

  await focusGame();
  await page.keyboard.press('p');
  await page.keyboard.press('d');
  await page.screenshot({ path: fileURLToPath(new URL('colliders.png', artifacts)) });
  assert.equal(await page.locator('.tuning-group legend').first().textContent(), 'Mass & recoil');
  const originalProperties = (await snapshot()).bodyProperties;
  const inertiaPerMass = Object.fromEntries(Object.entries(originalProperties)
    .map(([id, properties]) => [id, properties.inertia / properties.mass]));
  const assertMasses = (state) => {
    const shafts = state.parts.filter((part) => part.kind === 'handle');
    const expected = {
      root: state.tuning.playerMass * 0.25,
      pot: state.tuning.playerMass * 0.75,
      head: state.tuning.hammerMass,
      carrier: state.tuning.hingeCarrierMass,
      slider: state.tuning.sliderCarriageMass,
      ...Object.fromEntries(shafts.map((part) => [part.id, state.tuning.shaftMass / shafts.length])),
    };
    for (const [id, mass] of Object.entries(expected)) {
      assert.ok(Math.abs(state.bodyProperties[id].mass - mass) < 1e-9, `${id} must receive its tuned physical mass.`);
      assert.ok(Math.abs(state.bodyProperties[id].inertia - mass * inertiaPerMass[id]) < 1e-9,
        `${id} inertia must scale with its mass.`);
    }
  };
  assertMasses(await snapshot());
  for (const label of ['Shaft mass (total)', 'Hinge carrier mass', 'Slider carriage mass', 'Hammer head mass', 'Rotation speed cap']) {
    await page.getByRole('slider', { name: label, exact: true }).press('Home');
    assertMasses(await snapshot());
  }
  await page.getByRole('slider', { name: 'Player mass', exact: true }).press('ArrowRight');
  const lighter = await snapshot();
  assertMasses(lighter);
  assert.equal(lighter.tuning.shaftMass, 0.15);
  assert.equal(lighter.tuning.hingeCarrierMass, 0.1);
  assert.equal(lighter.tuning.sliderCarriageMass, 0.1);
  assert.equal(lighter.tuning.hammerMass, 0.5);
  assert.equal(lighter.tuning.angularSpeed, 2);
  report.scenarios.massControls = { before: originalProperties, after: lighter.bodyProperties };
  const hinge = page.getByRole('slider', { name: /Hinge strength/ });
  const initialTorque = (await snapshot()).tuning.hingeTorque;
  await hinge.focus();
  await page.keyboard.press('ArrowRight');
  const savedTorque = (await snapshot()).tuning.hingeTorque;
  const savedTuning = (await snapshot()).tuning;
  assert.ok(savedTorque > initialTorque, 'A live range control must reach the physics motor settings.');
  await page.getByRole('button', { name: 'Save tuning', exact: true }).click();
  await page.getByRole('button', { name: 'Defaults', exact: true }).click();
  assert.equal((await snapshot()).tuning.hingeTorque, initialTorque);
  const defaults = await snapshot();
  assertMasses(defaults);
  assert.equal(defaults.tuning.shaftMass, 0.66);
  assert.equal(defaults.bodyProperties.carrier.mass, 0.5);
  assert.equal(defaults.bodyProperties.carrier.inertia, 0.035);
  assert.equal(defaults.bodyProperties.slider.mass, 0.5);
  assert.equal(defaults.bodyProperties.slider.inertia, 0.035);
  await page.reload({ waitUntil: 'networkidle' });
  await ready();
  await page.getByRole('button', { name: 'Load tuning', exact: true }).click();
  assert.equal((await snapshot()).tuning.hingeTorque, savedTorque, 'A saved profile must survive a page reload.');
  assert.deepEqual((await snapshot()).tuning, savedTuning);
  assertMasses(await snapshot());
  await practice('2');
  const lightHold = await observe(2);
  assert.ok(!lightHold.end.stopped && lightHold.end.headContacts > 0 && lightHold.end.height > 0.8,
    'The lightweight mass settings must remain usable on a ledge.');
  report.scenarios.lightMassHold = lightHold;

  const legacyTuning = { ...savedTuning, hingeTorque: initialTorque + 20 };
  for (const key of ['shaftMass', 'hingeCarrierMass', 'sliderCarriageMass']) delete legacyTuning[key];
  const legacyRecord = JSON.stringify({ schemaVersion: 1, tuning: legacyTuning });
  await page.evaluate((record) => {
    localStorage.setItem('over-the-edge:tuning:v1', record);
    localStorage.removeItem('over-the-edge:tuning:v2');
  }, legacyRecord);
  const beforeBlockedMigration = (await snapshot()).tuning;
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restorePresetStorage = () => { Storage.prototype.setItem = original; delete window.restorePresetStorage; };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'over-the-edge:tuning:v2') throw new DOMException('Storage quota probe', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  try {
    await page.getByRole('button', { name: 'Load tuning', exact: true }).click();
    assert.deepEqual((await snapshot()).tuning, beforeBlockedMigration, 'Failed migration writes must not partially apply tuning.');
    assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v2')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v1')), legacyRecord);
    assert.ok(await page.getByRole('status').filter({ hasText: 'Tuning could not be saved.' }).isVisible());
  } finally {
    await page.evaluate(() => window.restorePresetStorage());
  }
  await page.getByRole('button', { name: 'Load tuning', exact: true }).click();
  const migrated = await snapshot();
  assert.deepEqual(migrated.tuning, {
    ...legacyTuning, shaftMass: 0.66, hingeCarrierMass: 0.5, sliderCarriageMass: 0.5,
  });
  assertMasses(migrated);
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v1')), legacyRecord);
  const upgradedRecord = await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v2'));
  assert.equal(JSON.parse(upgradedRecord).schemaVersion, 2);
  await page.getByRole('button', { name: 'Load tuning', exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v2')), upgradedRecord,
    'Repeated loading must not repeat or rewrite a completed migration.');
  await hinge.press('ArrowRight');
  const validTuning = (await snapshot()).tuning;
  await page.evaluate(() => localStorage.setItem('over-the-edge:tuning:v2', '{broken'));
  await page.getByRole('button', { name: 'Load tuning', exact: true }).click();
  assert.deepEqual((await snapshot()).tuning, validTuning, 'Invalid stored data must not replace the active profile.');
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v2')), '{broken');
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v1')), legacyRecord);
  assert.ok(await page.getByRole('status').filter({ hasText: 'Saved tuning is invalid:' }).isVisible(),
    'Invalid profiles must produce a visible explanation.');
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  const malformedLegacy = JSON.stringify({ schemaVersion: 1, tuning: { ...legacyTuning, shaftMass: 0.2 } });
  await page.evaluate((record) => {
    localStorage.removeItem('over-the-edge:tuning:v2');
    localStorage.setItem('over-the-edge:tuning:v1', record);
  }, malformedLegacy);
  await page.getByRole('button', { name: 'Load tuning', exact: true }).click();
  assert.deepEqual((await snapshot()).tuning, validTuning, 'Malformed legacy data must not change live tuning.');
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v1')), malformedLegacy);
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v2')), null);
  await page.getByRole('button', { name: 'Save tuning', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('over-the-edge:tuning:v2')).tuning), validTuning);
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v1')), malformedLegacy,
    'Saving a new current profile must preserve an invalid legacy record too.');
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await page.evaluate(() => localStorage.removeItem('over-the-edge:tuning:v1'));
  report.scenarios.persistence = {
    savedTorque, migratedVersion: 2, legacyRetained: true, invalidRecordRetained: true, writeFailureSafe: true,
  };

  await focusGame();
  await page.keyboard.press('4');
  await page.waitForFunction(() => window.gettingOver.snapshot().practice === 'vault');
  await page.getByRole('button', { name: /^Play$/ }).click();
  await page.waitForFunction(() => window.gettingOver.snapshot().pointerLocked);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.gettingOver.snapshot().pointerLocked);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.keyboard.press('p');
  await page.waitForFunction(() => window.gettingOver.snapshot().paused);
  await page.keyboard.press('p');
  await page.waitForFunction(() => !window.gettingOver.snapshot().paused);
  report.scenarios.appearance = await verifyAppearance(page, artifacts);
  report.scenarios.mobile = await verifyMobile(browser, address, artifacts);
  await page.setViewportSize({ width: 760, height: 600 });
  await page.waitForTimeout(300);
  const canvasBox = await page.locator('#game').boundingBox();
  assert.ok(canvasBox && canvasBox.width >= 400 && canvasBox.height >= 400, 'The responsive layout must leave room to play.');
  await page.screenshot({ path: fileURLToPath(new URL('compact.png', artifacts)) });
  assert.deepEqual(report.errors, [], 'Browser exceptions, console errors, and failed requests are not allowed.');
  report.status = 'passed';
  console.log('Browser gameplay scenarios passed. Screenshots and measurements: artifacts/');
} finally {
  await writeFile(new URL('runtime-report.json', artifacts), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  if (server.pid && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  }
}
