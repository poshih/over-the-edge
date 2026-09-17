import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { BoxGeometry, Matrix4, Vector3 } from 'three';

function pngChunk(type, bytes) {
  const content = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  content.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

export function texturePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const row = [0, 240, 5, 210, 255, 240, 5, 210, 255];
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([...row, ...row]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function modelFixture({ size = [1, 1, 1], externalTexture = false, textured = false } = {}) {
  const geometry = new BoxGeometry(...size);
  const buffers = [];
  const bufferViews = [];
  const accessors = [];
  let offset = 0;
  const append = (bytes) => {
    const index = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    const padding = Buffer.alloc((4 - bytes.length % 4) % 4);
    buffers.push(bytes, padding);
    offset += bytes.length + padding.length;
    return index;
  };
  for (const [name, type] of [['position', 'VEC3'], ['normal', 'VEC3'], ['uv', 'VEC2']]) {
    const attribute = geometry.getAttribute(name);
    const bytes = Buffer.from(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength);
    const accessor = { bufferView: append(bytes), componentType: 5126, count: attribute.count, type };
    if (name === 'position') {
      accessor.min = size.map((value) => -value / 2);
      accessor.max = size.map((value) => value / 2);
    }
    accessors.push(accessor);
  }
  const index = geometry.index;
  accessors.push({
    bufferView: append(Buffer.from(index.array.buffer, index.array.byteOffset, index.array.byteLength)),
    componentType: 5123, count: index.count, type: 'SCALAR',
  });
  const material = { pbrMetallicRoughness: { baseColorFactor: [1, 0.05, 0.65, 1], metallicFactor: 0, roughnessFactor: 0.65 } };
  const json = {
    asset: { version: '2.0', generator: 'Over the Edge runtime fixture' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [material], bufferViews, accessors,
  };
  if (textured || externalTexture) {
    json.images = externalTexture
      ? [{ uri: 'https://example.invalid/private-model-texture.png' }]
      : [{ bufferView: append(texturePng()), mimeType: 'image/png' }];
    json.textures = [{ source: 0 }];
    material.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
    material.pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }
  const binary = Buffer.concat(buffers);
  json.buffers = [{ byteLength: binary.length }];
  const text = Buffer.from(JSON.stringify(json));
  const description = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 0x20)]);
  const glb = Buffer.alloc(12 + 8 + description.length + 8 + binary.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(description.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  description.copy(glb, 20);
  const start = 20 + description.length;
  glb.writeUInt32LE(binary.length, start);
  glb.writeUInt32LE(0x004e4942, start + 4);
  binary.copy(glb, start + 8);
  geometry.dispose();
  return glb;
}

export async function inspectArmGeometry(page) {
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => {
    const visuals = window.gettingOver.appearance();
    const body = visuals.parts.find((part) => part.id === 'torso').transform;
    const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
    const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
    const project = (value, axis) => value.map((component, index) => component - axis[index] * dot(value, axis));
    for (const side of ['left', 'right']) {
      const upper = visuals.parts.find((part) => part.id === `${side}-upper-arm`).transform;
      const shoulder = [upper[12] - upper[4] / 2, upper[13] - upper[5] / 2, upper[14] - upper[6] / 2];
      const elbow = visuals.parts.find((part) => part.id === `${side}-elbow`).anchor;
      const hand = visuals.parts.find((part) => part.id === `${side}-hand`).anchor;
      const settings = visuals.armIk.settings;
      const local = [settings[`${side}HintX`], settings[`${side}HintY`], settings[`${side}HintZ`]];
      const hint = [0, 1, 2].map((row) => body[12 + row] +
        local.reduce((sum, value, column) => sum + value * body[column * 4 + row], 0));
      const reach = subtract([hand.x, hand.y, hand.z], shoulder);
      const axis = reach.map((value) => value / Math.hypot(...reach));
      const towardHint = subtract(hint, shoulder);
      const desired = project(towardHint, axis);
      const bend = project(subtract([elbow.x, elbow.y, elbow.z], shoulder), axis);
      if (Math.hypot(...bend) > 1e-6 && Math.hypot(...desired) / Math.hypot(...towardHint) > 0.15 &&
        dot(bend, desired) / Math.hypot(...bend) / Math.hypot(...desired) < 1 - 1e-8) return false;
    }
    return true;
  });
  const { state, visuals, spriteLayers } = await page.evaluate(() => ({
    state: window.gettingOver.snapshot(), visuals: window.gettingOver.appearance(),
    spriteLayers: window.gettingOver.sprites().rendering.layers,
  }));
  assert.equal(state.paused, true, 'Compare physics and rendered anchors on a paused frame.');
  const point = (value) => new Vector3(value.x, value.y, value.z);
  const endpoint = (part, y) => new Vector3(0, y, 0).applyMatrix4(new Matrix4().fromArray(part.transform));
  const torso = new Matrix4().fromArray(visuals.parts.find((part) => part.id === 'torso').transform);
  const shaft = visuals.parts.find((part) => part.id === 'hammer-shaft');
  const straightShaft = shaft.custom || spriteLayers.some(layer =>
    layer.anchor === 'hammer-shaft' && layer.underlay === 'replace');
  const firstSegment = state.parts.find((part) => part.id === 'handle-0');
  const result = {};
  for (const [side, shoulderX, shoulderZ, gripX] of [['left', -0.17, -0.09, 0.04], ['right', 0.17, 0.09, 0.22]]) {
    const upper = visuals.parts.find((part) => part.id === `${side}-upper-arm`);
    const lower = visuals.parts.find((part) => part.id === `${side}-forearm`);
    const elbow = point(visuals.parts.find((part) => part.id === `${side}-elbow`).anchor);
    const handPart = visuals.parts.find((part) => part.id === `${side}-hand`);
    const hand = point(handPart.anchor);
    const shoulder = new Vector3(shoulderX, 0.74, shoulderZ).applyMatrix4(torso);
    const settings = visuals.armIk.settings;
    const hint = new Vector3(settings[`${side}HintX`], settings[`${side}HintY`], settings[`${side}HintZ`]).applyMatrix4(torso);
    assert.ok(endpoint(upper, -0.5).distanceTo(shoulder) < 1e-8, `${side} upper arm must start at its torso-local shoulder.`);
    assert.ok(endpoint(upper, 0.5).distanceTo(elbow) < 1e-8, `${side} upper arm must end at the elbow.`);
    assert.ok(endpoint(lower, -0.5).distanceTo(elbow) < 1e-8, `${side} forearm must start at the elbow.`);
    assert.ok(endpoint(lower, 0.5).distanceTo(hand) < 1e-8, `${side} forearm must end at the grip.`);
    assert.ok(Math.abs(shoulder.distanceTo(elbow) - 0.82) < 1e-8);
    const distance = shoulder.distanceTo(hand);
    if (distance <= 1.64) assert.ok(Math.abs(elbow.distanceTo(hand) - 0.82) < 1e-8, 'Reachable arms must keep both bone lengths.');
    const expectedHand = straightShaft
      ? new Vector3(gripX - 0.75, 0, 0).applyMatrix4(new Matrix4().fromArray(shaft.transform))
      : new Vector3(firstSegment.x + (gripX - 0.25) * Math.cos(firstSegment.angle),
        firstSegment.y + (gripX - 0.25) * Math.sin(firstSegment.angle), 0.22);
    assert.ok(hand.distanceTo(expectedHand) < 1e-8, `${side} hand must grip the rendered shaft, including its actual depth.`);
    const shaftDirection = straightShaft
      ? new Vector3(shaft.transform[0], shaft.transform[1], shaft.transform[2]).normalize()
      : new Vector3(Math.cos(firstSegment.angle), Math.sin(firstSegment.angle), 0);
    const handDirection = new Vector3(handPart.transform[0], handPart.transform[1], handPart.transform[2]).normalize();
    assert.ok(handDirection.distanceTo(shaftDirection) < 1e-8, 'Hand orientation must follow the shaft.');
    for (const limb of [upper, lower]) {
      assert.ok(limb.transform.every(Number.isFinite), 'Actual rendered limb transforms must stay finite.');
      const x = new Vector3(limb.transform[0], limb.transform[1], limb.transform[2]).normalize();
      const y = new Vector3(limb.transform[4], limb.transform[5], limb.transform[6]).normalize();
      const z = new Vector3(limb.transform[8], limb.transform[9], limb.transform[10]).normalize();
      assert.ok(Math.abs(x.dot(y)) < 1e-8 && Math.abs(y.dot(z)) < 1e-8 && Math.abs(z.dot(x)) < 1e-8);
    }
    result[side] = { shoulder: shoulder.toArray(), elbow: elbow.toArray(), hand: hand.toArray(), hint: hint.toArray() };
  }
  return result;
}

export async function verifyAppearance(page, artifacts) {
  const foreignRequests = [];
  const uploads = [];
  const origin = new URL(page.url()).origin;
  const intercept = async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin) {
      foreignRequests.push(request.url());
      await route.abort();
    } else {
      if (!['GET', 'HEAD'].includes(request.method())) uploads.push(request.url());
      await route.continue();
    }
  };
  await page.route(/^https?:\/\//, intercept);
  const snapshot = () => page.evaluate(() => window.gettingOver.snapshot());
  const appearance = () => page.evaluate(() => window.gettingOver.appearance());
  const part = async (id) => (await appearance()).parts.find((entry) => entry.id === id);
  const frames = () => page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const armSettings = async () => (await appearance()).armIk.settings;
  const armPrefix = 'over-the-edge:appearance:arm-ik:profile:v2:';
  const activeKey = 'over-the-edge:appearance:arm-ik:active:v2';
  const armRecord = () => page.evaluate((key) => localStorage.getItem(key), activeKey);
  const armRecords = () => page.evaluate((prefix) => Object.fromEntries(Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix)).map((key) => [key, localStorage.getItem(key)])), armPrefix);
  const profileName = page.getByRole('textbox', { name: 'IK profile name', exact: true });
  const pastProfiles = page.getByRole('combobox', { name: 'Past IK profiles', exact: true });
  const saveProfile = page.getByRole('button', { name: 'Save IK profile', exact: true });
  const loadProfile = page.getByRole('button', { name: 'Load IK profile', exact: true });
  const armGeometry = () => inspectArmGeometry(page);
  const setHint = async (label, value) => {
    await page.getByRole('slider', { name: label, exact: true }).evaluate((input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await frames();
  };
  const physics = async () => {
    const state = await snapshot();
    return {
      root: state.root, tip: state.tip, parts: state.parts, bodyProperties: state.bodyProperties,
      bodyCount: state.bodyCount, jointCount: state.jointCount, tuning: state.tuning,
    };
  };
  const openEditor = async () => {
    if (!await page.getByRole('tab', { name: 'Appearance', exact: true }).isVisible()) {
      await page.getByRole('button', { name: 'Workshop', exact: true }).click();
    }
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await page.waitForFunction(() => !window.gettingOver.appearance().restoring);
  };
  const upload = async (id, name, buffer) => {
    await page.getByLabel('Body part', { exact: true }).selectOption(id);
    await page.getByLabel('GLB model', { exact: true }).setInputFiles({ name, mimeType: 'model/gltf-binary', buffer });
    await page.waitForFunction(({ id, name }) => {
      const part = window.gettingOver.appearance().parts.find((entry) => entry.id === id);
      return !part.busy && part.name === name && part.error === null;
    }, { id, name });
  };
  try {
    await page.waitForFunction(() => !window.gettingOver.appearance().restoring);
    assert.equal((await appearance()).error, null);
    await page.locator('#game').focus();
    if (!(await snapshot()).paused) await page.keyboard.press('p');
    await openEditor();
    assert.equal((await appearance()).parts.length, 13);
    await frames();
    const armPhysics = await physics();
    const namedTunings = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
      .filter((key) => key.startsWith('over-the-edge:tuning:'))
      .map((key) => [key, localStorage.getItem(key)])));
    const defaultArms = await armGeometry();
    const defaultHints = {
      leftHintX: -0.55, leftHintY: 0.15, leftHintZ: -0.35,
      rightHintX: 0.55, rightHintY: 0.15, rightHintZ: 0.45,
    };
    assert.deepEqual(await armSettings(), defaultHints);
    await page.screenshot({ path: fileURLToPath(new URL('arm-ik-defaults.png', artifacts)) });
    await profileName.fill('   ');
    await saveProfile.click();
    assert.deepEqual(await armRecords(), {});
    assert.ok((await appearance()).armIk.error.includes('Enter an IK profile name'));
    await profileName.fill('Original pose');
    await profileName.press('Enter');
    const originalProfile = await pastProfiles.inputValue();
    const savedDefaults = await armRecord();
    const originalProfileRecord = (await armRecords())[originalProfile];
    await setHint('Left elbow hint X', 0.8);
    await setHint('Left elbow hint Y', -0.1);
    await setHint('Left elbow hint Z', 0.7);
    const leftChanged = await armGeometry();
    assert.ok(new Vector3(...leftChanged.left.elbow).distanceTo(new Vector3(...defaultArms.left.elbow)) > 0.3,
      'Editing a hint must visibly move the elbow, not just change metadata.');
    assert.ok(new Vector3(...leftChanged.right.elbow).distanceTo(new Vector3(...defaultArms.right.elbow)) < 1e-8,
      'Left hint editing must not move the right elbow.');
    assert.deepEqual(leftChanged.left.hand, defaultArms.left.hand);
    const experimentName = 'r p c d 1234 <elbows>';
    await profileName.fill('');
    const beforeTyping = await snapshot();
    await profileName.pressSequentially(experimentName);
    const afterTyping = await snapshot();
    for (const key of ['practice', 'paused', 'debug', 'time']) assert.equal(afterTyping[key], beforeTyping[key]);
    await saveProfile.click();
    const firstExperiment = await pastProfiles.inputValue();
    assert.equal(await pastProfiles.locator('elbows').count(), 0, 'Profile names must be rendered as text.');
    await setHint('Right elbow hint Y', 0.95);
    await setHint('Right elbow hint Z', -0.65);
    const savedArmSettings = await armSettings();
    const tuned = await armGeometry();
    assert.ok(new Vector3(...tuned.right.elbow).distanceTo(new Vector3(...defaultArms.right.elbow)) > 0.3);
    for (const side of ['left', 'right']) assert.deepEqual(tuned[side].hand, defaultArms[side].hand);
    assert.deepEqual(await physics(), armPhysics, 'Arm IK changes must leave the complete physical rig unchanged.');
    const beforeFailedSave = await armRecords();
    const previousSelection = await armRecord();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.restoreArmIkWrites = () => { Storage.prototype.setItem = original; delete window.restoreArmIkWrites; };
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('over-the-edge:appearance:arm-ik:profile:v2:')) throw new DOMException('Arm IK quota probe', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    try {
      await saveProfile.click();
      assert.ok((await appearance()).armIk.error.includes('storage'));
      assert.deepEqual(await armRecords(), beforeFailedSave);
      assert.equal(await armRecord(), previousSelection);
      assert.deepEqual(await armSettings(), savedArmSettings, 'A failed save must retain the editable preview.');
    } finally {
      await page.evaluate(() => window.restoreArmIkWrites());
    }
    await saveProfile.click();
    const savedProfile = await pastProfiles.inputValue();
    assert.notEqual(savedProfile, firstExperiment, 'Reusing a profile name must keep separate versions.');
    assert.equal((await armRecords())[originalProfile], originalProfileRecord);
    assert.deepEqual(JSON.parse((await armRecords())[savedProfile]).settings, savedArmSettings);
    const savedDirections = await armRecord();
    assert.equal((await appearance()).armIk.dirty, false);
    assert.equal((await appearance()).armIk.error, null);
    await page.screenshot({ path: fileURLToPath(new URL('arm-ik-hints.png', artifacts)) });
    await page.getByRole('button', { name: 'Reset arm IK', exact: true }).click();
    assert.deepEqual(await armSettings(), defaultHints);
    const resetArms = await armGeometry();
    for (const side of ['left', 'right']) {
      assert.ok(new Vector3(...resetArms[side].elbow).distanceTo(new Vector3(...defaultArms[side].elbow)) < 1e-8);
    }
    assert.equal(await armRecord(), savedDirections, 'Reset must remain a preview until saved.');
    assert.deepEqual(await physics(), armPhysics);
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
      .filter((key) => key.startsWith('over-the-edge:tuning:'))
      .map((key) => [key, localStorage.getItem(key)]))), namedTunings);
    await pastProfiles.selectOption(savedProfile);
    assert.deepEqual(await armSettings(), defaultHints, 'Selecting a profile must not apply it.');
    await loadProfile.click();
    assert.deepEqual(await armSettings(), savedArmSettings);

    const otherTab = await page.context().newPage();
    const otherErrors = [];
    otherTab.on('pageerror', (error) => otherErrors.push(error.message));
    const protocol = await page.context().newCDPSession(otherTab);
    await protocol.send('Runtime.enable');
    protocol.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error' || event.type === 'assert') otherErrors.push(JSON.stringify(event.args));
    });
    const countBeforeOtherTab = Object.keys(await armRecords()).length;
    await pastProfiles.selectOption(originalProfile);
    try {
      await otherTab.goto(page.url(), { waitUntil: 'networkidle' });
      await otherTab.getByRole('tab', { name: 'Appearance', exact: true }).click();
      await otherTab.waitForFunction(() => !window.gettingOver.appearance().restoring);
      await otherTab.getByRole('textbox', { name: 'IK profile name', exact: true }).fill('Other tab pose');
      await otherTab.getByRole('button', { name: 'Save IK profile', exact: true }).click();
      await page.waitForFunction((count) => document.querySelector('#past-arm-ik').options.length === count, countBeforeOtherTab + 1);
      assert.equal(await pastProfiles.inputValue(), originalProfile);
      assert.deepEqual(await armSettings(), savedArmSettings, 'Other tabs may refresh history, never this preview.');
      assert.deepEqual(otherErrors, []);
    } finally {
      await otherTab.close();
    }
    await loadProfile.click();
    assert.deepEqual(await armSettings(), defaultHints);
    assert.equal(await armRecord(), savedDefaults, 'Loading an older profile must persist that selection without rewriting its snapshot.');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver && !window.gettingOver.appearance().restoring);
    await page.locator('#game').focus();
    await page.keyboard.press('p');
    await openEditor();
    await frames();
    assert.deepEqual(await armSettings(), defaultHints, 'The last loaded profile, not simply the newest save, must restore.');
    await pastProfiles.selectOption(savedProfile);
    await loadProfile.click();
    assert.deepEqual(await armSettings(), savedArmSettings);
    assert.equal((await appearance()).armIk.dirty, false);
    await armGeometry();

    await setHint('Left elbow hint Y', -0.4);
    const partialPreview = await armSettings();
    const beforePartial = await armRecords();
    const beforePartialSelection = await armRecord();
    await profileName.fill('Selection quota');
    await page.evaluate((active) => {
      const original = Storage.prototype.setItem;
      window.restoreArmIkWrites = () => { Storage.prototype.setItem = original; delete window.restoreArmIkWrites; };
      Storage.prototype.setItem = function (key, value) {
        if (key === active) throw new DOMException('Selection quota probe', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    }, activeKey);
    let partialKey;
    try {
      await saveProfile.click();
      assert.ok((await appearance()).armIk.error.includes('saved in history'));
      const created = Object.keys(await armRecords()).filter((key) => !Object.hasOwn(beforePartial, key));
      assert.equal(created.length, 1, 'A completed history write must survive a subsequent selection failure.');
      partialKey = created[0];
      assert.equal(await armRecord(), beforePartialSelection);
      assert.deepEqual(await armSettings(), partialPreview);
      await pastProfiles.selectOption(originalProfile);
      await loadProfile.click();
      assert.deepEqual(await armSettings(), partialPreview, 'A failed activation must not apply the selected profile.');
      assert.equal(await armRecord(), beforePartialSelection);
    } finally {
      await page.evaluate(() => window.restoreArmIkWrites());
    }
    await pastProfiles.selectOption(partialKey);
    await loadProfile.click();
    assert.equal((await appearance()).armIk.dirty, false);
    await pastProfiles.selectOption(savedProfile);
    await loadProfile.click();
    const before = await physics();
    const name = 'my <custom> pot.glb';
    await upload('pot', name, modelFixture({ textured: true }));
    assert.equal(await page.locator('.appearance-source').textContent(), name);
    assert.equal(await page.locator('.appearance-source img').count(), 0);
    assert.equal((await part('pot')).defaultsVisible, false);
    assert.equal((await part('torso')).custom, false);
    assert.deepEqual(await physics(), before, 'Importing a visual must not change physical bodies, colliders, masses or tuning.');
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();

    const pot = (await snapshot()).parts.find((part) => part.id === 'pot');
    const screen = await page.evaluate((pot) => window.gettingOver.project({ x: pot.x, y: pot.y - 0.1 }), pot);
    const crop = await page.screenshot({ clip: { x: screen.x - 20, y: screen.y - 20, width: 40, height: 40 } });
    const magenta = await page.evaluate(async (encoded) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > pixels[i + 1] * 1.4 && pixels[i + 2] > pixels[i + 1] * 1.4 && pixels[i] > 100) count++;
      }
      image.close();
      return count;
    }, crop.toString('base64'));
    assert.ok(magenta > 500, `The imported textured mesh must render on the pot; found ${magenta} textured pixels.`);

    await page.getByRole('slider', { name: 'Visual scale', exact: true }).press('ArrowRight');
    await page.getByRole('slider', { name: 'Rotate Z', exact: true }).press('ArrowRight');
    await page.getByRole('slider', { name: 'Offset X', exact: true }).press('ArrowRight');
    const alignment = (await part('pot')).alignment;
    assert.equal((await part('pot')).dirty, true);
    await page.getByRole('button', { name: 'Save alignment', exact: true }).click();
    await page.waitForFunction(() => !window.gettingOver.appearance().parts.find((part) => part.id === 'pot').dirty);
    await upload('left-upper-arm', 'arm.glb', modelFixture({ size: [0.12, 1, 0.12] }));
    await upload('hammer-shaft', 'shaft.glb', modelFixture({ size: [1.5, 0.08, 0.08] }));
    await upload('hammer-head', 'hammer.glb', modelFixture({ size: [0.2, 0.58, 0.22] }));
    assert.deepEqual(await physics(), before, 'Appearance alignment and other part imports must leave physics unchanged.');
    assert.equal((await part('right-upper-arm')).custom, false, 'Left and right arm customization must be independent.');
    const importedArm = (await part('left-upper-arm')).transform;
    await setHint('Left elbow hint Z', -0.6);
    await armGeometry();
    assert.notDeepEqual((await part('left-upper-arm')).transform, importedArm,
      'An imported arm must turn toward the configured body-relative hint.');
    assert.deepEqual(await physics(), before);
    await setHint('Left elbow hint Z', savedArmSettings.leftHintZ);
    assert.deepEqual(await armSettings(), savedArmSettings);
    await page.screenshot({ path: fileURLToPath(new URL('custom-visuals.png', artifacts)) });

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver && !window.gettingOver.appearance().restoring);
    await page.locator('#game').focus();
    await page.keyboard.press('p');
    await openEditor();
    assert.deepEqual((await part('pot')).alignment, alignment);
    assert.deepEqual(await armSettings(), savedArmSettings);
    await armGeometry();
    for (const id of ['pot', 'left-upper-arm', 'hammer-shaft', 'hammer-head']) {
      assert.equal((await part(id)).custom, true, `${id} must restore after reload.`);
    }
    await page.locator('#game').focus();
    await page.keyboard.press('3');
    await page.waitForTimeout(150);
    const moved = await snapshot();
    for (const [slot, physicalId] of [['pot', 'pot'], ['hammer-head', 'head']]) {
      const anchor = (await part(slot)).anchor;
      const body = moved.parts.find((part) => part.id === physicalId);
      assert.ok(Math.hypot(anchor.x - body.x, anchor.y - body.y) < 1e-8, `${slot} must follow its physical body after a practice reset.`);
    }
    const armBefore = (await part('left-upper-arm')).anchor;
    const relativeBefore = { x: armBefore.x - moved.root.x, y: armBefore.y - moved.root.y };
    await page.keyboard.press('p');
    const canvas = await page.locator('#game').boundingBox();
    assert.ok(canvas);
    await page.mouse.move(canvas.x + canvas.width * 0.48, canvas.y + canvas.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * 0.48 + 100, canvas.y + canvas.height * 0.4 - 40, { steps: 12 });
    await page.mouse.up();
    const motionTime = (await snapshot()).time;
    await page.waitForFunction((time) => window.gettingOver.snapshot().time >= time, motionTime + 1.5);
    await page.locator('#game').focus();
    await page.keyboard.press('p');
    await page.waitForTimeout(80);
    const animated = await snapshot();
    const armAfter = (await part('left-upper-arm')).anchor;
    assert.ok(Math.hypot(armAfter.x - animated.root.x - relativeBefore.x,
      armAfter.y - animated.root.y - relativeBefore.y) > 0.05, 'The imported arm must follow changing visual IK, not just root translation.');
    const preserved = await physics();
    await page.getByLabel('Body part', { exact: true }).selectOption('pot');
    for (const [name, bytes] of [
      ['broken.glb', Buffer.from('not a GLB')],
      ['external.glb', modelFixture({ externalTexture: true })],
    ]) {
      await page.getByLabel('GLB model', { exact: true }).setInputFiles({ name, mimeType: 'model/gltf-binary', buffer: bytes });
      await page.waitForFunction(() => {
        const part = window.gettingOver.appearance().parts.find((part) => part.id === 'pot');
        return !part.busy && part.error !== null;
      });
      assert.equal((await part('pot')).name, 'my <custom> pot.glb');
      assert.equal((await part('pot')).custom, true);
      assert.deepEqual(await physics(), preserved);
    }
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      window.restoreModelWrites = () => { IDBObjectStore.prototype.put = original; delete window.restoreModelWrites; };
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.name === 'parts') throw new DOMException('Model quota probe', 'QuotaExceededError');
        return original.call(this, value, key);
      };
    });
    try {
      await page.getByLabel('GLB model', { exact: true }).setInputFiles({
        name: 'replacement.glb', mimeType: 'model/gltf-binary', buffer: modelFixture(),
      });
      await page.waitForFunction(() => {
        const part = window.gettingOver.appearance().parts.find((part) => part.id === 'pot');
        return !part.busy && part.error?.includes('could not be saved');
      });
      assert.equal((await part('pot')).name, 'my <custom> pot.glb');
      assert.equal((await part('pot')).custom, true, 'A storage failure must leave the current visual in place.');
      assert.deepEqual(await physics(), preserved);
    } finally {
      await page.evaluate(() => window.restoreModelWrites());
    }
    assert.deepEqual(foreignRequests, [], 'GLB files must not initiate external resource requests.');
    assert.deepEqual(uploads, [], 'Private model data must not be uploaded to a server.');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver && !window.gettingOver.appearance().restoring);
    await openEditor();
    assert.equal((await part('pot')).name, 'my <custom> pot.glb', 'Failed imports must not overwrite the saved model.');
    assert.deepEqual((await part('pot')).alignment, alignment);
    await page.getByRole('button', { name: 'Use default', exact: true }).click();
    await page.waitForFunction(() => {
      const part = window.gettingOver.appearance().parts.find((part) => part.id === 'pot');
      return !part.busy && !part.custom && part.error === null;
    });
    assert.equal((await part('pot')).defaultsVisible, true);
    assert.equal((await part('left-upper-arm')).custom, true, 'Restoring one part must not reset other imports.');
    await page.evaluate((key) => localStorage.setItem(key, '{broken'), savedProfile);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver && !window.gettingOver.appearance().restoring);
    assert.equal((await part('pot')).custom, false, 'Default restoration must persist.');
    assert.equal((await part('hammer-head')).custom, true);
    await openEditor();
    assert.ok((await appearance()).armIk.error.includes('invalid'));
    assert.equal((await armRecords())[savedProfile], '{broken', 'An invalid profile must remain intact.');
    assert.deepEqual(await armSettings(), defaultHints, 'An unreadable active profile must not silently load another saved profile.');
    assert.ok(await page.locator('.arm-ik-state').filter({ hasText: 'invalid' }).isVisible());
    await page.getByRole('button', { name: 'Reset arm IK', exact: true }).click();
    assert.equal((await armRecords())[savedProfile], '{broken');
    await profileName.fill('After corruption');
    await saveProfile.click();
    assert.deepEqual(JSON.parse((await armRecords())[await pastProfiles.inputValue()]).settings, defaultHints);
    assert.equal((await armRecords())[savedProfile], '{broken', 'A new save must not overwrite an unreadable profile.');
    assert.equal((await appearance()).armIk.error, null);
    const previousRecord = JSON.stringify({ schemaVersion: 1, settings: { leftElbowAngle: 45, rightElbowAngle: -90 } });
    const beforeMigration = await armRecords();
    await page.evaluate(({ activeKey, previousRecord }) => {
      localStorage.removeItem(activeKey);
      localStorage.setItem('over-the-edge:appearance:arm-ik:v1', previousRecord);
    }, { activeKey, previousRecord });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver && !window.gettingOver.appearance().restoring);
    await openEditor();
    assert.deepEqual(await armSettings(), defaultHints);
    assert.equal((await appearance()).armIk.previousSave, true);
    assert.equal(await page.locator('.arm-ik-migration').isVisible(), true);
    assert.deepEqual(await armRecords(), beforeMigration, 'Opening the new editor must not rewrite either generation of saves.');
    await profileName.fill('Body-space baseline');
    await saveProfile.click();
    assert.equal(await page.evaluate(() => localStorage.getItem('over-the-edge:appearance:arm-ik:v1')), previousRecord);
    assert.equal((await appearance()).armIk.previousSave, false);
    const activeProfile = await pastProfiles.inputValue();
    await page.evaluate((key) => localStorage.setItem(key, '{broken'), activeKey);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver && !window.gettingOver.appearance().restoring);
    await openEditor();
    assert.ok((await appearance()).armIk.error.includes('invalid'));
    assert.equal(await armRecord(), '{broken', 'A malformed selection must not be silently replaced.');
    await pastProfiles.selectOption(activeProfile);
    await loadProfile.click();
    assert.equal((await appearance()).armIk.profile.key, activeProfile);
    for (const id of ['left-upper-arm', 'hammer-shaft', 'hammer-head']) {
      await page.getByLabel('Body part', { exact: true }).selectOption(id);
      await page.getByRole('button', { name: 'Use default', exact: true }).click();
      await page.waitForFunction((id) => {
        const part = window.gettingOver.appearance().parts.find((part) => part.id === id);
        return !part.busy && !part.custom;
      }, id);
    }
    await page.getByRole('tab', { name: 'Physics', exact: true }).click();
    return {
      importedParts: 4, texturedPixels: magenta, alignmentSaved: true, reloadRestored: true,
      physicsUnchanged: true, followsIk: true, failedWritesPreserved: true, externalRequests: 0,
      armIk: { bodyRelativeHints: true, gripsOnShaft: true, namedProfiles: true, crossTabSafe: true,
        activeProfileRestored: true, partialWriteReported: true, oldSwivelRetained: true, resetIsPreview: true },
    };
  } finally {
    await page.unroute(/^https?:\/\//, intercept);
  }
}
