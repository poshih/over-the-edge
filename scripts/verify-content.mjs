// Content delivery: a game build's shell carries no content, its content loads only through the
// game's content access (here a test module with a signing backend and a CDN stand-in), every file
// is verified, and nothing about players reaches the engine. See docs/content-delivery.md.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import { observeBrowserPage } from './verify-level.mjs';
import { modelFixture } from './verify-appearance.mjs';
import { solidPng } from './verify-flipbook.mjs';
import { hammerGlb, HUMANOID_BONE_MAP, potGlb, skinnedAvatarGlb } from './character-fixtures.mjs';
import { wavFixture } from './project-fixtures.mjs';
import { releaseContent, shellCode } from './release-fixtures.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const configFile = join(root, 'vite.game.config.ts');
const GAME_VARIABLES = [
  'GAME_PROJECT', 'GAME_LEVEL', 'GAME_SETTINGS', 'GAME_SPRITES', 'GAME_ALTERNATE_SPRITES', 'GAME_TITLE', 'GAME_ART_MODE',
  'GAME_CONTENT_URL', 'GAME_MODULE',
];
const saved = Object.fromEntries(GAME_VARIABLES.map(name => [name, process.env[name]]));
const DIRECTIONS = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'];
// Chromium logs a console error for every refused request; refusal scenarios expect those.
const REFUSED_REQUEST = /Failed to load resource: the server responded with a status of 40[13]/;
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(artifacts, 'content-proof-'));
const report = { status: 'incomplete', errors: [] };
const closers = [];
let browser;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const dataUrl = (type, bytes) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function setGameEnv(values) {
  for (const name of GAME_VARIABLES) delete process.env[name];
  Object.assign(process.env, values);
}

async function releaseBuild(values, outDir, plugins = []) {
  setGameEnv(values);
  try {
    return await build({ configFile, logLevel: 'silent', build: { outDir, emptyOutDir: true, write: outDir !== undefined }, plugins });
  } finally {
    setGameEnv({});
  }
}

