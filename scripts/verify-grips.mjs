import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inspectArmGeometry } from './verify-appearance.mjs';
import { observeBrowserPage } from './verify-level.mjs';
import { openSection } from './workshop-ui.mjs';

// The same 2.65 m reach with a longer handle and a shorter extension.
const LONG_HANDLE = { handleLength: 2.1, maxExtension: 0.55 };
// Sliding grips on that rig stay within about 1.03 m of the built-in shoulders at the default arm
// forward distance (the right hand holding the butt at full extension); the rest is joint slop.
const SLIDING_BOUND = 1.04;
const BUTT = { left: 0.04, right: 0.22 };
// Half the head's collision block along the handle, plus the hand clearance kept before it.
const HEAD_MARGIN = 0.1 + 0.1;
const EPSILON = 1e-6;
const START = { kind: 'start', id: 'pillar-start', x: 0, y: 0.48, angle: 0.4, reach: 1.2 };
// A high pillar, so the hammer swings through free space everywhere except straight down.
const PILLAR_LEVEL = {
  schemaVersion: 3, labels: [],
  objects: [
    {
      kind: 'terrain', id: 'pillar', shape: { type: 'box' }, x: 0, y: -10, width: 0.9, height: 20,
      angle: 0, depth: 1.5, color: 0x71817a, illusion: false,
    },
    START,
  ],
};

