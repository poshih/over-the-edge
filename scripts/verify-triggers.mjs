import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { observeBrowserPage } from './verify-level.mjs';
import { openSection } from './workshop-ui.mjs';

const VIDEO_DURATION_MS = 4000;
const UPDRAFT_TRIANGLES = 76;
const LEGACY_KEY = `over-the-edge:level:snapshot:v1:${'a'.repeat(32)}`;
const FLOOR = {
  kind: 'terrain', id: 'floor', shape: { type: 'box' }, x: 0, y: -1,
  width: 30, height: 2, angle: 0, depth: 2, color: 0x71817a, illusion: false,
};
const START = { kind: 'start', id: 'start', x: 0, y: 4, angle: 0.5, extension: 0.3 };

function scene(id, events) {
  return {
    schemaVersion: 2, labels: [],
    objects: [
      FLOOR, START,
      {
        kind: 'trigger', id, name: id, x: 0, y: 1,
        region: { type: 'box', width: 8, height: 2 },
        activation: 'once', marker: 'flag', events,
      },
    ],
  };
}

async function recordVideo(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const bytes = await page.evaluate(async (duration) => {
      const mimeType = 'video/webm;codecs=vp8,opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('The browser must encode the local media fixture.');
      const canvas = document.createElement('canvas');
      canvas.width = 160; canvas.height = 90;
      const paint = canvas.getContext('2d');
      if (!paint) throw new Error('A canvas context is required.');
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const destination = audio.createMediaStreamDestination();
      gain.gain.value = 0.002;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await audio.resume();
      const stream = canvas.captureStream(10);
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks = [];
      const stopped = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => chunks.push(event.data);
        recorder.onstop = resolve;
        recorder.onerror = () => reject(new Error('Recording the local clip failed.'));
      });
      recorder.start();
      let frame = 0;
      const interval = setInterval(() => {
        paint.fillStyle = ++frame % 2 ? '#365e56' : '#cead72';
        paint.fillRect(0, 0, canvas.width, canvas.height);
      }, 50);
      await new Promise(resolve => setTimeout(resolve, duration));
      recorder.stop();
      await stopped;
      clearInterval(interval);
      oscillator.stop();
      for (const track of stream.getTracks()) track.stop();
      await audio.close();
      return [...new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer())];
    }, VIDEO_DURATION_MS);
    return Buffer.from(bytes);
  } finally { await context.close(); }
}