async function servePreview(outDir) {
  const server = await preview({ configFile, logLevel: 'silent', build: { outDir }, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  const close = () => new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  closers.push(close);
  return { address: `http://127.0.0.1:${server.httpServer.address().port}/`, close };
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function paperProfile() {
  const layer = (id, anchor, image, width, height) => ({
    id, name: id, anchor, image, width, height, offset: { x: 0, y: 0, z: 0.6 }, rotation: 0,
    bone: null, directions: DIRECTIONS, skin: null, tileLength: null,
  });
  return {
    schemaVersion: 12, characterRiggingType: 'sprite-2d', armForwardDistance: 0.25,
    grips: { placement: 'fixed', left: 0.04, right: 0.22, slideAt: 0.85 }, arms: null,
    images: [
      { id: 'body', name: 'Body', source: dataUrl('image/png', solidPng(16, 16, 20)) },
      { id: 'tool', name: 'Tool', source: dataUrl('image/png', solidPng(16, 16, 200)) },
    ],
    layers: [layer('pot-card', 'pot', 'body', 1, 0.8), layer('head-card', 'hammer-head', 'tool', 0.2, 0.58)],
    skeleton: null, presentation: null,
  };
}

function heroProfile() {
  return {
    schemaVersion: 12, characterRiggingType: 'avatar-3d', armForwardDistance: 0.3,
    grips: { placement: 'sliding', left: 0.04, right: 0.22, slideAt: 0.85 }, arms: null,
    images: [], layers: [], skeleton: null, presentation: null,
    models: [
      { id: 'avatar', name: 'Hero', source: dataUrl('model/gltf-binary', skinnedAvatarGlb()) },
      { id: 'hammer', name: 'Mallet', source: dataUrl('model/gltf-binary', hammerGlb()) },
      { id: 'pot', name: 'Urn', source: dataUrl('model/gltf-binary', potGlb()) },
    ],
    avatar: { model: 'avatar', boneMap: HUMANOID_BONE_MAP }, hammer: { model: 'hammer' }, pot: { model: 'pot' },
  };
}

// A project with every kind of content: level, settings, two profiles, appearance, course
// artwork, sounds, music and a video.
async function richProject() {
  const directory = join(temporary, 'rich');
  const example = JSON.parse(await readFile(join(root, 'examples/projects/lantern-cavern/project.json'), 'utf8'));
  for (const folder of ['characters', 'appearance', 'art', 'media']) await mkdir(join(directory, folder), { recursive: true });
  const slab = modelFixture({ size: [2, 1, 3] });
  const assetId = `asset-${sha256(slab)}`;
  await writeFile(join(directory, 'art', `${assetId}.glb`), slab);
  await writeFile(join(directory, 'appearance/torso.glb'), modelFixture({ size: [0.6, 0.8, 0.4] }));
  await writeFile(join(directory, 'media/bell.wav'), wavFixture({ frequency: 660 }));
  await writeFile(join(directory, 'media/loop.wav'), wavFixture({ frequency: 220, seconds: 1 }));
  await copyFile(join(root, 'public/media/skyward-ruins-intro.webm'), join(directory, 'media/intro.webm'));
  await writeFile(join(directory, 'characters/primary.json'), JSON.stringify(paperProfile()));
  await writeFile(join(directory, 'characters/alternate.json'), JSON.stringify(heroProfile()));
  await writeFile(join(directory, 'level.json'), JSON.stringify({
    schemaVersion: 3,
    labels: [{ x: 4, y: 6, text: 'CONTENT_LEVEL_SENTINEL' }],
    objects: [
      {
        kind: 'terrain', id: 'floor', shape: { type: 'box' }, x: 0, y: -0.5, width: 30, height: 1, angle: 0, depth: 2,
        color: 0x71817a, illusion: false, art: { assetId, mirror: 'none' },
      },
      { kind: 'start', id: 'start', x: 0, y: 0.53, angle: 0, reach: 1.7 },
      {
        kind: 'trigger', id: 'cinema', name: 'Cinema', x: 400, y: 400, region: { type: 'box', width: 2, height: 2 },
        activation: 'on-enter', marker: 'none',
        events: [{ type: 'play-sound', source: '/media/bell.wav', volume: 1 }, { type: 'play-video', source: '/media/intro.webm' }],
      },
    ],
  }));
  const cues = Object.fromEntries(Object.keys(example.audio.cues).map(cue => [cue, null]));
  await writeFile(join(directory, 'project.json'), JSON.stringify({
    ...example, title: 'Content Proof',
    art: { mode: 'meshes', assets: [{ id: assetId, name: 'Slab' }] },
    characters: { primary: 'characters/primary.json', alternate: 'characters/alternate.json' },
    appearance: [{ part: 'torso', name: 'Armour.glb', alignment: { scale: 1, rotationX: 0, rotationY: 0, rotationZ: 0, offsetX: 0, offsetY: 0, offsetZ: 0 } }],
    audio: { volume: 1, music: { source: '/media/loop.wav', volume: 0.3 }, cues: { ...cues, impact: { source: '/media/bell.wav', volume: 0.5 } } },
    media: [{ path: '/media/bell.wav' }, { path: '/media/intro.webm' }, { path: '/media/loop.wav' }],
  }));
  return relative(root, directory);
}

/**
 * A game's backend and CDN, reduced to what the grant contract needs. POST /grant answers as the
 * game's backend would after checking the player: signed URLs (or a cookie grant), or a refusal.
 * GET /cdn/<path> serves the content output only to requests it signed or that carry its cookie.
 */
async function contentStandIn(options) {
  const state = {
    grant: 'allow', stale: false, cdn: 'signed', tamper: null, latency: 0, lifetime: 60_000,
    urlBase: null, grants: [], requests: [], active: 0, maxActive: 0,
  };
  const sign = (path, expires) => createHmac('sha256', options.secret).update(`${path}\n${expires}`).digest('hex');
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://stand-in.invalid');
    const cors = {
      'Access-Control-Allow-Origin': request.headers.origin ?? '*', 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin',
    };
    const reply = (status, headers = {}, body = '') => { response.writeHead(status, { ...cors, ...headers }); response.end(body); };
    if (request.method === 'OPTIONS') {
      reply(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type, range' });
      return;
    }
    if (url.pathname === '/grant' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.grants.push({ group: body.group, paths: body.paths, refresh: body.refresh, cookie: request.headers.cookie ?? null });
      await sleep(Math.min(state.latency, 50));
      if (state.grant !== 'allow') {
        reply(state.grant === 'unauthenticated' ? 401 : 403, { 'Content-Type': 'application/json' }, '{}');
        return;
      }
      const expires = Date.now() + state.lifetime;
      // A stale grant carries signatures its CDN already treats as expired.
      const signed = state.stale && !body.refresh ? Date.now() - 1000 : expires;
      const base = state.urlBase ?? options.base();
      const urls = Object.fromEntries(body.paths.map(path => [path, state.cdn === 'cookie'
        ? `${base}/cdn/${path}` : `${base}/cdn/${path}?expires=${signed}&sig=${sign(path, signed)}`]));
      reply(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'cdn-session=granted; Path=/; SameSite=Lax' },
        JSON.stringify({ urls, expires, credentials: state.cdn === 'cookie' ? 'include' : 'omit' }));
      return;
    }
    if (url.pathname.startsWith('/cdn/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const path = url.pathname.slice('/cdn/'.length);
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        await sleep(state.latency);
        const entry = { path, cookie: request.headers.cookie ?? null, signed: url.searchParams.has('sig'), status: 200, at: Date.now() };
        state.requests.push(entry);
        const expires = Number(url.searchParams.get('expires'));
        const refused = state.cdn === 'deny' ? 403
          : state.cdn === 'cookie' ? (/(^|; )cdn-session=granted(;|$)/.test(request.headers.cookie ?? '') ? 0 : 401)
            : !entry.signed ? 401 : expires <= Date.now() ? 401 : url.searchParams.get('sig') !== sign(path, expires) ? 403 : 0;
        if (refused !== 0) {
          entry.status = refused;
          reply(refused);
          return;
        }
        let bytes;
        try {
          bytes = await readFile(join(options.directory(), ...path.split('/')));
        } catch {
          entry.status = 404;
          reply(404);
          return;
        }
        if (state.tamper?.path === path) {
          bytes = Buffer.from(bytes);
          if (state.tamper.kind === 'grow') bytes = Buffer.concat([bytes, Buffer.from([0])]);
          else bytes[Math.floor(bytes.length / 2)] ^= 0xff;
        }
        reply(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) }, request.method === 'HEAD' ? '' : bytes);
      } finally {
        state.active--;
      }
      return;
    }
    reply(404);
  });
  const base = await listen(server);
  closers.push(() => new Promise(resolve => server.close(resolve)));
  return { base, state, reset() { Object.assign(state, { grant: 'allow', stale: false, cdn: 'signed', tamper: null, latency: 0, urlBase: null, grants: [], requests: [], maxActive: 0 }); } };
}

