import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import { chromium } from 'playwright';
import { observeBrowserPage } from './verify-level.mjs';
import { dragTouch } from './verify-mobile.mjs';
import { modelFixture, texturePng } from './verify-appearance.mjs';
import { solidPng } from './verify-flipbook.mjs';
import { hammerGlb, HUMANOID_BONE_MAP, potGlb, skinnedAvatarGlb } from './character-fixtures.mjs';
import { releaseContent, shellCode } from './release-fixtures.mjs';

const TOUCH_DRAG_PIXELS = 40;
const TOUCH_PIXELS_PER_REACH = 100;
const CONTENT_MODULE = '\0virtual:game-content';
const MODELS_MODULE = '\0virtual:game-character-models';
const CONTENT_FILE = /^\/content\/game\/[0-9a-f]{64}\.(png|glb)$/;
const CHARACTER_KEY = 'over-the-edge:play:character';
const FLIPBOOK_FRAMES = 3;
const DIRECTIONS = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'];
const SETTINGS_SAMPLE_TIMEOUT = 5000;
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const configFile = join(root, 'vite.game.config.ts');
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(artifacts, 'release-proof-'));
const levelPath = join(temporary, 'level.json');
const spritePath = join(temporary, 'sprites.json');
const flipbookPath = join(temporary, 'flipbook.json');
const settingsPath = join(temporary, 'settings.json');
const customOutput = join(temporary, 'game');
const previousLevel = process.env.GAME_LEVEL;
const previousSprites = process.env.GAME_SPRITES;
const previousSettings = process.env.GAME_SETTINGS;
const previousAlternate = process.env.GAME_ALTERNATE_SPRITES;
const report = { status: 'incomplete', errors: [], entries: [], blocked: [], settings: { invalid: [] } };
let browser;

const frames = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function minimalHud(page, width, characters = 0) {
  assert.equal(await page.locator('#fatal-error').isHidden(), true);
  assert.equal(await page.evaluate(() => typeof window.gettingOver), 'undefined');
  assert.equal(await page.getByRole('tab').count(), 0);
  assert.equal(await page.getByRole('button').count(), 0);
  // Only a release with two character profiles offers the player a character choice.
  assert.equal(await page.getByRole('radio').count(), characters);
  assert.equal(await page.locator('input[type="file"], .game-actions, .game-help, .brand, .peak-value').count(), 0);
  assert.deepEqual(await page.locator('.play-hud dt').allTextContents(), ['CURRENT HEIGHT', 'ELAPSED']);
  assert.equal(await page.locator('.play-hud dd').count(), 2);
  const canvas = await page.locator('#game').boundingBox();
  assert.equal(canvas.width, width, 'The release canvas must not reserve an empty editor column.');
  return canvas;
}

async function tracePointerMapping(page, sources) {
  return page.evaluate(async ({ view }) => {
    const { GameView } = await import(view);
    const original = GameView.prototype.pointerDelta;
    window.releasePointerSamples = [];
    GameView.prototype.pointerDelta = function (pixels, sensitivity, mode) {
      const world = original.call(this, pixels, sensitivity, mode);
      if (pixels.x !== 0 || pixels.y !== 0) {
        window.releasePointerSamples.push({ pixels, world, sensitivity, mode, camera: this.cameraState(), reach: this.rig.maxReach });
      }
      return world;
    };
  }, sources);
}

async function touchRelease(browser, address, sources) {
  const results = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    const context = await browser.newContext({ viewport, screen: viewport, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      const protocol = await observeBrowserPage(page, report.errors);
      await page.goto(address, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelector('.elapsed-value')?.textContent !== '00:00');
      await minimalHud(page, viewport.width);
      await tracePointerMapping(page, sources);
      const metric = await page.locator('.play-hud > div').first().boundingBox();
      const start = { x: metric.x + metric.width / 2, y: metric.y + metric.height / 2 };
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).id, start), 'game',
        'The readouts must not intercept hammer gestures.');
      // Raw coordinates avoid the extra touch slop added by synthesized scrolling.
      await dragTouch(page, protocol, { start, delta: { x: 0, y: TOUCH_DRAG_PIXELS } });
      const samples = await page.evaluate(() => window.releasePointerSamples);
      assert.ok(samples.length > 0 && samples.every(sample => sample.mode === 'touch'));
      const pixels = samples.reduce((total, sample) => total + sample.pixels.y, 0);
      const world = samples.reduce((total, sample) => total + sample.world.y, 0);
      assert.ok(Math.abs(Math.abs(pixels) - TOUCH_DRAG_PIXELS) < 1);
      for (const sample of samples) {
        assert.ok(Math.abs(sample.world.y + sample.pixels.y * sample.reach / TOUCH_PIXELS_PER_REACH * sample.sensitivity) < 1e-9,
          'The release must use the stronger touch mapping, not camera-dependent mouse gain.');
      }
      assert.equal(await page.evaluate(() => document.pointerLockElement), null);
      assert.equal(await page.locator('#fatal-error').isHidden(), true);
      await page.screenshot({ path: join(artifacts, `game-release-${viewport.width < viewport.height ? 'portrait' : 'landscape'}.png`) });
      results.push({ viewport, dragPixels: Math.abs(pixels), targetMovement: Math.abs(world), hudPassesTouch: true });
    } finally { await context.close(); }
  }
  assert.ok(Math.abs(results[0].targetMovement - results[1].targetMovement) < 0.001);
  return results;
}

function bundleModules(bundle) {
  const results = Array.isArray(bundle) ? bundle : [bundle];
  return results.flatMap(result => result.output.filter(file => file.type === 'chunk')
    .flatMap(file => Object.keys(file.modules)));
}

