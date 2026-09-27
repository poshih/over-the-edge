// A Workshop built with GAME_PROJECT, deployed as a static site: it opens its project, keeps the
// page's copy in the browser, leaves older browser saves alone and follows redeployments.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { build, createServer as createViteServer } from 'vite';
import { modelFixture } from './verify-appearance.mjs';
import { hammerGlb, HUMANOID_BONE_MAP, skinnedAvatarGlb } from './character-fixtures.mjs';
import { musicFixture } from './project-fixtures.mjs';
import { observeBrowserPage } from './verify-level.mjs';
import { openSection } from './workshop-ui.mjs';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.webm': 'video/webm',
};
const glbData = (bytes) => `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`;
const bundleOutput = (bundle) => (Array.isArray(bundle) ? bundle : [bundle]).flatMap((result) => result.output);
const PROJECT_ASSET = /^assets\/.*\.(json|wav|glb)$/;

// A static host like a Workers static-assets deployment: files, else index.html. `deploy` swaps the
// served build at the same address, so browser storage carries over like on a real redeploy.
async function staticSite() {
  let directory = null;
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent(new URL(request.url, 'http://site').pathname);
      requests.push(path);
      let file = resolve(directory, `.${path}`);
      const found = file.startsWith(directory + sep) && await stat(file).then((entry) => entry.isFile(), () => false);
      if (!found) file = join(directory, 'index.html');
      response.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    })().catch((error) => { response.statusCode = 500; response.end(String(error)); });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    deploy(next) { directory = next; },
    close: () => new Promise((done) => server.close(done)),
  };
}