// A downstream game's module: it asks its backend for grants and records what the release tells it,
// for this test only.
async function writeModule(name, backend, extra = '') {
  const path = join(temporary, `${name}.ts`);
  const engine = relative(temporary, join(root, 'src/release-module')).split('\\').join('/');
  await writeFile(path, `import { ContentError } from '${engine}';
import type { ContentAccess, ReleaseHost, ReleaseModule } from '${engine}';
${extra}
export async function start(host: ReleaseHost): Promise<ReleaseModule> {
  const proof = { grants: [] as unknown[], failures: [] as unknown[], progress: [] as unknown[], ready: false, readyAt: 0,
    contentUrl: host.contentUrl, retry: () => {}, giveUp: (_error: Error) => {} };
  (window as unknown as { contentProof: typeof proof }).contentProof = proof;
  const access: ContentAccess = {
    async grant(request, signal) {
      proof.grants.push({ group: request.group, paths: request.paths.length, refresh: request.refresh });
      const response = await fetch('${backend}/grant', {
        method: 'POST', body: JSON.stringify(request), headers: { 'Content-Type': 'application/json' }, credentials: 'include', signal,
      });
      if (response.status === 401) throw new ContentError('unauthenticated', 'Sign in to play.');
      if (response.status === 403) throw new ContentError('denied', 'This account does not own the game.');
      const answer = await response.json();
      return { urls: new Map(Object.entries(answer.urls)), credentials: answer.credentials, expires: answer.expires };
    },
  };
  return {
    access,
    progress(state) { proof.progress.push(state); },
    failed(error) {
      proof.failures.push({ name: error.name, code: error.code, message: error.message, group: error.group, path: error.path });
      return new Promise<void>((resolve, reject) => { proof.retry = resolve; proof.giveUp = reject; });
    },
    ready() { proof.ready = true; proof.readyAt = performance.now(); },
  };
}
`);
  return relative(root, path);
}

async function newPage(errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await observeBrowserPage(page, errors);
  closers.push(() => context.close());
  return page;
}

const proof = page => page.evaluate(() => {
  const value = window.contentProof;
  return value === undefined ? null : { ...value, retry: undefined, giveUp: undefined };
});
const running = page => page.waitForFunction(() => document.querySelector('.elapsed-value')?.textContent !== '00:00', null, { timeout: 20_000 });

// Browser storage after a session: nothing about content or grants may be kept.
async function storage(page) {
  return page.evaluate(async () => ({
    local: Object.entries(localStorage), session: Object.entries(sessionStorage),
    caches: await caches.keys(), databases: (await indexedDB.databases()).map(database => database.name),
  }));
}

function assertNoGrantUrls(texts, standIn) {
  for (const text of texts) {
    assert.ok(!text.includes(standIn.base) && !/sig=|expires=/.test(text), `No grant URL may appear in "${text.slice(0, 160)}".`);
  }
}

