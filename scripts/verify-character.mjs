import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Matrix4, Vector3 } from 'three';
import { createServer } from 'vite';
import { observeBrowserPage } from './verify-level.mjs';
import { modelFixture, texturePng } from './verify-appearance.mjs';
import { hammerGlb, HUMANOID_BONE_MAP, humanoidBoneMap, patchGlbJson, potGlb, skinnedAvatarGlb } from './character-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const PREFIX = 'mixamorig:';
const BONE_MAP = humanoidBoneMap(PREFIX);
const GRIP_X = { left: 0.04, right: 0.22 };
const TOOL_DEPTH = 0.5 + 0.25;
const HEAD_DISTANCE = 1.5;
const POT = { depth: 0.22, bottom: -0.48 };
const EPSILON = 1e-6;
const DIRECTIONS = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'];
const glbFile = (name, buffer) => ({ name, mimeType: 'model/gltf-binary', buffer });
const glbSource = buffer => `data:model/gltf-binary;base64,${buffer.toString('base64')}`;
const bytes = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

// Schema rules for profile data: schema 8 stays a byte-identical fixed point, and a pot needs schema 9.
function verifySchemas(data) {
  const base = {
    characterRiggingType: 'avatar-3d', armForwardDistance: 0.3, images: [], layers: [], skeleton: null, presentation: null,
  };
  const models = [
    { id: 'avatar', name: 'Hero', source: glbSource(skinnedAvatarGlb()) },
    { id: 'hammer', name: 'Mallet', source: glbSource(hammerGlb()) },
    { id: 'pot', name: 'Urn', source: glbSource(potGlb()) },
  ];
  const roles = { avatar: { model: 'avatar', boneMap: HUMANOID_BONE_MAP }, hammer: { model: 'hammer' } };
  const shading = { mode: 'cel', bands: 4, outline: null };
  const canonical = value => JSON.stringify(data.validateSpriteDocument(JSON.parse(JSON.stringify(value))));
  const eight = { schemaVersion: 8, ...base, models: models.slice(0, 2), ...roles, shading };
  assert.equal(canonical(eight), JSON.stringify(eight), 'A schema-8 profile without a pot stays byte-identical.');
  const nine = { schemaVersion: 9, ...base, models, ...roles, pot: { model: 'pot' }, shading };
  assert.equal(canonical(nine), JSON.stringify(nine), 'Schema 9 lists the pot after the hammer.');
  const potOnly = { schemaVersion: 9, ...base, characterRiggingType: 'model-3d', models: [models[2]], pot: { model: 'pot' } };
  assert.equal(canonical(potOnly), JSON.stringify(potOnly), 'A pot model alone is schema 9.');
  assert.equal(JSON.parse(canonical({ ...nine, models: models.slice(0, 2), pot: undefined })).schemaVersion, 8,
    'Removing the pot model saves schema 8 again.');
  const rejected = {
    'pot in schema 8': [{ ...nine, schemaVersion: 8 }, /pot model requires sprite schema version 9/],
    'shared pot model': [{ ...nine, models: models.slice(0, 2), pot: { model: 'hammer' } }, /separate character models/],
    'four models': [{ ...nine, models: [...models, { ...models[2], id: 'spare' }] }, /1-3 models/],
    'unused pot model': [{ ...nine, pot: undefined }, /no avatar, hammer or pot uses/],
  };
  for (const [name, [value, error]] of Object.entries(rejected)) {
    assert.throws(() => canonical(value), error, `${name} must be rejected.`);
  }
  return { schema8FixedPoint: true, schema9FixedPoint: true, rejected: Object.keys(rejected) };
}