async function settingsBuild(expected, outDir) {
  const bundle = await build({ configFile, logLevel: 'silent', build: { outDir } });
  const modules = bundleModules(bundle);
  const { manifest } = await releaseContent(outDir);
  assert.deepEqual(manifest.settings, expected, 'The release content must carry its validated settings.');
  assert.ok(!shellCode(bundle).includes(JSON.stringify(expected.physics)), 'Settings are content, not shell code.');
  assert.ok(modules.includes(CONTENT_MODULE));
  assert.ok(!modules.some(id => id.includes('/src/editor/') || id.includes('GLTFLoader')));
}

async function withSettingsDevelopment(page, inspect) {
  const server = await createServer({
    configFile, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  try {
    await server.listen();
    const address = `http://127.0.0.1:${server.httpServer.address().port}/`;
    return await inspect(server, address);
  } finally {
    try { await page.goto('about:blank'); }
    finally { await server.close(); }
  }
}

async function runtimeSettings(page, server) {
  await page.waitForFunction(() => {
    const elapsed = document.querySelector('.elapsed-value');
    return elapsed !== null && elapsed.textContent !== '00:00';
  });
  const module = server.moduleGraph.getModuleById(join(root, 'src/game.ts'));
  assert.ok(module);
  return page.evaluate(async ({ url, timeout }) => {
    const { Game } = await import(url);
    const original = Game.prototype.state;
    // Observe the live release instance on its next frame without adding a release debug API.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        Game.prototype.state = original;
        reject(new Error('The release did not produce a settings sample.'));
      }, timeout);
      Game.prototype.state = function () {
        Game.prototype.state = original;
        clearTimeout(timer);
        resolve(this.settings());
        return original.call(this);
      };
    });
  }, { url: module.url, timeout: SETTINGS_SAMPLE_TIMEOUT });
}

// The live release's rig: its geometry, the physical handle and the view's derived touch gain.
async function runtimeRig(page, server) {
  const module = server.moduleGraph.getModuleById(join(root, 'src/game.ts'));
  assert.ok(module);
  return page.evaluate(async ({ url, timeout }) => {
    const { Game } = await import(url);
    const original = Game.prototype.state;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        Game.prototype.state = original;
        reject(new Error('The release did not produce a rig sample.'));
      }, timeout);
      Game.prototype.state = function () {
        Game.prototype.state = original;
        clearTimeout(timer);
        const parts = this.simulation.frame(1).parts;
        const slider = parts.find(part => part.id === 'slider');
        const head = parts.find(part => part.id === 'head');
        resolve({
          geometry: { ...this.simulation.rigGeometry },
          viewSharesRig: this.view.rig === this.simulation.rigGeometry,
          shaftLength: Math.hypot(head.x - slider.x, head.y - slider.y),
          touchStep: -this.view.pointerDelta({ x: 0, y: 100 }, 1, 'touch').y,
          maxTargetRadius: this.settings().cursor.maxTargetRadius,
        });
        return original.call(this);
      };
    });
  }, { url: module.url, timeout: SETTINGS_SAMPLE_TIMEOUT });
}