async function verifyShell(project) {
  const output = join(temporary, 'rich-release');
  const bundle = await releaseBuild({ GAME_PROJECT: project }, output);
  const { files, manifest, manifestPath } = await releaseContent(output);
  const shell = [];
  for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) shell.push({ name: relative(output, join(entry.parentPath, entry.name)), bytes: await readFile(join(entry.parentPath, entry.name)) });
  }
  assert.deepEqual(shell.map(file => file.name).filter(name => !/^(index\.html|favicon\.svg|assets\/[\w.-]+\.(js|css))$/.test(name)), [],
    'The shell holds only its page, code, styles and icon.');
  const code = shellCode(bundle);
  for (const [path, bytes] of files) {
    if (path.endsWith('.json')) continue;
    const middle = bytes.subarray(Math.floor(bytes.length / 2) - 24, Math.floor(bytes.length / 2) + 24);
    assert.ok(shell.every(file => !file.bytes.includes(middle)), `Content ${path} must not be in any shell file.`);
    assert.ok(!code.includes(bytes.subarray(0, 3000).toString('base64').slice(0, 2000)), `Content ${path} must not be embedded in the shell.`);
  }
  for (const [label, value] of [['level', 'CONTENT_LEVEL_SENTINEL'], ['settings', JSON.stringify(manifest.settings.physics)],
    ['profile', JSON.stringify(manifest.characters.primary.layers)], ['HUD', manifest.hud.timer.label]]) {
    assert.ok(!code.includes(value), `The ${label} is content, not shell code.`);
  }
  const kinds = [...files.keys()].map(path => path.slice(path.lastIndexOf('.') + 1));
  for (const kind of ['json', 'png', 'glb', 'wav', 'webm']) assert.ok(kinds.includes(kind), `The rich release packages ${kind} content.`);
  report.shell = { files: shell.length, content: files.size, kinds: [...new Set(kinds)].sort() };
  return { output, files, manifest, manifestPath };
}

async function verifySignedRelease(project, rich) {
  const secret = randomBytes(16).toString('hex');
  let cdnBase = '';
  const standIn = await contentStandIn({ secret, base: () => cdnBase, directory: () => `${rich.output}-content` });
  cdnBase = standIn.base;
  const module = await writeModule('signed-module', standIn.base);
  const output = join(temporary, 'signed-release');
  await releaseBuild({ GAME_PROJECT: project, GAME_MODULE: module, GAME_CONTENT_URL: `${standIn.base}/cdn/` }, output);
  assert.deepEqual((await releaseContent(output)).files, rich.files, 'The content URL and module leave the content unchanged.');
  const shell = await servePreview(output);
  const errors = [];
  const page = await newPage(errors);
  const result = {};

  // Signed URLs: one grant for the game group; every request is one the backend signed.
  await page.goto(shell.address, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.contentProof?.ready === true, null, { timeout: 20_000 });
  await running(page);
  let state = await proof(page);
  assert.equal(state.contentUrl, `${standIn.base}/cdn/`);
  assert.deepEqual(standIn.state.grants.map(grant => [grant.group, grant.refresh]), [['game', false]], 'One grant covers the game group.');
  const granted = new Set(standIn.state.grants.flatMap(grant => grant.paths));
  assert.deepEqual(granted, new Set(rich.files.keys()), 'The grant names every game file.');
  assert.ok(standIn.state.requests.length >= 9 && standIn.state.requests.every(entry => entry.status === 200 && entry.signed && granted.has(entry.path)));
  assert.ok(standIn.state.requests.every(entry => entry.cookie === null), 'Signed grants send no cookies, although the CDN host set one.');
  assert.ok(!standIn.state.requests.some(entry => entry.path.endsWith('.webm')), 'A video streams only when it plays.');
  const last = state.progress.at(-1);
  assert.ok(state.progress.length > 1 && last.loaded === last.total && last.total > 0, 'The module sees load progress.');
  assert.deepEqual(await storage(page), { local: [], session: [], caches: [], databases: [] }, 'Content and grants are kept in memory only.');
  result.signed = { requests: standIn.state.requests.length, grants: standIn.state.grants.length, progress: state.progress.length };

  // An expired grant is renewed once, however many downloads it failed.
  standIn.reset();
  standIn.state.stale = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.contentProof?.ready === true, null, { timeout: 20_000 });
  assert.deepEqual(standIn.state.grants.map(grant => grant.refresh), [false, true], 'An expired grant is refreshed exactly once.');
  assert.equal(standIn.state.requests.filter(entry => entry.status === 401).length, 1, 'Only the manifest met the stale grant.');
  result.refresh = { grants: standIn.state.grants.length, refused: 1 };

  // A refusal reaches the module; nothing loads until it retries after "sign-in".
  standIn.reset();
  standIn.state.grant = 'unauthenticated';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.contentProof?.failures.length === 1, null, { timeout: 20_000 });
  state = await proof(page);
  assert.deepEqual(state.failures.map(failure => [failure.name, failure.code, failure.group]), [['ContentError', 'unauthenticated', 'game']]);
  await sleep(500);
  assert.equal(standIn.state.requests.length, 0, 'Nothing loads while access is refused.');
  assert.equal(standIn.state.grants.length, 1);
  assert.equal(await page.locator('.play-hud').count(), 0);
  standIn.state.grant = 'allow';
  await page.evaluate(() => window.contentProof.retry());
  await page.waitForFunction(() => window.contentProof?.ready === true, null, { timeout: 20_000 });
  await running(page);
  result.refusal = { retried: true };

  // A denied player gives up; the release shows the module's reason, with no grant URL anywhere.
  standIn.reset();
  standIn.state.grant = 'denied';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.contentProof?.failures.length === 1);
  state = await proof(page);
  assert.equal(state.failures[0].code, 'denied');
  await page.evaluate(() => window.contentProof.giveUp(new Error('The player closed the store.')));
  await page.waitForFunction(() => !document.querySelector('#fatal-error').hidden);
  assert.equal(await page.locator('#fatal-error').textContent(), 'The game could not load: The player closed the store.');

  // The CDN refuses: after one renewal the refusal is typed, and names content by path, never URL.
  standIn.reset();
  standIn.state.cdn = 'deny';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.contentProof?.failures.length === 1);
  state = await proof(page);
  assert.deepEqual([state.failures[0].code, state.failures[0].path], ['denied', rich.manifestPath]);
  assert.deepEqual(standIn.state.grants.map(grant => grant.refresh), [false, true]);
  await page.evaluate(() => window.contentProof.giveUp(new Error('Access ended.')));
  assertNoGrantUrls([...state.failures.map(failure => failure.message), await page.locator('body').innerText()], standIn);
  result.denied = { typed: true, renewedOnce: true };

  // Integrity: a changed manifest or file is rejected before parsing, and the game never starts.
  const png = [...rich.files.keys()].find(path => path.endsWith('.png'));
  for (const tamper of [{ path: rich.manifestPath, kind: 'flip' }, { path: png, kind: 'flip' }, { path: png, kind: 'grow' }]) {
    standIn.reset();
    standIn.state.tamper = tamper;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.contentProof?.failures.length === 1, null, { timeout: 20_000 });
    state = await proof(page);
    assert.deepEqual([state.failures[0].code, state.failures[0].path], ['integrity', tamper.path], `A ${tamper.kind} of ${tamper.path} is rejected.`);
    assert.equal(state.ready, false);
    assert.equal(await page.locator('.play-hud').count(), 0, 'The game never starts on changed content.');
  }
  result.integrity = ['manifest', 'image', 'size'];

  // Cookie grants: the CDN authorizes by cookie, and only those requests carry it.
  standIn.reset();
  standIn.state.cdn = 'cookie';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.contentProof?.ready === true, null, { timeout: 20_000 });
  assert.ok(standIn.state.requests.length > 0 && standIn.state.requests.every(entry => entry.status === 200 && /cdn-session=granted/.test(entry.cookie ?? '')));
  result.cookies = { requests: standIn.state.requests.length };

  // A grant may point anywhere: the adapter serves the group from a second host.
  let secondBase = '';
  const second = await contentStandIn({ secret, base: () => secondBase, directory: () => `${rich.output}-content` });
  secondBase = second.base;
  standIn.reset();
  standIn.state.urlBase = second.base;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.contentProof?.ready === true, null, { timeout: 20_000 });
  assert.equal(standIn.state.requests.length, 0);
  assert.ok(second.state.requests.length >= 9 && second.state.requests.every(entry => entry.status === 200));
  result.secondHost = { requests: second.state.requests.length };
  assert.deepEqual(await storage(page), { local: [], session: [], caches: [], databases: [] });
  assert.deepEqual(errors.filter(error => !REFUSED_REQUEST.test(error)), [], 'Signed releases log no errors besides refused requests.');
  return result;
}