// Typed codes from the shared validator, exactly as release builds and the browser loader see them.
async function verifyTypedErrors() {
  const server = await createServer({ root, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true } });
  try {
    const inspect = await server.ssrLoadModule('/src/character-model-inspect.ts');
    const profile = await server.ssrLoadModule('/src/character-profile.ts');
    const schemas = verifySchemas(await server.ssrLoadModule('/src/sprite-data.ts'));
    const code = (action) => {
      try {
        action();
      } catch (error) {
        assert.ok(error instanceof profile.CharacterModelError, `Expected a typed CharacterModelError, got ${error}`);
        return error.code;
      }
      throw new Error('Expected a typed character-model failure.');
    };
    const avatar = inspect.inspectCharacterModel(bytes(skinnedAvatarGlb({ prefix: PREFIX })), 'avatar');
    const resolve = changes => () => inspect.resolveAvatarJoints(avatar, { ...BONE_MAP, ...changes });
    const cases = {
      'no-skin': () => inspect.inspectCharacterModel(bytes(modelFixture()), 'avatar'),
      'unexpected-skin': () => inspect.inspectCharacterModel(bytes(skinnedAvatarGlb()), 'hammer'),
      'invalid-model': () => inspect.inspectCharacterModel(bytes(hammerGlb({ axis: 'y' })), 'hammer'),
      'invalid-skin': () => inspect.inspectCharacterModel(bytes(skinnedAvatarGlb({ omitBindMatrices: true })), 'avatar'),
      'model-limits': () => inspect.inspectCharacterModel(bytes(skinnedAvatarGlb({ extraNodes: 2100 })), 'avatar'),
      'too-many-influences': () => inspect.inspectCharacterModel(bytes(skinnedAvatarGlb({ extraInfluences: true })), 'avatar'),
      'unnormalized-weights': () => inspect.inspectCharacterModel(bytes(skinnedAvatarGlb({ unnormalized: true })), 'avatar'),
      'missing-joint': resolve({ head: undefined }),
      'unknown-joint': resolve({ head: 'Skull' }),
      'duplicate-joint': resolve({ head: `${PREFIX}Hips` }),
      'ambiguous-joint': () => inspect.resolveAvatarJoints(
        inspect.inspectCharacterModel(bytes(skinnedAvatarGlb({ duplicateName: 'Head' })), 'avatar'), humanoidBoneMap()),
      'broken-chain': resolve({ 'left-hand': `${PREFIX}Spine` }),
      'crossed-arms': resolve({
        'left-upper-arm': `${PREFIX}LeftArm`, 'left-forearm': `${PREFIX}LeftForeArm`, 'left-hand': `${PREFIX}LeftHand`,
        'right-upper-arm': `${PREFIX}RightArm`, 'right-forearm': `${PREFIX}RightForeArm`, 'right-hand': `${PREFIX}RightHand`,
      }),
      'degenerate-rig': () => inspect.resolveAvatarJoints(
        inspect.inspectCharacterModel(bytes(skinnedAvatarGlb({ prefix: PREFIX, armScale: 1e-7 })), 'avatar'), BONE_MAP),
    };
    // Malformed JSON must stay typed too, instead of escaping as a reader exception.
    const weights = json => json.meshes[0].primitives[0].attributes.WEIGHTS_0;
    for (const [label, expected, mutate] of [
      ['negative weight accessor offset', 'invalid-skin', json => { json.accessors[weights(json)].byteOffset = -4; }],
      ['negative weight view offset', 'invalid-skin', json => { json.bufferViews[json.accessors[weights(json)].bufferView].byteOffset = -8; }],
      ['negative position accessor offset', 'invalid-model', json => {
        json.accessors[json.meshes[0].primitives[0].attributes.POSITION].byteOffset = -12;
      }],
      ['non-object image', 'invalid-model', json => { json.images = [[]]; }],
      ['non-object node', 'invalid-model', json => { json.nodes[0] = 7; }],
    ]) {
      assert.equal(code(() => inspect.inspectCharacterModel(bytes(patchGlbJson(skinnedAvatarGlb(), mutate)), 'avatar')),
        expected, `A GLB with a ${label} must fail as ${expected}.`);
    }
    const results = {};
    for (const [expected, action] of Object.entries(cases)) {
      results[expected] = code(action);
      assert.equal(results[expected], expected, `${expected} must be reported with its typed code.`);
    }
    assert.deepEqual(profile.CHARACTER_MODEL_ERROR_CODES.filter(name => !(name in results)), [],
      'Every typed code must have a failing fixture.');
    assert.deepEqual({ ...inspect.suggestAvatarBoneMap(avatar) }, { ...BONE_MAP },
      'Mixamo names, including the mixamorig: prefix, must map automatically by screen side.');
    // Pots are static and follow their convention: +Y up, origin at the bottom-centre, metres.
    const pot = inspect.inspectCharacterModel(bytes(potGlb()), 'pot');
    assert.deepEqual([pot.bounds.min[1], pot.meshes], [0, 2], 'The pot fixture stands on its origin.');
    const potCodes = {};
    for (const [label, expected, glb] of [
      ['skinned pot', 'unexpected-skin', skinnedAvatarGlb()],
      ['origin at the centre', 'invalid-model', potGlb({ origin: 'centre' })],
      ['origin at an edge', 'invalid-model', potGlb({ origin: 'edge' })],
      ['Z-up axes', 'invalid-model', potGlb({ axis: 'z' })],
      ['centimetres', 'invalid-model', potGlb({ scale: 100 })],
      ['a hammer', 'invalid-model', hammerGlb()],
    ]) {
      potCodes[label] = code(() => inspect.inspectCharacterModel(bytes(glb), 'pot'));
      assert.equal(potCodes[label], expected, `A pot with ${label} must fail as ${expected}.`);
    }
    return { codes: Object.keys(results), mixamoAutoMap: true, potCodes, schemas };
  } finally {
    await server.close();
  }
}