export async function verifyWorkshopProject(browser, { root, temporary, errors, largeLevel, projectFile }) {
  const workshopConfig = join(root, 'vite.config.ts');
  const report = { builds: {}, flows: [], performance: {} };
  const workshopBuild = async (env, outDir) => {
    const saved = { GAME_PROJECT: process.env.GAME_PROJECT, GAME_TITLE: process.env.GAME_TITLE };
    delete process.env.GAME_PROJECT;
    delete process.env.GAME_TITLE;
    Object.assign(process.env, env);
    try {
      return await build({ configFile: workshopConfig, logLevel: 'silent', build: { write: outDir !== undefined, outDir, emptyOutDir: true } });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  // A representative game: about 1,000 level objects, a 10 MiB music track, an imported skinned
  // avatar as the primary character, a second character, an appearance model and arm IK.
  const v1 = join(temporary, 'workshop-v1');
  await cp(join(root, 'examples/projects/lantern-cavern'), v1, { recursive: true });
  const manifest = JSON.parse(await readFile(join(v1, 'project.json'), 'utf8'));
  await writeFile(join(v1, 'level.json'), JSON.stringify(largeLevel(990)));
  await writeFile(join(v1, 'media/cavern-loop.wav'), musicFixture({ seconds: 240 }));
  await mkdir(join(v1, 'characters'), { recursive: true });
  await mkdir(join(v1, 'appearance'), { recursive: true });
  await writeFile(join(v1, 'characters/primary.json'), JSON.stringify({
    schemaVersion: 11, characterRiggingType: 'avatar-3d', armForwardDistance: 0.25, grips: { placement: 'sliding', left: 0.04, right: 0.22 }, arms: null, images: [], layers: [], skeleton: null, presentation: null,
    models: [{ id: 'avatar', name: 'Climber', source: glbData(skinnedAvatarGlb()) }], avatar: { model: 'avatar', boneMap: HUMANOID_BONE_MAP },
  }));
  await writeFile(join(v1, 'characters/alternate.json'), JSON.stringify({
    schemaVersion: 11, characterRiggingType: 'model-3d', armForwardDistance: 0.3, grips: { placement: 'fixed', left: 0.04, right: 0.22 }, arms: null, images: [], layers: [], skeleton: null, presentation: null,
    models: [{ id: 'hammer', name: 'Mallet', source: glbData(hammerGlb()) }], hammer: { model: 'hammer' },
  }));
  await writeFile(join(v1, 'appearance/torso.glb'), modelFixture({ size: [0.6, 0.8, 0.4] }));
  await writeFile(join(v1, 'project.json'), JSON.stringify({
    ...manifest,
    characters: { primary: 'characters/primary.json', alternate: 'characters/alternate.json' },
    appearance: [{ part: 'torso', name: 'Armour.glb', alignment: { scale: 1.1, rotationX: 0, rotationY: 20, rotationZ: 0, offsetX: 0, offsetY: 0.05, offsetZ: 0 } }],
    armIk: { ...manifest.armIk, leftHintX: -0.9 },
  }));
  // The next deployment changes the look and the HUD.
  const v2 = join(temporary, 'workshop-v2');
  await cp(v1, v2, { recursive: true });
  await writeFile(join(v2, 'project.json'), JSON.stringify({
    ...JSON.parse(await readFile(join(v1, 'project.json'), 'utf8')),
    theme: { ...manifest.theme, sky: '#203040' }, hud: { ...manifest.hud, height: { ...manifest.hud.height, label: 'CAVE DEPTH' } },
  }));

  // 1. Builds -------------------------------------------------------------------------------
  const plain = bundleOutput(await workshopBuild({}));
  assert.deepEqual(plain.filter((file) => PROJECT_ASSET.test(file.fileName)).map((file) => file.fileName), [],
    'A Workshop built without GAME_PROJECT ships no project files.');
  const plainScript = plain.filter((file) => file.type === 'chunk').reduce((sum, file) => sum + file.code.length, 0);
  const w1 = join(temporary, 'workshop-site-v1');
  const w2 = join(temporary, 'workshop-site-v2');
  const started = Date.now();
  const built = bundleOutput(await workshopBuild({ GAME_PROJECT: relative(root, v1) }, w1));
  report.performance.buildMs = Date.now() - started;
  await workshopBuild({ GAME_PROJECT: relative(root, v2) }, w2);
  const assets = built.filter((file) => PROJECT_ASSET.test(file.fileName)).map((file) => file.fileName);
  for (const pattern of [/^assets\/project-.*\.json$/, /^assets\/level-.*\.json$/, /^assets\/primary-.*\.json$/, /^assets\/alternate-.*\.json$/, /^assets\/torso-.*\.glb$/]) {
    assert.equal(assets.filter((file) => pattern.test(file)).length, 1, `The Workshop build emits ${pattern}.`);
  }
  assert.equal(assets.filter((file) => file.endsWith('.wav')).length, 6);
  const scripts = built.filter((file) => file.type === 'chunk');
  assert.ok(!scripts.some((file) => file.code.includes('LANTERN TIME') || file.code.includes('block-500')), 'Project data is fetched, not inlined.');
  const script = scripts.reduce((sum, file) => sum + file.code.length, 0);
  assert.ok(script - plainScript < 2048, `The project adds ${script - plainScript} bytes of JavaScript.`);
  assert.match(built.find((file) => file.fileName === 'index.html').source, /<title>Lantern Cavern \| Physics Playground<\/title>/);
  const broken = join(temporary, 'workshop-broken');
  await cp(v1, broken, { recursive: true });
  await writeFile(join(broken, 'project.json'), JSON.stringify({ ...manifest, theme: { ...manifest.theme, sky: 'blue' } }));
  await assert.rejects(workshopBuild({ GAME_PROJECT: relative(root, broken) }), /theme: Sky colour must be a lowercase #rrggbb colour/);
  await assert.rejects(workshopBuild({ GAME_PROJECT: relative(root, v1), GAME_TITLE: 'Other' }), /GAME_TITLE cannot be combined with GAME_PROJECT/);
  report.builds = { assets: assets.length, addedScriptBytes: script - plainScript, rejected: ['invalid theme', 'GAME_TITLE'] };

  const site = await staticSite();
  site.deploy(w1);
  const recordNotices = () => {
    window.__notices = [];
    new MutationObserver(() => {
      const text = document.querySelector('.notice-message')?.textContent;
      if (text && window.__notices.at(-1) !== text) window.__notices.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  };
  const contexts = [];
  // observeBrowserPage accepts dialogs; only the confirmation of Reopen published project is expected.
  const dialogs = [];
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    await context.addInitScript(recordNotices);
    const page = await context.newPage();
    await observeBrowserPage(page, errors);
    page.on('dialog', (dialog) => dialogs.push(dialog.type()));
    return page;
  };
  const project = (page) => page.evaluate(() => window.gettingOver.gameProject());
  const projectTab = async (page) => {
    const toggle = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByRole('tab', { name: 'Project', exact: true }).click();
  };
  const ready = (page, origin) => page.waitForFunction((origin) => {
    const state = window.gettingOver?.gameProject();
    return state?.busy === null && state.published?.origin === origin && state.server !== null;
  }, origin, { timeout: 30_000 });
  const kept = (page) => page.waitForFunction(() => {
    const copy = window.gettingOver.gameProject().browserCopy;
    return copy.stored && !copy.pending;
  }, null, { timeout: 10_000 });
  const look = (page) => page.evaluate(() => ({
    title: window.gettingOver.gameProject().title,
    objects: window.gettingOver.level().definition.objects.length,
    sky: window.gettingOver.level().rendering.theme.sky,
    hud: document.querySelector('.height-metric .eyebrow').textContent,
    alternate: window.gettingOver.gameProject().alternate?.characterRiggingType ?? null,
    dirty: window.gettingOver.gameProject().dirty,
  }));
  const storage = (page) => page.evaluate(async () => {
    const records = (name, store) => new Promise((done, fail) => {
      const request = indexedDB.open(name);
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(store)) { database.close(); done([]); return; }
        const all = database.transaction(store).objectStore(store).getAll();
        all.onsuccess = () => { database.close(); done(all.result); };
        all.onerror = () => fail(all.error);
      };
    });
    const sprites = await records('over-the-edge:sprites', 'documents');
    const parts = await records('over-the-edge:appearance', 'parts');
    return {
      sprites: JSON.stringify(sprites),
      parts: parts.map((part) => ({ slot: part.slot, name: part.name, bytes: part.data.size, alignment: part.alignment })),
      local: Object.fromEntries(Object.keys(localStorage).filter((key) => /arm-ik|game-settings/.test(key)).sort().map((key) => [key, localStorage.getItem(key)])),
    };
  });

  try {
    // 2. A fresh browser opens the published project -------------------------------------------
    const fresh = await open();
    let time = Date.now();
    await fresh.goto(site.base, { waitUntil: 'domcontentloaded' });
    await ready(fresh, 'current');
    report.performance.openPublishedMs = Date.now() - time;
    assert.equal(await fresh.title(), 'Lantern Cavern | Physics Playground');
    const opened = await fresh.evaluate(() => ({
      grip: window.gettingOver.settings().physics.gripFriction,
      leftHintX: window.gettingOver.appearance().armIk.settings.leftHintX,
      torso: window.gettingOver.appearance().parts.find((part) => part.id === 'torso').name,
      primary: window.gettingOver.sprites().document.characterRiggingType,
      avatar: window.gettingOver.level().rendering.importedAvatar?.visible ?? false,
      media: window.gettingOver.gameProject().media.length,
      server: window.gettingOver.gameProject().server.available,
      copy: window.gettingOver.gameProject().browserCopy,
    }));
    assert.deepEqual(opened, { grip: 3.2, leftHintX: -0.9, torso: 'Armour.glb', primary: 'avatar-3d', avatar: true, media: 6, server: false, copy: { stored: false, pending: false, writes: 0 } });
    assert.deepEqual(await look(fresh), { title: 'Lantern Cavern', objects: 991, sky: '#0e1418', hud: 'DEPTH CLIMBED', alternate: 'model-3d', dirty: [] });
    const notices = await fresh.evaluate(() => window.__notices);
    assert.ok(notices.some((text) => /^Loading "Lantern Cavern": \d+%$/.test(text)), `Loading shows progress: ${notices.join(' | ')}`);
    assert.equal(notices.at(-1), 'Opened the published project "Lantern Cavern".');
    await projectTab(fresh);
    assert.match(await fresh.locator('.project-status').textContent(), /^The published project · no unsaved changes$/);
    report.flows.push('open published');

    // 3. Changes stay in this browser across reloads --------------------------------------------
    await openSection(fresh, 'project-theme');
    await fresh.locator('#project-theme-sky').evaluate((input) => { input.value = '#223344'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await openSection(fresh, 'project-characters');
    await fresh.getByRole('button', { name: 'Remove alternate', exact: true }).click();
    await fresh.getByRole('tab', { name: 'Level', exact: true }).click();
    await fresh.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
    await fresh.locator('[data-level-preset="box"]').click();
    const overlay = await fresh.locator('.level-overlay').boundingBox();
    await fresh.mouse.click(overlay.x + overlay.width * 0.5, overlay.y + overlay.height * 0.4);
    await fresh.waitForFunction(() => window.gettingOver.level().definition.objects.length === 992);
    time = Date.now();
    await kept(fresh);
    report.performance.firstCopyMs = Date.now() - time;
    assert.deepEqual((await project(fresh)).dirty, ['level', 'characters/alternate', 'theme']);
    // Nothing changes while the page is idle, so nothing is written again.
    const writes = (await project(fresh)).browserCopy.writes;
    await fresh.waitForTimeout(3000);
    assert.equal((await project(fresh)).browserCopy.writes, writes, 'An idle page does not rewrite its copy.');
    const downloads = site.requests.length;
    time = Date.now();
    await fresh.reload({ waitUntil: 'domcontentloaded' });
    await ready(fresh, 'current');
    report.performance.reopenCopyMs = Date.now() - time;
    assert.deepEqual(await look(fresh), {
      title: 'Lantern Cavern', objects: 992, sky: '#223344', hud: 'DEPTH CLIMBED', alternate: null, dirty: ['level', 'characters/alternate', 'theme'],
    });
    assert.equal(await fresh.evaluate(() => window.gettingOver.level().editor.dirty), true, 'Level still shows its unsaved changes.');
    assert.equal(await fresh.evaluate(() => window.gettingOver.sprites().document.characterRiggingType), 'avatar-3d');
    assert.deepEqual(site.requests.slice(downloads).filter((path) => PROJECT_ASSET.test(path.slice(1))), [],
      'Reopening the browser copy downloads nothing from the published project.');
    assert.equal(await fresh.evaluate(() => window.__notices.at(-1)),
      'Reopened "Lantern Cavern" from this browser with unsaved changes: level, characters/alternate, theme.');
    report.flows.push('edit and reload');

    // 4. Older browser saves neither open nor change --------------------------------------------
    const older = await open();
    await older.goto(`${site.base}/favicon.svg`);
    const head = [...modelFixture({ size: [0.3, 0.3, 0.3] })];
    await older.evaluate(async ({ head, settings }) => {
      const put = (name, store, keyPath, record) => new Promise((done, fail) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(store, { keyPath });
        request.onsuccess = () => {
          const transaction = request.result.transaction(store, 'readwrite');
          transaction.objectStore(store).put(record);
          transaction.oncomplete = () => { request.result.close(); done(); };
          transaction.onerror = () => fail(transaction.error);
        };
        request.onerror = () => fail(request.error);
      });
      // The editor's own saved profile, which must not replace the project's character.
      await put('over-the-edge:sprites', 'documents', 'id', {
        id: 'active', document: {
          schemaVersion: 11, characterRiggingType: 'model-3d', armForwardDistance: 0.7, grips: { placement: 'fixed', left: 0.04, right: 0.22 }, arms: null,
          images: [], layers: [], skeleton: null, presentation: null,
        },
      });
      await put('over-the-edge:appearance', 'parts', 'slot', {
        schemaVersion: 1, slot: 'character-head', name: 'Old head.glb', data: new Blob([new Uint8Array(head)], { type: 'model/gltf-binary' }),
        alignment: { scale: 1, rotationX: 0, rotationY: 0, rotationZ: 0, offsetX: 0, offsetY: 0, offsetZ: 0 },
      });
      const profile = 'over-the-edge:appearance:arm-ik:profile:v2:00112233445566778899aabbccddeeff';
      localStorage.setItem(profile, JSON.stringify({
        schemaVersion: 2, name: 'Old elbows', savedAt: 1_700_000_000_000,
        settings: { leftHintX: -0.4, leftHintY: 0.1, leftHintZ: -0.3, rightHintX: 0.4, rightHintY: 0.1, rightHintZ: 0.4 },
      }));
      localStorage.setItem('over-the-edge:appearance:arm-ik:active:v2', JSON.stringify({ schemaVersion: 2, key: profile }));
      localStorage.setItem('over-the-edge:game-settings:snapshot:v3:ffeeddccbbaa99887766554433221100', JSON.stringify({
        schemaVersion: 3, name: 'Old physics', savedAt: 1_700_000_000_000, settings,
      }));
    }, { head, settings: manifest.settings });
    const seeded = await storage(older);
    await older.goto(site.base, { waitUntil: 'domcontentloaded' });
    await ready(older, 'current');
    const booted = await older.evaluate(() => ({
      primary: window.gettingOver.sprites().document.characterRiggingType,
      armForwardDistance: window.gettingOver.sprites().document.armForwardDistance,
      grips: window.gettingOver.sprites().document.grips.placement,
      avatar: window.gettingOver.level().rendering.importedAvatar?.visible ?? false,
      head: window.gettingOver.appearance().parts.find((part) => part.id === 'character-head').name,
      torso: window.gettingOver.appearance().parts.find((part) => part.id === 'torso').name,
      leftHintX: window.gettingOver.appearance().armIk.settings.leftHintX,
      profile: window.gettingOver.appearance().armIk.profile?.name ?? null,
    }));
    assert.deepEqual(booted, {
      primary: 'avatar-3d', armForwardDistance: 0.25, grips: 'sliding', avatar: true, head: null, torso: 'Armour.glb',
      leftHintX: -0.9, profile: 'Old elbows',
    }, 'The project, not the editor\'s own saves, opens.');
    assert.deepEqual(await storage(older), seeded, 'Opening the project leaves older browser saves unchanged.');
    report.flows.push('older saves untouched');

    // 5. A redeployment with a changed project ---------------------------------------------------
    site.deploy(w2);
    // A page with unsaved changes keeps them and offers the new version.
    await fresh.reload({ waitUntil: 'domcontentloaded' });
    await ready(fresh, 'outdated');
    assert.deepEqual(await look(fresh), {
      title: 'Lantern Cavern', objects: 992, sky: '#223344', hud: 'DEPTH CLIMBED', alternate: null, dirty: ['level', 'characters/alternate', 'theme'],
    });
    assert.match(await fresh.evaluate(() => window.__notices.at(-1)), /has a newer published version\. This browser kept your unsaved changes/);
    await projectTab(fresh);
    assert.match(await fresh.locator('.project-status').textContent(), /^An older version of the published project; a newer one is published · kept in this browser · unsaved: /);
    await fresh.getByRole('button', { name: 'Reopen published project', exact: true }).click();
    await ready(fresh, 'current');
    assert.deepEqual(dialogs, ['confirm'], 'Only discarding unsaved changes asks first; reloads do not warn.');
    await fresh.waitForFunction(() => !window.gettingOver.gameProject().browserCopy.stored);
    assert.deepEqual(await look(fresh), { title: 'Lantern Cavern', objects: 991, sky: '#203040', hud: 'CAVE DEPTH', alternate: 'model-3d', dirty: [] });
    await fresh.reload({ waitUntil: 'domcontentloaded' });
    await ready(fresh, 'current');
    assert.equal((await look(fresh)).sky, '#203040', 'Reopen published project discarded the browser copy.');
    // A page without unsaved changes opens the new version.
    await older.reload({ waitUntil: 'domcontentloaded' });
    await ready(older, 'current');
    assert.deepEqual(await look(older), { title: 'Lantern Cavern', objects: 991, sky: '#203040', hud: 'CAVE DEPTH', alternate: 'model-3d', dirty: [] });
    report.flows.push('redeploy', 'reopen published');

    // 6. An imported project is the page's own: it stays over the published one -----------------
    await projectTab(older);
    await openSection(older, 'project-file');
    const bundle = JSON.parse(await readFile(projectFile, 'utf8'));
    bundle.files['project.json'] = { ...bundle.files['project.json'], title: 'Lantern Remix' };
    await older.locator('.project-file-input').setInputFiles({ name: 'remix.project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
    await older.waitForFunction(() => window.gettingOver.gameProject().title === 'Lantern Remix' && window.gettingOver.gameProject().busy === null);
    await kept(older);
    await older.reload({ waitUntil: 'domcontentloaded' });
    await ready(older, 'none');
    assert.equal((await look(older)).title, 'Lantern Remix');
    assert.deepEqual(await storage(older), seeded, 'Importing leaves older browser saves unchanged.');
    assert.deepEqual(dialogs, ['confirm']);
    report.flows.push('import stays');

    // 7. Tabs share one copy, and it always holds one page's whole project ----------------------
    const other = await fresh.context().newPage();
    await observeBrowserPage(other, errors);
    other.on('dialog', (dialog) => dialogs.push(dialog.type()));
    await other.goto(site.base, { waitUntil: 'domcontentloaded' });
    await ready(other, 'current');
    const colour = (page, id, value) => page.locator(id).evaluate((input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await projectTab(other);
    await openSection(other, 'project-theme');
    await colour(other, '#project-theme-sky', '#112233');
    await kept(other);
    await projectTab(fresh);
    await openSection(fresh, 'project-theme');
    await colour(fresh, '#project-theme-fog-color', '#445566');
    await kept(fresh);
    await openSection(other, 'project-characters');
    await other.getByRole('button', { name: 'Remove alternate', exact: true }).click();
    await kept(other);
    // The first tab stores again after the second one removed a file it still uses: all of its
    // project is written, not only its latest change.
    await colour(fresh, '#project-theme-sky', '#223355');
    await kept(fresh);
    await other.reload({ waitUntil: 'domcontentloaded' });
    await ready(other, 'current');
    assert.deepEqual(await look(other), { title: 'Lantern Cavern', objects: 991, sky: '#223355', hud: 'CAVE DEPTH', alternate: 'model-3d', dirty: ['theme'] });
    assert.equal(await other.evaluate(() => window.gettingOver.level().rendering.theme.fog.color), '#445566');
    await other.close();
    report.flows.push('tabs');

    // 8. The development server serves the project; a server project keeps precedence ----------
    const variables = ['GAME_PROJECT', 'STUDIO_PROJECTS', 'STUDIO_RELEASES', 'STUDIO_TOKEN', 'STUDIO_API'];
    const environment = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
    delete process.env.STUDIO_API;
    Object.assign(process.env, {
      GAME_PROJECT: relative(root, v2), STUDIO_TOKEN: '',
      STUDIO_PROJECTS: relative(root, join(temporary, 'workshop-projects')), STUDIO_RELEASES: relative(root, join(temporary, 'workshop-releases')),
    });
    let dev;
    try {
      dev = await createViteServer({ configFile: workshopConfig, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: true } });
    } finally {
      for (const [name, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    await dev.listen();
    const page = await open();
    try {
      await page.goto(`http://127.0.0.1:${dev.httpServer.address().port}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const state = window.gettingOver?.gameProject();
        return state?.busy === null && state.published?.origin === 'current' && state.server?.available === true;
      }, null, { timeout: 30_000 });
      assert.equal((await look(page)).hud, 'CAVE DEPTH');
      await projectTab(page);
      await openSection(page, 'project-theme');
      await colour(page, '#project-theme-sky', '#101010');
      await kept(page);
      await openSection(page, 'project-server');
      await page.locator('#project-id').fill('bundled-remix');
      await page.getByRole('button', { name: 'Save as project ID', exact: true }).click();
      await page.waitForFunction(() => window.gettingOver.gameProject().binding?.id === 'bundled-remix' && window.gettingOver.gameProject().busy === null,
        null, { timeout: 30_000 });
      await page.waitForFunction(() => !window.gettingOver.gameProject().browserCopy.stored);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.gettingOver?.gameProject().binding?.id === 'bundled-remix' && window.gettingOver.gameProject().busy === null,
        null, { timeout: 30_000 });
      assert.equal((await look(page)).sky, '#101010');
      assert.equal((await project(page)).published.origin, 'none');
      // Unsaved server work still warns before leaving, although Level does not warn here.
      await projectTab(page);
      await openSection(page, 'project-theme');
      await colour(page, '#project-theme-sky', '#101011');
      assert.equal(await page.evaluate(() => window.gettingOver.gameProject().browserCopy.pending), true);
    } finally {
      // The page polls the server, so it goes first.
      await page.context().close();
      await dev.close();
    }
    report.flows.push('dev server', 'server precedence');

    // 9. A download that fails is reported, and keeps no copy ----------------------------------
    const partial = join(temporary, 'workshop-site-partial');
    await cp(w2, partial, { recursive: true });
    const levelAsset = (await readdir(join(partial, 'assets'))).find((file) => /^level-.*\.json$/.test(file));
    await rm(join(partial, 'assets', levelAsset));
    site.deploy(partial);
    const failing = await open();
    await failing.goto(site.base, { waitUntil: 'domcontentloaded' });
    await failing.waitForFunction(() => window.gettingOver?.gameProject().error !== null && window.gettingOver.gameProject().busy === null,
      null, { timeout: 30_000 });
    const failed = await project(failing);
    assert.match(failed.error, /level\.json does not match this Workshop/);
    assert.equal(await failing.evaluate(() => window.__notices.at(-1)), failed.error);
    assert.deepEqual([failed.published.origin, failed.browserCopy.stored], ['none', false]);
    report.flows.push('failed download');
  } finally {
    for (const context of contexts) await context.close();
    await site.close();
  }
  return report;
}
