// Runtime model swaps: a release shows the library model its game's backend selects for each part,
// relays every change to that backend one request at a time, and neither decides nor keeps a
// selection. The Workshop imports, previews and saves the model library. See docs/characters.md.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer as createViteServer, preview } from 'vite';
import { chromium } from 'playwright';
import { hammerGlb, humanoidBoneMap, HUMANOID_BONE_MAP, patchGlbJson, potGlb, skinnedAvatarGlb } from './character-fixtures.mjs';
import { observeBrowserPage } from './verify-level.mjs';
import { releaseContent, shellCode } from './release-fixtures.mjs';
import { openSection } from './workshop-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const gameConfig = join(root, 'vite.game.config.ts');
const workshopConfig = join(root, 'vite.config.ts');
const example = join(root, 'examples/projects/lantern-cavern');
const GAME_VARIABLES = [
  'GAME_PROJECT', 'GAME_LEVEL', 'GAME_SETTINGS', 'GAME_SPRITES', 'GAME_ALTERNATE_SPRITES', 'GAME_TITLE', 'GAME_ART_MODE',
  'GAME_CONTENT_URL', 'GAME_MODULE',
];
const STUDIO_VARIABLES = ['STUDIO_PROJECTS', 'STUDIO_RELEASES', 'STUDIO_TOKEN', 'STUDIO_API'];
const ROLES = ['avatar', 'hammer', 'pot'];
const saved = Object.fromEntries([...GAME_VARIABLES, ...STUDIO_VARIABLES].map(name => [name, process.env[name]]));
// Chromium logs a console error for every refused request; refusal scenarios expect those.
const REFUSED_REQUEST = /Failed to load resource: the server responded with a status of 40[13]/;
process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true';
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(artifacts, 'model-swap-proof-'));
const report = { status: 'incomplete', errors: [] };
const closers = [];
let browser;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const glbData = bytes => `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`;
// A fixture with its own bytes, so every library model is its own file.
const variant = (glb, label) => patchGlbJson(glb, json => { json.asset.generator = `${json.asset.generator} (${label})`; });

const KNIGHT = { armForwardDistance: 0.18, grips: { placement: 'fixed', left: 0.06, right: 0.3, slideAt: 0.85 }, arms: null };
const GIANT = { armForwardDistance: 0.36, grips: { placement: 'sliding', left: 0.1, right: 0.4, slideAt: 0.7 }, arms: null };
const LIBRARY = {
  avatar: [
    { id: 'knight', name: 'Knight', glb: variant(skinnedAvatarGlb({ prefix: 'mixamorig:' }), 'knight'), settings: { boneMap: humanoidBoneMap('mixamorig:'), ...KNIGHT } },
    { id: 'giant', name: 'Giant', glb: variant(skinnedAvatarGlb(), 'giant'), settings: { boneMap: HUMANOID_BONE_MAP, ...GIANT } },
  ],
  hammer: [
    { id: 'mallet', name: 'Mallet', glb: variant(hammerGlb(), 'mallet') },
    { id: 'club', name: 'Club', glb: variant(hammerGlb(), 'club') },
  ],
  pot: [
    { id: 'urn', name: 'Urn', glb: variant(potGlb(), 'urn') },
    { id: 'vase', name: 'Vase', glb: variant(potGlb(), 'vase') },
  ],
};

function setEnv(names, values) {
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
}

async function releaseBuild(values, outDir) {
  setEnv(GAME_VARIABLES, values);
  try {
    return await build({ configFile: gameConfig, logLevel: 'silent', build: { outDir, emptyOutDir: true, write: outDir !== undefined } });
  } finally {
    setEnv(GAME_VARIABLES, {});
  }
}