// Two builds that differ only in their content URL write identical content, and each plays from its host.
async function verifyPublicHosts() {
  const staticHost = async directory => {
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://host.invalid').pathname.slice(1);
      try {
        const bytes = await readFile(join(directory(), ...path.split('/')));
        response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Length': String(bytes.length) });
        response.end(bytes);
      } catch {
        response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        response.end();
      }
    });
    const base = await listen(server);
    closers.push(() => new Promise(resolve => server.close(resolve)));
    return base;
  };
  const outputs = [join(temporary, 'host-a'), join(temporary, 'host-b')];
  const hosts = [await staticHost(() => `${outputs[0]}-content`), await staticHost(() => `${outputs[1]}-content`)];
  const level = join(temporary, 'hosts-level.json');
  await writeFile(level, JSON.stringify({
    schemaVersion: 3, labels: [{ x: 1, y: 5, text: 'HOSTS' }],
    objects: [
      { kind: 'terrain', id: 'floor', shape: { type: 'box' }, x: 0, y: -1, width: 20, height: 2, angle: 0, depth: 2, color: 0x71817a, illusion: false },
      { kind: 'start', id: 'start', x: 0, y: 0.53, angle: 0, reach: 1.7 },
    ],
  }));
  for (const [index, output] of outputs.entries()) {
    await releaseBuild({ GAME_LEVEL: relative(root, level), GAME_CONTENT_URL: `${hosts[index]}/` }, output);
  }
  const [a, b] = [await releaseContent(outputs[0]), await releaseContent(outputs[1])];
  assert.deepEqual(a.files, b.files, 'Content does not depend on where it is served.');
  const errors = [];
  const page = await newPage(errors);
  const result = [];
  for (const [index, output] of outputs.entries()) {
    const shell = await servePreview(output);
    const requests = [];
    const record = request => { if (request.url().startsWith(hosts[index])) requests.push(request); };
    page.on('request', record);
    await page.goto(shell.address, { waitUntil: 'networkidle' });
    await running(page);
    page.off('request', record);
    assert.equal(requests.length, 1, 'The release loads its manifest from its own host.');
    assert.equal((await requests[0].allHeaders()).cookie, undefined);
    result.push({ host: index, requests: requests.length });
    await shell.close();
  }
  // Public access sends no cookies to the content URL, even to the shell's own origin.
  const same = join(temporary, 'host-same');
  await releaseBuild({ GAME_LEVEL: relative(root, level) }, same);
  const shell = await servePreview(same);
  await page.goto(shell.address, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.cookie = 'player=someone; path=/'; });
  const requests = [];
  const record = request => { if (new URL(request.url()).pathname.startsWith('/content/')) requests.push(request); };
  page.on('request', record);
  await page.reload({ waitUntil: 'networkidle' });
  await running(page);
  page.off('request', record);
  assert.equal(requests.length, 1);
  assert.equal((await requests[0].allHeaders()).cookie, undefined, 'Public access sends no cookies with content requests.');
  assert.deepEqual(errors, []);
  return { hosts: result, identical: true, cookieless: true };
}

