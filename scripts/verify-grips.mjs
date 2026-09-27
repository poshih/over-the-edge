import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { inspectArmGeometry, texturePng } from './verify-appearance.mjs';
import { hammerGlb } from './character-fixtures.mjs';
import { observeBrowserPage } from './verify-level.mjs';
import { openSection } from './workshop-ui.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// The same 2.65 m reach with a longer handle and a shorter extension.
const LONG_HANDLE = { handleLength: 2.1, maxExtension: 0.55 };
const DEFAULT_GRIPS = { placement: 'sliding', left: 0.04, right: 0.22, slideAt: 0.85 };
const BUTT = { left: DEFAULT_GRIPS.left, right: DEFAULT_GRIPS.right };
// Human-proportioned arm segments, short enough that sliding hands slide both ways on the long handle.
const SHORT_ARM = 0.55;
// Half the head's collision block along the handle, plus the hand clearance kept before it.
const HEAD_MARGIN = 0.1 + 0.1;
const EPSILON = 1e-6;
const SIDES = ['left', 'right'];
const DIRECTIONS = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'];
// A 2D character with artwork only on its pot: no arm chains, so it draws the built-in arms.
const POT_CARD = {
  schemaVersion: 12, characterRiggingType: 'sprite-2d', armForwardDistance: 0.25, grips: DEFAULT_GRIPS, arms: null,
  images: [{ id: 'card', name: 'Card', source: `data:image/png;base64,${texturePng().toString('base64')}` }],
  layers: [{
    id: 'pot-card', name: 'Pot card', anchor: 'pot', image: 'card', width: 0.6, height: 0.4, offset: { x: 0, y: 0, z: 0.6 },
    rotation: 0, bone: null, directions: DIRECTIONS, skin: null, tileLength: null,
  }],
  skeleton: null, presentation: null,
};
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