export async function verifyTriggers(browser, address, artifacts) {
  const video = await recordVideo(browser);
  const media = createServer((request, response) => {
    if (request.url !== '/clip.webm') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': video.length, 'Access-Control-Allow-Origin': '*' });
    response.end(video);
  });
  media.listen(0, '127.0.0.1');
  await once(media, 'listening');
  const source = `http://127.0.0.1:${media.address().port}/clip.webm`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const report = { errors: [], videoBytes: video.length };
  await observeBrowserPage(page, report.errors);
  const physics = () => page.evaluate(() => window.gettingOver.snapshot());
  const events = () => page.evaluate(() => window.gettingOver.events());
  const level = () => page.evaluate(() => window.gettingOver.level());
  const triggerState = async id => (await events()).triggers.triggers.find(trigger => trigger.id === id);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const edit = async () => {
    if ((await physics()).pointerLocked) {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.gettingOver.snapshot().pointerLocked);
    }
    const workshop = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await workshop.getAttribute('aria-expanded') === 'false') await workshop.click();
    await page.getByRole('tab', { name: 'Level', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
    await openSection(page, 'level-saved', 'level-file');
  };
  const load = async definition => {
    await edit();
    const before = (await level()).editor.commits;
    await page.locator('.level-file').setInputFiles({
      name: 'trigger-course.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(definition)),
    });
    await page.waitForFunction(commits => window.gettingOver.level().editor.commits > commits, before);
  };
  const play = async () => {
    await page.locator('.level-play').click();
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'inactive');
  };
  const startVideo = async () => {
    await page.locator('video').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Play video');
      return video?.currentTime > 0 || button && !button.hidden && button.getClientRects().length > 0;
    });
    const button = page.getByRole('button', { name: 'Play video', exact: true });
    if (await button.isVisible()) await button.click();
    await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0);
  };
  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    const { kind, ...legacyFloor } = FLOOR;
    const legacy = {
      schemaVersion: 1,
      spawn: { position: { x: START.x, y: START.y }, angle: START.angle, extension: START.extension },
      summit: { xMin: 8, xMax: 10, y: 5, arrivalTolerance: 0.1 }, labels: [], objects: [legacyFloor],
    };
    const record = JSON.stringify({ schemaVersion: 1, name: 'Legacy level', savedAt: Date.now(), level: legacy });
    await page.evaluate(({ key, record }) => localStorage.setItem(key, record), { key: LEGACY_KEY, record });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    await edit();
    await page.getByRole('combobox', { name: 'Past levels', exact: true }).selectOption(LEGACY_KEY);
    await page.locator('.load-level').click();
    const migrated = (await level()).definition;
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.objects.filter(object => object.kind === 'start').length, 1);
    assert.equal(migrated.objects.filter(object => object.kind === 'trigger').length, 1);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), LEGACY_KEY), record);
    await page.getByRole('textbox', { name: 'Level name', exact: true }).fill('Converted level');
    await page.getByRole('textbox', { name: 'Level name', exact: true }).press('Enter');
    const savedKey = await page.getByRole('combobox', { name: 'Past levels', exact: true }).inputValue();
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), savedKey);
    assert.equal(saved.level.schemaVersion, 2);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), LEGACY_KEY), record);
    report.migration = { namedV1Loaded: true, originalPreserved: true, newSavesV2: true };

    await load(scene('authoring', [{ type: 'popup', title: 'Original title', message: 'Original message' }]));
    await frames();
    const handle = await page.evaluate(() => window.gettingOver.project({ x: 0, y: 1 }));
    await page.mouse.click(handle.x, handle.y);
    const titleField = page.getByRole('textbox', { name: 'Title', exact: true });
    const messageField = page.getByRole('textbox', { name: 'Message', exact: true });
    await titleField.fill('Edited title');
    await messageField.fill('Edited message');
    await page.getByRole('button', { name: 'Apply events', exact: true }).click();
    const authoredEvents = async () => (await level()).definition.objects.find(object => object.id === 'authoring').events;
    assert.deepEqual(await authoredEvents(), [{ type: 'popup', title: 'Edited title', message: 'Edited message' }]);

    await messageField.fill('Saved message');
    await titleField.fill('Saved title');
    await page.getByRole('textbox', { name: 'Level name', exact: true }).fill('Edited event fields');
    await page.getByRole('textbox', { name: 'Level name', exact: true }).press('Enter');
    const authoredKey = await page.getByRole('combobox', { name: 'Past levels', exact: true }).inputValue();
    const authoredSave = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), authoredKey);
    const popupFields = [{ type: 'popup', title: 'Saved title', message: 'Saved message' }];
    assert.deepEqual(await authoredEvents(), popupFields);
    assert.deepEqual(authoredSave.level.objects.find(object => object.id === 'authoring').events, popupFields);
    await titleField.fill('Discard this title');
    await messageField.fill('Discard this message');
    await page.getByRole('button', { name: 'Revert events', exact: true }).click();
    assert.equal(await titleField.inputValue(), 'Saved title');
    assert.equal(await messageField.inputValue(), 'Saved message');
    report.authoring = { bothPopupFieldsApplied: true, reverseOrderSaved: true, revertRestoresBoth: true };

    assert.equal(await page.locator('.level-gizmo-layer > .level-gizmo-start').count(), 1);
    assert.equal(await page.locator('.level-gizmo-layer > .level-gizmo-trigger').count(), 1);
    await load({
      schemaVersion: 2, labels: [],
      objects: [
        FLOOR,
        { ...FLOOR, id: START.id, x: 8, y: 1, width: 1 },
        { ...FLOOR, id: 'authoring', x: -8, y: 1, width: 1 },
        { ...START, id: 'replacement-start' },
      ],
    });
    assert.equal(await page.locator('.level-gizmo-layer > .level-gizmo-start').count(), 1);
    assert.equal(await page.locator('.level-gizmo-layer > .level-gizmo-trigger').count(), 0);
    assert.equal((await level()).rendering.flags.instances, 0);
    assert.equal((await level()).terrain.bodyCount, 3);
    report.retypedEntities = { noPhantomStart: true, noPhantomTrigger: true, noPhantomFlag: true };

    const popupTitle = 'Arrival <b>note</b>';
    await load(scene('arrival', [
      { type: 'stop-timer' },
      { type: 'popup', title: popupTitle, message: 'The timer has stopped, not the physics engine.' },
    ]));
    assert.equal((await level()).terrain.bodyCount, 1, 'Start/trigger entities must never create colliders.');
    await play();
    const popup = page.getByRole('dialog');
    await popup.waitFor({ state: 'visible' });
    assert.ok((await popup.textContent()).includes(popupTitle));
    assert.equal(await popup.locator('b').count(), 0);
    const stopped = await physics();
    assert.equal(stopped.timer.running, false);
    assert.ok(stopped.timer.elapsed > 0);
    await page.waitForTimeout(200);
    assert.equal((await physics()).time, stopped.time, 'Presentation must pause simulation.');
    assert.equal((await physics()).timer.elapsed, stopped.timer.elapsed);
    await popup.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForFunction(time => window.gettingOver.snapshot().time > time + 0.5, stopped.time);
    assert.equal((await physics()).timer.elapsed, stopped.timer.elapsed, 'Physics must resume without advancing a stopped timer.');
    assert.equal((await triggerState('arrival')).activationCount, 1);
    assert.deepEqual((await triggerState('arrival')).actionStatuses, ['completed', 'completed']);
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.keyboard.press('r');
    await page.getByRole('dialog').waitFor({ state: 'visible' });
    assert.equal((await triggerState('arrival')).activationCount, 1, 'Restart begins a new activation scope.');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    report.popup = { textOnly: true, proximity: true, stopTimer: true, physicsResumed: true, oncePerRun: true, restartRearmed: true };

    await load(scene('movie', [{ type: 'play-video', source }, { type: 'stop-timer' }]));
    await play();
    await startVideo();
    const movie = await page.locator('video').boundingBox();
    assert.ok(movie.width >= 1200 && movie.height >= 650, 'Video must fill the game window.');
    const covered = (await level()).rendering.frames;
    const frozen = await physics();
    await page.waitForTimeout(200);
    assert.equal((await level()).rendering.frames, covered, 'Do not render the 3D scene behind an opaque video.');
    assert.equal((await physics()).time, frozen.time);
    await page.screenshot({ path: fileURLToPath(new URL('trigger-video.png', artifacts)) });
    await page.waitForFunction(() => window.gettingOver.events().triggers.triggers.find(trigger => trigger.id === 'movie')?.status === 'completed');
    assert.deepEqual((await triggerState('movie')).actionStatuses, ['completed', 'completed']);
    assert.equal((await physics()).timer.running, false);
    assert.equal(await page.locator('video').count(), 0);
    report.video = { fullWindow: true, realPlayback: true, pausesGame: true, backgroundRenderingStopped: true, naturalCompletion: true };

    await load(scene('skipped', [{ type: 'play-video', source }, { type: 'stop-timer' }]));
    await play();
    await startVideo();
    await page.getByRole('button', { name: /^Skip(?: video)?$/i }).click();
    await page.waitForFunction(() => window.gettingOver.events().triggers.triggers.find(trigger => trigger.id === 'skipped')?.status === 'completed');
    assert.deepEqual((await triggerState('skipped')).actionStatuses, ['skipped', 'completed']);
    report.skipped = true;

    await load(scene('aborted', [
      { type: 'play-video', source }, { type: 'launch-player', height: 8, strength: 1 }, { type: 'stop-timer' },
    ]));
    await play();
    await startVideo();
    await page.evaluate(() => {
      window.oldTriggerVideo = document.querySelector('video');
      document.querySelector('[data-action="reset"]').click();
      document.querySelector('[data-action="pause"]').click();
    });
    await frames();
    assert.equal(await page.locator('video').count(), 0);
    assert.equal((await physics()).timer.running, true);
    assert.equal((await physics()).timer.elapsed, 0);
    await page.evaluate(() => {
      window.oldTriggerVideo.dispatchEvent(new Event('ended'));
      delete window.oldTriggerVideo;
    });
    await frames();
    assert.equal((await physics()).timer.running, true, 'A cancelled video cannot run its old next event.');
    assert.equal((await physics()).rootVelocity.y, 0, 'A cancelled sequence cannot launch the new player rig.');
    assert.equal((await triggerState('aborted')).activationCount, 0);
    report.aborted = { resetRemovedMedia: true, lateCompletionIgnored: true, nextActionCancelled: true, launchCancelled: true };

    await load({ schemaVersion: 2, labels: [], objects: [FLOOR, START] });
    await page.locator('[data-level-preset="updraft"]').click();
    const base = await page.evaluate(() => window.gettingOver.project({ x: 0, y: 0 }));
    await page.mouse.click(base.x, base.y);
    await page.waitForFunction(() => window.gettingOver.level().definition.objects.some(object => object.kind === 'trigger'));
    const placed = (await level()).definition.objects.find(object => object.kind === 'trigger');
    assert.equal(placed.marker, 'updraft');
    assert.equal(placed.activation, 'on-enter');
    assert.ok(Math.abs(placed.y - placed.region.height / 2) < 0.01);
    assert.deepEqual(placed.events, [{ type: 'launch-player', height: 8, strength: 1 }]);
    const heightField = page.getByRole('spinbutton', { name: 'Lift height (m)', exact: true });
    const strengthField = page.getByRole('spinbutton', { name: 'Launch strength (x)', exact: true });
    await heightField.fill('6');
    await strengthField.fill('1.25');
    await page.locator('.level-event-apply').click();
    const launchEvents = async () => (await level()).definition.objects.find(object => object.id === placed.id).events;
    assert.deepEqual(await launchEvents(), [{ type: 'launch-player', height: 6, strength: 1.25 }]);
    await heightField.fill('0');
    await page.locator('.level-event-apply').click();
    assert.deepEqual(await launchEvents(), [{ type: 'launch-player', height: 6, strength: 1.25 }],
      'Invalid launch settings must not change the authored action.');
    assert.match(await page.locator('.ui-notice').innerText(), /Lift height/);
    await page.locator('.level-event-revert').click();
    assert.equal(await heightField.inputValue(), '6');
    await strengthField.fill('1');
    await page.getByRole('textbox', { name: 'Level name', exact: true }).fill('Updraft layout');
    await page.getByRole('textbox', { name: 'Level name', exact: true }).press('Enter');
    const updraftKey = await page.getByRole('combobox', { name: 'Past levels', exact: true }).inputValue();
    const updraftSave = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), updraftKey);
    assert.deepEqual(updraftSave.level.objects.find(object => object.id === placed.id).events,
      [{ type: 'launch-player', height: 6, strength: 1 }]);
    const downloadReady = page.waitForEvent('download');
    await page.locator('.level-export').click();
    const download = await downloadReady;
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.deepEqual(exported, updraftSave.level);
    await load(exported);
    assert.equal((await level()).rendering.updrafts.instances, 1);
    assert.equal((await level()).terrain.bodyCount, 1);
    assert.equal(await page.locator('.level-gizmo-layer .level-gizmo-updraft').count(), 1);
    await page.screenshot({ path: fileURLToPath(new URL('updraft-editor.png', artifacts)) });
    await play();
    await page.waitForFunction(id => {
      const trigger = window.gettingOver.events().triggers.triggers.find(trigger => trigger.id === id);
      return trigger?.activationCount === 1 && trigger.status === 'completed';
    }, placed.id);
    const launched = await physics();
    assert.ok(launched.rootVelocity.y > 0);
    assert.equal(launched.jointCount, 7);
    assert.equal(launched.bodyCount, 9, 'Updrafts must not add rigid bodies.');
    await page.screenshot({ path: fileURLToPath(new URL('updraft-launch.png', artifacts)) });
    await page.waitForFunction(() => {
      const snapshot = window.gettingOver.snapshot();
      return snapshot.rootVelocity.y < 0 && snapshot.height > 4;
    });
    const apex = (await physics()).bestHeight;
    assert.ok(apex > 7 && apex < 9, `A 6 m lift from the entry zone should have a plausible pot apex (${apex}m).`);
    await page.waitForFunction(id => window.gettingOver.events().triggers.triggers
      .find(trigger => trigger.id === id)?.activationCount === 2, placed.id);
    assert.deepEqual((await triggerState(placed.id)).actionStatuses, ['completed']);
    await page.keyboard.press('r');
    await page.waitForFunction(id => window.gettingOver.events().triggers.triggers
      .find(trigger => trigger.id === id)?.activationCount === 1, placed.id);
    report.updraft = { preset: true, savedAndExported: true, apex, reentry: true, resetRearmed: true, extraBodies: 0 };

    const holding = {
      ...placed, id: 'holding-updraft', x: 0, y: 25,
      region: { type: 'box', width: 30, height: 50 }, events: [{ type: 'launch-player', height: 6, strength: 1 }],
    };
    await load({ schemaVersion: 2, labels: [], objects: [FLOOR, START, holding] });
    await play();
    await page.waitForFunction(() => window.gettingOver.snapshot().time > 4);
    assert.equal((await triggerState(holding.id)).activationCount, 1, 'An occupied updraft must not apply force every tick.');
    assert.equal((await triggerState(holding.id)).inside, true);
    report.updraft.continuousOverlap = 'one activation';

    await load({
      ...exported,
      objects: exported.objects.map(object => object.id === placed.id ? { ...object, activation: 'once' } : object),
    });
    await play();
    await page.waitForFunction(() => window.gettingOver.snapshot().time > 5);
    assert.equal((await triggerState(placed.id)).activationCount, 1);
    assert.equal((await triggerState(placed.id)).consumed, true);
    report.updraft.oncePerRun = true;

    const markers = Array.from({ length: 128 }, (_, index) => ({
      ...placed, id: `wind-${index}`, name: `Wind ${index}`,
      x: (index % 16 - 8) * 3, y: Math.floor(index / 16) * 3 + 0.7,
    }));
    const crowded = { schemaVersion: 2, labels: [], objects: [FLOOR, START, ...markers] };
    await load(crowded);
    await frames();
    const renderBefore = (await level()).rendering;
    assert.equal(renderBefore.updrafts.instances, 128);
    await page.evaluate(() => new Promise(resolve => {
      let remaining = 120;
      const tick = () => { if (--remaining === 0) resolve(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }));
    assert.deepEqual((await level()).rendering.updrafts, renderBefore.updrafts,
      'Idle rendering must not rewrite marker matrices or bounds.');
    assert.equal((await level()).rendering.geometries, renderBefore.geometries);
    await load({ ...crowded, objects: crowded.objects.map(object => object.kind === 'trigger' ? { ...object, name: 'Renamed wind' } : object) });
    await frames();
    assert.deepEqual((await level()).rendering.updrafts, renderBefore.updrafts, 'Name-only edits need no GPU work.');
    const moved = { ...markers[0], x: markers[0].x + 0.5, region: { ...markers[0].region, width: 3 } };
    await load({ ...crowded, objects: [FLOOR, START, moved, ...markers.slice(1)] });
    await frames();
    const renderMoved = (await level()).rendering.updrafts;
    assert.equal(renderMoved.matrixWrites, renderBefore.updrafts.matrixWrites + 1);
    assert.equal(renderMoved.boundsUpdates, renderBefore.updrafts.boundsUpdates + 1);
    await load({ ...crowded, objects: [FLOOR, START, ...markers.map((marker, index) => ({ ...marker, marker: index % 2 ? 'flag' : 'updraft' }))] });
    await frames();
    assert.equal((await level()).rendering.updrafts.instances, 64);
    assert.equal((await level()).rendering.flags.instances, 64);
    assert.equal((await level()).rendering.calls, renderBefore.calls + 2);
    await load({ ...crowded, objects: [FLOOR, START, ...markers.map(marker => ({ ...marker, marker: 'none' }))] });
    await frames();
    const withoutMarkers = (await level()).rendering;
    assert.equal(withoutMarkers.updrafts.instances, 0);
    assert.equal(withoutMarkers.flags.instances, 0);
    assert.equal(renderBefore.calls - withoutMarkers.calls, 2, 'All updrafts must share two draw calls.');
    assert.equal(renderBefore.triangles - withoutMarkers.triangles, markers.length * UPDRAFT_TRIANGLES);
    await load({ schemaVersion: 2, labels: [], objects: [FLOOR, START] });
    await frames();
    assert.equal((await level()).rendering.updrafts.instances, 0);
    assert.equal((await level()).rendering.flags.instances, 0);
    report.updraft.capacity = {
      instances: 128, drawCalls: 2, trianglesPerMarker: UPDRAFT_TRIANGLES,
      stableFrames: 120, writesPerMovedMarker: 1, retypingPreservedFlags: true,
    };
    assert.deepEqual(report.errors, []);
    return report;
  } finally {
    await writeFile(new URL('trigger-report.json', artifacts), JSON.stringify(report, null, 2));
    await context.close();
    await new Promise((resolve, reject) => media.close(error => error ? reject(error) : resolve()));
  }
}
