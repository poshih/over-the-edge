import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { observeBrowserPage } from './verify-level.mjs';

const FULL_TURN = 360;
const FRAME_COUNT = 72;
const SPACING = FULL_TURN / FRAME_COUNT;
// A dense turnaround: 72 frames of 128 x 128 pixels, about 1.2 Mi decoded pixels.
const FRAME_SIZE = { width: 128, height: 128 };
const DIRECTIONS = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'];
const HEAD = 'flipbook-head';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ANGLE_EPSILON = 1e-6;
const LIVE = { frames: 4, hysteresis: 40, offset: 60, turn: 125 };

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
  return chunk;
}

// Opaque PNG whose hue encodes its seed, so frames are distinct images (up to 360 seeds).
export function solidPng(width, height, seed) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const hue = seed % FULL_TURN / 60;
  const channel = offset => Math.round(255 * (0.25 + 0.7 * Math.max(0, Math.min(1, Math.abs((hue + offset) % 6 - 3) - 1))));
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) row.set([channel(0), channel(4), channel(2), 255], 1 + x * 4);
  return Buffer.concat([
    PNG_SIGNATURE, pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUri = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const signedDegrees = angle => ((angle % FULL_TURN) + FULL_TURN * 1.5) % FULL_TURN - FULL_TURN / 2;
const normalize = angle => ((angle % FULL_TURN) + FULL_TURN) % FULL_TURN;
const nearest = (aim, count, start) => Math.round(normalize(aim - start) / (FULL_TURN / count)) % count;

function frames(prefix, count, size, seed = 0) {
  return Array.from({ length: count }, (_, index) => {
    const angle = String(Math.round(index * FULL_TURN / count)).padStart(3, '0');
    return { id: `${prefix}-${angle}`, name: `${prefix} ${angle}`, bytes: solidPng(size.width, size.height, seed + index * 5) };
  });
}

// A schema-6 profile using every pre-flipbook feature, written in canonical field order. It is a fixed
// point of the pre-flipbook engine (86514b9): its validator exported JSON.stringify of this exact value.
// Load, save and export must therefore keep producing these bytes.
export function schema6Reference() {
  const layer = (id, name, anchor, image, fields) => ({
    id, name, anchor, image, width: fields.width, height: fields.height, offset: fields.offset,
    rotation: fields.rotation ?? 0, bone: fields.bone ?? null, directions: fields.directions ?? DIRECTIONS,
    skin: fields.skin ?? null, tileLength: fields.tileLength ?? null,
  });
  const body = [{ bone: 'body', weight: 1 }];
  return {
    schemaVersion: 6,
    characterRiggingType: 'sprite-2d',
    armForwardDistance: 0.4,
    images: [
      { id: 'body', name: 'Body', source: dataUri(solidPng(4, 4, 10)) },
      { id: 'face', name: 'Face', source: dataUri(solidPng(4, 4, 40)) },
      { id: 'shaft', name: 'Shaft', source: dataUri(solidPng(8, 2, 70)) },
    ],
    layers: [
      layer('pot-card', 'Pot', 'pot', 'body', { width: 1.1, height: 0.9, offset: { x: 0, y: -0.065, z: 0.4 } }),
      layer('torso-card', 'Torso', 'torso', 'body', { width: 0.62, height: 0.7, offset: { x: 0.26, y: 0, z: 0.11 }, rotation: -90, bone: 'body' }),
      layer('face-right', 'Face right', 'character-head', 'face', {
        width: 0.5, height: 0.5, offset: { x: 0.245, y: 0, z: 0.13 }, rotation: -90, bone: 'head',
        directions: ['right', 'up-right', 'down-right'],
      }),
      layer('face-left', 'Face left', 'character-head', 'face', {
        width: 0.5, height: 0.5, offset: { x: 0.245, y: 0, z: 0.13 }, rotation: 90, bone: 'head',
        directions: ['up', 'up-left', 'left', 'down-left', 'down'],
      }),
      layer('cape', 'Cape', 'torso', 'body', {
        width: 0.6, height: 0.8, offset: { x: 0, y: 0.5, z: 0.05 },
        skin: { columns: 1, rows: 1, weights: [body, [{ bone: 'body', weight: 0.5 }, { bone: 'head', weight: 0.5 }], body, body] },
      }),
      layer('left-arm', 'Left arm', 'left-upper-arm', 'body', { width: 0.95, height: 0.2, offset: { x: 0.45, y: 0, z: 0.03 }, bone: 'left-upper-arm' }),
      layer('shaft', 'Shaft', 'hammer-shaft', 'shaft', { width: 1.5, height: 0.1, offset: { x: 0, y: 0, z: 0.02 }, tileLength: 0.5 }),
    ],
    skeleton: {
      anchor: 'torso',
      bones: [
        { id: 'body', name: 'Body', parent: null, x: 0, y: 0.3, rotation: 90, length: 0.54 },
        { id: 'head', name: 'Head', parent: 'body', x: 0.54, y: 0, rotation: 0, length: 0.49 },
        { id: 'left-upper-arm', name: 'Left upper arm', parent: 'body', x: 0.2, y: 0.25, rotation: 90, length: 0.9 },
        { id: 'left-forearm', name: 'Left forearm', parent: 'left-upper-arm', x: 0.9, y: 0, rotation: 0, length: 0.9 },
        { id: 'left-hand', name: 'Left hand', parent: 'left-forearm', x: 0.9, y: 0, rotation: 0, length: 0.18 },
        { id: 'braid-1', name: 'Braid 1', parent: 'head', x: 0.3, y: -0.18, rotation: -150, length: 0.18 },
        { id: 'braid-2', name: 'Braid 2', parent: 'braid-1', x: 0.18, y: 0, rotation: 0, length: 0.18 },
      ],
      poses: [{ direction: 'up', pose: [{ bone: 'head', x: 0, y: 0, rotation: 10 }] }],
      clips: [{
        id: 'breathe', name: 'Breathe', duration: 2, loop: true,
        frames: [{ time: 0, pose: [] }, { time: 1, pose: [{ bone: 'body', x: 0, y: 0.01, rotation: 0 }] }],
      }],
      animation: 'breathe',
      ik: [{
        id: 'left-grip-ik', upper: 'left-upper-arm', lower: 'left-forearm', hand: 'left-hand', target: 'left-grip',
        bend: 1, mix: 1, offsetX: 0, offsetY: 0, handRotation: 0,
      }],
      hair: [{ id: 'braid', bones: ['braid-1', 'braid-2'], stiffness: 0.35, damping: 0.25, gravity: 9.8, radius: 0.04 }],
      colliders: [{ id: 'torso-guard', bone: 'body', x: 0.2, y: 0, radius: 0.2 }],
    },
    presentation: {
      hysteresis: true,
      rotation: true,
      boundaries: [337.5, 22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5],
      directions: DIRECTIONS.map((direction, index) => ({
        direction, clockwiseHold: 7.5, counterclockwiseHold: 7.5, neutralAngle: index * 45,
        minimumRotation: -12, maximumRotation: 15, responseTime: 0.12,
      })),
      pivot: { anchor: 'torso', x: 0, y: 0.89 },
      layers: ['pot-card'],
      bones: ['head'],
    },
  };
}

// Paper Climber with its eight helmets replaced by one head layer on the head bone, plus a braid
// hair chain whose socket follows that bone. With `images`, the head layer is an aim flipbook.
function character(base, { images = null, single, startAngle = 0, hysteresis = 0 }) {
  const helmets = base.layers.filter(layer => layer.anchor === 'character-head');
  assert.equal(helmets.length, 8, 'Paper Climber supplies eight direction-tagged helmets.');
  const helmet = helmets[0];
  const elbow = base.layers.find(layer => layer.id === 'paper-left-elbow');
  const kept = base.layers.filter(layer => layer.anchor !== 'character-head');
  const head = {
    id: HEAD, name: 'Flipbook head', anchor: 'character-head', image: images?.[0].id ?? single.id,
    width: helmet.width, height: helmet.height, offset: helmet.offset, rotation: helmet.rotation,
    bone: 'head', directions: DIRECTIONS, skin: null, tileLength: null,
    ...(images === null ? {} : { flipbook: { images: images.map(image => image.id), startAngle, hysteresis } }),
  };
  const braid = {
    id: 'flipbook-braid', name: 'Braid tie', anchor: 'character-head', image: elbow.image, width: 0.16, height: 0.16,
    offset: { x: 0.1, y: 0, z: helmet.offset.z - 0.02 }, rotation: 0, bone: 'braid-2',
    directions: DIRECTIONS, skin: null, tileLength: null,
  };
  const layers = [...kept, head, braid];
  const used = new Set(layers.flatMap(layer => layer.flipbook?.images ?? [layer.image]));
  const added = (images ?? [single]).map(({ id, name, bytes }) => ({ id, name, source: dataUri(bytes) }));
  return {
    ...base,
    schemaVersion: images === null ? 6 : 7,
    images: [...base.images.filter(image => used.has(image.id)), ...added],
    layers,
    skeleton: {
      ...base.skeleton,
      bones: [
        ...base.skeleton.bones,
        { id: 'braid-1', name: 'Braid 1', parent: 'head', x: 0.3, y: -0.18, rotation: -150, length: 0.18 },
        { id: 'braid-2', name: 'Braid 2', parent: 'braid-1', x: 0.18, y: 0, rotation: 0, length: 0.18 },
        { id: 'braid-3', name: 'Braid 3', parent: 'braid-2', x: 0.18, y: 0, rotation: 0, length: 0.18 },
      ],
      hair: [{ id: 'braid', bones: ['braid-1', 'braid-2', 'braid-3'], stiffness: 0.35, damping: 0.25, gravity: 9.8, radius: 0.04 }],
    },
  };
}

export async function verifyFlipbook(browser, address, artifacts) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const report = { errors: [] };
  await observeBrowserPage(page, report.errors);
  const nextFrames = (count = 2) => page.evaluate(total => new Promise(resolve => {
    let remaining = total;
    const tick = () => (--remaining <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), count);
  const physics = () => page.evaluate(() => window.gettingOver.snapshot());
  const idle = () => page.waitForFunction(() => {
    const state = window.gettingOver.sprites();
    return !state.busy && !state.restoring;
  });
  const documentState = () => page.evaluate(() => window.gettingOver.sprites().document);
  const spriteError = () => page.evaluate(() => window.gettingOver.sprites().error);
  const head = async () => {
    const state = await page.evaluate(id => {
      const sprites = window.gettingOver.sprites();
      const layer = sprites.rendering.layers.find(candidate => candidate.id === id);
      if (layer === undefined) return null;
      return {
        reported: ['flipbookFrame', 'flipbookImage', 'flipbookFrameChanges'].every(key => key in layer),
        frame: layer.flipbookFrame, image: layer.flipbookImage, changes: layer.flipbookFrameChanges,
        textureId: layer.textureId, materialId: layer.materialId,
        aim: sprites.rendering.presentation.aimAngle, preview: sprites.rendering.presentation.preview,
        texturesCreated: sprites.rendering.texturesCreated, materialCount: sprites.rendering.materialCount,
        geometryCount: sprites.rendering.geometryCount, layerCount: sprites.rendering.layerCount,
        resources: sprites.rendering.resources.map(resource => ({ textureId: resource.textureId, materialId: resource.materialId })),
        uploaded: window.gettingOver.level().rendering.textures,
      };
    }, HEAD);
    assert.ok(state !== null, `The renderer must report the ${HEAD} layer.`);
    assert.ok(state.reported, 'inspect() must report the flipbook fields on every layer.');
    return state;
  };
  const openTab = async (name) => {
    const toggle = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByRole('tab', { name, exact: true }).click();
  };
  const exportText = async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.sprite-export').click()]);
    return readFile(await download.path(), 'utf8');
  };
  const importText = async (text, name = 'sprites.json') => {
    await page.locator('.sprite-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
    await idle();
    await nextFrames();
  };
  const previewAim = angle => page.evaluate(async value => {
    const input = document.querySelector('#directional-aim-angle');
    input.value = String(value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // An in-progress preview applies a new aim on the next rendered frame.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, angle);
  const leavePreview = async () => {
    const live = page.locator('.directional-preview-live');
    if (await live.isEnabled()) await live.click();
    await nextFrames();
  };
  const key = async (name) => {
    await page.locator('#game').focus();
    await page.keyboard.press(name);
    await nextFrames();
  };
  const setPaused = async (paused) => {
    if ((await physics()).paused !== paused) await key('p');
    await page.waitForFunction(value => window.gettingOver.snapshot().paused === value, paused);
  };
  const editNumber = async (selector, value) => {
    await page.locator(selector).fill(String(value));
    await page.locator(selector).press('Tab');
    await idle();
    await nextFrames();
  };

  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0 && !window.gettingOver.sprites().restoring);

    // 1. Documents without flipbooks keep the pre-flipbook bytes through load, save and export.
    await openTab('Character');
    await page.locator('.character-load-example').click();
    await idle();
    await openTab('Sprites');
    const example = await exportText();
    const base = JSON.parse(example);
    assert.equal(base.schemaVersion, 6, 'Documents without flipbooks stay schema 6.');
    assert.ok(!example.includes('"flipbook"'), 'Single-image layers must not gain a flipbook field.');
    const reference = JSON.stringify(schema6Reference());
    await importText(reference);
    assert.equal(await spriteError(), null);
    assert.equal(await exportText(), reference, 'Load and export must reproduce the pre-flipbook schema-6 bytes.');
    await page.locator('.sprite-save').click();
    await idle();
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0 && !window.gettingOver.sprites().restoring);
    await openTab('Sprites');
    assert.equal(await exportText(), reference, 'Save and restore must reproduce the pre-flipbook schema-6 bytes.');
    await importText(example);
    assert.equal(await exportText(), example, 'Import and export must preserve the complete example byte for byte.');
    report.unchangedSchema6 = { referenceBytes: reference.length, exampleBytes: example.length, load: true, save: true, export: true };

    // 2. A 72-frame head flipbook loads with every frame decoded and uploaded before it is shown.
    const headFrames = frames('head', FRAME_COUNT, FRAME_SIZE);
    const single = character(base, { single: headFrames[0] });
    const flipbook = character(base, { images: headFrames });
    await setPaused(true);
    await importText(JSON.stringify(single));
    assert.equal(await spriteError(), null);
    const singleState = await head();
    assert.equal(singleState.frame, null, 'Single-image layers report no flipbook frame.');
    await importText(JSON.stringify(flipbook));
    assert.equal(await spriteError(), null, 'A valid 72-frame flipbook document must load.');
    const loaded = await head();
    assert.equal(loaded.texturesCreated - singleState.texturesCreated, FRAME_COUNT - 1, 'Only the new frames create textures.');
    assert.equal(loaded.uploaded - singleState.uploaded, FRAME_COUNT - 1, 'Every new frame is uploaded at load.');
    const flipbookDocument = await documentState();
    assert.equal(flipbookDocument.schemaVersion, 7);
    assert.deepEqual(flipbookDocument.layers.find(layer => layer.id === HEAD).flipbook, flipbook.layers.find(layer => layer.id === HEAD).flipbook);
    const exported = await exportText();
    assert.deepEqual(JSON.parse(exported), flipbookDocument, 'Export must carry the flipbook without loss.');
    assert.deepEqual(JSON.parse(exported).layers, flipbook.layers.map(layer => JSON.parse(JSON.stringify(layer))));
    await importText(exported);
    assert.equal(await exportText(), exported, 'Re-importing a flipbook export must be lossless.');

    // 3. Every 5 degrees of aim shows the nearest frame, across the wrap, without allocations.
    const sweep = [];
    for (let angle = 0; angle < FULL_TURN; angle += SPACING) {
      await previewAim(angle);
      const state = await head();
      assert.ok(state.preview, 'The directional preview aim drives the flipbook.');
      assert.equal(state.frame, angle / SPACING, `Aim ${angle} must show frame ${angle / SPACING}.`);
      assert.equal(state.image, headFrames[angle / SPACING].id);
      const shown = state.resources.find(resource => resource.textureId === state.textureId);
      assert.ok(shown && shown.materialId === state.materialId, 'A frame change swaps to the preloaded frame texture/material.');
      sweep.push(state);
    }
    for (const [angle, frame] of [[357.4, 71], [357.6, 0], [2.4, 0], [2.6, 1], [182.49, 36], [182.51, 37]]) {
      await previewAim(angle);
      assert.equal((await head()).frame, frame, `Aim ${angle} must show frame ${frame}.`);
    }
    const swept = await head();
    for (const field of ['texturesCreated', 'uploaded', 'materialCount', 'geometryCount', 'layerCount']) {
      assert.equal(swept[field], loaded[field], `Aiming must not change ${field}.`);
    }
    assert.equal(new Set(sweep.map(state => state.textureId)).size, FRAME_COUNT, 'All 72 frames were displayed.');
    report.sweep = { frames: FRAME_COUNT, stepDegrees: SPACING, wrap: true, allocations: 0, uploadsDuringPlay: 0 };

    // 4. Hysteresis: no flicker inside the band; beyond it, the destination is selected directly.
    await page.locator('#sprite-layer').selectOption(HEAD);
    await editNumber('#sprite-flipbook-hysteresis', 1);
    assert.equal((await documentState()).layers.find(layer => layer.id === HEAD).flipbook.hysteresis, 1);
    await previewAim(0);
    assert.equal((await head()).frame, 0);
    const steady = (await head()).changes;
    for (let index = 0; index < 12; index++) await previewAim(index % 2 === 0 ? 3.4 : 1.6);
    assert.equal((await head()).frame, 0, 'Oscillating inside the band keeps the frame.');
    assert.equal((await head()).changes, steady, 'No frame changes happen inside the band.');
    await previewAim(3.6);
    assert.equal((await head()).frame, 1);
    for (let index = 0; index < 12; index++) await previewAim(index % 2 === 0 ? 1.6 : 3.4);
    assert.equal((await head()).frame, 1, 'The band is symmetric around the new frame.');
    const beforeJump = (await head()).changes;
    await previewAim(200);
    assert.equal((await head()).frame, 40);
    assert.equal((await head()).changes, beforeJump + 1, 'A large jump selects the destination without intermediate frames.');
    await previewAim(355);
    await previewAim(358.4);
    assert.equal((await head()).frame, 71, 'The band extends across the 355 to 0 wrap.');
    await previewAim(358.6);
    assert.equal((await head()).frame, 0);
    const held = (await head()).changes;
    await nextFrames(30);
    assert.equal((await head()).changes, held, 'A steady aim does no frame work.');
    report.hysteresis = { degrees: 1, flicker: false, directJump: true, wrap: true };

    // 5. Head tilt, braid socket, hand IK and hammer artwork match the same rig without a flipbook.
    const rigState = () => page.evaluate(id => {
      const rendering = window.gettingOver.sprites().rendering;
      // Simulated braid joints and the tie bound to them follow the solver clock; the socket is pinned.
      const hair = new Set(['braid-1', 'braid-2', 'braid-3']);
      return {
        bones: rendering.skeleton.bones.filter(bone => !hair.has(bone.id)),
        tilt: rendering.presentation.headTracking,
        sockets: rendering.presentation.sockets,
        artwork: rendering.layers.filter(layer => layer.id !== id && layer.id !== 'flipbook-braid')
          .map(layer => ({ id: layer.id, visible: layer.visible, world: layer.worldTransform })),
      };
    }, HEAD);
    const compare = async (label) => {
      const results = [];
      for (const text of [JSON.stringify(flipbook), JSON.stringify(single)]) {
        await importText(text);
        const states = [await rigState()];
        for (const angle of [30, 150, 260]) {
          await leavePreview();
          await previewAim(angle);
          states.push(await rigState());
        }
        await leavePreview();
        results.push(states);
      }
      const [withFlipbook, without] = results;
      assert.equal(withFlipbook[0].tilt.status, 'automatic');
      assert.equal(withFlipbook[0].sockets.length, 1);
      for (const [index, state] of withFlipbook.entries()) {
        assert.deepEqual(state, without[index], `${label}: frame changes must not alter the rest of the rig (${index}).`);
      }
    };
    await compare('Paused live and preview');
    report.rigUnaffected = { tilt: true, braidSocket: true, handIk: true, hammer: true };

    // 6. Authoring: choose shuffled PNGs, edit angles, preview, Save, Use single image and Revert.
    await importText(JSON.stringify(single));
    await page.locator('#sprite-layer').selectOption(HEAD);
    const files = headFrames.map((frame, index) => ({ name: `head-${index * SPACING}.png`, mimeType: 'image/png', buffer: frame.bytes }));
    for (let index = files.length - 1; index > 0; index--) {
      const other = (index * 7919) % (index + 1);
      [files[index], files[other]] = [files[other], files[index]];
    }
    await page.locator('#sprite-flipbook-files').setInputFiles(files);
    await idle();
    await nextFrames();
    assert.equal(await spriteError(), null);
    let authored = await documentState();
    let layer = authored.layers.find(candidate => candidate.id === HEAD);
    const names = new Map(authored.images.map(image => [image.id, image.name]));
    assert.deepEqual(layer.flipbook.images.map(id => names.get(id)),
      [headFrames[0].name, ...headFrames.slice(1).map((_, index) => `head-${(index + 1) * SPACING}`)],
      'Frames are ordered by file name, numbers in natural order, reusing the identical first image.');
    assert.equal(layer.image, headFrames[0].id);
    assert.deepEqual(layer.directions, DIRECTIONS);
    assert.equal(authored.schemaVersion, 7);
    await editNumber('#sprite-flipbook-start', 10);
    await editNumber('#sprite-flipbook-hysteresis', 1.5);
    layer = (await documentState()).layers.find(candidate => candidate.id === HEAD);
    assert.deepEqual([layer.flipbook.startAngle, layer.flipbook.hysteresis], [10, 1.5]);
    await editNumber('#sprite-flipbook-hysteresis', 2.5);
    assert.match(await spriteError(), /less than 2\.5 degrees/, 'Invalid hysteresis is reported.');
    assert.equal((await documentState()).layers.find(candidate => candidate.id === HEAD).flipbook.hysteresis, 1.5,
      'An invalid edit leaves the last valid draft.');
    await editNumber('#sprite-flipbook-hysteresis', 1.5);
    await previewAim(15);
    assert.equal((await head()).frame, 1, 'Frame 1 faces the start angle plus one spacing.');
    assert.match(await page.locator('.sprite-flipbook-frame').textContent(), /Showing frame 1 \(frames 0-71\): "head-5", drawn for 15 deg aim/);
    await page.locator('.sprite-flipbook').screenshot({ path: fileURLToPath(new URL('flipbook-editor.png', artifacts)) });
    await page.screenshot({ path: fileURLToPath(new URL('flipbook-preview.png', artifacts)) });
    await leavePreview();
    authored = await documentState();
    await page.locator('.sprite-save').click();
    await idle();
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0 && !window.gettingOver.sprites().restoring);
    await openTab('Sprites');
    assert.deepEqual(await documentState(), authored, 'Save restores the flipbook exactly.');
    assert.notEqual((await head()).frame, null);
    await page.locator('#sprite-layer').selectOption(HEAD);
    await page.locator('.sprite-flipbook-single').click();
    await nextFrames();
    const reverted = await documentState();
    assert.equal(reverted.schemaVersion, 6, 'Removing the last flipbook returns the draft to schema 6.');
    assert.equal(reverted.layers.find(candidate => candidate.id === HEAD).flipbook, undefined);
    assert.equal(reverted.images.length, authored.images.length - (FRAME_COUNT - 1), 'Unused frames are removed.');
    assert.equal((await head()).frame, null);
    await page.locator('.sprite-revert').click();
    await idle();
    assert.deepEqual(await documentState(), authored, 'Revert restores the saved flipbook.');
    report.authoring = { naturalOrder: true, startAngle: true, hysteresis: true, invalidRejected: true, save: true, single: true, revert: true };

    // 7. Invalid documents are rejected with explanations; the previous rig stays active.
    const before = await documentState();
    const invalid = [
      ['unknown frame', value => { value.layers.find(entry => entry.id === HEAD).flipbook.images[4] = 'missing'; }, /flipbook references missing image "missing"/],
      ['duplicate frame', value => { const book = value.layers.find(entry => entry.id === HEAD).flipbook; book.images[4] = book.images[3]; }, /is repeated/],
      ['one frame', value => { const book = value.layers.find(entry => entry.id === HEAD).flipbook; book.images = book.images.slice(0, 1); }, /needs 2-128 frame/],
      ['size mismatch', value => { value.images.find(image => image.id === headFrames[9].id).source = dataUri(solidPng(120, 128, 9)); }, /identical pixel dimensions/],
      ['tiled flipbook', value => { value.layers.find(entry => entry.id === HEAD).tileLength = 0.5; }, /weighted mesh or tiled shaft/],
      ['masked flipbook', value => { value.layers.find(entry => entry.id === HEAD).directions = ['right']; }, /all eight directions/],
      ['schema 6 flipbook', value => { value.schemaVersion = 6; }, /require sprite schema version 7/],
      ['budget', value => {
        const big = frames('big', FRAME_COUNT, { width: 512, height: 512 });
        value.images = [...value.images.filter(image => !image.id.startsWith('head-')), ...big.map(({ id, name, bytes }) => ({ id, name, source: dataUri(bytes) }))];
        Object.assign(value.layers.find(entry => entry.id === HEAD), { image: big[0].id, flipbook: { images: big.map(image => image.id), startAngle: 0, hysteresis: 0 } });
      }, /image-memory budget/],
    ];
    for (const [label, mutate, pattern] of invalid) {
      const value = structuredClone(flipbook);
      mutate(value);
      await importText(JSON.stringify(value));
      assert.match(await spriteError() ?? '', pattern, `${label} must be rejected.`);
      assert.deepEqual(await documentState(), before, `A rejected ${label} import must keep the previous document.`);
    }
    report.invalid = invalid.map(([label]) => label);

    // 8. Live aim: hysteresis persists, pause freezes, reset and document replacement select directly.
    const liveFrames = frames('live', LIVE.frames, FRAME_SIZE, 180);
    await importText(JSON.stringify(character(base, { images: liveFrames, hysteresis: LIVE.hysteresis })));
    assert.equal(await spriteError(), null);
    await setPaused(true);
    await key('r');
    const spawnAim = (await head()).aim;
    await page.locator('#sprite-layer').selectOption(HEAD);
    const liveStart = Math.round(normalize(spawnAim + LIVE.offset) * 1000) / 1000;
    await editNumber('#sprite-flipbook-start', liveStart);
    const nearFrame = aim => nearest(aim, LIVE.frames, liveStart);
    const frameDistance = (aim, frame) => Math.abs(signedDegrees(aim - liveStart - frame * FULL_TURN / LIVE.frames));
    assert.equal((await head()).frame, LIVE.frames - 1, 'An edit selects the nearest frame directly.');
    const turnAim = async () => {
      await setPaused(false);
      const box = await page.locator('#game').boundingBox();
      const start = await physics();
      const scale = start.camera.height / start.camera.worldHeight / start.tuning.mouseSensitivity;
      const radius = Math.hypot(start.cursorOffset.x, start.cursorOffset.y);
      const initial = Math.atan2(start.cursorOffset.y, start.cursorOffset.x);
      const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(pointer.x, pointer.y);
      await page.mouse.down();
      const steps = 25;
      let previous = { x: start.cursorOffset.x, y: start.cursorOffset.y };
      for (let step = 1; step <= steps; step++) {
        const angle = initial + LIVE.turn * Math.PI / 180 * step / steps;
        const next = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
        pointer.x += (next.x - previous.x) * scale;
        pointer.y -= (next.y - previous.y) * scale;
        previous = next;
        await page.mouse.move(pointer.x, pointer.y);
        await nextFrames();
        const state = await head();
        assert.ok(frameDistance(state.aim, state.frame) <= FULL_TURN / LIVE.frames / 2 + LIVE.hysteresis + ANGLE_EPSILON,
          'The live frame always stays within its hysteresis band of the real aim.');
      }
      await page.mouse.up();
      await setPaused(true);
      const state = await head();
      const turned = normalize(state.aim - spawnAim);
      assert.ok(turned > LIVE.turn - 20 && turned < LIVE.turn + 20, `The scripted drag must turn the aim about ${LIVE.turn} degrees (${turned}).`);
      assert.equal(state.frame, 0, 'Frame 0 is kept inside its band.');
      assert.equal(nearFrame(state.aim), 1, 'The kept frame is not the nearest one.');
      return state;
    };
    const held0 = await turnAim();
    await nextFrames(30);
    const paused = await head();
    assert.equal(paused.aim, held0.aim, 'Paused aim is frozen.');
    assert.equal(paused.frame, 0, 'Paused selection is frozen.');
    await key('r');
    const reset = await head();
    assert.ok(Math.abs(signedDegrees(reset.aim - spawnAim)) < 1e-6, 'Reset restores the spawn aim.');
    assert.ok(frameDistance(reset.aim, 0) <= FULL_TURN / LIVE.frames / 2 + LIVE.hysteresis, 'Hysteresis alone would keep frame 0.');
    assert.equal(reset.frame, LIVE.frames - 1, 'Reset selects the nearest frame directly.');
    const held1 = await turnAim();
    await importText(await exportText());
    const replaced = await head();
    assert.equal(replaced.aim, held1.aim);
    assert.equal(replaced.frame, nearFrame(held1.aim), 'Document replacement selects the nearest frame directly.');
    report.live = { spawnAim, startAngle: liveStart, keptAim: held0.aim, pauseFrozen: true, resetDirect: true, replacementDirect: true };

    assert.deepEqual(report.errors, [], 'Flipbook scenarios must not produce browser errors.');
    return report;
  } finally {
    await context.close();
  }
}
