import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';
import { chromium } from 'playwright';
import { modelFixture } from './verify-appearance.mjs';
import { hammerGlb, HUMANOID_BONE_MAP, skinnedAvatarGlb } from './character-fixtures.mjs';
import { observeBrowserPage } from './verify-level.mjs';
import { openSection } from './workshop-ui.mjs';
import { wavFixture } from './project-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const gameConfig = join(root, 'vite.game.config.ts');
const workshopConfig = join(root, 'vite.config.ts');
const example = 'examples/projects/lantern-cavern';
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(artifacts, 'project-proof-'));
const projects = join(temporary, 'projects');
const releases = join(temporary, 'releases');
const report = { status: 'incomplete', errors: [], builds: {}, api: {}, editor: {}, performance: {} };
const GAME_VARIABLES = ['GAME_PROJECT', 'GAME_LEVEL', 'GAME_SETTINGS', 'GAME_SPRITES', 'GAME_ALTERNATE_SPRITES', 'GAME_TITLE', 'GAME_ART_MODE'];
const STUDIO_VARIABLES = ['STUDIO_PROJECTS', 'STUDIO_RELEASES', 'STUDIO_TOKEN', 'STUDIO_API'];
const saved = Object.fromEntries([...GAME_VARIABLES, ...STUDIO_VARIABLES].map((name) => [name, process.env[name]]));
process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true';
let browser;
const servers = [];

const glbData = (bytes) => `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`;
const bundleModules = (bundle) => (Array.isArray(bundle) ? bundle : [bundle]).flatMap((result) =>
  result.output.filter((file) => file.type === 'chunk').flatMap((file) => Object.keys(file.modules)));
const bundleAssets = (bundle) => (Array.isArray(bundle) ? bundle : [bundle]).flatMap((result) =>
  result.output.filter((file) => file.type === 'asset').map((file) => file.fileName));
const bundleHtml = (bundle) => (Array.isArray(bundle) ? bundle : [bundle]).flatMap((result) => result.output)
  .find((file) => file.fileName === 'index.html').source;

function setGameEnv(values) {
  for (const name of GAME_VARIABLES) delete process.env[name];
  Object.assign(process.env, values);
}

async function releaseBuild(values, options = {}) {
  setGameEnv(values);
  try {
    return await build({ configFile: gameConfig, logLevel: 'silent', build: { write: options.outDir !== undefined, outDir: options.outDir, emptyOutDir: true } });
  } finally {
    setGameEnv({});
  }
}