// The placement over whole slides and full turns, from the game's own shoulders, hinge and tool depth.
function verifyPlacement({ grips, arms, config, depth }) {
  const { placeGrips, HEAD_GRIP_MARGIN } = grips;
  const hinge = config.RIG.shoulder;
  const tool = depth.getToolDepth(depth.DEFAULT_ARM_FORWARD_DISTANCE);
  const shoulders = Object.fromEntries(SIDES.map(side => {
    const [x, y, z] = arms.ARM_GEOMETRY[side].shoulder;
    return [side, [x, y, depth.PLAYER_DEPTH.torso + z]];
  }));
  const inputs = { left: { along: 0, aside2: 0, arm: 0 }, right: { along: 0, aside2: 0, arm: 0 } };
  const out = { left: 0, right: 0 };
  const butt = [0, 0, tool];
  // The butt `extension` past the hinge along `angle`; each shoulder measured against the handle's line.
  const place = (setup, angle, extension) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    butt[0] = hinge.x + extension * cos;
    butt[1] = hinge.y + extension * sin;
    for (const side of SIDES) {
      const shoulder = shoulders[side];
      const dx = shoulder[0] - butt[0];
      const dy = shoulder[1] - butt[1];
      const dz = setup.inPlane ? 0 : butt[2] - shoulder[2];
      const along = dx * cos + dy * sin;
      const input = inputs[side];
      input.along = along;
      input.aside2 = Math.max(0, dx * dx + dy * dy + dz * dz - along * along);
      input.arm = setup.arm;
    }
    return placeGrips(setup.grips, inputs, setup.handle, out);
  };
  // A hand's distance from its shoulder, `grip` along the handle placed last.
  const reach = (setup, side, cos, sin, grip) => {
    const shoulder = shoulders[side];
    const x = butt[0] + grip * cos - shoulder[0];
    const y = butt[1] + grip * sin - shoulder[1];
    const z = setup.inPlane ? 0 : butt[2] - shoulder[2];
    return Math.sqrt(x * x + y * y + z * z);
  };
  // Bisects toward the half that changes more: a continuous placement's change vanishes there, a jump's does not.
  const residualJump = (setup, extension, from, to) => {
    let [a, b] = [from, to];
    let [placedA, placedB] = [place(setup, a, extension).left, place(setup, b, extension).left];
    for (let halving = 0; halving < 40; halving++) {
      const middle = (a + b) / 2;
      const placed = place(setup, middle, extension).left;
      if (Math.abs(placed - placedA) >= Math.abs(placedB - placed)) [b, placedB] = [middle, placed];
      else [a, placedA] = [middle, placed];
    }
    return Math.abs(placedB - placedA);
  };
  const GRID = 0.001;
  const TURN = Math.PI / 1800;
  const setups = [];
  for (const [handle, maxExtension] of [[1.5, 1.15], [2.1, 0.55]]) {
    for (const arm of [2 * SHORT_ARM, 1.64]) {
      for (const slideAt of [0.4, 0.85, 1]) {
        for (const inPlane of [false, true]) {
          setups.push({ handle, maxExtension, arm, slideAt, inPlane, grips: { ...DEFAULT_GRIPS, slideAt } });
        }
      }
    }
  }
  const summary = { setups: setups.length, samples: 0, oracle: 0, steepestPerMillimetre: 0, largestResidualJump: 0, farthestShare: {} };
  for (const setup of setups) {
    const farthest = Math.max(0, setup.handle - HEAD_GRIP_MARGIN);
    const limit = setup.slideAt * setup.arm;
    const label = `${setup.handle}+${setup.maxExtension} m, arm ${setup.arm} m, slide at ${setup.slideAt}${setup.inPlane ? ', in plane' : ''}`;
    let farthestShare = 0;
    // Extending by a millimetre moves no hand more than a millimetre along the handle.
    for (let degrees = 0; degrees < 360; degrees += 5) {
      const angle = degrees * Math.PI / 180;
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      let previous = null;
      const steps = Math.round((setup.handle + setup.maxExtension) / GRID);
      for (let step = 0; step <= steps; step++) {
        const placed = place(setup, angle, -setup.handle + step * GRID);
        assert.ok(placed.left >= -1e-12 && placed.right <= farthest + 1e-12, `${label}: hands must stay on the handle.`);
        assert.ok(Math.abs(placed.right - placed.left - (BUTT.right - BUTT.left)) < 1e-12, `${label}: hands keep their spacing.`);
        if (previous !== null) {
          const moved = Math.abs(placed.left - previous);
          summary.steepestPerMillimetre = Math.max(summary.steepestPerMillimetre, moved / GRID);
          assert.ok(moved <= GRID + 1e-12, `${label}: at ${degrees}° a hand moved ${moved} m for a ${GRID} m extension.`);
        }
        previous = placed.left;
        summary.samples++;
        if (setup.slideAt === 0.85) {
          for (const side of SIDES) farthestShare = Math.max(farthestShare, reach(setup, side, cos, sin, placed[side]) / setup.arm);
        }
      }
    }
    if (setup.slideAt === 0.85) summary.farthestShare[label] = farthestShare;
    // Turning never makes a hand jump, even where a reach only just meets the handle's line.
    for (const share of [0.02, 0.35, 0.6, 1]) {
      const extension = -setup.handle + share * (setup.handle + setup.maxExtension);
      for (let step = 0; step < 3600; step++) {
        const residual = residualJump(setup, extension, step * TURN, (step + 1) * TURN);
        summary.largestResidualJump = Math.max(summary.largestResidualJump, residual);
        assert.ok(residual < 1e-6, `${label}: a hand jumps ${residual} m near ${step / 10}° at extension ${extension} m.`);
      }
    }
    // Against the least shared slide, on a 1 mm grid, that keeps both hands on the handle and within reach.
    const lowest = -Math.min(BUTT.left, BUTT.right);
    const highest = farthest - Math.max(BUTT.left, BUTT.right);
    for (let degrees = 0; degrees < 360; degrees += 15) {
      const angle = degrees * Math.PI / 180;
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      for (let extension = -setup.handle; extension <= setup.maxExtension + 1e-9; extension += 0.05) {
        const placed = place(setup, angle, extension);
        let least = null;
        for (let step = Math.ceil(lowest / GRID - 1e-6); step <= Math.floor(highest / GRID + 1e-6); step++) {
          const offset = step * GRID;
          if (reach(setup, 'left', cos, sin, BUTT.left + offset) <= limit && reach(setup, 'right', cos, sin, BUTT.right + offset) <= limit &&
            (least === null || Math.abs(offset) < Math.abs(least))) least = offset;
        }
        if (least === null) continue;
        summary.oracle++;
        const offset = placed.left - BUTT.left;
        if (least === 0) assert.equal(offset, 0, `${label}: hands within reach must hold their grips.`);
        assert.ok(Math.abs(offset - least) <= GRID + 1e-9, `${label}: slid ${offset} m where ${least} m suffices.`);
        for (const side of SIDES) {
          assert.ok(reach(setup, side, cos, sin, placed[side]) <= limit + 1e-9, `${label}: the ${side} hand must stay within the slide point.`);
        }
      }
    }
  }
  assert.ok(summary.steepestPerMillimetre > 0.99, 'The sweep must include hands sliding with the butt.');
  // At the default slide point the built-in arms never stretch on the default rig, holding the butt at full
  // extension; on the long handle they and human-proportioned arms stay within, or near, the slide point.
  const share = (handle, extension, arm) => summary.farthestShare[`${handle}+${extension} m, arm ${arm} m, slide at 0.85`];
  assert.ok(share(1.5, 1.15, 1.64) < 0.96, `Built-in arms reach ${share(1.5, 1.15, 1.64)} of their length on the default rig.`);
  assert.ok(share(2.1, 0.55, 1.64) <= 0.85 + 1e-9, `Built-in arms reach ${share(2.1, 0.55, 1.64)} of their length on the long handle.`);
  assert.ok(share(2.1, 0.55, 2 * SHORT_ARM) < 0.91, `Short arms reach ${share(2.1, 0.55, 2 * SHORT_ARM)} of their length on the long handle.`);
  return summary;
}