const polar = (radius, degrees) => ({
  x: radius * Math.cos(degrees * Math.PI / 180), y: radius * Math.sin(degrees * Math.PI / 180),
});
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const close = (actual, expected, message, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} (${actual}, expected ${expected}).`);

export async function verifyGrips(browser, address, artifacts) {
  const report = { errors: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await observeBrowserPage(page, report.errors);
  const snapshot = () => page.evaluate(() => window.gettingOver.snapshot());
  const grips = () => page.evaluate(() => window.gettingOver.level().rendering.grips);
  const settings = () => page.evaluate(() => window.gettingOver.settings());
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const setPaused = async (paused) => {
    await page.locator('#game').focus();
    if ((await snapshot()).paused !== paused) await page.keyboard.press('p');
    await page.waitForFunction(value => window.gettingOver.snapshot().paused === value, paused);
    await frames();
  };
  const workshop = async (tab) => {
    const toggle = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByRole('tab', { name: tab, exact: true }).click();
  };
  const setRange = (id, value) => page.locator(`#${id}`).evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  // Real mouse input moves the hinge-relative target, then the hammer settles on it.
  const aim = async (goal, seconds = 0.8) => {
    const box = await page.locator('#game').boundingBox();
    assert.ok(box, 'The canvas must be visible.');
    const initial = await snapshot();
    const scale = initial.camera.height / initial.camera.worldHeight / initial.tuning.mouseSensitivity;
    const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    const steps = 10;
    for (let step = 0; step < steps; step++) {
      const state = await snapshot();
      const remaining = steps - step;
      pointer.x += (goal.x - state.cursorOffset.x) / remaining * scale;
      pointer.y -= (goal.y - state.cursorOffset.y) / remaining * scale;
      await page.mouse.move(pointer.x, pointer.y);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    const until = (await snapshot()).time + seconds;
    await page.waitForFunction(time => window.gettingOver.snapshot().time >= time, until);
  };
  const handle = (state) => {
    const slider = state.parts.find(part => part.id === 'slider');
    const head = state.parts.find(part => part.id === 'head');
    const hinge = state.parts.find(part => part.id === 'carrier');
    const segments = state.parts.filter(part => part.kind === 'handle');
    return {
      shaft: Math.hypot(head.x - slider.x, head.y - slider.y),
      reach: Math.hypot(head.x - hinge.x, head.y - hinge.y),
      spacing: segments.slice(1).map((segment, index) => Math.hypot(segment.x - segments[index].x, segment.y - segments[index].y)),
    };
  };
  // A rig change rebuilds the player, so the run restarts at once.
  const changeRig = async (key, value) => {
    await page.waitForFunction(() => window.gettingOver.snapshot().time >= 1);
    const before = await snapshot();
    await setRange(`rig-${key}`, value);
    await page.waitForFunction(({ key, value }) => Math.abs(window.gettingOver.snapshot().rig[key] - value) < 1e-9, { key, value });
    const after = await snapshot();
    assert.ok(after.time < before.time, `Changing ${key} must restart the run.`);
    return after;
  };

  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0 && !window.gettingOver.sprites().restoring);

    // 1. Defaults: the built-in rig, and fixed grips at the butt.
    const initial = await snapshot();
    close(initial.rig.handleLength, 1.5, 'The default handle is 1.5 m');
    close(initial.rig.maxReach, 2.65, 'The default reach is 2.65 m');
    assert.deepEqual(await grips(), { strategy: 'fixed', ...BUTT });

    // 2. A course with free space on every side; its start reach is kept for any handle.
    await workshop('Level');
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
    const commits = (await page.evaluate(() => window.gettingOver.level().editor.commits));
    await page.locator('.level-file').setInputFiles({
      name: 'pillar.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(PILLAR_LEVEL)),
    });
    await page.waitForFunction(previous => window.gettingOver.level().editor.commits > previous, commits);
    await page.locator('.level-play').click();
    await page.waitForFunction(() => !window.gettingOver.snapshot().paused && window.gettingOver.level().editor.mode === 'inactive');
    if ((await snapshot()).pointerLocked) {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.gettingOver.snapshot().pointerLocked);
    }
    // Acquiring pointer lock can inject a mouse movement that swings the hammer; restart from the start pose.
    await page.locator('#game').focus();
    await page.keyboard.press('r');
    await frames();
    close(handle(await snapshot()).reach, START.reach, 'The default rig starts at the authored reach', 0.05);

    // 3. The Physics tab's hammer rig rebuilds the player through a restart, never in place.
    await workshop('Physics');
    await openSection(page, 'physics-rig', 'physics-cursor');
    await changeRig('handleLength', LONG_HANDLE.handleLength);
    close((await settings()).cursor.maxRadius, 2.1 + 1.15, 'A full-reach target radius follows a longer reach');
    const rebuilt = await changeRig('maxExtension', LONG_HANDLE.maxExtension);
    const rig = rebuilt.rig;
    close(rig.minExtension, -2.1, 'Fully retracted, the head reaches the hinge');
    close(rig.maxReach, 2.65, 'The reach is the handle plus the extension', 1e-12);
    close(rig.segmentLength, 0.7, 'Three segments share the handle', 1e-12);
    close((await settings()).cursor.maxRadius, rig.maxReach, 'The full-reach target radius follows the reach again');
    const built = handle(rebuilt);
    close(built.shaft, 2.1, 'The physical handle is 2.1 m', 0.02);
    for (const spacing of built.spacing) close(spacing, 0.7, 'Handle segments are 0.7 m apart', 0.02);
    close(built.reach, START.reach, 'A longer handle starts at the same authored reach', 0.05);
    report.rig = { geometry: rig, shaft: built.shaft, spacing: built.spacing, startReach: built.reach };

    // 4. The Character tab measures the hammer model against this game's handle; grips switch live.
    await workshop('Character');
    await openSection(page, 'character-hammer', 'character-grips');
    assert.match(await page.locator('.character-hammer-geometry').textContent(), /physical head at x = 2\.1 m; its collision block spans x 2 m to 2\.2 m/);
    await setPaused(true);
    await inspectArmGeometry(page);
    assert.deepEqual(await grips(), { strategy: 'fixed', ...BUTT }, 'Fixed grips stay at the butt of a longer handle.');
    await page.getByRole('radio', { name: 'Slide along the handle', exact: true }).check();
    await frames();
    assert.equal((await grips()).strategy, 'sliding', 'The grip placement applies without a reload.');
    assert.equal(await page.evaluate(() => window.gettingOver.sprites().document.grips), 'sliding');
    assert.equal(await page.evaluate(() => window.gettingOver.sprites().dirty), true, 'Grips are profile data.');
    await setPaused(false);

    // 5. Every aim and extension keeps sliding grips on the handle and within reach of the shoulders.
    // Ordered so each move sweeps over the top: the pillar blocks the head's way underneath.
    const poses = [
      ...[315, 337, 0, 45, 90, 135, 158, 180, 202, 225].map(degrees => ({ name: `full ${degrees}`, offset: polar(rig.maxReach, degrees) })),
      { name: 'near 180', offset: polar(0.3, 180) },
      { name: 'near 0', offset: polar(0.3, 0) },
      { name: 'hinge', offset: { x: 0, y: 0 } },
    ];
    report.poses = [];
    let farthest = 0;
    for (const pose of poses) {
      await aim(pose.offset);
      await setPaused(true);
      const arms = await inspectArmGeometry(page);
      const [state, placed] = [await snapshot(), await grips()];
      const { shaft } = handle(state);
      assert.equal(state.headContacts, 0,
        `${pose.name} must be a free-space pose (root ${JSON.stringify(state.root)}, head ${JSON.stringify(state.tip)}).`);
      assert.equal(placed.strategy, 'sliding');
      close(placed.right - placed.left, BUTT.right - BUTT.left, `${pose.name}: sliding grips keep their spacing`, EPSILON);
      assert.ok(placed.left >= BUTT.left - EPSILON, `${pose.name}: the hands must not pass the butt.`);
      assert.ok(placed.right <= shaft - HEAD_MARGIN + EPSILON, `${pose.name}: the hands must stay short of the head block.`);
      if (state.extension > 0.1) {
        assert.deepEqual([placed.left, placed.right], [BUTT.left, BUTT.right], `${pose.name}: past the body the hands hold the butt.`);
      }
      const reach = { left: distance(arms.left.hand, arms.left.shoulder), right: distance(arms.right.hand, arms.right.shoulder) };
      for (const side of ['left', 'right']) {
        assert.ok(reach[side] <= SLIDING_BOUND, `${pose.name}: the ${side} grip is ${reach[side]} m from its shoulder.`);
        farthest = Math.max(farthest, reach[side]);
      }
      report.poses.push({ pose: pose.name, extension: state.extension, grips: placed, reach });
      await setPaused(false);
    }
    assert.ok(farthest > 0.9, `The poses must approach the worst case (farthest grip ${farthest} m).`);
    report.farthestGrip = farthest;

    // 6. Extending slowly through the body moves the hands continuously: never faster than the butt or body.
    await aim(polar(0.3, 158));
    await page.evaluate(() => {
      window.gripSamples = [];
      window.gripSampling = true;
      const sample = () => {
        if (!window.gripSampling) return;
        const state = window.gettingOver.snapshot();
        const parts = window.gettingOver.appearance().parts;
        const hand = side => parts.find(part => part.id === `${side}-hand`).anchor;
        const butt = state.parts.find(part => part.id === 'slider');
        window.gripSamples.push({ root: state.root, butt: { x: butt.x, y: butt.y }, left: hand('left'), right: hand('right') });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await aim(polar(rig.maxReach, 158), 0.6);
    const samples = await page.evaluate(() => { window.gripSampling = false; return window.gripSamples; });
    assert.ok(samples.length > 20, 'The continuity sweep needs many rendered frames.');
    let excess = -Infinity;
    for (let index = 1; index < samples.length; index++) {
      const [previous, current] = [samples[index - 1], samples[index]];
      const moved = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
      const allowed = moved(previous.butt, current.butt) + moved(previous.root, current.root);
      for (const side of ['left', 'right']) excess = Math.max(excess, moved(previous[side], current[side]) - allowed);
    }
    assert.ok(excess < 0.02, `A grip jumped ${excess} m further than the handle and body moved in one frame.`);
    report.continuity = { frames: samples.length, largestExcess: excess };
    await page.screenshot({ path: fileURLToPath(new URL('grips-sliding.png', artifacts)) });

    // 7. The target radius never exceeds the reach: a smaller radius is capped, a full one follows.
    await workshop('Physics');
    await openSection(page, 'physics-rig', 'physics-cursor');
    await setRange('cursor-maxRadius', 2.3);
    await changeRig('maxExtension', 0);
    close((await settings()).cursor.maxRadius, 2.1, 'A radius beyond the new reach is capped at it');
    assert.equal(await page.locator('#cursor-maxRadius').getAttribute('max'), '2.1');
    await changeRig('maxExtension', 0.55);
    close((await settings()).cursor.maxRadius, 2.1 + 0.55, 'A radius at the full reach follows it');
    await setRange('cursor-maxRadius', 2);
    await changeRig('maxExtension', 0.8);
    close((await settings()).cursor.maxRadius, 2, 'A smaller radius stays put when the reach grows');
    // 2.05 + 0.55 sums to just under 2.6 in floats; the slider must still hold the full reach.
    await changeRig('maxExtension', 0.55);
    await setRange('cursor-maxRadius', 2.65);
    await changeRig('handleLength', 2.05);
    assert.equal((await settings()).cursor.maxRadius, 2.6, 'A full-reach radius follows to the decimal reach.');
    const radius = page.locator('#cursor-maxRadius');
    assert.deepEqual([await radius.getAttribute('max'), await radius.inputValue()], ['2.6', '2.6']);
    // The touch layout's step buttons: at the full reach "+" must be off, never step down by rounding.
    assert.equal(await page.locator('button[aria-label="Increase Maximum target radius"]').evaluate(button => button.disabled), true,
      'At the full reach the radius cannot step past it.');
    report.radius = { capped: true, fullFollows: true, smallerKept: true, decimalReach: true };
    assert.deepEqual(report.errors, [], 'Grip scenario browser errors are not allowed.');
    return report;
  } finally {
    await context.close();
  }
}