function subtract(a, b) { return a.map((value, index) => value - b[index]); }
function length(a) { return Math.hypot(...a); }
function dot(a, b) { return a.reduce((sum, value, index) => sum + value * b[index], 0); }

// Expected IK frame from physics: shoulders from the imported chains, grips on the physical shaft.
function armExpectation(state, chains, side) {
  const root = state.parts.find(part => part.id === 'root');
  const slider = state.parts.find(part => part.id === 'slider');
  const head = state.parts.find(part => part.id === 'head');
  const shaftLength = Math.hypot(head.x - slider.x, head.y - slider.y);
  const angle = Math.atan2(head.y - slider.y, head.x - slider.x);
  const grip = Math.min(GRIP_X[side], shaftLength);
  const chain = chains[side];
  return {
    shoulder: [root.x + chain.shoulder[0], root.y + chain.shoulder[1], 0.27 + chain.shoulder[2]],
    hand: [slider.x + Math.cos(angle) * grip, slider.y + Math.sin(angle) * grip, TOOL_DEPTH],
    angle, slider, head,
  };
}

export async function verifyCharacter(browser, address, artifacts) {
  const report = { errors: [] };
  report.typed = await verifyTypedErrors();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await observeBrowserPage(page, report.errors);
  const rendering = () => page.evaluate(() => window.gettingOver.level().rendering);
  const sprites = () => page.evaluate(() => {
    const state = window.gettingOver.sprites();
    return {
      busy: state.busy, restoring: state.restoring, error: state.error, modelIssue: state.modelIssue,
      avatarModel: state.avatarModel, hammerModel: state.hammerModel, potModel: state.potModel,
      shading: state.shading, dirty: state.dirty,
      schemaVersion: state.document.schemaVersion, boneMap: state.document.avatar?.boneMap ?? null,
    };
  });
  const snapshot = () => page.evaluate(() => window.gettingOver.snapshot());
  const idle = () => page.waitForFunction(() => {
    const state = window.gettingOver.sprites();
    return !state.busy && !state.restoring;
  });
  const frames = (count = 2) => page.evaluate(total => new Promise(resolve => {
    let remaining = total;
    const tick = () => (--remaining <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), count);
  const openCharacter = async () => {
    const toggle = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByRole('tab', { name: 'Character', exact: true }).click();
  };
  const importAvatar = async (name, buffer) => {
    await page.getByLabel('Skinned avatar GLB', { exact: true }).setInputFiles(glbFile(name, buffer));
    await idle();
    await frames();
  };
  const exportProfile = async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.character-export').click()]);
    return readFile(await download.path(), 'utf8');
  };
  const physics = async () => {
    const state = await snapshot();
    return { parts: state.parts, bodyProperties: state.bodyProperties, tuning: state.tuning, time: state.time };
  };
  const pause = async () => {
    await page.locator('#game').focus();
    if (!(await snapshot()).paused) await page.keyboard.press('p');
    await page.waitForFunction(() => window.gettingOver.snapshot().paused);
    await frames();
  };
  const unpause = async () => {
    await page.locator('#game').focus();
    if ((await snapshot()).paused) await page.keyboard.press('p');
    await page.waitForFunction(() => !window.gettingOver.snapshot().paused);
  };
  const clip = async name => {
    const state = await snapshot();
    const point = await page.evaluate(value => window.gettingOver.project(value), { x: state.root.x + 0.4, y: state.root.y + 0.6 });
    await page.screenshot({ path: fileURLToPath(new URL(name, artifacts)), clip: { x: point.x - 230, y: point.y - 190, width: 460, height: 330 } });
  };

  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    await idle();
    await openCharacter();
    await page.getByRole('button', { name: 'Use Avatar', exact: true }).click();
    await frames();
    const builtIn = (await rendering()).avatar;
    assert.equal(builtIn.visible, true, 'Avatar mode starts with the built-in mesh.');
    await pause();

    // S1: a Mixamo-named skinned GLB replaces the built-in avatar and follows the IK.
    await importAvatar('hero.glb', skinnedAvatarGlb({ prefix: PREFIX, posed: true }));
    let state = await sprites();
    assert.equal(state.error, null);
    assert.equal(state.avatarModel.pending, false);
    assert.deepEqual({ ...state.boneMap }, { ...BONE_MAP }, 'The editor must apply the automatic Mixamo bone map.');
    assert.equal(state.schemaVersion, 8);
    let view = await rendering();
    assert.equal(view.importedAvatar.visible, true);
    assert.equal(view.avatar.visible, false, 'The imported avatar replaces the built-in mesh.');
    assert.equal(view.importedAvatar.unmapped.length, 13);
    const follows = Object.fromEntries(view.importedAvatar.unmapped.map(joint => [joint.name, joint.follows]));
    assert.equal(follows[`${PREFIX}Spine`], 'body');
    assert.equal(follows[`${PREFIX}Neck`], 'body');
    assert.equal(follows[`${PREFIX}LeftHandIndex1`], 'right-hand', 'A rig\'s anatomical left fingers follow the screen-right hand.');
    assert.equal(follows[`${PREFIX}LeftUpLeg`], 'body');
    assert.equal(await page.locator('.character-unmapped-list li').count(), 13, 'Unmapped joints are listed in the editor.');
    const checkArms = async (label) => {
      const [paused, drawn] = [await snapshot(), await rendering()];
      const avatar = drawn.importedAvatar;
      const result = {};
      for (const side of ['left', 'right']) {
        const expected = armExpectation(paused, avatar.chains, side);
        const shoulder = avatar.joints[`${side}-upper-arm`];
        const elbow = avatar.joints[`${side}-forearm`];
        const hand = avatar.joints[`${side}-hand`];
        assert.ok(length(subtract(shoulder, expected.shoulder)) < EPSILON, `${label}: ${side} shoulder must be the GLB bind shoulder.`);
        assert.ok(length(subtract(hand, expected.hand)) < 1e-5, `${label}: ${side} wrist must reach the physical grip.`);
        assert.ok(Math.abs(length(subtract(elbow, shoulder)) - avatar.chains[side].upper) < 1e-5,
          `${label}: ${side} upper arm keeps its bind-pose length.`);
        const reach = length(subtract(hand, shoulder));
        const straight = avatar.chains[side].upper + avatar.chains[side].forearm;
        const axis = subtract(hand, shoulder).map(value => value / reach);
        const offset = subtract(elbow, shoulder);
        const bend = length(offset.map((value, index) => value - axis[index] * dot(offset, axis)));
        result[side] = { reach, straight, bend, forearm: length(subtract(hand, elbow)) };
      }
      return result;
    };
    const reachable = await checkArms('reachable grips');
    for (const side of ['left', 'right']) {
      assert.ok(reachable[side].reach < reachable[side].straight, 'The long-armed fixture reaches its grips.');
      assert.ok(reachable[side].bend > 0.05, `The ${side} elbow must bend toward the grip.`);
      assert.ok(Math.abs(reachable[side].forearm - view.importedAvatar.chains[side].forearm) < 1e-5,
        'A reachable forearm keeps its bind-pose length.');
    }
    await clip('character-imported-pbr.png');

    // Per-frame work is seven bone writes, whatever the level holds.
    await unpause();
    const counted = async () => {
      const before = await rendering();
      await frames(20);
      const after = await rendering();
      const props = key => after[key] === null ? null : after[key].matrixWrites - before[key].matrixWrites;
      return {
        writes: after.importedAvatar.boneWrites - before.importedAvatar.boneWrites, frames: after.renders - before.renders,
        hammer: props('hammerModel'), pot: props('potModel'),
      };
    };
    const small = await counted();
    assert.equal(small.writes, small.frames * 7, 'Each rendered frame writes exactly the seven driven bones.');
    await pause();

    // Unreachable grips stretch the forearm, like the built-in avatar, without moving the hand.
    await importAvatar('short.glb', skinnedAvatarGlb({ prefix: PREFIX, armScale: 0.3 }));
    const stretched = await checkArms('unreachable grips');
    for (const side of ['left', 'right']) {
      assert.ok(stretched[side].reach > stretched[side].straight, 'The short-armed fixture cannot reach its grips.');
      assert.ok(stretched[side].bend < 1e-5, 'An unreachable arm is fully extended.');
      const rest = (await rendering()).importedAvatar.chains[side].forearm;
      assert.ok(Math.abs(stretched[side].forearm - (stretched[side].reach - (stretched[side].straight - rest))) < 1e-5 &&
        stretched[side].forearm > rest + 1e-3, `The ${side} forearm stretches to the grip (${stretched[side].forearm} > ${rest}).`);
    }
    report.ik = { reachable, stretched };
    await importAvatar('hero.glb', skinnedAvatarGlb({ prefix: PREFIX }));

    // Incomplete and broken maps fail with typed codes and leave the applied avatar untouched.
    const selectBone = async (joint, value) => {
      await page.locator(`#character-bone-${joint}`).selectOption(value);
      await idle();
    };
    const pendingCode = async () => {
      const current = await sprites();
      assert.equal(current.avatarModel.pending, true);
      assert.deepEqual({ ...current.boneMap }, { ...BONE_MAP }, 'An invalid map must not replace the applied one.');
      assert.equal(await page.locator('.character-bone-issue').getAttribute('data-code'), current.avatarModel.issue.code);
      return current.avatarModel.issue.code;
    };
    await selectBone('head', '');
    assert.equal(await pendingCode(), 'missing-joint');
    await page.getByRole('button', { name: 'Discard bone map changes', exact: true }).click();
    await selectBone('left-hand', `${PREFIX}Spine`);
    assert.equal(await pendingCode(), 'broken-chain');
    await page.getByRole('button', { name: 'Discard bone map changes', exact: true }).click();
    assert.equal((await sprites()).avatarModel.pending, false);
    const editorCodes = {};
    for (const [expected, name, buffer] of [
      ['no-skin', 'static.glb', modelFixture()],
      ['too-many-influences', 'eight-weights.glb', skinnedAvatarGlb({ prefix: PREFIX, extraInfluences: true })],
      ['unnormalized-weights', 'loose-weights.glb', skinnedAvatarGlb({ prefix: PREFIX, unnormalized: true })],
      ['model-limits', 'too-many-nodes.glb', skinnedAvatarGlb({ prefix: PREFIX, extraNodes: 2100 })],
    ]) {
      await page.getByLabel('Skinned avatar GLB', { exact: true }).setInputFiles(glbFile(name, buffer));
      await idle();
      const current = await sprites();
      assert.equal(current.modelIssue?.code, expected, `${name} must fail with ${expected}.`);
      assert.equal(await page.locator('.character-state').getAttribute('data-code'), expected);
      assert.deepEqual({ ...current.boneMap }, { ...BONE_MAP }, 'A rejected import keeps the applied avatar.');
      editorCodes[name] = expected;
    }
    report.editorCodes = editorCodes;
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();

    // S2: one rigid hammer model on the physical tool frame, in every character type.
    await pause();
    const beforeHammer = await physics();
    await page.getByLabel('Hammer GLB', { exact: true }).setInputFiles(glbFile('mallet.glb', hammerGlb()));
    await idle();
    await frames();
    const checkHammer = async (label) => {
      const [paused, drawn, parts] = [await snapshot(), await rendering(),
        await page.evaluate(() => window.gettingOver.appearance().parts)];
      assert.equal(drawn.hammerModel.visible, true, `${label}: the hammer model must be visible.`);
      for (const id of ['hammer-shaft', 'hammer-head']) {
        assert.equal(parts.find(part => part.id === id).defaultsVisible, false, `${label}: the two-part ${id} is replaced.`);
      }
      const frame = new Matrix4().fromArray(drawn.hammerModel.transform);
      const expected = armExpectation(paused, drawn.armChains, 'left');
      const columns = [0, 1, 2].map(column => new Vector3().setFromMatrixColumn(frame, column));
      assert.ok(columns.every(axis => Math.abs(axis.length() - 1) < EPSILON), `${label}: the hammer is not stretched.`);
      assert.ok(columns[0].distanceTo(new Vector3(Math.cos(expected.angle), Math.sin(expected.angle), 0)) < EPSILON,
        `${label}: the handle runs along the physical shaft.`);
      const origin = new Vector3().setFromMatrixPosition(frame);
      assert.ok(origin.distanceTo(new Vector3(expected.slider.x, expected.slider.y, TOOL_DEPTH)) < EPSILON,
        `${label}: the model origin sits at the butt of the physical handle.`);
      const head = new Vector3(HEAD_DISTANCE, 0, 0).applyMatrix4(frame);
      assert.ok(Math.hypot(head.x - expected.head.x, head.y - expected.head.y) < 1e-3,
        `${label}: the modelled head sits on the collision head.`);
      return { origin: origin.toArray(), angle: expected.angle };
    };
    report.hammer = { avatar: await checkHammer('avatar mode') };
    assert.deepEqual(await physics(), beforeHammer, 'The hammer model must not change physical length, grips or contacts.');
    await page.locator('#character-rigging-type').selectOption('model-3d');
    await frames();
    report.hammer.meshParts = await checkHammer('mesh parts mode');
    assert.equal((await rendering()).importedAvatar.visible, false, 'Mesh parts mode hides the avatar.');
    await page.locator('#character-rigging-type').selectOption('avatar-3d');
    await frames();
    await page.getByRole('button', { name: 'Use two-part hammer', exact: true }).click();
    await idle();
    await frames();
    assert.equal((await rendering()).hammerModel, null);
    assert.equal((await page.evaluate(() => window.gettingOver.appearance().parts))
      .find(part => part.id === 'hammer-head').defaultsVisible, true, 'The two-part hammer remains the default.');
    await page.getByLabel('Hammer GLB', { exact: true }).setInputFiles(glbFile('mallet.glb', hammerGlb()));
    await idle();
    await page.getByLabel('Hammer GLB', { exact: true }).setInputFiles(glbFile('skinned.glb', skinnedAvatarGlb()));
    await idle();
    assert.equal((await sprites()).modelIssue?.code, 'unexpected-skin');
    assert.equal((await sprites()).hammerModel.name, 'mallet', 'A rejected hammer keeps the current one.');
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();

    // A pot model follows the physical pot body rigidly, at the pot's depth, in every character type.
    await pause();
    const schema8 = await exportProfile();
    assert.equal(JSON.parse(schema8).schemaVersion, 8);
    const beforePot = await physics();
    await page.getByLabel('Pot GLB', { exact: true }).setInputFiles(glbFile('urn.glb', potGlb()));
    await idle();
    await frames();
    const checkPot = async (label) => {
      const [paused, drawn, parts] = [await snapshot(), await rendering(),
        await page.evaluate(() => window.gettingOver.appearance().parts)];
      assert.equal(drawn.potModel.visible, true, `${label}: the pot model must be visible.`);
      assert.equal(parts.find(part => part.id === 'pot').defaultsVisible, false, `${label}: the default pot is replaced.`);
      const body = paused.parts.find(part => part.id === 'pot');
      const frame = new Matrix4().fromArray(drawn.potModel.transform);
      const columns = [0, 1, 2].map(column => new Vector3().setFromMatrixColumn(frame, column));
      assert.ok(columns.every(axis => Math.abs(axis.length() - 1) < EPSILON), `${label}: the pot is not stretched.`);
      assert.ok(columns[0].distanceTo(new Vector3(Math.cos(body.angle), Math.sin(body.angle), 0)) < EPSILON,
        `${label}: the pot model turns with the physical pot.`);
      // The collision outline's bottom edge, midway between its two base vertices.
      const [baseLeft, baseRight] = body.vertices.filter(vertex => Math.abs(vertex.y - POT.bottom) < EPSILON)
        .map(vertex => new Vector3(vertex.x, vertex.y, 0).applyAxisAngle(new Vector3(0, 0, 1), body.angle).add(new Vector3(body.x, body.y, 0)));
      const bottom = baseLeft.clone().add(baseRight).multiplyScalar(0.5).setZ(POT.depth);
      const origin = new Vector3().setFromMatrixPosition(frame);
      assert.ok(origin.distanceTo(bottom) < EPSILON, `${label}: the model's base sits on the pot's physical bottom.`);
      return { origin: origin.toArray(), angle: body.angle };
    };
    report.pot = { avatar: await checkPot('avatar mode') };
    assert.deepEqual(await physics(), beforePot, 'The pot model must not change colliders, contacts or physics.');
    const notice = page.getByRole('button', { name: 'Dismiss notification', exact: true });
    if (await notice.isVisible()) await notice.click();
    await page.locator('#game').focus();
    await page.keyboard.press('d');
    await frames();
    await clip('character-pot-overlay.png');
    await page.keyboard.press('d');
    await page.locator('#character-rigging-type').selectOption('model-3d');
    await frames();
    report.pot.meshParts = await checkPot('mesh parts mode');
    await page.locator('#character-rigging-type').selectOption('avatar-3d');
    await frames();
    for (const [name, expected, buffer] of [
      ['skinned-pot.glb', 'unexpected-skin', skinnedAvatarGlb()],
      ['centred-pot.glb', 'invalid-model', potGlb({ origin: 'centre' })],
      ['centimetre-pot.glb', 'invalid-model', potGlb({ scale: 100 })],
    ]) {
      await page.getByLabel('Pot GLB', { exact: true }).setInputFiles(glbFile(name, buffer));
      await idle();
      assert.equal((await sprites()).modelIssue?.code, expected, `${name} must fail with ${expected}.`);
      assert.equal((await sprites()).potModel.name, 'urn', 'A rejected pot keeps the current one.');
    }
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    const withPot = JSON.parse(await exportProfile());
    assert.equal(withPot.schemaVersion, 9, 'A pot model saves as schema 9.');
    assert.deepEqual(withPot.models.map(model => model.id), ['avatar', 'hammer', 'pot']);
    assert.deepEqual(withPot.pot, { model: 'pot' });
    await page.getByRole('button', { name: 'Use default pot', exact: true }).click();
    await idle();
    await frames();
    assert.equal((await rendering()).potModel, null);
    assert.equal((await page.evaluate(() => window.gettingOver.appearance().parts))
      .find(part => part.id === 'pot').defaultsVisible, true, 'The default pot returns.');
    assert.equal(await exportProfile(), schema8, 'Removing the pot model restores the schema-8 profile byte for byte.');
    await page.getByLabel('Pot GLB', { exact: true }).setInputFiles(glbFile('urn.glb', potGlb()));
    await idle();
    await frames();

    // S3: flip PBR and cel live on the same models; materials are built once.
    const shadingState = async () => (await rendering()).shading;
    const pbr = await shadingState();
    assert.equal(pbr.mode, 'pbr');
    assert.equal(pbr.materialsCreated, 0, 'PBR builds no cel materials.');
    const geometriesBefore = (await rendering()).geometries;
    await page.getByRole('radio', { name: 'Cel', exact: true }).check();
    await frames();
    const cel = await shadingState();
    assert.equal(cel.mode, 'cel');
    assert.ok(cel.materialsCreated > 0 && cel.hullsVisible > 0 && cel.skinnedHulls >= 2 && cel.sharedSkeletons);
    const potTypes = async () => (await rendering()).potModel.materialTypes;
    assert.deepEqual(await potTypes(), ['MeshToonMaterial'], 'Cel shading restyles the pot model.');
    await clip('character-imported-cel.png');
    await page.getByRole('radio', { name: 'PBR', exact: true }).check();
    await frames();
    const flippedBack = await shadingState();
    assert.equal(flippedBack.mode, 'pbr');
    assert.equal(flippedBack.hullsVisible, 0);
    assert.deepEqual(await potTypes(), ['MeshStandardMaterial'], 'PBR restores the pot model\'s own materials.');
    await page.getByRole('radio', { name: 'Cel', exact: true }).check();
    await page.locator('#character-cel-bands').evaluate(input => {
      input.value = '5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#character-outline-width').evaluate(input => {
      input.value = '0.03';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await frames();
    const tuned = await shadingState();
    assert.equal(tuned.materialsCreated, cel.materialsCreated, 'Later switches and cel edits create no materials.');
    assert.equal(tuned.hullsCreated, cel.hullsCreated, 'Outline hulls are built once.');
    assert.equal(tuned.outlineMaterialId, cel.outlineMaterialId);
    assert.equal(tuned.gradientTextureId, cel.gradientTextureId);
    assert.deepEqual(tuned.requested, { mode: 'cel', bands: 5, outline: { color: '#1f2428', width: 0.03 } });
    assert.equal((await rendering()).geometries, geometriesBefore, 'Outlines share the model geometry.');
    // The outline shares the skeleton, so it deforms with the arms while IK moves them.
    await unpause();
    const box = await page.locator('#game').boundingBox();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35, { steps: 12 });
    await page.mouse.up();
    await frames(10);
    const moving = await shadingState();
    assert.equal(moving.sharedSkeletons, true);
    assert.equal(moving.hullsVisible, tuned.hullsVisible, 'The outline stays attached during IK.');
    report.shading = { pbr, cel, tuned, moving };

    // Large level: the avatar writes seven bones and each prop model one matrix per frame.
    const withProps = await counted();
    assert.deepEqual([withProps.writes, withProps.hammer, withProps.pot], [withProps.frames * 7, withProps.frames, withProps.frames],
      'Per frame: seven avatar bones, one hammer matrix and one pot matrix.');
    await pause();
    const levelToggle = page.getByRole('tab', { name: 'Level', exact: true });
    await levelToggle.click();
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
    const commits = (await page.evaluate(() => window.gettingOver.level().editor.commits));
    // The full course without its modal video and popups, which would pause the measurement.
    const course = JSON.parse(await readFile(new URL('../levels/skyward-ruins.json', import.meta.url), 'utf8'));
    course.objects = course.objects.filter(object => object.kind !== 'trigger' ||
      object.events.every(event => event.type === 'launch-player' || event.type === 'stop-timer'));
    await page.locator('.level-file').setInputFiles({
      name: 'skyward-ruins.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(course)),
    });
    await page.waitForFunction(previous => window.gettingOver.level().editor.commits > previous, commits);
    await openCharacter();
    await page.locator('#game').focus();
    await page.keyboard.press('1');
    await unpause();
    const large = await counted();
    const objects = (await page.evaluate(() => window.gettingOver.level().definition.objects.length));
    assert.ok(objects >= 300, 'The large-level check must use the full course.');
    assert.equal(large.writes, large.frames * 7, 'Avatar work is independent of level size.');
    assert.equal(large.pot, large.frames, 'The pot model copies one matrix per frame on any level.');
    assert.equal(large.hammer, large.frames, 'The hammer model copies one matrix per frame on any level.');
    report.largeLevel = { objects, small, withProps, large };

    // Versioned data: schema 9 only while a pot model is present, 8 with other models or shading.
    const exported = await exportProfile();
    const profile = JSON.parse(exported);
    assert.equal(profile.schemaVersion, 9);
    assert.deepEqual(profile.models.map(model => model.id), ['avatar', 'hammer', 'pot']);
    assert.deepEqual(profile.pot, { model: 'pot' });
    assert.ok(profile.models.every(model => model.source.startsWith('data:model/gltf-binary;base64,')));
    assert.deepEqual(profile.avatar, { model: 'avatar', boneMap: { ...BONE_MAP } });
    assert.deepEqual(profile.hammer, { model: 'hammer' });
    assert.deepEqual(profile.shading, { mode: 'cel', bands: 5, outline: { color: '#1f2428', width: 0.03 } });
    await page.getByRole('button', { name: 'Save character profile', exact: true }).click();
    await idle();
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    await idle();
    await frames();
    view = await rendering();
    assert.equal(view.importedAvatar.visible, true, 'Saved profiles restore the imported avatar.');
    assert.equal(view.hammerModel.visible, true);
    assert.equal(view.potModel.visible, true, 'Saved profiles restore the pot model.');
    assert.equal(view.shading.mode, 'cel');
    await openCharacter();
    assert.equal(await exportProfile(), exported, 'Save and restore keep the profile byte-identical.');
    await page.getByRole('button', { name: 'Use built-in avatar mesh', exact: true }).click();
    await idle();
    await page.getByRole('button', { name: 'Use two-part hammer', exact: true }).click();
    await idle();
    await page.getByRole('button', { name: 'Use default pot', exact: true }).click();
    await idle();
    await page.getByRole('radio', { name: 'PBR', exact: true }).check();
    await page.locator('#character-cel-bands').evaluate(input => {
      input.value = '3';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#character-outline-width').evaluate(input => {
      input.value = '0.02';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await idle();
    const plain = JSON.parse(await exportProfile());
    assert.equal(plain.schemaVersion, 6, 'Without models or shading the profile saves as schema 6 again.');
    assert.deepEqual(Object.keys(plain), ['schemaVersion', 'characterRiggingType', 'armForwardDistance', 'images', 'layers', 'skeleton', 'presentation']);
    assert.equal((await rendering()).avatar.visible, true, 'Removing the import restores the built-in avatar.');
    report.schema = { withPot: 9, withoutPot: 8, withoutAssets: 6, restored: true, bytes: exported.length };

    // A 2D profile imported from JSON shows its pot model too, beside its pot sprite layer.
    await pause();
    const flat = {
      schemaVersion: 9, characterRiggingType: 'sprite-2d', armForwardDistance: 0.25,
      images: [{ id: 'card', name: 'Card', source: `data:image/png;base64,${texturePng().toString('base64')}` }],
      layers: [{
        id: 'pot-card', name: 'Pot card', anchor: 'pot', image: 'card', width: 0.6, height: 0.4, offset: { x: 0, y: 0, z: 0.6 },
        rotation: 0, bone: null, directions: DIRECTIONS, skin: null, tileLength: null,
      }],
      skeleton: null, presentation: null,
      models: [{ id: 'pot', name: 'Urn', source: glbSource(potGlb()) }], pot: { model: 'pot' },
    };
    await page.locator('.sprite-file').setInputFiles({
      name: 'flat-pot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(flat)),
    });
    await idle();
    await frames();
    assert.equal((await sprites()).error, null);
    assert.equal((await sprites()).schemaVersion, 9);
    report.pot.sprite2d = await checkPot('2D mode');
    assert.equal(await exportProfile(), JSON.stringify(flat), 'A schema-9 profile JSON round-trips byte for byte.');
    assert.deepEqual(report.errors, [], 'Character scenario browser errors are not allowed.');
    return report;
  } finally {
    await context.close();
  }
}
