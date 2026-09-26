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

const TOUCH_DRAG_PIXELS = 40;
const TOUCH_PIXELS_PER_REACH = 100;
const SETTINGS_MODULE = '\0virtual:game-settings';
const SPRITES_MODULE = '\0virtual:game-sprites';
const ALTERNATE_MODULE = '\0virtual:game-alternate-sprites';
const MODELS_MODULE = '\0virtual:game-character-models';
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
  return page.evaluate(async ({ view, config }) => {
    const { GameView } = await import(view);
    const { RIG } = await import(config);
    const original = GameView.prototype.pointerDelta;
    window.releasePointerSamples = [];
    GameView.prototype.pointerDelta = function (pixels, sensitivity, mode) {
      const world = original.call(this, pixels, sensitivity, mode);
      if (pixels.x !== 0 || pixels.y !== 0) {
        window.releasePointerSamples.push({ pixels, world, sensitivity, mode, camera: this.cameraState() });
      }
      return world;
    };
    return RIG.maxReach;
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
      const reach = await tracePointerMapping(page, sources);
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
        assert.ok(Math.abs(sample.world.y + sample.pixels.y * reach / TOUCH_PIXELS_PER_REACH * sample.sensitivity) < 1e-9,
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

async function settingsBuild(expected, buildOptions) {
  let embedded = false;
  const bundle = await build({
    configFile, logLevel: 'silent', build: buildOptions,
    plugins: [{
      name: 'release-settings-proof', enforce: 'pre',
      transform(code, id) {
        if (id !== SETTINGS_MODULE) return;
        assert.deepEqual(JSON.parse(code.slice('export default '.length, -1)), expected);
        embedded = true;
      },
    }],
  });
  const modules = bundleModules(bundle);
  assert.ok(embedded && modules.includes(SETTINGS_MODULE), 'The release must embed its validated settings.');
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

async function verifySettings(page) {
  delete process.env.GAME_SETTINGS;
  const { defaults, fileBytes } = await withSettingsDevelopment(page, async (server, address) => {
    const shared = await server.ssrLoadModule('/src/game-settings.ts');
    const defaults = shared.DEFAULT_GAME_SETTINGS;
    await settingsBuild(defaults, { write: false });
    assert.equal((await page.goto(address, { waitUntil: 'networkidle' })).status(), 200);
    assert.deepEqual(await runtimeSettings(page, server), defaults);
    report.settings.defaults = { build: true, development: true, profile: defaults };
    return { defaults, fileBytes: shared.GAME_SETTINGS_LIMITS.fileBytes };
  });
  const selected = {
    ...defaults,
    physics: { ...defaults.physics, playerMass: 14, mouseSensitivity: 1.75 },
    cursor: { maxRadius: 2.1 },
  };
  await writeFile(settingsPath, JSON.stringify(selected));
  process.env.GAME_SETTINGS = relative(root, settingsPath);
  const output = join(temporary, 'settings-game');
  await settingsBuild(selected, { outDir: output });
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
    const edited = {
      ...selected,
      physics: { ...selected.physics, mouseSensitivity: 0.8 },
      cursor: { maxRadius: 1.1 },
    };
    const reload = page.waitForEvent('domcontentloaded');
    await writeFile(settingsPath, JSON.stringify(edited));
    await reload;
    assert.deepEqual(await runtimeSettings(page, server), edited);
    report.settings.reload = { fullReload: true, profile: edited };
  });

  const legacy = {
    schemaVersion: 1,
    physics: { ...defaults.physics, hingeTorque: defaults.physics.hingeTorque + 70, mouseSensitivity: 1.35 },
    cursor: { returnToHammer: true, returnRate: 12, returnOffsetX: 0.35, returnOffsetY: -0.25 },
  };
  const normalizedLegacy = { schemaVersion: 2, physics: legacy.physics, cursor: defaults.cursor };
  await writeFile(settingsPath, JSON.stringify(legacy));
  process.env.GAME_SETTINGS = relative(root, settingsPath);
  await settingsBuild(normalizedLegacy, { write: false });
  await withSettingsDevelopment(page, async (server, address) => {
    assert.equal((await page.goto(address, { waitUntil: 'networkidle' })).status(), 200);
    assert.deepEqual(await runtimeSettings(page, server), normalizedLegacy);
    report.settings.legacyNormalized = { build: true, development: true, source: legacy, normalized: normalizedLegacy };
  });

  const invalidPath = join(temporary, 'invalid-settings.json');
  const invalid = [
    { name: 'malformed-json', source: '{broken', error: /JSON|Unexpected/ },
    { name: 'unsupported-version', value: { ...defaults, schemaVersion: 3 }, error: /version is not supported/ },
    {
      name: 'invalid-physics', value: { ...defaults, physics: { ...defaults.physics, playerMass: 0 } },
      error: /Player mass must be between/,
    },
    {
      name: 'invalid-cursor', value: { ...defaults, cursor: { maxRadius: 1000 } },
      error: /Maximum target radius must be between/,
    },
    {
      name: 'invalid-legacy-cursor',
      value: {
        schemaVersion: 1,
        physics: defaults.physics,
        cursor: { returnToHammer: 'yes', returnRate: 12, returnOffsetX: 0.35, returnOffsetY: -0.25 },
      },
      error: /retired return setting must be a boolean/i,
    },
    {
      name: 'invalid-legacy-offset',
      value: {
        schemaVersion: 1,
        physics: defaults.physics,
        cursor: { returnToHammer: true, returnRate: 12, returnOffsetX: 1000, returnOffsetY: -0.25 },
      },
      error: /Retired return offset X must be between/,
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
      const response = await fetch(`${address}@id/__x00__virtual:game-settings`);
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
    schemaVersion: 6, characterRiggingType: 'sprite-2d', armForwardDistance: 0.25,
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
    schemaVersion: 9, characterRiggingType: 'avatar-3d', armForwardDistance: 0.3,
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
      transform(code, id) { if ([SPRITES_MODULE, ALTERNATE_MODULE, MODELS_MODULE].includes(id)) modules.set(id, code); },
    }],
  });
  const outputs = (Array.isArray(release) ? release : [release]).flatMap(result => result.output);
  const glbs = outputs.filter(file => file.type === 'asset' && /character-[^/]+\.glb$/.test(file.fileName));
  assert.equal(glbs.length, 3, 'The avatar, hammer and pot GLBs must be separate hashed assets.');
  assert.equal(outputs.filter(file => file.type === 'asset' && /sprite-[^/]+\.png$/.test(file.fileName)).length, 2);
  const heroModels = heroProfile().models.map(model => model.source.slice(model.source.indexOf(',') + 1));
  assert.ok(outputs.filter(file => file.type === 'chunk').every(file => heroModels.every(model => !file.code.includes(model.slice(0, 4096)))),
    'Character GLB bytes must not be embedded in executable JavaScript.');
  assert.match(modules.get(ALTERNATE_MODULE), /schemaVersion:9,.*models:\[.*import\.meta\.ROLLUP_FILE_URL_.*avatar:.*hammer:.*pot:.*shading:/s);
  assert.match(modules.get(MODELS_MODULE), /createCharacterModelLoader/);
  const releaseModules = bundleModules(release);
  assert.ok(!releaseModules.some(id => id.includes('/src/editor/')), 'The character release contains no editor modules.');
  assert.ok(releaseModules.some(id => id.endsWith('/src/character-model-loader.ts')));
  const result = { assets: glbs.map(file => file.fileName), toggles: 0 };

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
    ['pot in schema 8', heroProfile({ schemaVersion: 8 }), /pot model requires sprite schema version 9/],
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

function customLevel(lift) {
  return {
    schemaVersion: 1,
    spawn: { position: { x: 11, y: lift + 6 }, angle: -0.4, extension: 0.3 },
    summit: { xMin: 8, xMax: 15, y: lift + 8, arrivalTolerance: 0.1 },
    labels: [{ x: 10, y: lift + 7, text: 'RELEASE_LEVEL_SENTINEL' }],
    objects: [{
      id: 'release-floor', shape: { type: 'box' }, x: 11, y: lift + 3,
      width: 20, height: 2, angle: 0, depth: 2, color: 0x71817a, illusion: false,
    }],
  };
}

function updraftLevel() {
  return {
    schemaVersion: 2, labels: [],
    objects: [
      { ...customLevel(0).objects[0], kind: 'terrain', x: 0, y: -1 },
      { kind: 'start', id: 'release-start', x: 0, y: 4, angle: 0, extension: 0.2 },
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
    schemaVersion: 2, labels: [],
    objects: [
      { ...customLevel(0).objects[0], kind: 'terrain', x: 0, y: -1 },
      { kind: 'start', id: 'release-start', x: 0, y: 0.53, angle: 0, extension: 0.2 },
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
    if (spriteRequests !== null && /\/sprite-[^/]+\.png$/.test(path)) spriteRequests.add(path);
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
      const outputs = Array.isArray(custom) ? custom : [custom];
      const code = outputs.flatMap(result => result.output.filter(file => file.type === 'chunk').map(file => file.code)).join('\n');
      assert.ok(code.includes('RELEASE_LEVEL_SENTINEL'));
      assert.ok(!/["']ascent["']/.test(code), 'A custom release must replace the built-in course.');
    }
    if (mode === 'sprites') {
      const source = `data:image/png;base64,${texturePng().toString('base64')}`;
      await writeFile(spritePath, JSON.stringify({
        schemaVersion: 1,
        images: [{ id: 'body', name: 'Generated body', source }, { id: 'alias', name: 'Shared source', source }],
        layers: [
          { id: 'body-card', name: 'Body card', anchor: 'pot', image: 'body', width: 1.2, height: 1,
            offset: { x: 0, y: 0, z: 0.6 }, rotation: 0, underlay: 'replace' },
          { id: 'head-card', name: 'Head card', anchor: 'character-head', image: 'alias', width: 0.4, height: 0.4,
            offset: { x: 0, y: 1.1, z: 0.6 }, rotation: 0, underlay: 'replace' },
        ],
      }));
      process.env.GAME_SPRITES = spritePath;
      const skin = await build({ configFile, logLevel: 'silent', build: { outDir: customOutput } });
      const outputs = (Array.isArray(skin) ? skin : [skin]).flatMap(result => result.output);
      assert.equal(outputs.filter(file => file.type === 'asset' && file.fileName.endsWith('.png')).length, 1,
        'Repeated PNG contents must share one hashed release asset.');
      assert.ok(outputs.filter(file => file.type === 'chunk').every(file => !file.code.includes(source)),
        'Uploaded PNG bytes must not be in executable JavaScript.');
      assert.ok(!bundleModules(skin).some(id => id.includes('/src/editor/') || id.includes('GLTFLoader')));
    }
    if (mode === 'flipbook') {
      const frames = Array.from({ length: FLIPBOOK_FRAMES }, (_, index) => ({
        id: `frame-${index}`, name: `Frame ${index}`, source: `data:image/png;base64,${solidPng(12, 16, index * 90).toString('base64')}`,
      }));
      const flipbook = {
        schemaVersion: 7, characterRiggingType: 'sprite-2d', armForwardDistance: 0.25,
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
      let virtualModule = null;
      const release = await build({
        configFile, logLevel: 'silent', build: { outDir: customOutput },
        plugins: [{
          name: 'release-flipbook-proof', enforce: 'pre',
          transform(code, id) { if (id === SPRITES_MODULE) virtualModule = code; },
        }],
      });
      const outputs = (Array.isArray(release) ? release : [release]).flatMap(result => result.output);
      assert.equal(outputs.filter(file => file.type === 'asset' && /sprite-[^/]+\.png$/.test(file.fileName)).length, FLIPBOOK_FRAMES,
        'Every flipbook frame must become its own hashed release asset.');
      assert.ok(virtualModule?.includes('schemaVersion:7,'), 'The release must embed the schema-7 flipbook document.');
      assert.deepEqual(JSON.parse(virtualModule.match(/layers:(\[.*\]),skeleton:/s)[1]), flipbook.layers,
        'GAME_SPRITES must carry the flipbook layer without loss.');
      assert.equal(virtualModule.match(/import\.meta\.ROLLUP_FILE_URL_/g).length, FLIPBOOK_FRAMES);
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
        flipbookRelease = { frames: FLIPBOOK_FRAMES, schemaVersion: 7, assets: [...spriteRequests] };
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
        const configModule = server.moduleGraph.getModuleById(join(root, 'src/config.ts'));
        assert.ok(viewModule && configModule);
        const sources = { view: viewModule.url, config: configModule.url };
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