async function verifyPackagedOnly(project) {
  const directory = join(root, project);
  const manifest = JSON.parse(await readFile(join(directory, 'project.json'), 'utf8'));
  const level = JSON.parse(await readFile(join(directory, 'level.json'), 'utf8'));
  const paper = JSON.parse(await readFile(join(directory, 'characters/primary.json'), 'utf8'));
  const remote = 'https://cdn.example.invalid/outside.webm';
  const variants = [
    ['level event', 'level.json', { ...level, objects: level.objects.map(object => object.kind !== 'trigger' ? object
      : { ...object, events: [{ type: 'play-video', source: remote }] }) }, /The level plays https:\/\/cdn\.example\.invalid\/outside\.webm/],
    ['audio', 'project.json', { ...manifest, audio: { ...manifest.audio, music: { source: 'https://cdn.example.invalid/music.wav', volume: 1 } } },
      /The audio plays https:\/\/cdn\.example\.invalid\/music\.wav/],
    ['profile image', 'characters/primary.json', { ...paper, images: paper.images.map((image, index) => index === 0
      ? { ...image, source: 'https://cdn.example.invalid/body.png' } : image) }, /image "Body" is https:\/\/cdn\.example\.invalid\/body\.png/],
  ];
  const results = [];
  for (const [name, file, value, error] of variants) {
    const copy = join(temporary, `packaged-${results.length}`);
    await exec('cp', ['-r', directory, copy]);
    await writeFile(join(copy, file), JSON.stringify(value));
    await assert.rejects(releaseBuild({ GAME_PROJECT: relative(root, copy) }), error, `An external ${name} source fails the build, naming it.`);
    results.push(name);
  }
  return results;
}

