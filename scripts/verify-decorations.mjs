import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { observeBrowserPage } from './verify-level.mjs';
import { openSection } from './workshop-ui.mjs';

const floor = {
  kind: 'terrain', id: 'floor', shape: { type: 'box' }, x: 0, y: -1, width: 14, height: 2,
  angle: 0, depth: 1.5, color: 0x71817a, illusion: false,
};
const start = { kind: 'start', id: 'start', x: -4, y: 0.7, angle: 0.5, reach: 1.7 };
const decoration = (id, model, x, y, z, extra = {}) => ({
  kind: 'decoration', id, model, x, y, z, height: 3, angle: 0, mirror: false, tint: 0xffffff, ...extra,
});

// Decorations: scenery that never collides, placed at any depth from the library, edited with its own
// tool, and drawn in instanced batches whose idle frames upload nothing.
export async function verifyDecorations(browser, address, artifacts) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const report = { errors: [] };
  await observeBrowserPage(page, report.errors);
  const state = () => page.evaluate(() => window.gettingOver.level());
  const last = async () => (await state()).definition.objects.at(-1);
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const workshopTab = async (name) => {
    const toggle = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByRole('tab', { name, exact: true }).click();
  };
  const importLevel = async (definition) => {
    const commits = (await state()).editor.commits;
    await page.locator('.level-file').setInputFiles({ name: 'course.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(definition)) });
    await page.waitForFunction((previous) => window.gettingOver.level().editor.commits > previous, commits);
    await frames();
  };
  // Where a point at depth z is drawn: the course-plane mapping, scaled about the view's centre by depth.
  const screenAt = (point, z) => page.evaluate(({ point, z }) => {
    const { x, y, width, height, worldHeight } = window.gettingOver.snapshot().camera;
    const { perspective, distance } = window.gettingOver.level().rendering.camera;
    const scale = height / worldHeight * (perspective ? distance / (distance - z) : 1);
    const rect = document.querySelector('#game').getBoundingClientRect();
    return { x: rect.left + width / 2 + (point.x - x) * scale, y: rect.top + height / 2 - (point.y - y) * scale };
  }, { point, z });
  const setField = async (id, value) => {
    await page.locator(id).fill(String(value));
    await page.locator(id).press('Tab');
    await frames();
  };
  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    await workshopTab('Project');
    await openSection(page, 'project-theme');
    await page.locator('#project-theme-camera-perspective').check();
    await workshopTab('Level');
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
    await importLevel({ schemaVersion: 3, labels: [], objects: [floor, start] });

    // The library shows each category's models with painted thumbnails.
    await openSection(page, 'level-decorations');
    const ruins = await page.locator('.level-decoration-grid [data-decoration]').evaluateAll((buttons) => buttons.map((button) => {
      const canvas = button.querySelector('canvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) painted++;
      return { id: button.dataset.decoration, painted: painted > 200 };
    }));
    assert.deepEqual(ruins.map((entry) => entry.id), ['ruined-pillar', 'gothic-arch', 'broken-wall', 'watchtower', 'cathedral', 'castle', 'stone-bridge', 'obelisk', 'knight-statue']);
    assert.ok(ruins.every((entry) => entry.painted), 'Every thumbnail shows its model.');

    // A decoration lands under the pointer at its own depth, draws, and adds no collider.
    const box = await page.locator('.level-overlay').boundingBox();
    const target = { x: box.x + box.width * 0.35, y: box.y + box.height * 0.3 };
    await page.locator('[data-decoration="ruined-pillar"]').click();
    assert.equal((await state()).editor.decorations.armed, 'ruined-pillar');
    await page.mouse.move(target.x, target.y, { steps: 4 });
    assert.ok((await state()).rendering.decorations.preview, 'Placing shows a preview.');
    assert.equal((await state()).definition.objects.length, 2, 'The preview does not change the level.');
    await page.mouse.click(target.x, target.y);
    const pillar = await last();
    assert.deepEqual({ kind: pillar.kind, model: pillar.model, z: pillar.z, height: pillar.height, mirror: pillar.mirror, tint: pillar.tint },
      { kind: 'decoration', model: 'ruined-pillar', z: -3, height: 6, mirror: false, tint: 0xffffff });
    const drawn = await screenAt(pillar, pillar.z);
    assert.ok(Math.hypot(drawn.x - target.x, drawn.y - target.y) < 1, 'The base lands under the pointer at its depth.');
    let current = await state();
    assert.equal(current.editor.tool, 'decorate');
    assert.equal(current.editor.selectedId, pillar.id);
    assert.equal(current.rendering.decorations.instances, 1);
    assert.equal(current.rendering.decorations.preview, false);
    assert.equal(current.terrain.bodyCount, 1, 'Decorations add no colliders.');

    // Close to the course, a decoration rests on the terrain top under the pointer.
    await page.locator('#level-decoration-category').selectOption('relics');
    const ground = await screenAt({ x: 2, y: 0 }, -1.2);
    await page.locator('[data-decoration="graves"]').click();
    await page.mouse.move(ground.x, ground.y - 12, { steps: 3 });
    await page.mouse.click(ground.x, ground.y - 12);
    const graves = await last();
    assert.equal(graves.model, 'graves');
    assert.equal(graves.y, 0, 'The graves rest on the floor.');

    // Select never picks scenery; Select decorations does, and drags it at its own depth.
    const middle = await screenAt({ x: pillar.x, y: pillar.y + 3 }, pillar.z);
    await page.locator('[data-level-tool="select"]').click();
    await page.mouse.click(middle.x, middle.y);
    assert.equal((await state()).editor.selectedId, null, 'Select does not pick decorations.');
    await page.locator('[data-level-tool="decorate"]').click();
    await page.mouse.click(middle.x, middle.y);
    assert.equal((await state()).editor.selectedId, pillar.id);
    current = await state();
    await page.mouse.move(middle.x, middle.y);
    await page.mouse.down();
    await page.mouse.move(middle.x + 90, middle.y - 30, { steps: 10 });
    assert.equal((await state()).editor.commits, current.editor.commits, 'Dragging previews without editing.');
    await page.mouse.up();
    const moved = (await state()).definition.objects.find((object) => object.id === pillar.id);
    const after = await screenAt(moved, moved.z);
    assert.ok(Math.hypot(after.x - drawn.x - 90, after.y - drawn.y + 30) < 1, 'The dragged base follows the pointer.');
    let edited = await state();
    assert.equal(edited.editor.commits, current.editor.commits + 1);
    assert.equal(edited.rendering.decorations.matrixWrites, current.rendering.decorations.matrixWrites + 1, 'A move rewrites one instance.');

    // Inspector edits: depth and height move one instance; tint recolours it; mirroring moves it to a mirrored batch.
    current = edited;
    await setField('#level-decoration-z', -12);
    await setField('#level-decoration-height', 9);
    await page.locator('#level-decoration-tint').evaluate((input) => { input.value = '#c08040'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await frames();
    edited = await state();
    const tuned = edited.definition.objects.find((object) => object.id === pillar.id);
    assert.deepEqual([tuned.z, tuned.height, tuned.tint], [-12, 9, 0xc08040]);
    assert.equal(edited.rendering.decorations.matrixWrites, current.rendering.decorations.matrixWrites + 2);
    assert.equal(edited.rendering.decorations.colorWrites, current.rendering.decorations.colorWrites + 1);
    await page.locator('#level-decoration-mirror').check();
    await frames();
    edited = await state();
    assert.equal(edited.definition.objects.find((object) => object.id === pillar.id).mirror, true);
    assert.equal(edited.rendering.decorations.instances, 2);
    await page.screenshot({ path: fileURLToPath(new URL('decorations-editor.png', artifacts)) });
    await page.getByRole('button', { name: 'Delete selected object', exact: true }).click();
    await frames();
    edited = await state();
    assert.equal(edited.definition.objects.some((object) => object.id === pillar.id), false);
    assert.equal(edited.rendering.decorations.instances, 1);

    // A level may name a model this game lacks: it opens, and that decoration is simply not drawn.
    await importLevel({ schemaVersion: 3, labels: [], objects: [floor, start, decoration('lost', 'no-such-model', 0, 0, -2)] });
    current = await state();
    assert.deepEqual([current.rendering.decorations.instances, current.rendering.decorations.waiting], [0, ['no-such-model']]);

    // A representative large level: 1,000 decorations of every model, each at the depth it is made for, from
    // the far horizon to the foreground, spread along a 360 m by 200 m climb and half of them mirrored.
    const depths = {
      'mountain-ridge': -1000, 'great-tree': -900, castle: -600, cathedral: -400, 'stone-bridge': -200, watchtower: -80,
      'rock-spire': -60, 'gothic-arch': -15, obelisk: -12, 'knight-statue': -5, 'broken-wall': -4, 'ruined-pillar': -3,
      'dead-tree': -3, 'sword-grave': -2, 'thorn-bush': -1.5, banner: -1.5, graves: -1.2, 'skull-pile': -1, 'iron-fence': -1,
      'ember-cairn': -1, brazier: -1, 'lantern-post': -1, candelabra: 1.5, 'hanging-cage': 2, chains: 4,
    };
    const models = Object.keys(depths);
    const large = {
      schemaVersion: 3, labels: [], objects: [floor, start, ...Array.from({ length: 1000 }, (_, index) => {
        const model = models[index % models.length];
        return decoration(`scenery-${index}`, model, (index % 40 - 20) * 9, Math.floor(index / 40) * 8, depths[model],
          { height: 2 + (index % 7), angle: (index % 5 - 2) * 0.1, mirror: index % 2 === 0 });
      })],
    };
    await importLevel(large);
    const loaded = await state();
    assert.equal(loaded.rendering.decorations.instances, 1000);
    assert.equal(loaded.terrain.bodyCount, 1);
    assert.ok(loaded.rendering.calls < 100, `1,000 decorations used ${loaded.rendering.calls} draw calls.`);
    await page.waitForTimeout(600);
    const idle = await state();
    for (const key of ['matrixWrites', 'colorWrites', 'boundsUpdates', 'batchesCreated']) {
      assert.equal(idle.rendering.decorations[key], loaded.rendering.decorations[key], `Static frames must not change ${key}.`);
    }
    await page.screenshot({ path: fileURLToPath(new URL('decorations-large.png', artifacts)) });
    report.decorations = {
      library: ruins.length, placement: 'under the pointer at depth', snapped: true, colliders: 0,
      large: { instances: 1000, calls: loaded.rendering.calls, batches: loaded.rendering.decorations.batches, triangles: loaded.rendering.triangles },
    };
    assert.deepEqual(report.errors, []);
    return report;
  } finally {
    await context.close();
  }
}