async function verifySettings(page) {
  delete process.env.GAME_SETTINGS;
  const { defaults, fileBytes } = await withSettingsDevelopment(page, async (server, address) => {
    const shared = await server.ssrLoadModule('/src/game-settings.ts');
    const defaults = shared.DEFAULT_GAME_SETTINGS;
    await settingsBuild(defaults, join(temporary, 'default-settings-game'));
    assert.equal((await page.goto(address, { waitUntil: 'networkidle' })).status(), 200);
    assert.deepEqual(await runtimeSettings(page, server), defaults);
    report.settings.defaults = { build: true, development: true, profile: defaults };
    return { defaults, fileBytes: shared.GAME_SETTINGS_LIMITS.fileBytes };
  });
  // A longer handle with a different reach, so every value derived from the rig must follow it.
  const selected = {
    ...defaults,
    physics: { ...defaults.physics, playerMass: 14, mouseSensitivity: 1.75 },
    rig: { handleLength: 2.1, maxExtension: 0.8 },
    cursor: { maxTargetRadius: 2.1, deadZone: 0.15 },
  };
  await writeFile(settingsPath, JSON.stringify(selected));
  process.env.GAME_SETTINGS = relative(root, settingsPath);
  const output = join(temporary, 'settings-game');
  await settingsBuild(selected, output);
  const release = await preview({
    configFile, logLevel: 'silent', build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  try {
    const address = `http://127.0.0.1:${release.httpServer.address().port}/`;
    assert.equal((await fetch(address)).status, 200);
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => {
      const elapsed = document.querySelector('.elapsed-value');
      return elapsed !== null && elapsed.textContent !== '00:00';
    });
    await minimalHud(page, 1440);
    report.settings.selected = { build: true, preview: true, profile: selected };
  } finally {
    try { await page.goto('about:blank'); }
    finally {
      await new Promise((resolve, reject) => release.httpServer.close(error => error ? reject(error) : resolve()));
    }
  }

  process.env.GAME_SETTINGS = settingsPath;
  await withSettingsDevelopment(page, async (server, address) => {
    assert.equal((await page.goto(address, { waitUntil: 'networkidle' })).status(), 200);
    assert.deepEqual(await runtimeSettings(page, server), selected);
    report.settings.selected.development = true;
    const rig = await runtimeRig(page, server);
    const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
    close(rig.geometry.handleLength, 2.1, 'handle length');
    close(rig.geometry.maxExtension, 0.8, 'maximum extension');
    close(rig.geometry.minExtension, -2.1, 'the head retracts to the hinge');
    close(rig.geometry.maxReach, 2.9, 'reach');
    close(rig.geometry.segmentLength, 0.7, 'three segments share the handle');
    assert.ok(rig.viewSharesRig, 'The view must render the simulation\'s rig.');
    assert.ok(Math.abs(rig.shaftLength - 2.1) < 0.02, `The physical handle must be 2.1 m (${rig.shaftLength} m).`);
    close(rig.touchStep, 2.9, '100 touch pixels must move the target one reach');
    assert.ok(rig.maxTargetRadius <= rig.geometry.maxReach);
    report.settings.rig = rig;
    const edited = {
      ...selected,
      physics: { ...selected.physics, mouseSensitivity: 0.8, hingeDownswingBoost: 1.6 },
      cursor: { maxTargetRadius: 1.1, deadZone: 0 },
    };
    const reload = page.waitForEvent('domcontentloaded');
    await writeFile(settingsPath, JSON.stringify(edited));
    await reload;
    assert.deepEqual(await runtimeSettings(page, server), edited);
    report.settings.reload = { fullReload: true, profile: edited };
  });

  const invalidPath = join(temporary, 'invalid-settings.json');
  const invalid = [
    { name: 'malformed-json', source: '{broken', error: /JSON|Unexpected/ },
    { name: 'unsupported-version', value: { ...defaults, schemaVersion: 3 }, error: /require schema version 4/ },
    {
      name: 'invalid-physics', value: { ...defaults, physics: { ...defaults.physics, playerMass: 0 } },
      error: /Player mass must be between/,
    },
    {
      name: 'invalid-cursor', value: { ...defaults, cursor: { ...defaults.cursor, maxTargetRadius: 1000 } },
      error: /Maximum target radius must be between/,
    },
    {
      name: 'radius-beyond-reach', value: { ...defaults, cursor: { ...defaults.cursor, maxTargetRadius: 3 } },
      error: /must not exceed the hammer's 2\.65 m reach/,
    },
    {
      name: 'invalid-dead-zone', value: { ...defaults, cursor: { ...defaults.cursor, deadZone: -0.1 } },
      error: /Dead zone must be between 0 and 0\.5/,
    },
    {
      name: 'renamed-radius', value: { ...defaults, cursor: { maxRadius: 2.65, deadZone: 0.1 } },
      error: /Cursor settings contains missing or unknown settings/,
    },
    {
      name: 'invalid-downswing', value: { ...defaults, physics: { ...defaults.physics, sliderDownswingBoost: 0.5 } },
      error: /Slider downswing boost must be between 1 and 3/,
    },
    {
      name: 'invalid-rig', value: { ...defaults, rig: { handleLength: 0.2, maxExtension: 1 } },
      error: /Handle length must be between/,
    },
    { name: 'missing-fields', value: { ...defaults, physics: {} }, error: /missing or unknown settings/ },
    { name: 'unknown-field', value: { ...defaults, unknown: 1 }, error: /missing or unknown settings/ },
    {
      name: 'oversized', source: JSON.stringify(defaults) + ' '.repeat(fileBytes),
      error: /GAME_SETTINGS exceeds the file size limit/,
    },
    { name: 'missing-file', path: join(temporary, 'missing-settings.json'), error: /ENOENT/ },
    { name: 'empty-path', path: '', error: /GAME_SETTINGS must name a JSON file inside this project/ },
    { name: 'non-json-file', path: join(root, 'src/play.ts'), error: /GAME_SETTINGS must name a JSON file inside this project/ },
    { name: 'outside-project', path: join(root, '..'), error: /GAME_SETTINGS must name a JSON file inside this project/ },
  ];
  for (const scenario of invalid) {
    if (scenario.path === undefined) {
      await writeFile(invalidPath, scenario.source === undefined ? JSON.stringify(scenario.value) : scenario.source);
    }
    process.env.GAME_SETTINGS = scenario.path === undefined ? invalidPath : scenario.path;
    await assert.rejects(build({ configFile, logLevel: 'silent', build: { write: false } }), scenario.error,
      `${scenario.name} must fail the build instead of selecting defaults.`);
    const development = () => withSettingsDevelopment(page, async (_server, address) => {
      const response = await fetch(`${address}@id/__x00__virtual:game-content`);
      assert.equal(response.status, 500, `${scenario.name} must not serve default settings.`);
      assert.match(await response.text(), scenario.error);
    });
    if (scenario.path === undefined) await development();
    else await assert.rejects(development, scenario.error,
      `${scenario.name} must fail development instead of selecting defaults.`);
    report.settings.invalid.push({ case: scenario.name, build: true, development: true });
  }
}

const glbSource = buffer => `data:model/gltf-binary;base64,${buffer.toString('base64')}`;

function paperProfile() {
  const layer = (id, anchor, image, width, height) => ({
    id, name: id, anchor, image, width, height, offset: { x: 0, y: 0, z: 0.6 }, rotation: 0,
    bone: null, directions: DIRECTIONS, skin: null, tileLength: null,
  });
  return {
    schemaVersion: 12, characterRiggingType: 'sprite-2d', armForwardDistance: 0.25, grips: { placement: 'fixed', left: 0.04, right: 0.22, slideAt: 0.85 }, arms: null,
    images: [
      { id: 'body', name: 'Body', source: `data:image/png;base64,${solidPng(16, 16, 20).toString('base64')}` },
      { id: 'tool', name: 'Tool', source: `data:image/png;base64,${solidPng(16, 16, 200).toString('base64')}` },
    ],
    layers: [
      layer('pot-card', 'pot', 'body', 1, 0.8), layer('shaft-card', 'hammer-shaft', 'tool', 1.5, 0.08),
      layer('head-card', 'hammer-head', 'tool', 0.2, 0.58),
    ],
    skeleton: null, presentation: null,
  };
}

// Avatar, hammer and pot models; `only` keeps just the avatar, for single-model failure cases.
function heroProfile(changes = {}) {
  return {
    schemaVersion: 12, characterRiggingType: 'avatar-3d', armForwardDistance: 0.3,
    grips: { placement: 'sliding', left: 0.04, right: 0.22, slideAt: 0.85 },
    arms: { left: { upper: 0.5, forearm: 0.48 }, right: { upper: 0.52, forearm: 0.46 } },
    images: [], layers: [], skeleton: null, presentation: null,
    models: [
      { id: 'avatar', name: 'Hero', source: glbSource(skinnedAvatarGlb()) },
      { id: 'hammer', name: 'Mallet', source: glbSource(hammerGlb()) },
      { id: 'pot', name: 'Urn', source: glbSource(potGlb()) },
    ],
    avatar: { model: 'avatar', boneMap: HUMANOID_BONE_MAP }, hammer: { model: 'hammer' }, pot: { model: 'pot' },
    shading: { mode: 'cel', bands: 3, outline: { color: '#1f2428', width: 0.02 } },
    ...changes,
  };
}

function avatarOnly(source) {
  return heroProfile({ models: [{ id: 'avatar', name: 'Hero', source }], hammer: undefined, pot: undefined });
}

// S4: a release with a 2D profile and a skinned 3D profile that players switch between.
async function verifyCharacterRelease(page) {
  const paperPath = join(temporary, 'paper.json');
  const heroPath = join(temporary, 'hero.json');
  const output = join(temporary, 'characters-game');
  await writeFile(levelPath, JSON.stringify(customLevel(0)));
  await writeFile(paperPath, JSON.stringify(paperProfile()));
  await writeFile(heroPath, JSON.stringify(heroProfile()));
  delete process.env.GAME_SETTINGS;
  process.env.GAME_LEVEL = levelPath;
  process.env.GAME_SPRITES = paperPath;
  process.env.GAME_ALTERNATE_SPRITES = heroPath;
  const modules = new Map();
  const release = await build({
    configFile, logLevel: 'silent', build: { outDir: output },
    plugins: [{
      name: 'release-character-proof', enforce: 'pre',
      transform(code, id) { if (id === MODELS_MODULE) modules.set(id, code); },
    }],
  });
  const { files, manifest } = await releaseContent(output);
  const glbs = [...files.keys()].filter(path => path.endsWith('.glb'));
  assert.equal(glbs.length, 3, 'The avatar, hammer and pot GLBs must be separate content files.');
  assert.equal([...files.keys()].filter(path => path.endsWith('.png')).length, 2);
  const heroModels = heroProfile().models.map(model => model.source.slice(model.source.indexOf(',') + 1));
  const code = shellCode(release);
  assert.ok(heroModels.every(model => !code.includes(model.slice(0, 4096))), 'Character GLB bytes must not be in the shell.');
  const hero = manifest.characters.alternate;
  assert.equal(hero.schemaVersion, 12);
  assert.deepEqual([hero.grips, hero.arms], [heroProfile().grips, heroProfile().arms]);
  assert.ok(hero.models.every(model => /^content:game\/[0-9a-f]{64}\.glb$/.test(model.source)), 'Profile models become packaged sources.');
  assert.deepEqual([hero.avatar.model, hero.hammer.model, hero.pot.model, hero.shading.mode], ['avatar', 'hammer', 'pot', 'cel']);
  assert.match(modules.get(MODELS_MODULE), /createCharacterModelLoader/);
  const releaseModules = bundleModules(release);
  assert.ok(!releaseModules.some(id => id.includes('/src/editor/')), 'The character release contains no editor modules.');
  assert.ok(releaseModules.some(id => id.endsWith('/src/character-model-loader.ts')));
  const result = { assets: glbs, toggles: 0 };

  const server = await preview({
    configFile, logLevel: 'silent', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  const requests = [];
  const record = request => {
    const path = new URL(request.url()).pathname;
    if (/\.(glb|png)$/.test(path)) requests.push(path);
  };
  page.on('request', record);
  try {
    const address = `http://127.0.0.1:${server.httpServer.address().port}/`;
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.evaluate(key => localStorage.removeItem(key), CHARACTER_KEY);
    requests.length = 0;
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('.elapsed-value')?.textContent !== '00:00');
    await minimalHud(page, 1440, 2);
    const group = page.getByRole('radiogroup', { name: 'Character' });
    const flat = group.getByRole('radio', { name: '2D', exact: true });
    const avatar = group.getByRole('radio', { name: '3D', exact: true });
    assert.equal(await flat.isChecked(), true, 'The first profile is the default choice.');
    const loaded = [...requests].sort();
    assert.equal(loaded.length, 5, 'Both profiles load every asset before play.');
    assert.equal(new Set(loaded).size, 5, 'Every asset loads exactly once.');
    await page.screenshot({ path: join(artifacts, 'game-release-character-2d.png') });
    // Switch mid-level while the clock runs: no reload, reset or asset request.
    const elapsedBefore = await page.locator('.elapsed-value').textContent();
    for (const choice of [avatar, flat, avatar]) {
      await choice.check();
      await frames(page);
      result.toggles++;
    }
    assert.deepEqual([...requests].sort(), loaded, 'Toggling reuses both profiles\' loaded assets.');
    await page.waitForFunction(previous => document.querySelector('.elapsed-value').textContent !== previous, elapsedBefore);
    assert.notEqual(await page.locator('.elapsed-value').textContent(), '00:00', 'Toggling must not restart the level.');
    await page.screenshot({ path: join(artifacts, 'game-release-character-3d.png') });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), CHARACTER_KEY), '1');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('.elapsed-value')?.textContent !== '00:00');
    assert.equal(await avatar.isChecked(), true, 'The choice persists locally.');
    assert.equal(await page.locator('#fatal-error').isHidden(), true);
    result.persisted = true;
  } finally {
    page.off('request', record);
    await page.goto('about:blank');
    await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }

  // Development entry: switching leaves physics identical and builds nothing new after the first switch.
  const development = await createServer({ configFile, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true } });
  try {
    await development.listen();
    await page.goto(`http://127.0.0.1:${development.httpServer.address().port}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('.elapsed-value')?.textContent !== '00:00');
    const gameModule = development.moduleGraph.getModuleById(join(root, 'src/game.ts'));
    assert.ok(gameModule);
    await page.evaluate(async url => {
      const { Game } = await import(url);
      const original = Game.prototype.state;
      await new Promise(resolve => {
        Game.prototype.state = function () {
          Game.prototype.state = original;
          window.releaseGame = this;
          resolve();
          return original.call(this);
        };
      });
    }, gameModule.url);
    await page.locator('#game').focus();
    await page.keyboard.press('p');
    await frames(page);
    const sample = () => page.evaluate(() => {
      const game = window.releaseGame;
      const view = game.view.statistics();
      return {
        physics: JSON.stringify(game.simulation.snapshot()),
        selection: view.characters,
        grips: view.grips.placement,
        armChains: view.armChains,
        textures: view.textures, geometries: view.geometries,
        shading: { mode: view.shading.mode, materialsCreated: view.shading.materialsCreated, hullsCreated: view.shading.hullsCreated },
        avatar: view.importedAvatar === null ? null : { visible: view.importedAvatar.visible, bones: view.importedAvatar.bones },
        hammer: view.hammerModel === null ? null : view.hammerModel.visible,
        pot: view.potModel === null ? null : { visible: view.potModel.visible, transform: view.potModel.transform },
        potBody: game.simulation.frame(1).parts.find(part => part.id === 'pot'),
        paused: game.state().paused,
      };
    });
    const select = async index => {
      await page.getByRole('radio').nth(index).check();
      await frames(page);
      return sample();
    };
    const start = await sample();
    assert.equal(start.paused, true);
    const first = await select(1);
    const back = await select(0);
    const again = await select(1);
    for (const state of [first, back, again]) assert.equal(state.physics, start.physics, 'Switching characters must not touch physics.');
    assert.deepEqual([start.grips, first.grips, back.grips, again.grips], ['fixed', 'sliding', 'fixed', 'sliding'],
      'Each character applies its own grip placement, without a reload.');
    assert.deepEqual([first.selection.active, back.selection.active, again.selection.active], [1, 0, 1]);
    assert.deepEqual(first.selection.types, ['sprite-2d', 'avatar-3d']);
    assert.equal(first.avatar.visible, true);
    assert.equal(first.hammer, true);
    assert.equal(first.pot.visible, true, 'The release renders avatar, hammer and pot models together.');
    // The pot model's origin is the physical pot's bottom-centre, 0.48 m below the body, at the pot depth.
    const { x, y, angle } = first.potBody;
    const origin = [first.pot.transform[12], first.pot.transform[13], first.pot.transform[14]];
    const bottom = [x + 0.48 * Math.sin(angle), y - 0.48 * Math.cos(angle), 0.22];
    assert.ok(Math.hypot(...origin.map((value, index) => value - bottom[index])) < 1e-9, 'The pot tracks the physical pot body exactly.');
    assert.ok(Math.abs(Math.atan2(first.pot.transform[1], first.pot.transform[0]) - angle) < 1e-9);
    assert.equal(back.avatar, null, 'The 2D profile shows no imported avatar.');
    assert.equal(back.pot, null, 'The 2D profile keeps its own pot.');
    assert.equal(first.shading.mode, 'cel');
    assert.deepEqual(again.shading, first.shading, 'Switching back builds no new materials or outlines.');
    assert.equal(again.textures, first.textures, 'Switching back uploads no new textures.');
    assert.equal(again.geometries, first.geometries, 'Switching back creates no new geometry.');
    result.development = { physicsUnchanged: true, textures: again.textures, geometries: again.geometries, shading: again.shading };
  } finally {
    await page.goto('about:blank');
    await development.close();
  }

  // Release builds validate every character GLB and bone map with the shared typed checks.
  const invalid = [
    ['incomplete bone map', heroProfile({ avatar: { model: 'avatar', boneMap: { ...HUMANOID_BONE_MAP, head: undefined } } }), /no GLB joint for head/],
    ['unknown joint', heroProfile({ avatar: { model: 'avatar', boneMap: { ...HUMANOID_BONE_MAP, head: 'Skull' } } }), /no skin joint named "Skull"/],
    ['broken chain', heroProfile({ avatar: { model: 'avatar', boneMap: { ...HUMANOID_BONE_MAP, 'left-hand': 'Spine' } } }), /ancestor chains/],
    ['eight influences', avatarOnly(glbSource(skinnedAvatarGlb({ extraInfluences: true }))), /at most 4 joint influences/],
    ['unnormalized weights', avatarOnly(glbSource(skinnedAvatarGlb({ unnormalized: true }))), /must sum to 1/],
    ['model limits', avatarOnly(glbSource(skinnedAvatarGlb({ extraNodes: 2100 }))), /at most 2048 nodes/],
    ['static avatar', avatarOnly(glbSource(modelFixture())), /no skinned mesh/],
    ['remote model', avatarOnly('https://example.invalid/hero.glb'), /must be an embedded GLB/],
    ['skinned hammer', heroProfile({ models: heroProfile().models.map(model => model.id === 'hammer'
      ? { ...model, source: glbSource(skinnedAvatarGlb()) } : model) }), /hammer model "Mallet".*static mesh without skins/],
    ['skinned pot', heroProfile({ models: heroProfile().models.map(model => model.id === 'pot'
      ? { ...model, source: glbSource(skinnedAvatarGlb()) } : model) }), /pot model "Urn".*static mesh without skins/],
    ['pot convention', heroProfile({ models: heroProfile().models.map(model => model.id === 'pot'
      ? { ...model, source: glbSource(potGlb({ origin: 'centre' })) } : model) }), /pot model "Urn".*bottom-centre/],
    ['shared pot model', heroProfile({ pot: { model: 'hammer' }, models: heroProfile().models.slice(0, 2) }), /separate character models/],
    ['earlier schema', heroProfile({ schemaVersion: 11 }), /require schema version 12/],
  ];
  result.invalid = [];
  for (const [name, profile, error] of invalid) {
    await writeFile(heroPath, JSON.stringify(profile));
    await assert.rejects(build({ configFile, logLevel: 'silent', build: { write: false } }), error,
      `${name} must fail the release build.`);
    result.invalid.push(name);
  }
  delete process.env.GAME_ALTERNATE_SPRITES;
  delete process.env.GAME_SPRITES;
  return result;
}

// A custom course; its decorations stand where the pot starts, so the release only supports the pot
// on its floor if scenery never collides.
function customLevel(lift) {
  const decoration = (id, model, z, height) => ({
    kind: 'decoration', id, model, x: 11, y: lift + 4, z, height, angle: 0, mirror: false, tint: 0xffffff,
  });
  return {
    schemaVersion: 3,
    labels: [{ x: 10, y: lift + 7, text: 'RELEASE_LEVEL_SENTINEL' }],
    objects: [{
      kind: 'terrain', id: 'release-floor', shape: { type: 'box' }, x: 11, y: lift + 3,
      width: 20, height: 2, angle: 0, depth: 2, color: 0x71817a, illusion: false,
    }, { kind: 'start', id: 'release-start', x: 11, y: lift + 6, angle: -0.4, reach: 1.8 },
    decoration('release-wall', 'broken-wall', 0, 6), decoration('release-chains', 'chains', 4, 8), decoration('release-castle', 'castle', -600, 110)],
  };
}

function updraftLevel() {
  return {
    schemaVersion: 3, labels: [],
    objects: [
      { ...customLevel(0).objects[0], x: 0, y: -1 },
      { kind: 'start', id: 'release-start', x: 0, y: 4, angle: 0, reach: 1.7 },
      {
        kind: 'trigger', id: 'release-updraft', name: 'Updraft', x: 0, y: 0.7,
        region: { type: 'box', width: 2, height: 1.4 }, activation: 'on-enter', marker: 'updraft',
        events: [{ type: 'launch-player', height: 8, strength: 1.25 }],
      },
    ],
  };
}

function enemiesLevel() {
  return {
    schemaVersion: 3, labels: [],
    objects: [
      { ...customLevel(0).objects[0], x: 0, y: -1 },
      { kind: 'start', id: 'release-start', x: 0, y: 0.53, angle: 0, reach: 1.7 },
      {
        kind: 'enemy', id: 'release-bird', species: 'bird', x: 2.35, y: 1.2,
        facing: 'left', patrolDistance: 0, speed: 0,
      },
      {
        kind: 'enemy', id: 'release-soldier', species: 'hollow-soldier', x: -4, y: 0.7,
        facing: 'right', patrolDistance: 0, speed: 0,
      },
    ],
  };
}

async function observeEnemySprites(page) {
  await page.addInitScript(() => {
    window.enemySpriteDraw = { instances: 0 };
    const prototype = WebGL2RenderingContext.prototype;
    const clear = prototype.clear;
    const draw = prototype.drawElementsInstanced;
    prototype.clear = function (...args) {
      // Count per frame: the view also clears depth alone between its scene and foreground passes.
      if (this.canvas.id === 'game' && (args[0] & this.COLOR_BUFFER_BIT) !== 0) window.enemySpriteDraw.instances = 0;
      return clear.apply(this, args);
    };
    prototype.drawElementsInstanced = function (mode, count, type, offset, instances) {
      if (this.canvas.id === 'game' && count === 6) window.enemySpriteDraw.instances = instances;
      return draw.call(this, mode, count, type, offset, instances);
    };
  });
}

try {
  const bundle = await build({ configFile, logLevel: 'silent', build: { write: false } });
  const modules = bundleModules(bundle);
  assert.ok(modules.some(id => id.endsWith('/src/play.ts')));
  assert.ok(!modules.some(id => id.includes('/src/editor/') || id.includes('GLTFLoader')));
  assert.ok(!modules.some(id => id.endsWith('/src/default-level.ts') || id.endsWith('/src/course.ts')), 'Even the built-in course is content.');
  assert.ok(!modules.some(id => /\/src\/decoration-(view|library|models|geometry)\.ts$/.test(id)), 'A release without decorations ships no decoration code.');
  const results = Array.isArray(bundle) ? bundle : [bundle];
  const styles = results.flatMap(result => result.output.filter(file =>
    file.type === 'asset' && file.fileName.endsWith('.css')));
  assert.ok(styles.every(asset => !/workshop|tuning-group|appearance-editor|level-editor|game-actions|game-help|brand-mark/.test(String(asset.source))),
    'Game-only styles must not include authoring UI or its controls/help.');
  report.modules = modules.length;

  for (const target of [
    'game-settings-ui.ts', 'game-settings-store.ts', 'style.css', 'workshop.html?raw', 'game-ui.ts', 'game-ui.css',
    'sprite-editor.ts', 'sprite-editor.css', 'visual-store.ts', 'set-pieces.ts', 'set-piece-view.ts',
  ]) {
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
  await observeBrowserPage(page, report.errors);
  let spriteRequests = null;
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (spriteRequests !== null && CONTENT_FILE.test(path) && path.endsWith('.png')) spriteRequests.add(path);
  });
  let flipbookRelease = null;
  const ready = () => page.waitForFunction(() => {
    const elapsed = document.querySelector('.elapsed-value');
    return elapsed !== null && elapsed.textContent !== '00:00';
  });

  for (const mode of ['preview', 'development', 'custom', 'sprites', 'updraft', 'enemies', 'flipbook']) {
    if (mode === 'custom') {
      await writeFile(levelPath, JSON.stringify(customLevel(0)));
      process.env.GAME_LEVEL = levelPath;
      const custom = await build({ configFile, logLevel: 'silent', build: { outDir: customOutput } });
      assert.ok(!bundleModules(custom).some(id => id.endsWith('/src/course.ts') || id.endsWith('/src/default-level.ts')));
      const { manifest } = await releaseContent(customOutput);
      assert.ok(!shellCode(custom).includes('RELEASE_LEVEL_SENTINEL'), 'The level is content, not shell code.');
      assert.deepEqual(manifest.level.labels, customLevel(0).labels, 'A custom release must replace the built-in course.');
      assert.deepEqual(manifest.level.objects.filter(object => object.kind === 'decoration'),
        customLevel(0).objects.filter(object => object.kind === 'decoration'), 'Decorations ship with the level.');
      assert.ok(bundleModules(custom).some(id => id.endsWith('/src/decoration-view.ts')), 'The release draws decorations.');
      // A decoration model the library lacks, with no course artwork, fails the build instead of vanishing from the release.
      const unknown = customLevel(0);
      await writeFile(levelPath, JSON.stringify({ ...unknown, objects: [...unknown.objects, { ...unknown.objects.at(-1), id: 'release-lost', model: 'no-such-model' }] }));
      await assert.rejects(build({ configFile, logLevel: 'silent', build: { write: false } }),
        /no-such-model, which is neither in the decoration library nor in the course artwork\. Shape releases draw only the built-in library/);
      await writeFile(levelPath, JSON.stringify(customLevel(0)));
    }
    if (mode === 'sprites') {
      const source = `data:image/png;base64,${texturePng().toString('base64')}`;
      const rigging = { bone: null, directions: DIRECTIONS, skin: null, tileLength: null };
      await writeFile(spritePath, JSON.stringify({
        schemaVersion: 12, characterRiggingType: 'sprite-2d', armForwardDistance: 0.25, grips: { placement: 'fixed', left: 0.04, right: 0.22, slideAt: 0.85 }, arms: null,
        images: [{ id: 'body', name: 'Generated body', source }, { id: 'alias', name: 'Shared source', source }],
        layers: [
          { id: 'body-card', name: 'Body card', anchor: 'pot', image: 'body', width: 1.2, height: 1,
            offset: { x: 0, y: 0, z: 0.6 }, rotation: 0, ...rigging },
          { id: 'head-card', name: 'Head card', anchor: 'character-head', image: 'alias', width: 0.4, height: 0.4,
            offset: { x: 0, y: 1.1, z: 0.6 }, rotation: 0, ...rigging },
        ],
        skeleton: null, presentation: null,
      }));
      process.env.GAME_SPRITES = spritePath;
      const skin = await build({ configFile, logLevel: 'silent', build: { outDir: customOutput } });
      const { files } = await releaseContent(customOutput);
      assert.equal([...files.keys()].filter(path => path.endsWith('.png')).length, 1, 'Repeated PNG contents must share one content file.');
      assert.ok(!shellCode(skin).includes(source.slice(source.indexOf(',') + 1, 4096)), 'Uploaded PNG bytes must not be in the shell.');
      assert.ok(!bundleModules(skin).some(id => id.includes('/src/editor/') || id.includes('GLTFLoader')));
    }
    if (mode === 'flipbook') {
      const frames = Array.from({ length: FLIPBOOK_FRAMES }, (_, index) => ({
        id: `frame-${index}`, name: `Frame ${index}`, source: `data:image/png;base64,${solidPng(12, 16, index * 90).toString('base64')}`,
      }));
      const flipbook = {
        schemaVersion: 12, characterRiggingType: 'sprite-2d', armForwardDistance: 0.25, grips: { placement: 'fixed', left: 0.04, right: 0.22, slideAt: 0.85 }, arms: null,
        images: frames,
        layers: [{
          id: 'aim-head', name: 'Aim head', anchor: 'character-head', image: frames[0].id, width: 0.4, height: 0.4,
          offset: { x: 0, y: 1.1, z: 0.6 }, rotation: 0, bone: null, directions: DIRECTIONS, skin: null, tileLength: null,
          flipbook: { images: frames.map(frame => frame.id), startAngle: 15, hysteresis: 10 },
        }],
        skeleton: null, presentation: null,
      };
      await writeFile(levelPath, JSON.stringify(customLevel(0)));
      await writeFile(flipbookPath, JSON.stringify(flipbook));
      process.env.GAME_SPRITES = flipbookPath;
      const release = await build({ configFile, logLevel: 'silent', build: { outDir: customOutput } });
      const { files, manifest } = await releaseContent(customOutput);
      assert.equal([...files.keys()].filter(path => path.endsWith('.png')).length, FLIPBOOK_FRAMES,
        'Every flipbook frame must become its own content file.');
      const document = manifest.characters.primary;
      assert.equal(document.schemaVersion, 12, 'The release must carry the flipbook document.');
      assert.deepEqual(document.layers, flipbook.layers, 'GAME_SPRITES must carry the flipbook layer without loss.');
      assert.equal(document.images.filter(image => /^content:game\//.test(image.source)).length, FLIPBOOK_FRAMES);
      assert.ok(!bundleModules(release).some(id => id.includes('/src/editor/') || id.includes('GLTFLoader')));
      spriteRequests = new Set();
    }
    if (mode === 'updraft') {
      await writeFile(levelPath, JSON.stringify(updraftLevel()));
      const launch = await build({ configFile, logLevel: 'silent', build: { outDir: customOutput } });
      assert.ok(!bundleModules(launch).some(id => id.includes('/src/editor/') || id.endsWith('/src/default-level.ts')));
    }
    if (mode === 'enemies') {
      await writeFile(levelPath, JSON.stringify(enemiesLevel()));
      const enemies = await build({ configFile, logLevel: 'silent', build: { outDir: customOutput } });
      assert.ok(!bundleModules(enemies).some(id => id.includes('/src/editor/') || id.endsWith('/src/default-level.ts')));
      await observeEnemySprites(page);
    }
    const development = mode === 'development';
    const server = development
      ? await createServer({ configFile, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true } })
      : await preview({
        configFile, logLevel: 'silent',
        ...(['custom', 'sprites', 'updraft', 'enemies', 'flipbook'].includes(mode) ? { build: { outDir: customOutput } } : {}),
        preview: { host: '127.0.0.1', port: 0, strictPort: true },
      });
    try {
      if (development) await server.listen();
      const address = `http://127.0.0.1:${server.httpServer.address().port}/`;
      assert.equal((await fetch(address)).status, 200);
      await page.goto(address, { waitUntil: mode === 'enemies' ? 'domcontentloaded' : 'networkidle' });
      if (mode === 'enemies') {
        await page.waitForFunction(() => window.enemySpriteDraw?.instances === 2);
        await page.mouse.move(720, 500);
        await page.mouse.down();
        await page.mouse.move(800, 500, { steps: 6 });
        await page.mouse.up();
        await page.waitForFunction(() => window.enemySpriteDraw?.instances === 1);
        report.enemies = { birdAndSoldierSprites: true, hammerKilledBird: true };
        await page.screenshot({ path: join(artifacts, 'game-release-enemies.png') });
      }
      await ready();
      if (mode === 'flipbook') {
        assert.equal(spriteRequests.size, FLIPBOOK_FRAMES, 'All flipbook frames must load before gameplay starts.');
        flipbookRelease = { frames: FLIPBOOK_FRAMES, schemaVersion: 12, assets: [...spriteRequests] };
        spriteRequests = null;
      }
      const canvas = await minimalHud(page, 1440);
      if (mode === 'custom' || mode === 'sprites') {
        const height = Number(await page.locator('.height-value').textContent());
        const floor = customLevel(0).objects[0];
        assert.ok(Math.abs(height - (floor.y + floor.height / 2)) < 0.2,
          `The custom course must support the pot at its authored floor, not the built-in floor (${height}m).`);
      }
      if (mode === 'updraft') {
        await page.waitForFunction(() => Number(document.querySelector('.height-value')?.textContent) > 11);
        report.updraft = { height: 8, strength: 1.25, reached: Number(await page.locator('.height-value').textContent()) };
        await page.screenshot({ path: join(artifacts, 'game-release-updraft.png') });
      }
      await page.locator('#game').focus();
      await page.keyboard.press('p');
      await frames(page);
      const elapsed = await page.locator('.elapsed-value').textContent();
      await page.keyboard.press('1');
      await page.keyboard.press('d');
      await page.waitForTimeout(1200);
      assert.equal(await page.locator('.elapsed-value').textContent(), elapsed);
      if (mode === 'preview') await page.screenshot({ path: join(artifacts, 'game-release.png') });
      await page.keyboard.press('r');
      await page.waitForFunction(() => document.querySelector('.elapsed-value').textContent === '00:00');
      if (mode === 'enemies') {
        await page.waitForFunction(() => window.enemySpriteDraw?.instances === 2);
        report.enemies.resetRestored = true;
      }
      if (development) {
        await page.keyboard.press('p');
        await ready();
        // Import the loaded modules, not aliases that instantiate a second copy.
        const viewModule = server.moduleGraph.getModuleById(join(root, 'src/view.ts'));
        assert.ok(viewModule);
        const sources = { view: viewModule.url };
        await tracePointerMapping(page, sources);
        const start = { x: canvas.width / 2, y: canvas.height / 2 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 24, start.y - 12, { steps: 4 });
        await page.mouse.up();
        await frames(page);
        const samples = await page.evaluate(() => window.releasePointerSamples);
        assert.ok(samples.length > 0 && samples.every(sample => sample.mode === 'mouse'));
        assert.equal(samples.reduce((total, sample) => total + sample.pixels.x, 0), 24);
        for (const sample of samples) {
          const scale = sample.camera.worldHeight / sample.camera.height * sample.sensitivity;
          assert.ok(Math.abs(sample.world.x - sample.pixels.x * scale) < 1e-9);
          assert.ok(Math.abs(sample.world.y + sample.pixels.y * scale) < 1e-9);
        }
        report.mouseMappingPreserved = true;
        report.touch = await touchRelease(browser, address, sources);
      }
      report.entries.push({ mode, canvas, keyboardPauseAndReset: true, heightAndTimeOnly: true });
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
  await verifySettings(page);
  report.characters = await verifyCharacterRelease(page);
  report.flipbook = flipbookRelease;
  assert.deepEqual(report.errors, [], 'Release browser errors are not allowed.');
  report.status = 'passed';
  console.log('Game-only release, sprites, aim flipbooks, two-character profiles, updrafts, enemies, dependency boundary, custom level, settings profiles, and development scenarios passed.');
} finally {
  if (previousLevel === undefined) delete process.env.GAME_LEVEL;
  else process.env.GAME_LEVEL = previousLevel;
  if (previousSprites === undefined) delete process.env.GAME_SPRITES;
  else process.env.GAME_SPRITES = previousSprites;
  if (previousSettings === undefined) delete process.env.GAME_SETTINGS;
  else process.env.GAME_SETTINGS = previousSettings;
  if (previousAlternate === undefined) delete process.env.GAME_ALTERNATE_SPRITES;
  else process.env.GAME_ALTERNATE_SPRITES = previousAlternate;
  await writeFile(join(artifacts, 'game-release-report.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  await rm(temporary, { recursive: true });
}