const polar = (radius, degrees) => ({
  x: radius * Math.cos(degrees * Math.PI / 180), y: radius * Math.sin(degrees * Math.PI / 180),
});
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const close = (actual, expected, message, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} (${actual}, expected ${expected}).`);

// The game's own modules, exactly as the browser runs them.
async function loadModules() {
  const server = await createServer({ root, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true } });
  try {
    return {
      grips: await server.ssrLoadModule('/src/grips.ts'), arms: await server.ssrLoadModule('/src/arm-ik.ts'),
      config: await server.ssrLoadModule('/src/config.ts'), depth: await server.ssrLoadModule('/src/character-depth.ts'),
      fit: await server.ssrLoadModule('/src/hammer-handle-fit.ts'),
    };
  } finally {
    await server.close();
  }
}

export async function verifyGrips(browser, address, artifacts) {
  const report = { errors: [] };
  const modules = await loadModules();
  close(modules.grips.HEAD_GRIP_MARGIN, HEAD_MARGIN, 'The head margin is the head block plus the hand clearance', 1e-12);
  assert.deepEqual({ ...modules.grips.DEFAULT_GRIPS }, DEFAULT_GRIPS, 'New characters slide beyond 85% of each arm.');
  report.placement = verifyPlacement(modules);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await observeBrowserPage(page, report.errors);
  const snapshot = () => page.evaluate(() => window.gettingOver.snapshot());
  // Where each hand holds the handle this frame.
  const grips = () => page.evaluate(() => {
    const { placement, left, right, slideAt } = window.gettingOver.level().rendering.grips;
    return { placement, left, right, slideAt };
  });
  const profile = () => page.evaluate(() => window.gettingOver.sprites().document);
  // The placement's inputs as the view measures them: each shoulder against the handle's line from the
  // butt, in the drawing plane for a 2D character, and each arm's length.
  const gripInputs = async ({ inPlane = false, arms = null } = {}) => {
    const { state, visuals, chains } = await page.evaluate(() => ({
      state: window.gettingOver.snapshot(), visuals: window.gettingOver.appearance(),
      chains: window.gettingOver.level().rendering.armChains,
    }));
    assert.equal(state.paused, true, 'Measure the placement on a paused frame.');
    const torso = visuals.parts.find(part => part.id === 'torso').transform;
    const butt = state.parts.find(part => part.id === 'slider');
    const head = state.parts.find(part => part.id === 'head');
    const depth = visuals.parts.find(part => part.id === 'hammer-shaft').anchor.z;
    const angle = Math.atan2(head.y - butt.y, head.x - butt.x);
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const shoulders = {};
    for (const side of SIDES) {
      const local = chains[side].shoulder;
      const world = [0, 1, 2].map(row => torso[12 + row] + local.reduce((sum, value, column) => sum + value * torso[column * 4 + row], 0));
      const [dx, dy, dz] = [world[0] - butt.x, world[1] - butt.y, inPlane ? 0 : depth - world[2]];
      const along = dx * cos + dy * sin;
      shoulders[side] = {
        along, aside2: Math.max(0, dx * dx + dy * dy + dz * dz - along * along),
        arm: arms?.[side] ?? chains[side].upper + chains[side].forearm,
      };
    }
    return { shoulders, shaft: Math.hypot(head.x - butt.x, head.y - butt.y) };
  };
  // The rendered grips are the shared placement of exactly what the view measures.
  const assertPlacement = async (message, options) => {
    const [placed, inputs, document] = [await grips(), await gripInputs(options), await profile()];
    const expected = modules.grips.placeGrips(document.grips, inputs.shoulders, inputs.shaft, { left: 0, right: 0 });
    for (const side of SIDES) close(placed[side], expected[side], `${message}: the ${side} grip`, 1e-9);
    return { placed, inputs };
  };
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

    // 1. Defaults: the built-in rig, and sliding grips from the butt.
    const initial = await snapshot();
    close(initial.rig.handleLength, 1.5, 'The default handle is 1.5 m');
    close(initial.rig.maxReach, 2.65, 'The default reach is 2.65 m');
    assert.deepEqual((await profile()).grips, DEFAULT_GRIPS);
    assert.deepEqual([(await grips()).placement, (await grips()).slideAt], ['sliding', 0.85]);

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
    assert.match(await page.locator('.character-hammer-geometry').textContent(), /This game's handle is 2\.1 m: the model's handle up to x = 1\.3 m stretches to 1\.9 m and its head centres at x = 2\.1 m\./);
    await setPaused(true);
    await inspectArmGeometry(page);
    const slidePoint = page.locator('#character-grip-slide-at');
    assert.deepEqual([await slidePoint.inputValue(), await slidePoint.isDisabled()], ['85', false]);
    await page.getByRole('radio', { name: 'Fixed', exact: true }).check();
    await frames();
    assert.deepEqual(await grips(), { placement: 'fixed', ...BUTT, slideAt: 0.85 }, 'Fixed grips stay at the butt of a longer handle.');
    assert.equal(await slidePoint.isDisabled(), true, 'Fixed hands have no slide point.');
    assert.equal(await page.evaluate(() => window.gettingOver.sprites().dirty), true, 'Grips are profile data.');
    await inspectArmGeometry(page);
    await page.getByRole('radio', { name: 'Slide along the handle', exact: true }).check();
    await frames();
    assert.equal((await grips()).placement, 'sliding', 'The grip placement applies without a reload.');
    assert.deepEqual((await profile()).grips, DEFAULT_GRIPS);
    assert.equal(await slidePoint.isDisabled(), false);
    // Human-proportioned arms, so the hands slide both ways on this handle.
    await openSection(page, 'character-arm-lengths');
    for (const id of ['left-upper', 'left-forearm', 'right-upper', 'right-forearm']) await setRange(`character-${id}-length`, SHORT_ARM);
    await setPaused(false);

    // 5. Every aim and extension: sliding hands hold their grips while each is within the slide point of its
    // shoulder, otherwise slide together by the least amount that restores it, never leaving the handle.
    // Ordered so each move sweeps over the top: the pillar blocks the head's way underneath.
    const poses = [
      ...[315, 337, 0, 45, 90, 135, 158, 180, 202, 225].map(degrees => ({ name: `full ${degrees}`, offset: polar(rig.maxReach, degrees) })),
      { name: 'near 180', offset: polar(0.3, 180) },
      { name: 'near 0', offset: polar(0.3, 0) },
      { name: 'hinge', offset: { x: 0, y: 0 } },
    ];
    report.poses = [];
    const cases = new Set();
    for (const pose of poses) {
      await aim(pose.offset);
      await setPaused(true);
      const arms = await inspectArmGeometry(page);
      const state = await snapshot();
      assert.equal(state.headContacts, 0,
        `${pose.name} must be a free-space pose (root ${JSON.stringify(state.root)}, head ${JSON.stringify(state.tip)}).`);
      const { placed, inputs } = await assertPlacement(pose.name);
      const farthest = inputs.shaft - HEAD_MARGIN;
      close(placed.right - placed.left, BUTT.right - BUTT.left, `${pose.name}: sliding grips keep their spacing`, EPSILON);
      assert.ok(placed.left >= -EPSILON, `${pose.name}: the hands must not pass the butt.`);
      assert.ok(placed.right <= farthest + EPSILON, `${pose.name}: the hands must stay short of the head block.`);
      const share = Object.fromEntries(SIDES.map(side => [side, distance(arms[side].hand, arms[side].shoulder) / (2 * SHORT_ARM)]));
      const worst = Math.max(share.left, share.right);
      const atButt = placed.left <= EPSILON;
      const slid = Math.abs(placed.left - BUTT.left) > EPSILON;
      if (!atButt && placed.right < farthest - EPSILON) {
        assert.ok(worst <= DEFAULT_GRIPS.slideAt + EPSILON, `${pose.name}: a hand is ${worst} of its arm from its shoulder.`);
      }
      if (slid) assert.ok(worst >= DEFAULT_GRIPS.slideAt - EPSILON, `${pose.name}: the hands slid farther than needed (${worst}).`);
      assert.ok(worst < 1, `${pose.name}: an arm stretches (${worst} of its length).`);
      cases.add(!slid ? 'held' : placed.left > BUTT.left ? 'toward the head' : atButt ? 'at the butt' : 'toward the butt');
      report.poses.push({ pose: pose.name, extension: state.extension, grips: placed, share });
      if (pose.name === 'near 180') await page.screenshot({ path: fileURLToPath(new URL('grips-sliding.png', artifacts)) });
      await setPaused(false);
    }
    assert.deepEqual([...cases].sort(), ['at the butt', 'held', 'toward the butt', 'toward the head'],
      'The poses must hold the grips, slide both ways and reach the butt.');
    report.farthestShare = Math.max(...report.poses.map(pose => Math.max(pose.share.left, pose.share.right)));

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

    // 8. The Character tab sets each hand's grip and shows the game's handle length.
    await workshop('Character');
    await openSection(page, 'character-grips');
    await page.waitForFunction(() => window.gettingOver.snapshot().time >= 1);
    const beforeHandle = await snapshot();
    await setRange('character-handle-length', 1.8);
    await page.waitForFunction(() => Math.abs(window.gettingOver.snapshot().rig.handleLength - 1.8) < 1e-9);
    assert.ok((await snapshot()).time < beforeHandle.time, 'The Character tab\'s handle length restarts the run like Physics.');
    assert.equal((await settings()).rig.handleLength, 1.8, 'It sets the game\'s shared setting.');
    assert.equal(await page.locator('#rig-handleLength').inputValue(), '1.8', 'Physics shows the same handle length.');
    assert.match(await page.locator('.character-hammer-geometry').textContent(), /This game's handle is 1\.8 m: .* stretches to 1\.6 m and its head centres at x = 1\.8 m\./);
    assert.equal(await page.locator('#character-right-grip').getAttribute('max'), '1.6', 'Grips reach up to the head margin.');
    await page.getByRole('radio', { name: 'Fixed', exact: true }).check();
    await setRange('character-left-grip', 0.3);
    await setRange('character-right-grip', 0.75);
    assert.deepEqual((await profile()).grips, { placement: 'fixed', left: 0.3, right: 0.75, slideAt: 0.85 });
    await setPaused(true);
    await inspectArmGeometry(page);
    assert.deepEqual(await grips(), { placement: 'fixed', left: 0.3, right: 0.75, slideAt: 0.85 }, 'Fixed hands hold the chosen grips.');
    await page.getByRole('radio', { name: 'Slide along the handle', exact: true }).check();
    await frames();
    const { placed: slid } = await assertPlacement('Sliding from the chosen grips');
    close(slid.right - slid.left, 0.45, 'Sliding hands keep the chosen spacing', EPSILON);
    // A lower slide point slides the hands sooner, applied live from the profile.
    await setRange('character-grip-slide-at', 40);
    assert.equal((await profile()).grips.slideAt, 0.4);
    await frames();
    const { placed: sooner } = await assertPlacement('Sliding beyond 40%');
    assert.equal(sooner.slideAt, 0.4);
    assert.ok(Math.abs(sooner.left - slid.left) > 0.01, `A lower slide point must move the hands here (${slid.left} m, then ${sooner.left} m).`);
    await page.locator('.character-grip-reset').click();
    assert.deepEqual((await profile()).grips, DEFAULT_GRIPS, 'Reset keeps the placement and restores the slide point.');
    report.gripControls = { fixed: { left: 0.3, right: 0.75 }, sliding: slid, slidingSooner: sooner, handleMirror: 1.8 };
    await page.locator('.character-arm-length-reset').click();

    // 9. Arm lengths start at the type's own lengths and resize the 3D arms, per side.
    await openSection(page, 'character-arm-lengths');
    const armInputs = ['left-upper', 'left-forearm', 'right-upper', 'right-forearm'].map(id => page.locator(`#character-${id}-length`));
    const armValues = async () => Promise.all(armInputs.map(input => input.inputValue()));
    assert.deepEqual(await armValues(), ['0.82', '0.82', '0.82', '0.82'], 'Mesh parts start from the built-in arms.');
    assert.equal((await profile()).arms, null);
    const lengths = { left: { upper: 0.5, forearm: 0.45 }, right: { upper: 0.55, forearm: 0.6 } };
    await setRange('character-left-upper-length', lengths.left.upper);
    assert.deepEqual((await profile()).arms, { left: { upper: 0.5, forearm: 0.82 }, right: { upper: 0.82, forearm: 0.82 } },
      'The first edit keeps the other segments at their shown lengths.');
    await setRange('character-left-forearm-length', lengths.left.forearm);
    await setRange('character-right-upper-length', lengths.right.upper);
    await setRange('character-right-forearm-length', lengths.right.forearm);
    assert.deepEqual((await profile()).arms, lengths);
    await frames();
    const chains = await page.evaluate(() => window.gettingOver.level().rendering.armChains);
    for (const side of ['left', 'right']) {
      assert.deepEqual([chains[side].upper, chains[side].forearm], [lengths[side].upper, lengths[side].forearm]);
    }
    const arms3d = await inspectArmGeometry(page);
    report.armLengths = { mesh: arms3d };
    assert.equal(await page.locator('.character-arm-length-status').textContent(), 'This profile\'s arm lengths apply to every character type.');

    // 10. A 2D character reaches in its drawing plane with its arm chains, and like the built-in arms without
    // them. Retracted past the body the hands must slide, and every other way of measuring puts them elsewhere.
    await setPaused(false);
    await aim(polar(0.3, 180));
    await setPaused(true);
    const elsewhere = async (message, placed, alternatives) => {
      const { grips: chosen } = await profile();
      for (const [name, options] of alternatives) {
        const inputs = await gripInputs(options);
        const other = modules.grips.placeGrips(chosen, inputs.shoulders, inputs.shaft, { left: 0, right: 0 });
        assert.ok(Math.abs(other.left - placed.left) > 0.05,
          `${message}: measured ${name}, the hands would be at ${other.left} m, too near ${placed.left} m to tell apart.`);
      }
    };
    await page.locator('.sprite-file').setInputFiles({
      name: 'pot-card.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(POT_CARD)),
    });
    await page.waitForFunction(() => {
      const state = window.gettingOver.sprites();
      return !state.busy && state.document.characterRiggingType === 'sprite-2d' && state.document.skeleton === null;
    });
    await frames();
    assert.deepEqual(await armValues(), ['0.82', '0.82', '0.82', '0.82'], 'A 2D character without arm chains starts from the built-in arms.');
    // Its hands are the built-in arms', reaching forward to the tool.
    await inspectArmGeometry(page);
    const { placed: builtIn } = await assertPlacement('A 2D character without arm chains');
    assert.ok(builtIn.left - BUTT.left > 0.05, `Retracted past the body the hands must slide (${builtIn.left} m).`);
    await elsewhere('Without arm chains', builtIn, [['in the drawing plane', { inPlane: true }]]);
    await page.locator('.character-load-example').click();
    await page.waitForFunction(() => {
      const state = window.gettingOver.sprites();
      return !state.busy && state.document.characterRiggingType === 'sprite-2d' && state.document.skeleton !== null;
    });
    await frames();
    assert.equal((await profile()).arms, null, 'A loaded profile brings its own arm lengths.');
    assert.deepEqual(await armValues(), ['0.9', '0.9', '0.9', '0.9'], 'A 2D character starts from its authored arm bones.');
    const { placed: flat } = await assertPlacement('The 2D arm chains', { inPlane: true, arms: { left: 1.8, right: 1.8 } });
    assert.ok(flat.left - BUTT.left > 0.05, `Retracted past the body the 2D hands must slide (${flat.left} m).`);
    await elsewhere('The 2D arm chains', flat, [
      ['at the tool\'s depth', { arms: { left: 1.8, right: 1.8 } }], ['with the built-in arm lengths', { inPlane: true }],
    ]);
    // The chains stretch to the profile's lengths, and reach with them; their elbow caps keep their size.
    const sprites = () => page.evaluate(() => window.gettingOver.sprites().rendering);
    const layerWidth = (rendering, id) => rendering.layers.find(layer => layer.id === id).worldTransform.scale.x;
    const natural = await sprites();
    await setRange('character-left-upper-length', 0.6);
    await setRange('character-left-forearm-length', 0.5);
    await frames();
    const { placed: shorter } = await assertPlacement('The 2D arm chains at the profile\'s lengths', { inPlane: true });
    assert.ok(shorter.left - flat.left > 0.05, `A shorter left arm must slide the hands farther (${shorter.left} m, from ${flat.left} m).`);
    report.sprite2d = { withoutChains: builtIn, chains: flat, shorterLeftArm: shorter };
    const stretched = await sprites();
    const bone = (rendering, id) => rendering.skeleton.bones.find(entry => entry.id === id);
    const gap = (rendering, from, to) => Math.hypot(bone(rendering, to).x - bone(rendering, from).x, bone(rendering, to).y - bone(rendering, from).y);
    close(bone(stretched, 'left-upper-arm').length, 0.6, 'The 2D upper arm takes its length', 1e-9);
    close(bone(stretched, 'left-upper-arm').scale, 0.6 / 0.9, 'It stretches by the ratio to its authored length', 1e-9);
    close(gap(stretched, 'left-upper-arm', 'left-forearm'), 0.6, 'The forearm starts at the stretched tip', 1e-6);
    close(gap(stretched, 'left-forearm', 'left-hand'), 0.5, 'The glove starts at the stretched forearm tip', 1e-6);
    close(bone(stretched, 'right-upper-arm').scale, 1, 'The other arm keeps its authored length', 1e-9);
    close(layerWidth(stretched, 'paper-left-upper-arm') / layerWidth(natural, 'paper-left-upper-arm'), 0.6 / 0.9,
      'Upper-arm art stretches with its bone', 1e-6);
    close(layerWidth(stretched, 'paper-left-elbow'), layerWidth(natural, 'paper-left-elbow'), 'The elbow cap keeps its size', 1e-6);
    close(layerWidth(stretched, 'paper-left-hand'), layerWidth(natural, 'paper-left-hand'), 'The glove keeps its size', 1e-6);
    await page.screenshot({ path: fileURLToPath(new URL('grips-2d-arms.png', artifacts)) });
    await page.locator('.character-arm-length-reset').click();
    await frames();
    assert.equal((await profile()).arms, null);
    close(bone(await sprites(), 'left-upper-arm').length, 0.9, 'Natural lengths return the authored arm', 1e-9);
    report.armLengths.sprite = { upper: 0.6, forearm: 0.5, elbowKeepsSize: true };

    // 11. A hammer model, authored on the reference handle, fits every handle length: its handle up to the head end
    // stretches, the head end keeps its size on the physical head, and cel outlines follow the fitted geometry.
    const { HAMMER_MODEL_HANDLE, HAMMER_MODEL_HEAD_END } = modules.fit;
    const hammerProfile = {
      schemaVersion: 12, characterRiggingType: 'avatar-3d', armForwardDistance: 0.25, grips: DEFAULT_GRIPS, arms: null,
      images: [], layers: [], skeleton: null, presentation: null,
      models: [{ id: 'hammer', name: 'Mallet', source: `data:model/gltf-binary;base64,${hammerGlb().toString('base64')}` }],
      hammer: { model: 'hammer' }, shading: { mode: 'cel', bands: 3, outline: { color: '#1f2428', width: 0.03 } },
    };
    await page.locator('.sprite-file').setInputFiles({
      name: 'mallet.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(hammerProfile)),
    });
    await page.waitForFunction(() => {
      const state = window.gettingOver.sprites();
      return !state.busy && state.document.characterRiggingType === 'avatar-3d' && window.gettingOver.level().rendering.hammerModel !== null;
    });
    await frames();
    report.hammerFit = [];
    for (const length of [1.8, 2.6, 0.9, HAMMER_MODEL_HANDLE]) {
      if ((await snapshot()).rig.handleLength !== length) {
        await setRange('character-handle-length', length);
        await page.waitForFunction(value => Math.abs(window.gettingOver.snapshot().rig.handleLength - value) < 1e-9, length);
      }
      await frames();
      const [state, drawn] = [await snapshot(), await page.evaluate(() => window.gettingOver.level().rendering)];
      const { fit, transform } = drawn.hammerModel;
      assert.equal(fit.handleLength, length, `The hammer model fits the ${length} m handle.`);
      assert.ok(drawn.shading.hullsVisible > 0, 'The fitted hammer keeps its cel outline.');
      // Behind the butt stays, the holdable handle stretches, and the head end moves with the physical head.
      const map = x => x <= 0 ? x : x < HAMMER_MODEL_HEAD_END ? x * (length - HEAD_MARGIN) / HAMMER_MODEL_HEAD_END : x + length - HAMMER_MODEL_HANDLE;
      for (const { authored, fitted } of fit.meshes) {
        close(fitted.min[0], map(authored.min[0]), `${length} m: a mesh's near end`, 1e-6);
        close(fitted.max[0], map(authored.max[0]), `${length} m: a mesh's far end`, 1e-6);
        for (const axis of [1, 2]) {
          close(fitted.min[axis], authored.min[axis], `${length} m: the model keeps its thickness`, 1e-9);
          close(fitted.max[axis], authored.max[axis], `${length} m: the model keeps its thickness`, 1e-9);
        }
      }
      // The fixture's head is its block beyond the head end: the same size, centred on the physical head.
      const head = fit.meshes.find(mesh => mesh.authored.min[0] >= HAMMER_MODEL_HEAD_END);
      close(head.fitted.max[0] - head.fitted.min[0], head.authored.max[0] - head.authored.min[0], `${length} m: the head keeps its size`, 1e-6);
      const centre = (head.fitted.min[0] + head.fitted.max[0]) / 2;
      const world = [transform[12] + transform[0] * centre, transform[13] + transform[1] * centre];
      const physical = state.parts.find(part => part.id === 'head');
      close(Math.hypot(world[0] - physical.x, world[1] - physical.y), 0, `${length} m: the model's head sits on the physical head`, 0.02);
      assert.match(await page.locator('.character-hammer-geometry').textContent(), length === HAMMER_MODEL_HANDLE
        ? /This game's handle is 1\.5 m, so the model draws as authored\./ : new RegExp(`This game's handle is ${length} m:`));
      report.hammerFit.push({ length, bounds: fit.bounds, head: head.fitted });
    }
    await page.screenshot({ path: fileURLToPath(new URL('grips-hammer-model.png', artifacts)) });
    assert.deepEqual(report.errors, [], 'Grip scenario browser errors are not allowed.');
    return report;
  } finally {
    await context.close();
  }
}