async function studio(env = {}) {
  for (const name of STUDIO_VARIABLES) delete process.env[name];
  Object.assign(process.env, { STUDIO_PROJECTS: relative(root, projects), STUDIO_RELEASES: relative(root, releases), STUDIO_TOKEN: '', ...env });
  const server = await createServer({ configFile: workshopConfig, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true } });
  await server.listen();
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.httpServer.address().port}` };
}

function client(base, defaults = {}) {
  return async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...defaults, ...headers } };
    if (method !== 'GET' && init.headers['X-Studio-Request'] === undefined) init.headers['X-Studio-Request'] = '1';
    if (init.headers['X-Studio-Request'] === null) delete init.headers['X-Studio-Request'];
    if (body !== undefined) {
      if (body instanceof Uint8Array) {
        init.body = body;
        init.headers['Content-Type'] ??= 'application/octet-stream';
      } else {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
      }
    }
    const response = await fetch(base + path, init);
    const type = response.headers.get('content-type') ?? '';
    return {
      status: response.status, etag: response.headers.get('etag'), headers: response.headers,
      value: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()),
    };
  };
}

// Node's fetch forbids a custom Host header, so DNS-rebinding requests go through http.request.
function rawRequest(base, path, headers) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: url.hostname, port: url.port, path, headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

function largeLevel(count) {
  const objects = [
    { kind: 'terrain', id: 'floor', shape: { type: 'box' }, x: 0, y: -1, width: 128, height: 2, angle: 0, depth: 3, color: 0x3b4046, illusion: false },
    { kind: 'start', id: 'start', x: 0, y: 0.65, angle: -0.42, extension: 0.2 },
  ];
  const shapes = ['box', 'ramp', 'triangle', 'circle', 'hexagon'];
  for (let index = 1; objects.length < count + 1; index++) {
    const type = shapes[index % shapes.length];
    objects.push({
      kind: 'terrain', id: `block-${index}`, shape: { type },
      x: (index % 40) * 3 - 60, y: 2 + Math.floor(index / 40) * 2.2, width: 1.4, height: type === 'circle' ? 1.4 : 0.6,
      angle: 0, depth: 1.2, color: 0x4f6b45, illusion: index % 17 === 0,
    });
  }
  return { schemaVersion: 2, labels: [], objects };
}

// A structurally valid GLB with nothing to draw, which the runtime loader refuses.
function emptyGlb() {
  let json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}

// The example's intro trigger greets the player at the start; close it like a player would.
async function dismissPopup(page) {
  const button = page.getByRole('button', { name: 'Continue', exact: true });
  try {
    await button.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    return false;
  }
  await button.click();
  await button.waitFor({ state: 'hidden' });
  return true;
}

async function examplePackage() {
  const manifest = JSON.parse(await readFile(join(root, example, 'project.json'), 'utf8'));
  const files = { 'project.json': manifest, 'level.json': JSON.parse(await readFile(join(root, example, 'level.json'), 'utf8')) };
  for (const entry of manifest.media) {
    const name = entry.path.slice('/media/'.length);
    files[`media/${name}`] = `data:audio/wav;base64,${(await readFile(join(root, example, 'media', name))).toString('base64')}`;
  }
  return { format: 'over-the-edge-project-bundle', schemaVersion: 1, files };
}

try {
  // 1. Standalone releases from project files --------------------------------------------------
  {
    const bundle = await releaseBuild({ GAME_PROJECT: example });
    const modules = bundleModules(bundle);
    const assets = bundleAssets(bundle);
    assert.ok(modules.some((id) => id.endsWith('/src/play.ts')));
    assert.ok(!modules.some((id) => id.includes('/src/editor/')), 'A project release contains no editor modules.');
    assert.ok(modules.some((id) => id.endsWith('/src/audio.ts')), 'A project with audio ships the audio director.');
    assert.ok(!modules.some((id) => id.includes('GLTFLoader') || id.endsWith('/src/appearance-loader.ts')),
      'A project without GLBs ships no model loader.');
    assert.equal(assets.filter((file) => file.endsWith('.wav')).length, 6, 'Every media file is emitted once.');
    assert.ok(assets.includes('favicon.svg') && !assets.some((file) => file.includes('skyward')), 'Project releases skip public/ media.');
    assert.match(bundleHtml(bundle), /<title>Lantern Cavern<\/title>/);
    assert.match(bundleHtml(bundle), /href="favicon\.svg"/);
    report.builds.directory = { modules: modules.length, assets: assets.length };

    const packed = join(temporary, 'lantern.project.json');
    await writeFile(packed, JSON.stringify(await examplePackage()));
    const fromBundle = await releaseBuild({ GAME_PROJECT: relative(root, packed) });
    assert.deepEqual(bundleAssets(fromBundle).sort(), assets.sort(), 'A bundle builds exactly like its directory.');
    report.builds.bundle = { identical: true };

    const defaults = await releaseBuild({});
    const defaultModules = bundleModules(defaults);
    assert.ok(!defaultModules.some((id) => id.endsWith('/src/audio.ts') || id.includes('GLTFLoader') || id.endsWith('/src/appearance-loader.ts')),
      'Releases without projects stay free of audio and model loaders.');
    assert.match(bundleHtml(defaults), /<title>Over the Edge<\/title>/);

    await assert.rejects(releaseBuild({ GAME_PROJECT: example, GAME_LEVEL: 'levels/skyward-ruins.json' }), /GAME_LEVEL cannot be combined with GAME_PROJECT/);
    await assert.rejects(releaseBuild({ GAME_PROJECT: example, GAME_TITLE: 'Other' }), /GAME_TITLE cannot be combined with GAME_PROJECT/);
    await assert.rejects(releaseBuild({ GAME_PROJECT: '..' }), /GAME_PROJECT must stay inside/);
    const broken = join(temporary, 'broken');
    await cp(join(root, example), broken, { recursive: true });
    const manifest = JSON.parse(await readFile(join(broken, 'project.json'), 'utf8'));
    await writeFile(join(broken, 'project.json'), JSON.stringify({ ...manifest, theme: { ...manifest.theme, sky: 'blue' } }));
    await assert.rejects(releaseBuild({ GAME_PROJECT: relative(root, broken) }), /theme: Sky colour must be a lowercase #rrggbb colour/);
    await writeFile(join(broken, 'project.json'), JSON.stringify({ ...manifest, media: manifest.media.filter((entry) => entry.path !== '/media/bell.wav') }));
    await assert.rejects(releaseBuild({ GAME_PROJECT: relative(root, broken) }), /uses \/media\/bell\.wav, which is not in the media library/);
    report.builds.rejected = ['per-file inputs', 'GAME_TITLE', 'outside path', 'invalid theme', 'missing media'];

    // The release applies the project: HUD, title, sounds and theme, with no editor globals.
    const output = join(temporary, 'lantern-release');
    await releaseBuild({ GAME_PROJECT: example }, { outDir: output });
    setGameEnv({ GAME_PROJECT: example });
    const server = await preview({ configFile: gameConfig, logLevel: 'silent', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
    setGameEnv({});
    browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await observeBrowserPage(page, report.errors);
    const media = [];
    page.on('request', (request) => { if (request.url().endsWith('.wav')) media.push(new URL(request.url()).pathname); });
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.event-presenter-popup, [role="dialog"]', { timeout: 10_000 });
      assert.equal(await page.title(), 'Lantern Cavern');
      assert.deepEqual(await page.locator('.play-hud dt').allTextContents(), ['DEPTH CLIMBED', 'LANTERN TIME']);
      assert.equal(await page.locator('.play-height-unit').textContent(), 'ft');
      assert.equal(await page.evaluate(() => typeof window.gettingOver), 'undefined');
      assert.equal(new Set(media).size, 6, 'The release preloads every project sound.');
      await page.screenshot({ path: join(artifacts, 'project-release.png') });
      // The cave theme's sky replaces the default pale green in the top-left corner.
      const pixel = await page.screenshot({ clip: { x: 640, y: 120, width: 1, height: 1 } });
      report.builds.release = { title: 'Lantern Cavern', sounds: new Set(media).size, sky: pixel.length > 0 };
    } finally {
      await page.close();
      await server.close();
    }
  }

  // 2. Projects with character profiles, appearance models and arm IK ---------------------------
  {
    const directory = join(temporary, 'characters');
    await cp(join(root, example), directory, { recursive: true });
    const manifest = JSON.parse(await readFile(join(directory, 'project.json'), 'utf8'));
    const hammer = { id: 'hammer', name: 'Mallet', source: glbData(hammerGlb()) };
    const avatar = { id: 'avatar', name: 'Hero', source: glbData(skinnedAvatarGlb()) };
    const primary = {
      schemaVersion: 8, characterRiggingType: 'model-3d', armForwardDistance: 0.3, images: [], layers: [], skeleton: null, presentation: null,
      models: [hammer], hammer: { model: 'hammer' },
    };
    const alternate = {
      schemaVersion: 8, characterRiggingType: 'avatar-3d', armForwardDistance: 0.25, images: [], layers: [], skeleton: null, presentation: null,
      models: [avatar], avatar: { model: 'avatar', boneMap: HUMANOID_BONE_MAP },
    };
    await mkdir(join(directory, 'characters'), { recursive: true });
    await mkdir(join(directory, 'appearance'), { recursive: true });
    await writeFile(join(directory, 'characters/primary.json'), JSON.stringify(primary));
    await writeFile(join(directory, 'characters/alternate.json'), JSON.stringify(alternate));
    await writeFile(join(directory, 'appearance/torso.glb'), modelFixture({ size: [0.6, 0.8, 0.4] }));
    await writeFile(join(directory, 'project.json'), JSON.stringify({
      ...manifest,
      characters: { primary: 'characters/primary.json', alternate: 'characters/alternate.json' },
      appearance: [{ part: 'torso', name: 'Armour.glb', alignment: { scale: 1.1, rotationX: 0, rotationY: 20, rotationZ: 0, offsetX: 0, offsetY: 0.05, offsetZ: 0 } }],
      armIk: { ...manifest.armIk, leftHintX: -0.9 },
    }));
    const bundle = await releaseBuild({ GAME_PROJECT: relative(root, directory) });
    const modules = bundleModules(bundle);
    const assets = bundleAssets(bundle);
    assert.ok(modules.some((id) => id.endsWith('/src/appearance-loader.ts')), 'Appearance models ship their loader.');
    assert.ok(modules.some((id) => id.endsWith('/src/character-model-loader.ts')));
    assert.ok(!modules.some((id) => id.includes('/src/editor/')));
    assert.equal(assets.filter((file) => /^assets\/torso-.*\.glb$/.test(file)).length, 1);
    assert.equal(assets.filter((file) => /^assets\/character-.*\.glb$/.test(file)).length, 2);
    const presentation = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((result) => result.output)
      .filter((file) => file.type === 'chunk').map((file) => file.code).join('\n');
    assert.ok(presentation.includes('-0.9'), 'The release embeds the project arm IK hints.');

    const output = join(temporary, 'characters-release');
    await releaseBuild({ GAME_PROJECT: relative(root, directory) }, { outDir: output });
    setGameEnv({ GAME_PROJECT: relative(root, directory) });
    const server = await preview({ configFile: gameConfig, logLevel: 'silent', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
    setGameEnv({});
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await observeBrowserPage(page, report.errors);
    const glbs = [];
    page.on('request', (request) => { if (request.url().endsWith('.glb')) glbs.push(new URL(request.url()).pathname); });
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelectorAll('input[name="play-character"]:not([disabled])').length === 2, null, { timeout: 15_000 });
      assert.equal(await page.locator('#fatal-error').isHidden(), true);
      assert.equal(new Set(glbs).size, 3, 'Both character models and the appearance model load.');
      await page.screenshot({ path: join(artifacts, 'project-characters-release.png') });
      report.builds.characters = { glbs: new Set(glbs).size, characterChoice: 2 };
    } finally {
      await page.close();
      await server.close();
    }
  }

  // 3. The project API --------------------------------------------------------------------------
  const { base } = await studio();
  const api = client(base);
  {
    const health = await api('GET', '/api/health');
    assert.deepEqual(health.value, { ok: true, api: 1, auth: 'loopback', authenticated: true });
    const manual = await api('GET', '/api');
    assert.ok(manual.value.endpoints.length > 20 && manual.value.sections.theme.fields.length > 20);
    assert.equal((await api('PUT', '/api/projects/lantern/bundle', await examplePackage())).status, 200);
    assert.equal((await api('POST', '/api/projects', { title: 'Blank Test' })).value.id, 'blank-test');
    assert.equal((await api('POST', '/api/projects', { title: 'Blank Test' })).value.id, 'blank-test-2');
    assert.equal((await api('POST', '/api/projects', { title: 'Blank Test', id: 'blank-test' })).status, 409);
    assert.deepEqual((await api('GET', '/api/projects')).value.projects.map((project) => project.id), ['blank-test', 'blank-test-2', 'lantern']);

    const theme = await api('GET', '/api/projects/lantern/theme');
    assert.equal(theme.value.sky, '#0e1418');
    const patched = await api('PATCH', '/api/projects/lantern/theme', { sky: '#101820' }, { 'If-Match': theme.etag });
    assert.equal(patched.status, 200);
    const stale = await api('PATCH', '/api/projects/lantern/theme', { sky: '#101821' }, { 'If-Match': theme.etag });
    assert.equal(stale.status, 412);
    assert.equal(stale.value.error.code, 'conflict');
    const invalid = await api('PUT', '/api/projects/lantern/hud', { height: {} });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.value.error.section, 'hud');
    assert.equal((await api('PATCH', '/api/projects/lantern/theme', {}, { 'X-Studio-Request': null })).status, 403);
    assert.equal((await api('PATCH', '/api/projects/lantern/theme', {}, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal(await rawRequest(base, '/api/projects', { Host: 'attacker.example' }), 403, 'Rebound hostnames are refused.');
    assert.equal((await api('GET', '/api/projects/..%2F..%2Fetc')).status, 400);
    // The dev server must not serve stored projects or releases as plain files around the API.
    assert.equal((await api('GET', `/${relative(root, projects)}/lantern/project.json`)).status, 403);
    assert.equal((await api('GET', `/@fs${projects}/lantern/level.json`)).status, 403);
    assert.equal((await api('GET', '/api/projects/lantern/media/..%2Fproject.json')).status, 400);

    // Level objects and referential integrity.
    const bell = { kind: 'trigger', id: 'bell-2', name: 'Bell', x: 1, y: 3, region: { type: 'circle', radius: 1 }, activation: 'once', marker: 'none', events: [{ type: 'play-sound', source: '/media/gong.wav', volume: 1 }] };
    assert.equal((await api('POST', '/api/projects/lantern/level/objects', bell)).status, 400);
    assert.equal((await api('PUT', '/api/projects/lantern/media/gong.wav', new Uint8Array(wavFixture({ frequency: 200 })))).status, 200);
    assert.equal((await api('PUT', '/api/projects/lantern/media/fake.wav', new Uint8Array(Buffer.from('<script>alert(1)</script>')))).status, 400);
    assert.equal((await api('POST', '/api/projects/lantern/level/objects', bell)).status, 200);
    assert.equal((await api('DELETE', '/api/projects/lantern/media/gong.wav')).status, 409);
    assert.equal((await api('PATCH', '/api/projects/lantern/level/objects/bell-2', { x: 2.5 })).status, 200);
    assert.equal((await api('GET', '/api/projects/lantern/level/objects/bell-2')).value.x, 2.5);
    assert.equal((await api('DELETE', '/api/projects/lantern/level/objects/start')).status, 409);
    assert.equal((await api('DELETE', '/api/projects/lantern/level/objects/bell-2')).status, 200);
    assert.equal((await api('DELETE', '/api/projects/lantern/media/gong.wav')).status, 200);
    const media = await api('GET', '/api/projects/lantern/media/bell.wav', undefined, { Range: 'bytes=0-11' });
    assert.equal(media.status, 206);
    assert.equal(media.value.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(media.headers.get('x-content-type-options'), 'nosniff');

    // Characters, appearance and settings.
    assert.equal((await api('PUT', '/api/projects/blank-test/characters/alternate', { schemaVersion: 6, characterRiggingType: 'model-3d', armForwardDistance: 0.25, images: [], layers: [], skeleton: null, presentation: null })).status, 409);
    assert.equal((await api('PATCH', '/api/projects/blank-test/characters/primary', { armForwardDistance: 0.6 })).status, 200);
    assert.equal((await api('PATCH', '/api/projects/blank-test/characters/primary', { shading: { mode: 'cel', bands: 4, outline: null } })).status, 200);
    assert.equal((await api('GET', '/api/projects/blank-test/characters/primary')).value.schemaVersion, 8, 'PATCH recomputes the schema version.');
    assert.equal((await api('PUT', '/api/projects/blank-test/appearance/torso/model?name=Armour.glb', new Uint8Array(modelFixture()))).status, 200);
    assert.equal((await api('PATCH', '/api/projects/blank-test/appearance/torso', { alignment: { scale: 1.5 } })).status, 200);
    assert.equal((await api('GET', '/api/projects/blank-test/appearance')).value[0].alignment.scale, 1.5);
    assert.equal((await api('PUT', '/api/projects/blank-test/appearance/torso/model', new Uint8Array(Buffer.from('not a glb at all, sorry')))).status, 400);
    const empty = await api('PUT', '/api/projects/blank-test/appearance/left-hand/model', new Uint8Array(emptyGlb()));
    assert.equal(empty.status, 400, 'A model the runtime would refuse is rejected on upload.');
    assert.match(empty.value.error.message, /1-128 meshes/);
    assert.equal((await api('PATCH', '/api/projects/blank-test/settings', { physics: { hammerMass: 99 } })).status, 400);
    assert.equal((await api('PATCH', '/api/projects/blank-test/settings', { physics: { hammerMass: 1.4 } })).status, 200);
    assert.deepEqual((await api('POST', '/api/projects/blank-test/validate')).value, { ok: true, problems: [] });

    // Bundles round-trip byte for byte.
    const exported = await api('GET', '/api/projects/lantern/bundle');
    assert.equal((await api('PUT', '/api/projects/lantern-copy/bundle', exported.value)).status, 200);
    assert.deepEqual((await api('GET', '/api/projects/lantern-copy/bundle')).value, exported.value);
    assert.equal((await api('DELETE', '/api/projects/lantern-copy')).status, 200);

    // Publishing builds the release and serves it for play-testing.
    const started = Date.now();
    const published = await api('POST', '/api/projects/lantern/publish');
    assert.equal(published.status, 200, JSON.stringify(published.value));
    assert.equal(published.value.url, '/play/lantern/');
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await observeBrowserPage(page, report.errors);
    try {
      await page.goto(`${base}/play/lantern/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.play-hud');
      assert.equal(await page.title(), 'Lantern Cavern');
      assert.equal(await page.evaluate(() => typeof window.gettingOver), 'undefined');
    } finally {
      await page.close();
    }
    assert.equal((await api('GET', '/play/lantern/.hidden')).status, 404);
    report.api = { sections: Object.keys(manual.value.sections).length, endpoints: manual.value.endpoints.length, publishMs: Date.now() - started, publishFiles: published.value.files };

    // A token-protected studio accepts only its token (or the session cookie it sets).
    const tokenStudio = await studio({ STUDIO_TOKEN: 'correct-horse-battery-staple' });
    const anonymous = client(tokenStudio.base);
    assert.equal((await anonymous('GET', '/api/projects')).status, 401);
    assert.deepEqual((await anonymous('GET', '/api/health')).value, { ok: true, api: 1, auth: 'token', authenticated: false });
    assert.equal((await client(tokenStudio.base, { Authorization: 'Bearer wrong-token-value-here' })('GET', '/api/projects')).status, 401);
    const authorized = client(tokenStudio.base, { Authorization: 'Bearer correct-horse-battery-staple' });
    assert.equal((await authorized('GET', '/api/projects')).status, 200);
    const session = await authorized('POST', '/api/session');
    const cookie = session.headers.get('set-cookie').split(';')[0];
    assert.equal((await client(tokenStudio.base, { Cookie: cookie })('GET', '/api/projects')).status, 200);
    report.api.token = { anonymous: 401, bearer: 200, cookie: 200 };
    await tokenStudio.server.close();
  }

  // 4. The Workshop swaps whole games through the Project tab ----------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    await observeBrowserPage(page, report.errors);
    const project = () => page.evaluate(() => window.gettingOver.gameProject());
    const idle = () => page.waitForFunction(() => window.gettingOver.gameProject().busy === null);
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.gameProject().server?.authenticated === true);
    await page.getByRole('tab', { name: 'Project', exact: true }).click();
    await page.locator('#project-list').selectOption('lantern');
    const opening = Date.now();
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.gameProject().binding?.id === 'lantern');
    await idle();
    report.performance.openExampleMs = Date.now() - opening;
    assert.ok(await dismissPopup(page), 'The opened project runs its own intro event.');
    const opened = await page.evaluate(() => ({
      title: window.gettingOver.gameProject().title,
      objects: window.gettingOver.level().definition.objects.length,
      grip: window.gettingOver.settings().physics.gripFriction,
      theme: window.gettingOver.level().rendering.theme,
      enemies: window.gettingOver.level().rendering.enemies.customArt,
      hud: document.querySelector('.height-metric .eyebrow').textContent,
      unit: document.querySelector('.metric-unit').textContent,
      dirty: window.gettingOver.gameProject().dirty,
      scene: document.querySelector('.game-ui').dataset.scene,
      ink: getComputedStyle(document.querySelector('.height-reading')).color,
    }));
    assert.deepEqual(opened, {
      title: 'Lantern Cavern', objects: 20, grip: 3.2, theme: { ...opened.theme, sky: '#101820' },
      enemies: ['bird', 'hollow-soldier'], hud: 'DEPTH CLIMBED', unit: 'ft', dirty: [],
      scene: 'dark', ink: 'rgb(238, 240, 230)',
    });
    await page.screenshot({ path: join(artifacts, 'project-workshop-dark.png') });

    // Editing in the Workshop and saving writes only the changed section.
    await openSection(page, 'project-theme');
    await page.locator('#project-theme-sky').evaluate((input) => { input.value = '#223344'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.deepEqual((await project()).dirty, ['theme']);
    assert.equal(await page.evaluate(() => window.gettingOver.level().rendering.theme.sky), '#223344');
    const before = (await api('GET', '/api/projects/lantern/revision')).value.sections;
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.gameProject().dirty.length === 0 && window.gettingOver.gameProject().busy === null);
    const after = (await api('GET', '/api/projects/lantern/revision')).value.sections;
    assert.equal((await api('GET', '/api/projects/lantern/theme')).value.sky, '#223344');
    assert.deepEqual(Object.keys(after).filter((name) => after[name] !== before[name]), ['theme']);

    // A server change that lands while the Workshop saves is still loaded afterwards.
    await page.locator('#project-theme-sky').evaluate((input) => { input.value = '#223345'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal((await api('PATCH', '/api/projects/lantern/hud', { timer: { label: 'LAMP TIME' } })).status, 200);
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.timer-label')?.textContent === 'LAMP TIME', null, { timeout: 10_000 });
    assert.equal((await api('GET', '/api/projects/lantern/theme')).value.sky, '#223345');

    // Changes made through the API (for example by a language model) appear live.
    assert.equal((await api('PATCH', '/api/projects/lantern/hud', { height: { label: 'ALTITUDE' } })).status, 200);
    await page.waitForFunction(() => document.querySelector('.height-metric .eyebrow')?.textContent === 'ALTITUDE', null, { timeout: 10_000 });
    assert.equal((await api('POST', '/api/projects/lantern/level/objects', {
      kind: 'terrain', id: 'api-ledge', shape: { type: 'box' }, x: -6, y: 4, width: 2, height: 0.5, angle: 0, depth: 1.2, color: 0x4f6b45, illusion: false,
    })).status, 200);
    await page.waitForFunction(() => window.gettingOver.level().definition.objects.some((object) => object.id === 'api-ledge'), null, { timeout: 10_000 });
    // A section changed on both sides is a conflict, not a silent overwrite.
    await page.locator('#project-theme-fog-color').evaluate((input) => { input.value = '#445566'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal((await api('PATCH', '/api/projects/lantern/theme', { exposure: 1.1 })).status, 200);
    await page.waitForFunction(() => window.gettingOver.gameProject().conflicts.includes('theme'), null, { timeout: 10_000 });
    assert.equal(await page.evaluate(() => window.gettingOver.level().rendering.theme.fog.color), '#445566');
    report.editor.liveSync = { hud: true, level: true, conflict: true };

    // Enemy art, media and the alternate character are project sections too.
    await openSection(page, 'project-enemies');
    await page.getByRole('button', { name: 'Use built-in art: Bird', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.gettingOver.level().rendering.enemies.customArt), ['hollow-soldier']);
    await openSection(page, 'project-media');
    const gong = join(temporary, 'Gong Sound.wav');
    await writeFile(gong, wavFixture({ frequency: 150, seconds: 0.5 }));
    await page.locator('#project-media-file').setInputFiles(gong);
    await page.waitForFunction(() => window.gettingOver.gameProject().media.some((item) => item.path === '/media/gong-sound.wav'));
    await openSection(page, 'project-characters');
    await page.getByRole('button', { name: 'Use current character as alternate', exact: true }).click();
    assert.ok((await project()).dirty.includes('characters/alternate'));
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.gameProject().dirty.length === 0 && window.gettingOver.gameProject().busy === null, null, { timeout: 15_000 });
    const stored = (await api('GET', '/api/projects/lantern')).value.manifest;
    assert.equal(stored.theme.fog.color, '#445566', 'Saving again overwrites a reported conflict.');
    assert.equal(stored.enemies.bird, null);
    assert.ok(stored.media.some((entry) => entry.path === '/media/gong-sound.wav'));
    assert.equal(stored.characters.alternate, 'characters/alternate.json');

    // Export the whole game, start a new one, and import it back.
    await openSection(page, 'project-file');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export project file', exact: true }).click()]);
    const exported = join(temporary, 'exported.project.json');
    await download.saveAs(exported);
    const exportedBundle = JSON.parse(await readFile(exported, 'utf8'));
    assert.equal(exportedBundle.format, 'over-the-edge-project-bundle');
    assert.ok(exportedBundle.files['media/gong-sound.wav'].startsWith('data:audio/wav;base64,'));
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.gameProject().binding === null && window.gettingOver.gameProject().busy === null);
    assert.equal(await page.evaluate(() => window.gettingOver.level().rendering.theme.sky), '#d8e3d6');
    assert.equal(await page.evaluate(() => window.gettingOver.level().definition.objects.length), 5);
    assert.equal(await page.evaluate(() => document.querySelector('.game-ui').dataset.scene), 'light');
    await page.locator('.project-file-input').setInputFiles(exported);
    await page.waitForFunction(() => window.gettingOver.gameProject().title === 'Lantern Cavern' && window.gettingOver.gameProject().busy === null);
    await dismissPopup(page);
    const imported = await page.evaluate(() => ({
      objects: window.gettingOver.level().definition.objects.length, sky: window.gettingOver.level().rendering.theme.sky,
      alternate: window.gettingOver.gameProject().alternate !== null, media: window.gettingOver.gameProject().media.length,
    }));
    assert.deepEqual(imported, { objects: 21, sky: '#223345', alternate: true, media: 7 });

    // Save it as a new server project and publish it from the Workshop.
    await openSection(page, 'project-server');
    await page.locator('#project-id').fill('lantern-remix');
    await page.getByRole('button', { name: 'Save as project ID', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.gameProject().binding?.id === 'lantern-remix' && window.gettingOver.gameProject().busy === null);
    await page.getByRole('button', { name: 'Publish standalone game', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.gameProject().publish?.id === 'lantern-remix', null, { timeout: 60_000 });
    assert.equal(await page.locator('.project-publish-status a').getAttribute('href'), '/play/lantern-remix/');
    await page.screenshot({ path: join(artifacts, 'project-workshop.png') });
    report.editor.flows = ['open', 'save', 'live sync', 'conflict', 'enemy art', 'media', 'alternate', 'export', 'new', 'import', 'save as', 'publish'];

    // Reloading reopens the server project the Workshop was working on.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.gameProject().binding?.id === 'lantern-remix' && window.gettingOver.gameProject().busy === null, null, { timeout: 15_000 });
    await dismissPopup(page);

    // Save as copies server-held media: the fork keeps working after its source is deleted.
    await page.getByRole('tab', { name: 'Project', exact: true }).click();
    await openSection(page, 'project-server');
    await page.locator('#project-id').fill('remix-fork');
    await page.getByRole('button', { name: 'Save as project ID', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.gameProject().binding?.id === 'remix-fork' && window.gettingOver.gameProject().busy === null);
    assert.equal((await api('DELETE', '/api/projects/lantern-remix')).status, 200);
    await openSection(page, 'project-file');
    const [forkDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export project file', exact: true }).click()]);
    const fork = JSON.parse(await readFile(await forkDownload.path(), 'utf8'));
    assert.ok(fork.files['media/gong-sound.wav'].startsWith('data:audio/wav;base64,'));
    await context.close();
  }

  // 5. Representative large levels stay responsive --------------------------------------------
  {
    const level = largeLevel(1000);
    const bundle = await examplePackage();
    bundle.files['level.json'] = level;
    bundle.files['project.json'] = { ...bundle.files['project.json'], title: 'Thousand Ledges' };
    let started = Date.now();
    const imported = await api('PUT', '/api/projects/thousand/bundle', bundle);
    assert.equal(imported.status, 200, JSON.stringify(imported.value));
    report.performance.importThousandMs = Date.now() - started;
    const edits = [];
    for (let index = 0; index < 10; index++) {
      started = Date.now();
      assert.equal((await api('PATCH', `/api/projects/thousand/level/objects/block-${index + 1}`, { x: -61 + index * 3 })).status, 200);
      edits.push(Date.now() - started);
    }
    report.performance.objectPatchMs = { max: Math.max(...edits), mean: edits.reduce((sum, value) => sum + value, 0) / edits.length };
    assert.ok(report.performance.objectPatchMs.mean < 250, `Object edits on a 1,000-object level take ${report.performance.objectPatchMs.mean} ms.`);

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await observeBrowserPage(page, report.errors);
    try {
      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.gettingOver?.gameProject().server?.authenticated === true, null, { timeout: 15_000 });
      await page.getByRole('tab', { name: 'Project', exact: true }).click();
      await page.locator('#project-list').selectOption('thousand');
      started = Date.now();
      await page.getByRole('button', { name: 'Open project', exact: true }).click();
      await page.waitForFunction(() => window.gettingOver.gameProject().binding?.id === 'thousand' && window.gettingOver.gameProject().busy === null, null, { timeout: 30_000 });
      report.performance.openThousandMs = Date.now() - started;
      const rendering = await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const stats = window.gettingOver.level().rendering;
        return { objects: window.gettingOver.level().definition.objects.length, calls: stats.calls, instances: stats.terrain.instances ?? null };
      });
      assert.equal(rendering.objects, 1001);
      report.performance.thousandRendering = rendering;
      // A remote edit to one object reaches the open Workshop as one incremental change: the
      // playtest continues, and only that object's terrain instance is rewritten.
      const commits = await page.evaluate(() => window.gettingOver.level().editor.commits);
      const time = await page.evaluate(() => window.gettingOver.snapshot().time);
      const writes = await page.evaluate(() => window.gettingOver.level().rendering.terrain.matrixWrites);
      assert.equal((await api('PATCH', '/api/projects/thousand/level/objects/block-500', { y: 60 })).status, 200);
      await page.waitForFunction(() => window.gettingOver.level().definition.objects.find((object) => object.id === 'block-500').y === 60, null, { timeout: 10_000 });
      report.performance.liveSyncCommits = await page.evaluate(() => window.gettingOver.level().editor.commits) - commits;
      report.performance.liveSyncMatrixWrites = await page.evaluate(() => window.gettingOver.level().rendering.terrain.matrixWrites) - writes;
      assert.equal(report.performance.liveSyncCommits, 1);
      assert.ok(report.performance.liveSyncMatrixWrites <= 2, `A remote one-object edit rewrote ${report.performance.liveSyncMatrixWrites} terrain matrices.`);
      assert.ok(await page.evaluate(() => window.gettingOver.snapshot().time) >= time, 'A remote level edit does not restart the attempt.');
      assert.ok(report.performance.openThousandMs < 15_000, `Opening a 1,000-object project took ${report.performance.openThousandMs} ms.`);
    } finally {
      await page.close();
    }
  }

  // 6. `npm run studio` serves the same API from the built Workshop ----------------------------
  {
    if (!existsSync(join(root, 'dist/index.html'))) await build({ configFile: workshopConfig, logLevel: 'silent' });
    for (const name of STUDIO_VARIABLES) delete process.env[name];
    Object.assign(process.env, { STUDIO_PROJECTS: relative(root, projects), STUDIO_RELEASES: relative(root, releases), STUDIO_TOKEN: '' });
    const server = await preview({ configFile: workshopConfig, logLevel: 'silent', preview: { host: '127.0.0.1', port: 0, strictPort: true } });
    try {
      const studioApi = client(`http://127.0.0.1:${server.httpServer.address().port}`);
      assert.equal((await studioApi('GET', '/api/health')).value.api, 1);
      assert.ok((await studioApi('GET', '/api/projects')).value.projects.some((entry) => entry.id === 'lantern'));
      assert.equal((await studioApi('GET', '/play/lantern/')).status, 200);
      report.api.preview = true;
    } finally {
      await server.close();
    }
  }

  assert.deepEqual(report.errors, [], 'Pages must not log errors.');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  for (const server of servers) await server.close().catch(() => {});
  await browser?.close();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await writeFile(join(artifacts, 'project-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'passed') await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, builds: report.builds, api: report.api, editor: report.editor, performance: report.performance, failure: report.failure }, null, 2));
}