async function verifyPerformance() {
  const levelPath = join(temporary, 'large-level.json');
  const assignmentsPath = join(temporary, 'large-assignments.json');
  const packagePath = join(temporary, 'large-course.json');
  const objects = [
    { kind: 'terrain', id: 'floor', shape: { type: 'box' }, x: 0, y: -0.5, width: 40, height: 1, angle: 0, depth: 1, color: 0x71817a, illusion: false },
    ...Array.from({ length: 999 }, (_, index) => ({
      kind: 'terrain', id: `box-${index}`, shape: { type: 'box' }, x: (index % 20 - 10) * 2, y: (Math.floor(index / 20) + 1) * 12,
      width: 0.9, height: 0.9, angle: 0, depth: 1, color: 0x71817a, illusion: false,
    })),
    { kind: 'start', id: 'start', x: 0, y: 0.53, angle: 0, reach: 1.7 },
  ];
  const meshes = 8;
  const assignments = {};
  for (let index = 0; index < meshes; index++) {
    await writeFile(join(temporary, `mesh-${index}.glb`), modelFixture({ size: [1 + index * 0.1, 1, 1] }));
  }
  objects.filter(object => object.kind === 'terrain').forEach((object, index) => { assignments[object.id] = `mesh-${index % meshes}.glb`; });
  await writeFile(levelPath, JSON.stringify({ schemaVersion: 3, labels: [], objects }));
  await writeFile(assignmentsPath, JSON.stringify(assignments));
  await exec(process.execPath, [join(root, 'scripts/pack-course.mjs'), levelPath, assignmentsPath, packagePath, '--mode=meshes'], { cwd: root });
  const images = Array.from({ length: 12 }, (_, index) => ({ id: `image-${index}`, name: `Image ${index}`, source: dataUrl('image/png', solidPng(16, 16, index * 20)) }));
  const spritesPath = join(temporary, 'many-images.json');
  await writeFile(spritesPath, JSON.stringify({
    ...paperProfile(), images,
    layers: images.map((image, index) => ({
      id: `layer-${index}`, name: `Layer ${index}`, anchor: 'pot', image: image.id, width: 0.4, height: 0.4,
      offset: { x: (index % 4) * 0.1, y: Math.floor(index / 4) * 0.1, z: 0.6 }, rotation: 0,
      bone: null, directions: DIRECTIONS, skin: null, tileLength: null,
    })),
  }));
  const output = join(temporary, 'large-release');
  let base = '';
  const standIn = await contentStandIn({ secret: randomBytes(16).toString('hex'), base: () => base, directory: () => `${output}-content` });
  base = standIn.base;
  const module = await writeModule('large-module', standIn.base);
  await releaseBuild({ GAME_LEVEL: relative(root, packagePath), GAME_SPRITES: relative(root, spritesPath), GAME_MODULE: module, GAME_CONTENT_URL: `${base}/cdn/` }, output);
  const { files } = await releaseContent(output);
  assert.equal(files.size, meshes + images.length + 1);
  const shell = await servePreview(output);
  const errors = [];
  const page = await newPage(errors);
  const boot = async latency => {
    standIn.reset();
    standIn.state.latency = latency;
    await page.goto('about:blank');
    await page.goto(shell.address, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.contentProof?.ready === true, null, { timeout: 60_000 });
    const { readyAt } = await proof(page);
    return { readyAt, grants: standIn.state.grants.map(grant => [grant.group, grant.refresh]), maxActive: standIn.state.maxActive, requests: standIn.state.requests.length };
  };
  await boot(0);
  const immediate = await boot(0);
  const latency = 150;
  const delayed = await boot(latency);
  assert.deepEqual(delayed.grants, [['game', false]], 'The large course makes one grant request.');
  assert.equal(delayed.requests, files.size);
  assert.ok(delayed.maxActive >= 3 && delayed.maxActive <= 6, `Downloads run in parallel, at most six at a time (${delayed.maxActive}).`);
  const waves = Math.ceil((files.size - 1) / 6);
  const added = delayed.readyAt - immediate.readyAt;
  // The grant and the manifest come first; the files follow in parallel waves, not one by one.
  assert.ok(added < (2 + waves) * latency + 600, `Latency adds ${Math.round(added)} ms, beyond the grant, manifest and ${waves} waves.`);
  assert.ok(added < files.size * latency * 0.6, `Latency adds ${Math.round(added)} ms, close to sequential downloads.`);
  // Verification stays off the frame loop: play makes no further requests.
  const before = standIn.state.requests.length;
  await running(page);
  await sleep(1500);
  assert.equal(standIn.state.requests.length, before, 'Play makes no content requests.');
  assert.deepEqual(errors, []);
  return { files: files.size, maxActive: delayed.maxActive, readyMs: { immediate: Math.round(immediate.readyAt), delayed: Math.round(delayed.readyAt) }, addedMs: Math.round(added) };
}

// A video streams from its grant URL when its event plays, as a CORS request without cookies.
async function verifyVideo() {
  const level = join(temporary, 'video-level.json');
  const video = '/media/skyward-ruins-intro.webm';
  await writeFile(level, JSON.stringify({
    schemaVersion: 3, labels: [],
    objects: [
      { kind: 'terrain', id: 'floor', shape: { type: 'box' }, x: 0, y: -1, width: 20, height: 2, angle: 0, depth: 2, color: 0x71817a, illusion: false },
      { kind: 'start', id: 'start', x: 0, y: 0.53, angle: 0, reach: 1.7 },
      {
        kind: 'trigger', id: 'opening', name: 'Opening', x: 0, y: 0.6, region: { type: 'box', width: 4, height: 4 },
        activation: 'on-enter', marker: 'none', events: [{ type: 'play-video', source: video }],
      },
    ],
  }));
  const output = join(temporary, 'video-release');
  let base = '';
  const standIn = await contentStandIn({ secret: randomBytes(16).toString('hex'), base: () => base, directory: () => `${output}-content` });
  base = standIn.base;
  const module = await writeModule('video-module', standIn.base);
  await releaseBuild({ GAME_LEVEL: relative(root, level), GAME_MODULE: module, GAME_CONTENT_URL: `${base}/cdn/` }, output);
  const { files, manifest } = await releaseContent(output);
  const packaged = manifest.media[video].slice('content:'.length);
  assert.ok(files.has(packaged), 'A level\'s public/media/ video is packaged as content.');
  const shell = await servePreview(output);
  const errors = [];
  const page = await newPage(errors);
  await page.goto(shell.address, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (document.querySelector('video.event-presenter-video')?.readyState ?? 0) >= 1, null, { timeout: 20_000 });
  const element = await page.evaluate(() => {
    const player = document.querySelector('video.event-presenter-video');
    return { crossOrigin: player.crossOrigin, signed: new URL(player.src).searchParams.has('sig') };
  });
  assert.deepEqual(element, { crossOrigin: 'anonymous', signed: true });
  const streamed = standIn.state.requests.filter(entry => entry.path === packaged);
  assert.ok(streamed.length > 0 && streamed.every(entry => entry.signed && entry.status === 200 && entry.cookie === null));
  assert.equal(standIn.state.grants.length, 1, 'The video streams on the game group\'s grant.');
  assert.deepEqual(errors, []);
  return { streamedRequests: streamed.length };
}

