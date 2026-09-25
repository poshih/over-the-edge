import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { inspectArmGeometry, verifyAppearance } from './verify-appearance.mjs';
import { verifyMobile } from './verify-mobile.mjs';
import { verifyLevel } from './verify-level.mjs';
import { verifySetPieces } from './verify-set-pieces.mjs';
import { verifyTriggers } from './verify-triggers.mjs';

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
  const settings = () => page.evaluate(() => window.gettingOver.settings());
  const ready = () => page.waitForFunction(() => window.gettingOver && window.gettingOver.snapshot().time > 0);
  const focusGame = () => page.locator('#game').focus();
  const radius = (point) => Math.hypot(point.x, point.y);
  const assertCursorMatchesOffset = (state, message) => {
    assert.ok(Math.abs((state.cursor.x - state.cursorOrigin.x) - state.cursorOffset.x) < 1e-9 &&
      Math.abs((state.cursor.y - state.cursorOrigin.y) - state.cursorOffset.y) < 1e-9, message);
  };
  const assertCursorFollowsRoot = (before, after, message) => {
    const drift = Math.hypot(
      (after.cursor.x - before.cursor.x) - (after.root.x - before.root.x),
      (after.cursor.y - before.cursor.y) - (after.root.y - before.root.y),
    );
    assert.ok(drift < 1e-9, `${message} (${drift}m drift).`);
  };
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
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
  const defaultCursor = (await settings()).cursor;
  const aiming = [];
  report.scenarios.aiming = aiming;
  const outerRadius = maxReach - 0.8;
  const goals = [
    { name: 'center', offset: { x: 0, y: 0 } },
    { name: 'near-right', offset: { x: 0.15, y: 0 } },
    { name: 'near-up', offset: { x: 0, y: 0.15 } },
    { name: 'near-left', offset: { x: -0.15, y: 0 } },
    { name: 'near-down', offset: { x: 0, y: -0.15 } },
    { name: 'outer-right', offset: { x: outerRadius, y: 0 } },
    { name: 'outer-left', offset: { x: -outerRadius, y: 0 } },
    { name: 'outer-up', offset: { x: 0, y: outerRadius } },
    { name: 'full-right', offset: { x: maxReach, y: 0 } },
    { name: 'full-up', offset: { x: 0, y: maxReach } },
  ];
  for (const goal of goals) {
    await dragInput(1.2, (state) => ({ x: goal.offset.x - state.cursorOffset.x, y: goal.offset.y - state.cursorOffset.y }));
    const before = await snapshot();
    await page.waitForFunction((time) => window.gettingOver.snapshot().time >= time, before.time + 0.6);
    const aimed = await snapshot();
    const error = Math.hypot(aimed.tip.x - aimed.cursor.x, aimed.tip.y - aimed.cursor.y);
    const offsetError = Math.hypot(aimed.cursorOffset.x - goal.offset.x, aimed.cursorOffset.y - goal.offset.y);
    aiming.push({ goal, error, offsetError, headContacts: aimed.headContacts, tip: aimed.tip, cursor: aimed.cursor, cursorOffset: aimed.cursorOffset });
    assert.equal(aimed.headContacts, 0, `${goal.name} must be a free-space aiming scenario.`);
    assert.ok(offsetError < 0.03, `${goal.name} stored offset missed by ${offsetError} m.`);
    assert.ok(error < 0.03, `${goal.name} missed the drag target by ${error} m.`);
    if (goal.name.startsWith('full-')) {
      const pivot = aimed.parts.find((part) => part.id === 'carrier');
      assert.ok(pivot);
      assert.ok(Math.abs(Math.hypot(aimed.tip.x - pivot.x, aimed.tip.y - pivot.y) - maxReach) < 0.03,
        `${goal.name} must extend the head to its full reach from the hinge.`);
    }
    assertCursorMatchesOffset(aimed, `${goal.name} world target must equal the hinge plus the stored offset.`);
    await focusGame();
    await page.keyboard.press('p');
    const arms = await inspectArmGeometry(page);
    aiming[aiming.length - 1].arms = arms;
    await page.keyboard.press('p');
    if (goal.name === 'near-up') {
      assert.deepEqual(aimed.cursorOffset, before.cursorOffset, 'Free-space targets must not drift toward the lagging head.');
      assertCursorFollowsRoot(before, aimed, 'Free-space world targets must only move with character translation.');
    }
  }
  await dragInput(0.8, (state) => ({ x: -state.cursorOffset.x, y: defaultCursor.maxRadius * 1.5 - state.cursorOffset.y }));
  const overreach = await snapshot();
  await page.waitForFunction((time) => window.gettingOver.snapshot().time >= time, overreach.time + 1);
  const limited = await snapshot();
  const pivot = limited.parts.find((part) => part.id === 'carrier');
  assert.ok(pivot);
  const targetRadius = radius(limited.cursorOffset);
  const tipRadius = Math.hypot(limited.tip.x - pivot.x, limited.tip.y - pivot.y);
  assert.ok(Math.abs(radius(overreach.cursorOffset) - defaultCursor.maxRadius) < 0.02,
    'Outward input must clamp immediately to the configured target radius.');
  assert.deepEqual(limited.cursorOffset, overreach.cursorOffset, 'No-input after clamping must preserve the stored relative target.');
  assertCursorFollowsRoot(overreach, limited, 'A clamped world target must translate with the character.');
  assert.ok(Math.abs(targetRadius - defaultCursor.maxRadius) < 0.02, 'The stored cursor offset must stay inside the configured radius.');
  assert.ok(tipRadius <= maxReach + 0.03, 'Only the physical rig and motor target must be reach-limited.');
  report.scenarios.reachLimit = { maxReach, maxTargetRadius: defaultCursor.maxRadius, targetRadius, tipRadius, targetRelative: true };
  await practice('2');
  const startupHold = await observe(2);
  assert.ok(startupHold.end.headContacts > 0 && startupHold.end.height > 0.8, 'The ledge pose must stay supported through startup settling.');
  report.scenarios.ledgeStartup = startupHold;
  const hold = await observe(6);
  report.scenarios.ledge = hold;
  assert.ok(hold.maxDrift < 0.06, `Character-relative ledge hold drifted ${hold.maxDrift} m.`);
  assert.ok(hold.end.height > 0.8, 'The ledge pose must remain suspended, not settle on the floor.');
  assert.ok(hold.maxPotAngle < 0.31, 'The pot must respect its limited hinge.');
  assert.deepEqual(hold.end.cursorOffset, hold.first.cursorOffset, 'Ledge contact must preserve the stored relative target.');
  assertCursorFollowsRoot(hold.first, hold.end, 'The ledge target must move only with character translation.');

  await practice('3');
  const beforePush = await snapshot();
  await dragWorld({ x: 0, y: -0.5 }, 2);
  const afterPush = await snapshot();
  const pushed = await observe(2);
  report.scenarios.groundPush = { beforePush, afterPush, ...pushed };
  assert.ok(afterPush.root.y > beforePush.root.y + 0.35, 'Real mouse input must lift the player through the slider motor.');
  assert.ok(pushed.end.headContacts > 0, 'The head, not the shaft, must support the ground push.');
  assert.deepEqual(pushed.end.cursorOffset, pushed.first.cursorOffset, 'Terrain contact must not recenter the stored target.');
  assertCursorFollowsRoot(pushed.first, pushed.end, 'Terrain contact must leave the world target locked to the character translation.');
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
  assert.equal(await page.getByRole('checkbox', { name: 'Return target to hammer', exact: true }).count(), 0);
  assert.equal(await page.getByRole('slider', { name: 'Return speed', exact: true }).count(), 0);
  const radiusControl = page.getByRole('slider', { name: 'Maximum target radius', exact: true });
  const beforeRadiusEdit = await snapshot();
  const configuredRadius = (await settings()).cursor.maxRadius;
  const beforeRadius = radius(beforeRadiusEdit.cursorOffset);
  assert.ok(beforeRadius > 0.5, 'The radius clamp scenario needs a meaningful stored target.');
  await radiusControl.press('Home');
  const clampedRadius = await snapshot();
  assert.equal(clampedRadius.time, beforeRadiusEdit.time, 'Changing the cursor radius while paused must not advance time.');
  assert.deepEqual(clampedRadius.tuning, beforeRadiusEdit.tuning,
    'Changing the cursor radius must not retune physics.');
  assert.deepEqual(clampedRadius.root, beforeRadiusEdit.root, 'Changing the cursor radius while paused must not move the player.');
  assertCursorMatchesOffset(clampedRadius, 'Paused radius edits must keep the world cursor aligned with the stored offset.');
  assert.ok(Math.abs(radius(clampedRadius.cursorOffset) - 0.25) < 0.01,
    'Shrinking the cursor radius must immediately clamp the stored offset to the configured minimum.');
  if (beforeRadius > 0.25) {
    const sameDirection = (beforeRadiusEdit.cursorOffset.x * clampedRadius.cursorOffset.x +
      beforeRadiusEdit.cursorOffset.y * clampedRadius.cursorOffset.y) / (beforeRadius * radius(clampedRadius.cursorOffset));
    assert.ok(sameDirection > 0.999, 'Shrinking the cursor radius must project the stored offset inward without changing direction.');
  }
  await radiusControl.evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, configuredRadius);
  const restoredRadius = await snapshot();
  assert.equal(restoredRadius.time, beforeRadiusEdit.time, 'Growing the cursor radius while paused must not advance time.');
  assert.deepEqual(restoredRadius.cursorOffset, clampedRadius.cursorOffset,
    'Growing the cursor radius must keep the existing stored offset instead of re-extending it.');
  report.scenarios.radiusClamp = {
    configuredRadius,
    before: beforeRadius,
    clamped: radius(clampedRadius.cursorOffset),
    restored: radius(restoredRadius.cursorOffset),
  };
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
  const nameInput = page.getByRole('textbox', { name: 'Game settings name', exact: true });
  const pastTuning = page.getByRole('combobox', { name: 'Past game settings', exact: true });
  const saveTuning = page.getByRole('button', { name: 'Save game settings', exact: true });
  const loadTuning = page.getByRole('button', { name: 'Load game settings', exact: true });
  const savedRecords = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
    .filter((key) => key.startsWith('over-the-edge:game-settings:snapshot:v2:'))
    .map((key) => [key, localStorage.getItem(key)])));
  assert.equal(await loadTuning.isDisabled(), true, 'An empty history must not offer a load action.');
  await nameInput.fill('   ');
  await saveTuning.click();
  assert.deepEqual(await savedRecords(), {}, 'An empty name must not create a snapshot.');
  assert.ok(await page.getByRole('status').filter({ hasText: 'Enter a game settings name' }).isVisible());
  const beforeTyping = await snapshot();
  await nameInput.fill('');
  await nameInput.pressSequentially('r p c d 1234');
  const afterTyping = await snapshot();
  for (const key of ['practice', 'paused', 'debug', 'time']) assert.equal(afterTyping[key], beforeTyping[key],
    'Typing a profile name must not invoke game keyboard shortcuts.');
  const experimentName = 'Light <hammer> & recoil';
  await nameInput.fill(experimentName);
  await nameInput.press('Enter');
  const firstSave = await pastTuning.inputValue();
  const originalRecord = (await savedRecords())[firstSave];
  assert.deepEqual(JSON.parse(originalRecord).settings.physics, savedTuning);
  assert.equal(JSON.parse(originalRecord).schemaVersion, 2);
  assert.equal(JSON.parse(originalRecord).settings.schemaVersion, 2);
  assert.deepEqual(JSON.parse(originalRecord).settings, await page.evaluate(() => window.gettingOver.settings()));
  assert.equal(Object.hasOwn(JSON.parse(originalRecord).settings.physics, 'cursorRelaxation'), false);
  assert.equal(await page.getByRole('slider', { name: 'Cursor settling', exact: true }).count(), 0);
  assert.equal(JSON.parse(originalRecord).name, experimentName);
  assert.ok(Number.isFinite(JSON.parse(originalRecord).savedAt));
  assert.equal(await pastTuning.locator('hammer').count(), 0, 'Names must render as text, never markup.');
  await page.getByRole('button', { name: 'Defaults', exact: true }).click();
  assert.equal((await snapshot()).tuning.hingeTorque, initialTorque);
  const defaults = await snapshot();
  assertMasses(defaults);
  assert.equal(defaults.tuning.shaftMass, 0.66);
  assert.equal(defaults.bodyProperties.carrier.mass, 0.5);
  assert.equal(defaults.bodyProperties.carrier.inertia, 0.035);
  assert.equal(defaults.bodyProperties.slider.mass, 0.5);
  assert.equal(defaults.bodyProperties.slider.inertia, 0.035);
  const defaultSettings = await settings();
  assert.deepEqual(defaultSettings.cursor, { maxRadius: defaults.maxReach });
  await page.reload({ waitUntil: 'networkidle' });
  await ready();
  await loadTuning.click();
  assert.equal((await snapshot()).tuning.hingeTorque, savedTorque, 'A saved profile must survive a page reload.');
  assert.deepEqual((await snapshot()).tuning, savedTuning);
  assertMasses(await snapshot());
  await practice('2');
  const lightHold = await observe(2);
  assert.ok(!lightHold.end.stopped && lightHold.end.headContacts > 0 && lightHold.end.height > 0.8,
    'The lightweight mass settings must remain usable on a ledge.');
  report.scenarios.lightMassHold = lightHold;

  await hinge.press('ArrowRight');
  const secondTuning = (await snapshot()).tuning;
  await nameInput.fill(experimentName);
  await saveTuning.click();
  const secondSave = await pastTuning.inputValue();
  assert.notEqual(secondSave, firstSave, 'Reusing a name must create a distinct snapshot.');
  assert.equal((await savedRecords())[firstSave], originalRecord);
  await page.getByRole('slider', { name: 'Hammer friction', exact: true }).press('ArrowRight');
  const thirdTuning = (await snapshot()).tuning;
  await nameInput.fill('Rock grip');
  await saveTuning.click();
  const thirdSave = await pastTuning.inputValue();
  assert.equal(Object.keys(await savedRecords()).length, 3);
  await pastTuning.selectOption(firstSave);
  assert.deepEqual((await snapshot()).tuning, thirdTuning, 'Choosing a past save must not apply it until explicitly loaded.');
  await loadTuning.click();
  assert.deepEqual((await snapshot()).tuning, savedTuning);
  await pastTuning.selectOption(secondSave);
  await loadTuning.click();
  assert.deepEqual((await snapshot()).tuning, secondTuning);
  const historyBeforeDefaults = await savedRecords();
  await page.getByRole('button', { name: 'Defaults', exact: true }).click();
  assert.deepEqual(await savedRecords(), historyBeforeDefaults);
  await page.reload({ waitUntil: 'networkidle' });
  await ready();
  assert.deepEqual((await snapshot()).tuning, defaults.tuning, 'Reload must not auto-load a saved experiment.');
  assert.deepEqual(await savedRecords(), historyBeforeDefaults);
  assert.equal(await pastTuning.inputValue(), thirdSave, 'The newest snapshot should be offered first.');
  await pastTuning.selectOption(firstSave);
  await loadTuning.click();
  assert.deepEqual((await snapshot()).tuning, savedTuning);

  const otherTab = await context.newPage();
  otherTab.on('pageerror', (error) => report.errors.push(error.message));
  const otherProtocol = await context.newCDPSession(otherTab);
  await otherProtocol.send('Runtime.enable');
  await otherProtocol.send('Log.enable');
  otherProtocol.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error' || event.type === 'assert') {
      report.errors.push(event.args.map((arg) => 'value' in arg ? String(arg.value) : arg.description).join(' '));
    }
  });
  otherProtocol.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'error') report.errors.push(entry.text); });
  try {
    await otherTab.goto(address, { waitUntil: 'networkidle' });
    await otherTab.waitForFunction(() => window.gettingOver);
    await otherTab.getByRole('textbox', { name: 'Game settings name', exact: true }).fill('Other tab');
    await otherTab.getByRole('button', { name: 'Save game settings', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#past-game-settings').options.length === 4);
    assert.equal(await pastTuning.inputValue(), firstSave, 'Another tab must not replace the selected experiment.');
    assert.deepEqual((await snapshot()).tuning, savedTuning);
    await nameInput.fill('Original tab');
    await saveTuning.click();
    await otherTab.waitForFunction(() => document.querySelector('#past-game-settings').options.length === 5);
    assert.equal(Object.keys(await savedRecords()).length, 5, 'Independent tab saves must retain all snapshots.');
  } finally {
    await otherTab.close();
  }

  const beforeFailedSave = await savedRecords();
  const beforeFailedTuning = (await snapshot()).tuning;
  const beforeFailedSelection = await pastTuning.inputValue();
  await nameInput.fill('Quota experiment');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restorePresetStorage = () => { Storage.prototype.setItem = original; delete window.restorePresetStorage; };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('over-the-edge:game-settings:snapshot:v2:')) throw new DOMException('Storage quota probe', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  try {
    await saveTuning.click();
    assert.deepEqual(await savedRecords(), beforeFailedSave);
    assert.deepEqual((await snapshot()).tuning, beforeFailedTuning);
    assert.equal(await pastTuning.inputValue(), beforeFailedSelection);
    assert.equal(await nameInput.inputValue(), 'Quota experiment');
    assert.ok(await page.getByRole('status').filter({ hasText: 'Game settings could not be saved.' }).isVisible());
  } finally {
    await page.evaluate(() => window.restorePresetStorage());
  }
  await saveTuning.click();
  assert.equal(Object.keys(await savedRecords()).length, 6);

  const legacyTuning = { ...savedTuning, hingeTorque: initialTorque + 20 };
  for (const key of ['shaftMass', 'hingeCarrierMass', 'sliderCarriageMass']) delete legacyTuning[key];
  const legacyRecord = JSON.stringify({ schemaVersion: 1, tuning: { ...legacyTuning, cursorRelaxation: 8 } });
  await page.evaluate((record) => {
    localStorage.setItem('over-the-edge:tuning:v1', record);
    localStorage.removeItem('over-the-edge:tuning:v2');
  }, legacyRecord);
  await page.reload({ waitUntil: 'networkidle' });
  await ready();
  await pastTuning.selectOption('over-the-edge:tuning:v1');
  await loadTuning.click();
  const migrated = await snapshot();
  assert.deepEqual(migrated.tuning, {
    ...legacyTuning, shaftMass: 0.66, hingeCarrierMass: 0.5, sliderCarriageMass: 0.5,
  });
  assertMasses(migrated);
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v1')), legacyRecord);
  await loadTuning.click();
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v2')), null,
    'Reading a legacy save must not rewrite storage.');
  await nameInput.fill('Imported v1');
  await saveTuning.click();
  const migratedV1Save = JSON.parse((await savedRecords())[await pastTuning.inputValue()]);
  assert.equal(migratedV1Save.schemaVersion, 2);
  assert.equal(migratedV1Save.settings.schemaVersion, 2);
  assert.deepEqual(migratedV1Save.settings.physics, migrated.tuning);
  assert.deepEqual(migratedV1Save.settings.cursor, defaultSettings.cursor);
  const v2Tuning = { ...savedTuning, gripFriction: 1.2 };
  const v2Record = JSON.stringify({ schemaVersion: 2, tuning: { ...v2Tuning, cursorRelaxation: 8 } });
  await page.evaluate((record) => localStorage.setItem('over-the-edge:tuning:v2', record), v2Record);
  await page.reload({ waitUntil: 'networkidle' });
  await ready();
  assert.equal(await pastTuning.locator('option[value="over-the-edge:tuning:v1"]').count(), 0);
  await pastTuning.selectOption('over-the-edge:tuning:v2');
  await loadTuning.click();
  assert.deepEqual((await snapshot()).tuning, v2Tuning);
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v2')), v2Record);
  const v3Key = `over-the-edge:tuning:snapshot:v3:${'c'.repeat(32)}`;
  const v3Tuning = { ...savedTuning, mouseSensitivity: 1.35 };
  const v3Record = JSON.stringify({
    schemaVersion: 3, name: 'Earlier named tuning', savedAt: Date.now(),
    tuning: { ...v3Tuning, cursorRelaxation: 12 },
  });
  await page.evaluate(({ key, record }) => localStorage.setItem(key, record), { key: v3Key, record: v3Record });
  await page.reload({ waitUntil: 'networkidle' });
  await ready();
  await pastTuning.selectOption(v3Key);
  await loadTuning.click();
  assert.deepEqual((await snapshot()).tuning, v3Tuning);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), v3Key), v3Record);
  await nameInput.fill('Imported v3');
  await saveTuning.click();
  const migratedV3 = JSON.parse((await savedRecords())[await pastTuning.inputValue()]);
  assert.equal(migratedV3.schemaVersion, 2);
  assert.equal(migratedV3.settings.schemaVersion, 2);
  assert.deepEqual(migratedV3.settings.physics, v3Tuning);
  assert.deepEqual(migratedV3.settings.cursor, defaultSettings.cursor);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), v3Key), v3Record);
  const v4Key = `over-the-edge:tuning:snapshot:v4:${'d'.repeat(32)}`;
  const v4Tuning = { ...savedTuning, gripFriction: 1.4 };
  const v4Record = JSON.stringify({
    schemaVersion: 4, name: 'Previous fixed target tuning', savedAt: Date.now(), tuning: v4Tuning,
  });
  await page.evaluate(({ key, record }) => localStorage.setItem(key, record), { key: v4Key, record: v4Record });
  await page.reload({ waitUntil: 'networkidle' });
  await ready();
  await pastTuning.selectOption(v4Key);
  assert.ok((await pastTuning.locator('option:checked').textContent()).includes('(physics only)'));
  await loadTuning.click();
  assert.deepEqual((await snapshot()).tuning, v4Tuning);
  assert.deepEqual((await settings()).cursor, defaultSettings.cursor);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), v4Key), v4Record);
  const v1ProfileKey = `over-the-edge:game-settings:snapshot:v1:${'e'.repeat(32)}`;
  const v1ProfileSettings = {
    schemaVersion: 1,
    physics: { ...savedTuning, mouseSensitivity: 1.4 },
    cursor: { returnToHammer: true, returnRate: 12, returnOffsetX: 0.35, returnOffsetY: -0.25 },
  };
  const v1ProfileRecord = JSON.stringify({
    schemaVersion: 1, name: 'Earlier full settings', savedAt: Date.now(), settings: v1ProfileSettings,
  });
  await page.evaluate(({ key, record }) => localStorage.setItem(key, record), { key: v1ProfileKey, record: v1ProfileRecord });
  await page.reload({ waitUntil: 'networkidle' });
  await ready();
  await pastTuning.selectOption(v1ProfileKey);
  assert.ok((await pastTuning.locator('option:checked').textContent()).includes('(physics only)'));
  await loadTuning.click();
  const migratedFullProfile = await settings();
  assert.deepEqual((await snapshot()).tuning, v1ProfileSettings.physics);
  assert.deepEqual(migratedFullProfile.cursor, defaultSettings.cursor);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), v1ProfileKey), v1ProfileRecord);
  await nameInput.fill('Imported v1 full profile');
  await saveTuning.click();
  const importedFullProfile = JSON.parse((await savedRecords())[await pastTuning.inputValue()]);
  assert.equal(importedFullProfile.schemaVersion, 2);
  assert.equal(importedFullProfile.settings.schemaVersion, 2);
  assert.deepEqual(importedFullProfile.settings.physics, v1ProfileSettings.physics);
  assert.deepEqual(importedFullProfile.settings.cursor, defaultSettings.cursor);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), v1ProfileKey), v1ProfileRecord);
  await pastTuning.selectOption('over-the-edge:tuning:v2');
  await loadTuning.click();
  const beforeInvalidLegacy = (await snapshot()).tuning;
  await page.evaluate(() => localStorage.setItem('over-the-edge:tuning:v2', '{broken'));
  await loadTuning.click();
  assert.deepEqual((await snapshot()).tuning, beforeInvalidLegacy, 'An invalid v2 record must never cause v1 to be loaded.');
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v2')), '{broken');
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v1')), legacyRecord);
  assert.ok(await page.getByRole('status').filter({ hasText: 'Saved tuning is invalid:' }).isVisible(),
    'Invalid profiles must produce a visible explanation.');
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await pastTuning.selectOption(firstSave);
  const validTuning = (await snapshot()).tuning;
  await page.evaluate((key) => localStorage.setItem(key, '{broken'), firstSave);
  await loadTuning.click();
  assert.deepEqual((await snapshot()).tuning, validTuning, 'A malformed snapshot must not change live tuning.');
  assert.equal((await savedRecords())[firstSave], '{broken');
  assert.equal(await pastTuning.locator(`option[value="${firstSave}"]`).isDisabled(), true);
  assert.ok(await page.locator('.game-settings-history-error').isVisible());
  await pastTuning.selectOption(secondSave);
  await loadTuning.click();
  assert.deepEqual((await snapshot()).tuning, secondTuning, 'Other history must remain loadable when one record is unreadable.');
  await nameInput.fill('After corrupt record');
  await saveTuning.click();
  assert.equal((await savedRecords())[firstSave], '{broken', 'Saving must never replace an unreadable record.');
  assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:tuning:v2')), '{broken');
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await page.evaluate(() => {
    localStorage.removeItem('over-the-edge:tuning:v1');
    localStorage.removeItem('over-the-edge:tuning:v2');
  });
  report.scenarios.persistence = {
    savedTorque, snapshots: Object.keys(await savedRecords()).length, repeatedNamesPreserved: true,
    manualLoad: true, crossTabSafe: true, legacyRetained: true, invalidRecordRetained: true, writeFailureSafe: true,
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
  report.scenarios.level = await verifyLevel(browser, address, artifacts);
  report.scenarios.setPieces = await verifySetPieces(browser, address, artifacts);
  report.scenarios.triggers = await verifyTriggers(browser, address, artifacts);
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