async function servePreview(outDir) {
  const server = await preview({ configFile: gameConfig, logLevel: 'silent', build: { outDir }, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  closers.push(() => new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.httpServer.address().port}/`;
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

// An avatar-3d hero with its own avatar, hammer and pot models and cel shading, and a mesh-parts
// second character with its own hammer.
function profiles() {
  const base = { images: [], layers: [], skeleton: null, presentation: null, arms: null };
  return {
    primary: {
      ...base, schemaVersion: 12, characterRiggingType: 'avatar-3d', armForwardDistance: 0.25,
      grips: { placement: 'sliding', left: 0.04, right: 0.22, slideAt: 0.85 },
      models: [
        { id: 'avatar', name: 'Hero', source: glbData(variant(skinnedAvatarGlb(), 'hero')) },
        { id: 'hammer', name: 'Hero hammer', source: glbData(variant(hammerGlb(), 'hero')) },
        { id: 'pot', name: 'Hero pot', source: glbData(variant(potGlb(), 'hero')) },
      ],
      avatar: { model: 'avatar', boneMap: HUMANOID_BONE_MAP }, hammer: { model: 'hammer' }, pot: { model: 'pot' },
      shading: { mode: 'cel', bands: 3, outline: { color: '#202428', width: 0.015 } },
    },
    alternate: {
      ...base, schemaVersion: 12, characterRiggingType: 'model-3d', armForwardDistance: 0.3,
      grips: { placement: 'fixed', left: 0.04, right: 0.22, slideAt: 0.85 },
      models: [{ id: 'hammer', name: 'Spare hammer', source: glbData(variant(hammerGlb(), 'spare')) }], hammer: { model: 'hammer' },
    },
  };
}

// A representative large course: about 1,000 terrain objects.
function largeLevel(count) {
  const objects = [
    { kind: 'terrain', id: 'floor', shape: { type: 'box' }, x: 0, y: -1, width: 128, height: 2, angle: 0, depth: 3, color: 0x3b4046, illusion: false },
    { kind: 'start', id: 'start', x: 0, y: 0.65, angle: -0.42, reach: 1.7 },
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
  return { schemaVersion: 3, labels: [], objects };
}

// The Lantern Cavern example on a large course, with two characters and a library of two models
// per part, as a project bundle.
async function swapBundle() {
  const manifest = JSON.parse(await readFile(join(example, 'project.json'), 'utf8'));
  const { primary, alternate } = profiles();
  const models = Object.fromEntries(ROLES.map(role => [role, LIBRARY[role].map(({ id, name, settings }) => ({ id, name, ...settings }))]));
  const files = {
    'project.json': {
      ...manifest, title: 'Swap Proof', models,
      characters: { primary: 'characters/primary.json', alternate: 'characters/alternate.json' },
    },
    'level.json': largeLevel(1000),
    'characters/primary.json': primary,
    'characters/alternate.json': alternate,
  };
  for (const entry of manifest.media) {
    const name = entry.path.slice('/media/'.length);
    files[`media/${name}`] = `data:audio/wav;base64,${(await readFile(join(example, 'media', name))).toString('base64')}`;
  }
  for (const role of ROLES) for (const entry of LIBRARY[role]) files[`models/${role}/${entry.id}.glb`] = glbData(entry.glb);
  return { format: 'over-the-edge-project-bundle', schemaVersion: 2, files };
}

// The bundle as a project directory, for GAME_PROJECT builds.
async function writeProject(bundle, directory) {
  for (const [path, value] of Object.entries(bundle.files)) {
    await mkdir(join(directory, path, '..'), { recursive: true });
    const data = typeof value === 'string' && value.startsWith('data:') ? Buffer.from(value.slice(value.indexOf(',') + 1), 'base64') : JSON.stringify(value);
    await writeFile(join(directory, path), data);
  }
  return relative(root, directory);
}

/**
 * A game's backend and CDN, reduced to what swaps need. POST /select stores the player's selection
 * and answers it, refusing models the player does not own; `answer` lets a test make the backend
 * answer differently. POST /grant signs the game group, and a library model's group only while the
 * backend's selection uses it. GET /cdn/<path> serves only what the backend signed.
 */
async function standIn(directory) {
  const secret = randomBytes(16).toString('hex');
  const initial = () => ({
    selection: { avatar: null, hammer: null, pot: null },
    owned: new Set(['avatar/knight', 'hammer/mallet', 'hammer/club', 'pot/urn', 'pot/vase']),
    answer: null, latency: 0, denyLibrary: false,
    selects: [], active: 0, maxActive: 0, grants: [], refusedGrants: [], requests: [],
  });
  const state = initial();
  const sign = (path, expires) => createHmac('sha256', secret).update(`${path}\n${expires}`).digest('hex');
  let base = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://stand-in.invalid');
    const cors = { 'Access-Control-Allow-Origin': request.headers.origin ?? '*', 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' };
    const reply = (status, body = '', headers = {}) => { response.writeHead(status, { ...cors, ...headers }); response.end(body); };
    const json = (status, value) => reply(status, JSON.stringify(value), { 'Content-Type': 'application/json' });
    if (request.method === 'OPTIONS') {
      reply(204, '', { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type, range' });
      return;
    }
    const body = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    if (url.pathname === '/select' && request.method === 'POST') {
      const { request: change } = await body();
      state.selects.push(change);
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        await sleep(state.latency);
        if (change !== null && change.id !== null && !state.owned.has(`${change.role}/${change.id}`)) {
          json(403, { error: 'not-owned' });
          return;
        }
        const next = change === null ? state.selection : { ...state.selection, [change.role]: change.id };
        state.selection = state.answer?.(change, next) ?? next;
        json(200, state.selection);
      } finally {
        state.active--;
      }
      return;
    }
    if (url.pathname === '/grant' && request.method === 'POST') {
      const grant = await body();
      state.grants.push({ group: grant.group, paths: grant.paths.length });
      const [kind, role, id] = grant.group.split('/');
      if (kind === 'library' && (state.denyLibrary || state.selection[role] !== id)) {
        state.refusedGrants.push(grant.group);
        json(403, { error: 'not-selected' });
        return;
      }
      const expires = Date.now() + 60_000;
      json(200, { urls: Object.fromEntries(grant.paths.map(path => [path, `${base}/cdn/${path}?expires=${expires}&sig=${sign(path, expires)}`])), expires });
      return;
    }
    if (url.pathname.startsWith('/cdn/') && request.method === 'GET') {
      const path = url.pathname.slice('/cdn/'.length);
      const expires = Number(url.searchParams.get('expires'));
      const entry = { path, status: 200 };
      state.requests.push(entry);
      if (expires <= Date.now() || url.searchParams.get('sig') !== sign(path, expires)) {
        entry.status = 403;
        reply(403);
        return;
      }
      try {
        const bytes = await readFile(join(directory, ...path.split('/')));
        reply(200, bytes, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) });
      } catch {
        entry.status = 404;
        reply(404);
      }
      return;
    }
    reply(404);
  });
  base = await listen(server);
  closers.push(() => new Promise(resolve => server.close(resolve)));
  return { base, state, reset(values = {}) { Object.assign(state, initial(), values); } };
}

// A downstream game's module, for this test only: grants and selections come from its backend, and
// it exposes the release's model library and what the release reports.
async function writeModule(name, backend, options = { select: true }) {
  const path = join(temporary, `${name}.ts`);
  const engine = relative(temporary, join(root, 'src/release-module')).split('\\').join('/');
  await writeFile(path, `import { ContentError } from '${engine}';
import type { ContentAccess, ModelLibraryApi, ReleaseHost, ReleaseModule } from '${engine}';

export async function start(_host: ReleaseHost): Promise<ReleaseModule> {
  const proof = { ready: false, atReady: null as unknown, failures: [] as unknown[], modelFailures: [] as unknown[], library: null as ModelLibraryApi | null };
  (window as unknown as { swapProof: typeof proof }).swapProof = proof;
  const post = (path: string, body: unknown, signal: AbortSignal) => fetch('${backend}' + path, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal,
  });
  const answer = async (response: Response) => {
    if (response.status === 403) throw new ContentError('denied', 'This account may not use that.');
    if (!response.ok) throw new ContentError('unavailable', 'The backend answered ' + response.status + '.');
    return response.json();
  };
  const access: ContentAccess = {
    async grant(request, signal) {
      const granted = await answer(await post('/grant', request, signal));
      return { urls: new Map(Object.entries(granted.urls as Record<string, string>)), credentials: 'omit', expires: granted.expires };
    },
    ${options.select ? `async select(request, signal) {
      return answer(await post('/select', { request }, signal));
    },` : ''}
  };
  return {
    access,
    failed(error) {
      proof.failures.push({ code: error.code, message: error.message });
      return Promise.reject(error);
    },
    modelFailed(error) {
      proof.modelFailures.push({ name: error.name, code: (error as { code?: string }).code ?? null, message: error.message });
    },
    ready(api) {
      proof.library = api.modelLibrary;
      proof.atReady = { avatar: api.modelLibrary.active('avatar'), hammer: api.modelLibrary.active('hammer'), pot: api.modelLibrary.active('pot') };
      proof.ready = true;
    },
  };
}
`);
  return relative(root, path);
}

// Every swap settles as { selection } or { error }, so a test can fire several at once.
const swaps = (page, list) => page.evaluate(list => Promise.all(list.map(([role, id]) => window.swapProof.library.swap(role, id).then(
  selection => ({ selection }), error => ({ error: { name: error.name, code: error.code ?? null, message: error.message } })))), list);
const swap = async (page, role, id) => (await swaps(page, [[role, id]]))[0];
const refresh = page => page.evaluate(() => window.swapProof.library.refresh().then(
  selection => ({ selection }), error => ({ error: { name: error.name, code: error.code ?? null, message: error.message } })));
const active = page => page.evaluate(roles => Object.fromEntries(roles.map(role => [role, window.swapProof.library.active(role)])), ROLES);
const proof = page => page.evaluate(() => ({ ...window.swapProof, library: undefined }));
const elapsed = page => page.evaluate(() => document.querySelector('.elapsed-value')?.textContent ?? '');
const booted = page => page.waitForFunction(() => window.swapProof?.ready === true || window.swapProof?.failures.length > 0 || !document.querySelector('#fatal-error').hidden, null, { timeout: 20_000 });
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const storage = page => page.evaluate(async () => ({
  local: Object.entries(localStorage), session: Object.entries(sessionStorage),
  caches: await caches.keys(), databases: (await indexedDB.databases()).map(database => database.name),
}));

async function verifyRelease(project) {
  const result = {};
  // 1. The build: each library model is its own group, in the content only.
  const release = join(temporary, 'swap-release');
  let cdn = null;
  const backend = await standIn(`${release}-content`);
  cdn = backend;
  const module = await writeModule('swap-module', backend.base);
  const bundle = await releaseBuild({ GAME_PROJECT: project, GAME_MODULE: module, GAME_CONTENT_URL: `${backend.base}/cdn/` }, release);
  const { files, manifest } = await releaseContent(release);
  const paths = Object.fromEntries(ROLES.map(role => [role, Object.fromEntries(manifest.library[role].map(entry => [entry.id, entry.source.slice('content:'.length)]))]));
  for (const role of ROLES) {
    assert.deepEqual(manifest.library[role].map(entry => entry.id), LIBRARY[role].map(entry => entry.id));
    for (const entry of LIBRARY[role]) {
      const path = paths[role][entry.id];
      assert.match(path, new RegExp(`^library/${role}/${entry.id}/[0-9a-f]{64}\\.glb$`), `${role} ${entry.id} is in its own group.`);
      assert.deepEqual(files.get(path), Buffer.from(entry.glb), `${role} ${entry.id} is packaged unchanged.`);
    }
  }
  assert.deepEqual(manifest.library.avatar[0].grips, KNIGHT.grips, 'A library avatar carries its own settings.');
  const code = shellCode(bundle);
  for (const role of ROLES) {
    for (const entry of LIBRARY[role]) {
      assert.ok(!code.includes(paths[role][entry.id]), 'The shell pins no library model: each needs its own grant.');
      assert.ok(!code.includes(Buffer.from(entry.glb).subarray(0, 3000).toString('base64').slice(0, 2000)), 'No library model is in the shell.');
    }
  }
  const profileModels = Object.fromEntries(ROLES.map(role => [role, manifest.characters.primary.models.find(model => model.id === role).source.slice('content:'.length)]));
  result.build = { libraryFiles: Object.values(paths).flatMap(Object.values).length, content: files.size };

  const address = await servePreview(release);
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  closers.push(() => context.close());
  const page = await context.newPage();
  await observeBrowserPage(page, errors);
  const fetched = () => cdn.state.requests.filter(entry => entry.status === 200).map(entry => entry.path);
  const libraryGrants = () => cdn.state.grants.filter(grant => grant.group.startsWith('library/')).map(grant => grant.group);

  // 2. Boot: the backend's stored selection shows before the first frame; the replaced parts'
  // profile models are never fetched, and the other library models are neither granted nor fetched.
  backend.reset({ selection: { avatar: 'knight', hammer: null, pot: 'urn' } });
  await page.goto(address, { waitUntil: 'domcontentloaded' });
  await booted(page);
  let state = await proof(page);
  assert.equal(await page.locator('#fatal-error').isHidden(), true, await page.locator('#fatal-error').textContent());
  assert.deepEqual(state.failures, []);
  assert.deepEqual(state.atReady, { avatar: 'knight', hammer: null, pot: 'urn' }, 'The stored selection shows when the game starts.');
  assert.deepEqual(backend.state.selects, [null], 'The release reads the selection once at boot.');
  assert.deepEqual(libraryGrants().sort(), ['library/avatar/knight', 'library/pot/urn']);
  const booting = fetched();
  assert.ok(booting.includes(paths.avatar.knight) && booting.includes(paths.pot.urn) && booting.includes(profileModels.hammer));
  assert.ok(!booting.includes(profileModels.avatar) && !booting.includes(profileModels.pot), 'Replaced profile models are never fetched.');
  assert.equal(booting.filter(path => path.startsWith('library/')).length, 2, 'Only the selected library models load.');
  assert.deepEqual(state.modelFailures, []);
  assert.deepEqual(await page.evaluate(() => Object.keys(window.swapProof.library).sort()), ['active', 'available', 'refresh', 'swap'],
    'The module can only ask: the API has no way to apply a selection.');
  assert.deepEqual(await page.evaluate(() => window.swapProof.library.available('hammer')), ['mallet', 'club']);
  await page.waitForFunction(() => document.querySelector('.elapsed-value')?.textContent !== '00:00', null, { timeout: 20_000 });
  const timerBefore = await elapsed(page);
  result.boot = { requests: booting.length, libraryGrants: 2 };

  // 3. Each part swaps on its own, through the backend; a new model costs one grant and one fetch,
  // returning to a cached one costs nothing.
  let requests = cdn.state.requests.length;
  let outcomeOf = await swap(page, 'hammer', 'club');
  assert.deepEqual(outcomeOf, { selection: { avatar: 'knight', hammer: 'club', pot: 'urn' } });
  assert.deepEqual(backend.state.selects.at(-1), { role: 'hammer', id: 'club' });
  assert.deepEqual(libraryGrants().at(-1), 'library/hammer/club');
  assert.deepEqual(cdn.state.requests.slice(requests).map(entry => entry.path), [paths.hammer.club], 'A new model is fetched once.');
  requests = cdn.state.requests.length;
  const grants = cdn.state.grants.length;
  let started = Date.now();
  assert.deepEqual(await swap(page, 'hammer', null), { selection: { avatar: 'knight', hammer: null, pot: 'urn' } });
  assert.deepEqual(await swap(page, 'hammer', 'club'), { selection: { avatar: 'knight', hammer: 'club', pot: 'urn' } });
  const cachedMs = (Date.now() - started) / 2;
  assert.equal(cdn.state.requests.length, requests, 'Swapping back to the own and a cached model fetches nothing.');
  assert.equal(cdn.state.grants.length, grants, 'A cached model needs no new grant.');
  assert.deepEqual(await active(page), { avatar: 'knight', hammer: 'club', pot: 'urn' });
  started = Date.now();
  assert.deepEqual(await swap(page, 'avatar', null), { selection: { avatar: null, hammer: 'club', pot: 'urn' } });
  assert.deepEqual(await swap(page, 'avatar', 'knight'), { selection: { avatar: 'knight', hammer: 'club', pot: 'urn' } });
  const avatarMs = (Date.now() - started) / 2;
  assert.ok(cachedMs < 1000 && avatarMs < 1000, `Cached swaps on a large course take ${cachedMs} ms (hammer) and ${avatarMs} ms (avatar).`);
  await sleep(1100);
  assert.ok(await elapsed(page) > timerBefore, 'The timer keeps running through swaps; nothing reloads.');
  result.swaps = { fetchesPerNewModel: 1, cachedFetches: 0, cachedMs, avatarMs };

  // 4. The backend decides: it refuses what the player does not own, and may answer otherwise.
  outcomeOf = await swap(page, 'avatar', 'giant');
  assert.equal(outcomeOf.error?.code, 'denied', 'A refused swap fails with the backend\'s reason.');
  assert.equal((await active(page)).avatar, 'knight', 'A refused swap keeps the part.');
  assert.ok(!libraryGrants().includes('library/avatar/giant'), 'A refused model is never granted.');
  backend.state.answer = (change, next) => change?.role === 'pot' ? { ...next, hammer: 'mallet' } : null;
  outcomeOf = await swap(page, 'pot', 'vase');
  assert.deepEqual(outcomeOf, { selection: { avatar: 'knight', hammer: 'mallet', pot: 'vase' } }, 'The release shows the backend\'s answer, not the request.');
  backend.state.answer = (_change, _next) => ({ ...backend.state.selection });
  assert.deepEqual(await swap(page, 'pot', 'urn'), { selection: { avatar: 'knight', hammer: 'mallet', pot: 'vase' } }, 'An unchanged answer keeps the part.');
  backend.state.answer = null;
  // Unknown IDs: the release rejects its own at once; a backend's fails only its part.
  const selects = backend.state.selects.length;
  assert.equal((await swap(page, 'hammer', 'nope')).error?.code, 'unknown-model');
  assert.equal((await swap(page, 'shield', 'club')).error?.code, 'unknown-model');
  assert.equal(backend.state.selects.length, selects, 'Unknown models are never requested.');
  backend.state.answer = (_change, next) => ({ ...next, hammer: 'ghost' });
  outcomeOf = await swap(page, 'hammer', 'club');
  assert.equal(outcomeOf.error?.code, 'unknown-model', 'An answer naming an unknown model fails the swap.');
  assert.equal((await active(page)).hammer, 'mallet', 'That part keeps its model.');
  backend.state.answer = null;
  // A model whose file is refused keeps the part as it was.
  backend.state.selection = { avatar: 'knight', hammer: 'mallet', pot: 'vase' };
  backend.state.owned.add('avatar/giant');
  backend.state.denyLibrary = true;
  outcomeOf = await swap(page, 'avatar', 'giant');
  assert.equal(outcomeOf.error?.code, 'denied', 'A refused file fails the swap with a typed error.');
  assert.equal((await active(page)).avatar, 'knight');
  backend.state.denyLibrary = false;
  backend.state.owned.delete('avatar/giant');
  backend.state.selection = { avatar: 'knight', hammer: 'mallet', pot: 'vase' };
  assert.deepEqual(backend.state.refusedGrants, ['library/avatar/giant'], 'The release asks only for models the backend selected.');
  result.authority = { refused: 'denied', rewritten: true, unknown: 'unknown-model', refusedFile: 'denied' };

  // 5. Requests go one at a time, in order; a newer swap of a part replaces one not yet sent.
  backend.state.owned.add('avatar/giant');
  backend.state.latency = 200;
  backend.state.maxActive = 0;
  let before = backend.state.selects.length;
  const ordered = await swaps(page, [['avatar', 'giant'], ['pot', 'urn'], ['hammer', 'club']]);
  assert.equal(backend.state.maxActive, 1, 'The backend sees one request at a time.');
  assert.deepEqual(backend.state.selects.slice(before), [{ role: 'avatar', id: 'giant' }, { role: 'pot', id: 'urn' }, { role: 'hammer', id: 'club' }]);
  assert.deepEqual(ordered.map(entry => entry.selection), [
    { avatar: 'giant', hammer: 'mallet', pot: 'vase' }, { avatar: 'giant', hammer: 'mallet', pot: 'urn' }, { avatar: 'giant', hammer: 'club', pot: 'urn' },
  ], 'Each swap resolves with the selection its answer showed.');
  before = backend.state.selects.length;
  const superseded = await swaps(page, [['pot', 'vase'], ['hammer', 'mallet'], ['hammer', null]]);
  assert.equal(superseded[1].error?.code, 'superseded');
  assert.deepEqual(backend.state.selects.slice(before), [{ role: 'pot', id: 'vase' }, { role: 'hammer', id: null }], 'A superseded swap is never sent.');
  assert.deepEqual(superseded[2].selection, { avatar: 'giant', hammer: null, pot: 'vase' });
  assert.deepEqual(await active(page), backend.state.selection, 'The release ends showing the backend\'s stored selection.');
  assert.equal(backend.state.refusedGrants.length, 1, 'Recovering after a purchase asks for the file again.');
  backend.state.latency = 0;
  result.ordering = { maxActive: 1, superseded: true };

  // 6. A selection changed elsewhere shows after refresh(); switching characters fetches nothing.
  backend.state.selection = { avatar: 'knight', hammer: 'club', pot: 'vase' };
  assert.deepEqual(await refresh(page), { selection: { avatar: 'knight', hammer: 'club', pot: 'vase' } });
  requests = cdn.state.requests.length;
  await page.getByRole('radio').nth(1).check();
  await frames(page);
  await page.getByRole('radio').nth(0).check();
  await frames(page);
  assert.equal(cdn.state.requests.length, requests, 'Switching characters fetches nothing.');
  assert.deepEqual(await active(page), { avatar: 'knight', hammer: 'club', pot: 'vase' }, 'The selection belongs to the player, across characters.');
  // Only the player's character choice, a local preference, is remembered.
  assert.deepEqual(await storage(page), { local: [['over-the-edge:play:character', '0']], session: [], caches: [], databases: [] },
    'The release keeps no model selection.');
  await page.screenshot({ path: join(artifacts, 'model-swap-release.png') });

  // 7. A reload shows what the backend stored, from memory nowhere. A backend selection the release cannot follow
  // starts that part with the profile's own model, and the module hears why.
  const stored = { ...backend.state.selection };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await booted(page);
  assert.deepEqual((await proof(page)).atReady, stored, 'A reload starts with the backend\'s stored selection.');
  backend.reset({ selection: { avatar: 'giant', hammer: 'ghost', pot: 'urn' }, denyLibrary: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await booted(page);
  state = await proof(page);
  assert.equal(state.ready, true, 'Parts that cannot load do not stop the game.');
  assert.deepEqual(state.atReady, { avatar: null, hammer: null, pot: null });
  assert.deepEqual(state.modelFailures.map(failure => failure.code).sort(), ['denied', 'denied', 'unknown-model']);
  assert.ok(fetched().includes(profileModels.avatar) && fetched().includes(profileModels.hammer) && fetched().includes(profileModels.pot),
    'Parts that failed use the profile\'s own models.');
  result.bootFailures = state.modelFailures.map(failure => failure.code).sort();
  assert.deepEqual(errors.filter(error => !REFUSED_REQUEST.test(error)), [], 'Swapping logs no errors besides refused requests.');

  // 8. Without select(), the library is unavailable and parts use their profiles' models.
  const plain = join(temporary, 'plain-release');
  const plainBackend = await standIn(`${plain}-content`);
  cdn = plainBackend;
  await releaseBuild({ GAME_PROJECT: project, GAME_MODULE: await writeModule('plain-module', plainBackend.base, { select: false }), GAME_CONTENT_URL: `${plainBackend.base}/cdn/` }, plain);
  const plainPage = await context.newPage();
  await observeBrowserPage(plainPage, errors);
  await plainPage.goto(await servePreview(plain), { waitUntil: 'domcontentloaded' });
  await booted(plainPage);
  assert.deepEqual((await proof(plainPage)).atReady, { avatar: null, hammer: null, pot: null });
  assert.equal((await swap(plainPage, 'hammer', 'club')).error?.code, 'unavailable', 'Without a backend that selects, nothing swaps.');
  assert.deepEqual(plainBackend.state.grants.map(grant => grant.group), ['game'], 'Library models are never granted without a selection.');
  assert.deepEqual(errors.filter(error => !REFUSED_REQUEST.test(error)), []);
  result.withoutSelect = 'unavailable';
  return result;
}

// Builds and the project server refuse library models a release would refuse.
async function verifyChecks(bundle) {
  const broken = structuredClone(bundle);
  broken.files['models/hammer/club.glb'] = glbData(skinnedAvatarGlb());
  const directory = await writeProject(broken, join(temporary, 'broken-project'));
  await assert.rejects(releaseBuild({ GAME_PROJECT: directory }), /Library hammer "Club" \(club\)/, 'A build refuses an invalid library model.');
  const unmapped = structuredClone(bundle);
  unmapped.files['project.json'].models.avatar[0].boneMap = { ...HUMANOID_BONE_MAP, head: 'mixamorig:Nowhere' };
  await assert.rejects(releaseBuild({ GAME_PROJECT: await writeProject(unmapped, join(temporary, 'unmapped-project')) }), /Library avatar "Knight" \(knight\)/);
  return { invalidModel: 'refused', unmappedAvatar: 'refused' };
}

function client(base) {
  return async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (method !== 'GET') init.headers['X-Studio-Request'] = '1';
    if (body instanceof Uint8Array) {
      init.body = body;
      init.headers['Content-Type'] ??= 'model/gltf-binary';
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(base + path, init);
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, value: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
}

async function verifyWorkshop(bundle) {
  const result = {};
  const projects = join(temporary, 'projects');
  setEnv(STUDIO_VARIABLES, { STUDIO_PROJECTS: relative(root, projects), STUDIO_RELEASES: relative(root, join(temporary, 'releases')), STUDIO_TOKEN: '' });
  const server = await createViteServer({ configFile: workshopConfig, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true } });
  await server.listen();
  closers.push(() => server.close());
  setEnv(STUDIO_VARIABLES, {});
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const api = client(base);

  // The project API: the library section, each model and its entry.
  assert.equal((await api('PUT', '/api/projects/swap/bundle', bundle)).status, 200);
  assert.deepEqual((await api('GET', '/api/projects/swap/models')).value.hammer.map(entry => entry.id), ['mallet', 'club']);
  assert.deepEqual((await api('GET', '/api/projects/swap/models/avatar/knight')).value.grips, KNIGHT.grips);
  assert.deepEqual((await api('GET', '/api/projects/swap/models/pot/urn/model')).value, Buffer.from(LIBRARY.pot[0].glb));
  let answer = await api('PUT', '/api/projects/swap/models/hammer/broken/model?name=Broken', skinnedAvatarGlb());
  assert.equal(answer.status, 400, 'The server refuses a hammer that is not one.');
  answer = await api('PUT', `/api/projects/swap/models/avatar/stray/model?settings=${encodeURIComponent(JSON.stringify({ ...GIANT, boneMap: { ...HUMANOID_BONE_MAP, head: 'Nowhere' } }))}`, skinnedAvatarGlb());
  assert.equal(answer.status, 400, 'An avatar\'s bone map must resolve against its model.');
  answer = await api('PUT', '/api/projects/swap/models/avatar/scout/model?name=Scout', variant(skinnedAvatarGlb(), 'scout'));
  assert.equal(answer.status, 200, 'An uploaded avatar maps its joints automatically.');
  assert.deepEqual((await api('GET', '/api/projects/swap/models/avatar/scout')).value.boneMap, HUMANOID_BONE_MAP);
  answer = await api('PATCH', '/api/projects/swap/models/avatar/scout', { armForwardDistance: 0.4 });
  assert.equal(answer.status, 200);
  assert.equal((await api('GET', '/api/projects/swap/models/avatar/scout')).value.armForwardDistance, 0.4);
  answer = await api('PATCH', '/api/projects/swap/models/avatar/scout', { boneMap: { head: 'Nowhere' } });
  assert.equal(answer.status, 400);
  const listed = (await api('GET', '/api/projects/swap/models')).value;
  answer = await api('PUT', '/api/projects/swap/models', { ...listed, pot: [...listed.pot, { id: 'jar', name: 'Jar' }] });
  assert.equal(answer.status, 400, 'A listed model must be uploaded first.');
  assert.equal(answer.value.error.code, 'missing-file');
  assert.equal((await api('DELETE', '/api/projects/swap/models/avatar/scout')).status, 200);
  assert.equal((await api('GET', '/api/projects/swap/models/avatar/scout/model')).status, 404, 'Removing an entry removes its model.');
  result.api = { sections: true, refused: 3 };

  // The Workshop: open the project, preview library models in the game, edit and save the library.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  closers.push(() => context.close());
  const page = await context.newPage();
  const errors = [];
  await observeBrowserPage(page, errors);
  const project = () => page.evaluate(() => window.gettingOver.gameProject());
  const rendering = () => page.evaluate(() => window.gettingOver.level().rendering);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.gettingOver?.gameProject().server?.authenticated === true);
  await page.getByRole('tab', { name: 'Project', exact: true }).click();
  await page.locator('#project-list').selectOption('swap');
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await page.waitForFunction(() => window.gettingOver.gameProject().binding?.id === 'swap' && window.gettingOver.gameProject().busy === null);
  await openSection(page, 'project-models');
  assert.deepEqual((await project()).library.map(model => `${model.role}/${model.id}`),
    ['avatar/knight', 'avatar/giant', 'hammer/mallet', 'hammer/club', 'pot/urn', 'pot/vase']);
  assert.equal(await page.locator('.project-library-part[data-role="hammer"] li').count(), 2);

  // Previews use the release's path: the part shows the library model, shaded like the character.
  await frames(page);
  const own = await rendering();
  assert.equal(own.hammerModel.name, 'Hero hammer');
  assert.ok(own.terrain.instances >= 1000, 'The Workshop previews on a large course.');
  await page.locator('#project-library-hammer-preview').selectOption('club');
  await page.waitForFunction(() => window.gettingOver.gameProject().parts.hammer === 'club');
  await frames(page);
  let view = await rendering();
  assert.equal(view.hammerModel.name, 'Club');
  assert.ok(view.hammerModel.visible && view.hammerModel.fit !== null, 'A library hammer fits the handle like the profile\'s.');
  assert.ok(view.shading.hullsCreated > own.shading.hullsCreated, 'Cel outlines follow a library model.');
  assert.deepEqual(view.hammerModel.materialTypes, own.hammerModel.materialTypes, 'A library model takes the character\'s cel shading.');
  assert.notDeepEqual(own.hammerModel.materialTypes, ['MeshStandardMaterial']);
  await page.locator('#project-library-avatar-preview').selectOption('knight');
  await page.waitForFunction(() => window.gettingOver.gameProject().parts.avatar === 'knight');
  await frames(page);
  view = await rendering();
  assert.equal(view.importedAvatar.name, 'Knight');
  assert.equal(view.grips.placement, 'fixed', 'A library avatar brings its own grips.');
  await page.locator('#project-library-pot-preview').selectOption('urn');
  await page.waitForFunction(() => window.gettingOver.gameProject().parts.pot === 'urn');
  await page.locator('.project-library-part[data-role="hammer"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, 'model-swap-workshop.png') });
  await page.locator('#project-library-avatar-preview').selectOption('');
  await page.waitForFunction(() => window.gettingOver.gameProject().parts.avatar === null);
  await frames(page);
  view = await rendering();
  assert.equal(view.importedAvatar.name, 'Hero');
  assert.equal(view.grips.placement, 'sliding', 'The character\'s own avatar brings back its grips.');
  // Previews touch only the character: the course is not rewritten, and ending them frees their models.
  assert.equal(view.terrain.matrixWrites, own.terrain.matrixWrites, 'Swapping parts leaves the course untouched.');
  for (const role of ['hammer', 'pot']) {
    await page.locator(`#project-library-${role}-preview`).selectOption('');
    await page.waitForFunction(role => window.gettingOver.gameProject().parts[role] === null, role);
  }
  await frames(page);
  view = await rendering();
  assert.equal(view.hammerModel.name, 'Hero hammer');
  assert.deepEqual([view.geometries, view.textures], [own.geometries, own.textures], 'Ended previews release their models.');
  assert.deepEqual((await project()).dirty, [], 'Previews change nothing in the project.');

  // Adding models: an invalid one is refused with its name; a hammer; an avatar whose joints do
  // not all map waits for its bone map.
  await page.locator('#project-library-pot-file').setInputFiles({ name: 'Bad Pot.glb', mimeType: 'model/gltf-binary', buffer: skinnedAvatarGlb() });
  await page.waitForFunction(() => /Library pot "Bad Pot" \(bad-pot\)/.test(document.querySelector('.notice-message')?.textContent ?? ''));
  assert.equal((await project()).library.length, 6, 'An invalid model is not added.');
  await page.locator('#project-library-hammer-file').setInputFiles({ name: 'Stone Club.glb', mimeType: 'model/gltf-binary', buffer: variant(hammerGlb(), 'stone') });
  await page.waitForFunction(() => window.gettingOver.gameProject().library.some(model => model.id === 'stone-club'));
  const skull = patchGlbJson(skinnedAvatarGlb(), json => { for (const node of json.nodes) if (node.name === 'Head') node.name = 'Skull'; });
  await page.locator('#project-library-avatar-file').setInputFiles({ name: 'Odd Rig.glb', mimeType: 'model/gltf-binary', buffer: skull });
  await page.locator('.project-library-bones').waitFor({ state: 'visible' });
  assert.match(await page.locator('.project-library-bones-status').textContent(), /not added yet/);
  assert.equal(await page.locator('#project-library-bone-head').getAttribute('aria-invalid'), 'true');
  assert.ok(!(await project()).library.some(model => model.id === 'odd-rig'));
  await page.locator('#project-library-bone-head').selectOption('Skull');
  await page.waitForFunction(() => window.gettingOver.gameProject().library.some(model => model.id === 'odd-rig'));
  const odd = (await project()).library.find(model => model.id === 'odd-rig');
  assert.equal(odd.avatar.boneMap.head, 'Skull');
  assert.deepEqual(odd.avatar.grips, profiles().primary.grips, 'A new avatar takes the open character\'s settings.');
  assert.match(await page.locator('.project-library-bones-status').textContent(), /apply to the library avatar/);
  await page.locator('.project-library-bones-close').click();
  // The open character's settings, taken for an existing avatar, apply at once to its preview.
  await page.locator('#project-library-avatar-preview').selectOption('giant');
  await page.waitForFunction(() => window.gettingOver.gameProject().parts.avatar === 'giant');
  await frames(page);
  view = await rendering();
  assert.deepEqual([view.importedAvatar.name, view.importedAvatar.visible, view.grips.slideAt], ['Giant', true, GIANT.grips.slideAt]);
  await page.getByRole('button', { name: 'Use the open character\'s grips, arm lengths and arm distance for avatar giant' }).click();
  await page.waitForFunction(() => window.gettingOver.gameProject().library.find(model => model.id === 'giant').avatar.grips.placement === 'sliding' &&
    window.gettingOver.gameProject().library.find(model => model.id === 'giant').avatar.armForwardDistance === 0.25);
  await page.waitForFunction(slideAt => window.gettingOver.level().rendering.grips.slideAt === slideAt, profiles().primary.grips.slideAt);
  view = await rendering();
  assert.deepEqual([view.importedAvatar.name, view.importedAvatar.visible], ['Giant', true], 'A previewed avatar stays drawn when its settings change.');
  // Removing the previewed model returns the part to the character's own.
  await page.getByRole('button', { name: 'Remove hammer club' }).click();
  await page.waitForFunction(() => window.gettingOver.gameProject().parts.hammer === null);
  assert.deepEqual((await project()).dirty, ['models']);

  // Saving writes the library section and its files, and nothing else.
  const revisions = (await api('GET', '/api/projects/swap/revision')).value.sections;
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.waitForFunction(() => window.gettingOver.gameProject().dirty.length === 0 && window.gettingOver.gameProject().busy === null);
  const after = (await api('GET', '/api/projects/swap/revision')).value.sections;
  assert.deepEqual(Object.keys(after).filter(name => after[name] !== revisions[name]), ['models']);
  const stored = (await api('GET', '/api/projects/swap/models')).value;
  assert.deepEqual(stored.hammer.map(entry => entry.id), ['mallet', 'stone-club']);
  assert.deepEqual(stored.avatar.map(entry => entry.id), ['knight', 'giant', 'odd-rig']);
  assert.equal(stored.avatar[2].boneMap.head, 'Skull');
  assert.deepEqual(stored.avatar[1].grips, profiles().primary.grips);
  assert.equal((await api('GET', '/api/projects/swap/models/hammer/club/model')).status, 404);
  assert.deepEqual((await api('GET', '/api/projects/swap/models/avatar/odd-rig/model')).value, skull);

  // A library change made through the API appears in the Workshop.
  assert.equal((await api('DELETE', '/api/projects/swap/models/pot/urn')).status, 200);
  await page.waitForFunction(() => !window.gettingOver.gameProject().library.some(model => model.id === 'urn'), null, { timeout: 10_000 });
  await page.waitForFunction(() => window.gettingOver.gameProject().parts.pot === null, null, { timeout: 10_000 });

  // The exported project file carries the library.
  await openSection(page, 'project-file');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export project file' }).click()]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.deepEqual(Object.keys(exported.files).filter(path => path.startsWith('models/')).sort(),
    ['models/avatar/giant.glb', 'models/avatar/knight.glb', 'models/avatar/odd-rig.glb', 'models/hammer/mallet.glb', 'models/hammer/stone-club.glb', 'models/pot/vase.glb']);
  assert.deepEqual(errors, [], 'The Workshop library logs no errors.');
  result.workshop = { previews: 3, added: ['stone-club', 'odd-rig'], saved: 'models' };
  return result;
}

try {
  browser = await chromium.launch();
  const bundle = await swapBundle();
  const project = await writeProject(bundle, join(temporary, 'swap-project'));
  report.release = await verifyRelease(project);
  report.checks = await verifyChecks(bundle);
  report.workshop = await verifyWorkshop(bundle);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  for (const close of closers.reverse()) await close().catch(() => {});
  await browser?.close();
  setEnv([...GAME_VARIABLES, ...STUDIO_VARIABLES], Object.fromEntries(Object.entries(saved).filter(([, value]) => value !== undefined)));
  if (report.status === 'passed') await rm(temporary, { recursive: true, force: true });
  await writeFile(join(artifacts, 'model-swap-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