// Pages served over plain HTTP to another machine have no WebCrypto; verification still runs.
async function verifyInsecureContext() {
  const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;
  if (address === undefined) return { skipped: 'no non-loopback address' };
  const output = join(temporary, 'host-same');
  const server = await preview({ configFile, logLevel: 'silent', build: { outDir: output }, preview: { host: '0.0.0.0', port: 0, strictPort: true } });
  closers.push(() => new Promise(resolve => server.httpServer.close(resolve)));
  const errors = [];
  const page = await newPage(errors);
  await page.goto(`http://${address}:${server.httpServer.address().port}/`, { waitUntil: 'networkidle' });
  await running(page);
  assert.deepEqual(await page.evaluate(() => [window.isSecureContext, typeof crypto.subtle]), [false, 'undefined']);
  assert.deepEqual(errors, []);
  return { secure: false, verified: true };
}

async function verifyBoundary() {
  let moduleCode = null;
  const plain = await releaseBuild({}, undefined, [{
    name: 'module-proof', enforce: 'pre', transform(code, id) { if (id === '\0virtual:game-module') moduleCode = code; },
  }]);
  const modules = (Array.isArray(plain) ? plain : [plain]).flatMap(result => result.output.filter(file => file.type === 'chunk')
    .flatMap(file => Object.keys(file.modules)));
  assert.equal(moduleCode, 'export default null;');
  assert.ok(!modules.some(id => id.includes('content-proof-')), 'Without GAME_MODULE the shell has no downstream code.');
  const editorModule = await writeModule('editor-module', 'http://127.0.0.1:9', `import '${relative(temporary, join(root, 'src/editor/ui.ts')).split('\\').join('/')}';`);
  await assert.rejects(releaseBuild({ GAME_MODULE: editorModule }), /Editor code\/assets reached the game-only build/);
  await assert.rejects(releaseBuild({ GAME_MODULE: 'README.md' }), /GAME_MODULE must name a \.ts or \.js module inside this project/);
  await assert.rejects(releaseBuild({ GAME_CONTENT_URL: 'https://cdn.example.invalid/game' }), /GAME_CONTENT_URL must be/);
  await assert.rejects(releaseBuild({ GAME_CONTENT_URL: 'https://user:secret@cdn.example.invalid/game/' }), /GAME_CONTENT_URL must be/);
  // The release relays grants; it never handles credentials, identities or storage for content.
  for (const file of ['content.ts', 'content-ref.ts', 'content-session.ts', 'release.ts', 'release-module.ts', 'media-host.ts']) {
    const source = await readFile(join(root, 'src', file), 'utf8');
    assert.ok(!/document\.cookie|localStorage|sessionStorage|indexedDB|caches\.|Authorization|Bearer/.test(source), `${file} handles no credentials or storage.`);
  }
  return { noModule: true, editorImportRejected: true, invalidInputs: 3 };
}

try {
  const project = await richProject();
  const rich = await verifyShell(project);
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  report.signed = await verifySignedRelease(project, rich);
  report.hosts = await verifyPublicHosts();
  report.packagedOnly = await verifyPackagedOnly(project);
  report.performance = await verifyPerformance();
  report.video = await verifyVideo();
  report.insecureContext = await verifyInsecureContext();
  report.boundary = await verifyBoundary();
  report.status = 'passed';
  console.log('Content delivery: empty shell, grants, refresh, refusal and retry, integrity, cookies, hosts, packaged-only builds, parallel loading, video streaming, insecure pages and the module boundary passed.');
} catch (error) {
  report.status = 'failed';
  report.error = error?.stack ?? String(error);
  throw error;
} finally {
  setGameEnv(Object.fromEntries(Object.entries(saved).filter(([, value]) => value !== undefined)));
  for (const close of closers.reverse()) await close().catch(() => undefined);
  await browser?.close();
  await writeFile(join(artifacts, 'content-report.json'), JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true });
}
