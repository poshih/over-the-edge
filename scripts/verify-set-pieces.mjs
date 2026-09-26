import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { observeBrowserPage } from './verify-level.mjs';
import { openSection } from './workshop-ui.mjs';

const SPACING = 13.5;
const GALLERY_SIZE = 4;
const GALLERY_GAP = 3;
const FLOOR_COLOR = 0x485d5a;
const TERRAIN_COUNTERS = ['matrixWrites', 'colorWrites', 'boundsUpdates', 'geometriesBuilt', 'phaseUpdates'];
const ENEMY_SIZE = { bird: { width: 1.2, height: 0.8 }, 'hollow-soldier': { width: 1, height: 1.4 } };
const LABEL_SIZE = { width: 2.25, height: 0.42 };
// Unit outlines replicated from src/level.ts so placed geometry is checked independently of the editor.
const UNIT = {
  box: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
  ramp: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5]],
  triangle: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]],
  hexagon: [[0.5, 0], [0.25, 0.5], [-0.25, 0.5], [-0.5, 0], [-0.25, -0.5], [0.25, -0.5]],
  circle: Array.from({ length: 32 }, (_, index) => [Math.cos(index * Math.PI / 16) / 2, Math.sin(index * Math.PI / 16) / 2]),
};
const PLURAL = { terrain: 'terrain', trigger: 'triggers', enemy: 'enemies' };

const terrainOf = definition => definition.objects.filter(object => object.kind === 'terrain');
const tidy = value => Number(value.toFixed(6)) + 0;

function outline(object) {
  const cosine = Math.cos(object.angle);
  const sine = Math.sin(object.angle);
  return UNIT[object.shape.type].map(([unitX, unitY]) => {
    const x = unitX * object.width;
    const y = unitY * object.height;
    return { x: object.x + x * cosine - y * sine, y: object.y + x * sine + y * cosine };
  });
}

/** Horizontal extent and bottom of any placed object or course label. */
function extent(object) {
  if (object.kind === 'terrain') {
    const points = outline(object);
    return {
      left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)),
      bottom: Math.min(...points.map(point => point.y)),
    };
  }
  const size = object.kind === 'trigger'
    ? object.region.type === 'circle'
      ? { width: object.region.radius * 2, height: object.region.radius * 2 } : object.region
    : object.kind === 'enemy' ? ENEMY_SIZE[object.species] : LABEL_SIZE;
  return { left: object.x - size.width / 2, right: object.x + size.width / 2, bottom: object.y - size.height / 2 };
}

/** Overlap depth of two convex outlines along their separating axes; zero when they only touch. */
function penetration(first, second) {
  let depth = Infinity;
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index];
      const b = polygon[(index + 1) % polygon.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-9) continue;
      const axis = { x: (b.y - a.y) / length, y: (a.x - b.x) / length };
      const span = points => {
        const values = points.map(point => point.x * axis.x + point.y * axis.y);
        return [Math.min(...values), Math.max(...values)];
      };
      const [firstMin, firstMax] = span(first);
      const [secondMin, secondMax] = span(second);
      const overlap = Math.min(firstMax, secondMax) - Math.max(firstMin, secondMin);
      if (overlap <= 0) return 0;
      depth = Math.min(depth, overlap);
    }
  }
  return depth;
}

function sameOutline(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  const remaining = [...expected];
  for (const point of actual) {
    const index = remaining.findIndex(candidate => Math.hypot(candidate.x - point.x, candidate.y - point.y) < 1e-3);
    assert.ok(index >= 0, message);
    remaining.splice(index, 1);
  }
}

export async function verifySetPieces(browser, address, artifacts) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const report = { errors: [], pieces: 0, categories: {}, galleries: [], mirrored: [], largeLevel: null };
  await observeBrowserPage(page, report.errors);
  const artifact = name => fileURLToPath(new URL(name, artifacts));
  const state = () => page.evaluate(() => window.gettingOver.level());
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const project = point => page.evaluate(value => window.gettingOver.project(value), point);
  const edit = async () => {
    if ((await page.evaluate(() => window.gettingOver.snapshot())).pointerLocked) {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.gettingOver.snapshot().pointerLocked);
    }
    const toggle = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByRole('tab', { name: 'Level', exact: true }).click();
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
    await openSection(page, 'level-set-pieces');
    await frames();
  };
  const importLevel = async definition => {
    const commits = (await state()).editor.commits;
    await page.locator('.level-file').setInputFiles({
      name: 'set-pieces.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(definition)),
    });
    await page.waitForFunction(previous => window.gettingOver.level().editor.commits > previous, commits);
    await frames();
  };
  const screenshotCanvas = async name => {
    const { overlay } = (await state()).editor;
    await page.screenshot({ path: artifact(name), clip: { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height } });
  };
  const chooseCategory = category => page.locator('#level-set-piece-category').selectOption(category);
  const pieceButton = id => page.locator(`[data-set-piece="${id}"]`);
  let start;
  let catalog;
  // A box floor whose top is y = 0, spanning x = -6 to `right`, with the start on it.
  const level = (right, { objects = [], labels = [] } = {}) => ({
    schemaVersion: 2, labels,
    objects: [
      {
        kind: 'terrain', id: 'floor', shape: { type: 'box' }, x: (right - 6) / 2, y: -0.5, width: right + 6, height: 1,
        angle: 0, depth: 3, color: FLOOR_COLOR, illusion: false,
      },
      { ...start, x: -4 },
      ...objects,
    ],
  });

  async function drop(id, x, { mirror = false, toggle = 'key', y = 0.4, top = 0 } = {}) {
    const piece = catalog.find(entry => entry.id === id);
    await chooseCategory(piece.category);
    await pieceButton(id).click();
    // Deferred terrain bounds work from earlier edits settles before counters are compared.
    await frames();
    let before = await state();
    assert.equal(before.editor.tool, 'place-set-piece');
    assert.equal(before.editor.setPieces.armed, id);
    if (before.editor.setPieces.mirror !== mirror) {
      if (toggle === 'key') await page.keyboard.press('m');
      else await page.locator('#level-set-piece-mirror').setChecked(mirror);
      before = await state();
      assert.equal(before.editor.setPieces.mirror, mirror, `The ${toggle} toggles mirroring while placing.`);
      assert.equal(before.editor.tool, 'place-set-piece', 'Mirroring keeps the piece armed.');
    }
    const target = await project({ x, y });
    await page.mouse.move(target.x, target.y, { steps: 3 });
    const builds = (await state()).editor.setPieces.surfaceIndexBuilds;
    assert.ok(builds <= before.editor.setPieces.surfaceIndexBuilds + 1, 'The surface index builds at most once per level change.');
    await page.mouse.move(target.x + 12, target.y - 9, { steps: 4 });
    await page.mouse.move(target.x, target.y, { steps: 4 });
    const preview = await state();
    assert.equal(preview.editor.setPieces.surfaceIndexBuilds, builds, 'Pointer moves must reuse the surface index.');
    assert.deepEqual(preview.definition, before.definition, 'Set piece previews must not author objects.');
    assert.equal(preview.editor.commits, before.editor.commits);
    for (const key of TERRAIN_COUNTERS) assert.equal(preview.rendering.terrain[key], before.rendering.terrain[key], `Preview changed ${key}.`);
    if (top !== null) {
      assert.equal(preview.editor.setPieces.snapped, true, `${id} must rest on the terrain top under the pointer.`);
      assert.ok(Math.abs(preview.editor.setPieces.anchor.y - top) < 1e-9, `${id} rested at ${preview.editor.setPieces.anchor.y}, not ${top}.`);
    }
    await page.mouse.click(target.x, target.y);
    const after = await state();
    assert.equal(after.editor.commits, before.editor.commits + 1, 'A drop must be one atomic level commit.');
    assert.equal(after.editor.tool, 'select');
    assert.equal(after.editor.setPieces.armed, null);
    const known = new Set(before.definition.objects.map(object => object.id));
    const added = after.definition.objects.filter(object => !known.has(object.id));
    assert.deepEqual(after.definition.labels.slice(0, before.definition.labels.length), before.definition.labels);
    const labels = after.definition.labels.slice(before.definition.labels.length);
    const counts = { terrain: 0, triggers: 0, enemies: 0, labels: labels.length };
    for (const object of added) counts[PLURAL[object.kind]]++;
    assert.deepEqual(counts, piece.counts, `${id} added the wrong objects.`);
    const pattern = new RegExp(`^${id}-([0-9a-f]{12})-(\\d+)$`);
    const stamps = new Set(added.map(object => object.id.match(pattern)?.[1]));
    assert.equal(stamps.size, 1, `${id} objects need one shared placement stamp.`);
    assert.ok(!stamps.has(undefined), `${id} object IDs must follow <piece>-<stamp>-<part>.`);
    const anchor = after.editor.setPieces.anchor;
    const terrain = added.filter(object => object.kind === 'terrain');
    assert.ok(terrain.every(object => object.shape.type !== 'polygon'), 'Set pieces use only built-in shapes.');
    for (const part of [...added, ...labels]) {
      // Placed coordinates are rounded to 0.1 mm.
      assert.ok(extent(part).bottom >= anchor.y - 1e-4, `${id} reaches below its base.`);
    }
    for (let first = 0; first < terrain.length; first++) {
      for (let second = first + 1; second < terrain.length; second++) {
        if (terrain[first].color === terrain[second].color) continue;
        const depth = penetration(outline(terrain[first]), outline(terrain[second]));
        assert.ok(depth <= 1e-3, `${id}: differently coloured ${terrain[first].id} and ${terrain[second].id} overlap by ${depth} and would z-fight.`);
      }
    }
    const authoredTerrain = terrainOf(after.definition).length;
    assert.equal(after.terrain.bodyCount, authoredTerrain);
    assert.equal(after.rendering.terrain.instances, authoredTerrain);
    assert.equal(after.rendering.terrain.matrixWrites - before.rendering.terrain.matrixWrites, terrain.length,
      'A drop uploads only its new terrain instances.');
    assert.equal(after.rendering.terrain.colorWrites - before.rendering.terrain.colorWrites, terrain.length);
    return { piece, added, labels, anchor, before, after };
  }

  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    const initial = await state();
    start = initial.definition.objects.find(object => object.kind === 'start');
    catalog = initial.editor.setPieces.catalog;
    assert.ok(catalog.length >= 50, 'The set piece library should cover the trope list.');
    assert.equal(new Set(catalog.map(entry => entry.id)).size, catalog.length);
    const categories = [...new Set(catalog.map(entry => entry.category))];
    await edit();
    assert.equal(await page.locator('[data-set-piece]').count(),
      catalog.filter(entry => entry.category === categories[0]).length, 'Only the chosen category builds thumbnails.');

    // Every piece is dropped through the UI onto a floor, one category at a time.
    const placements = [];
    for (const category of categories) {
      const pieces = catalog.filter(entry => entry.category === category);
      await importLevel(level(pieces.length * SPACING));
      assert.equal((await state()).editor.setPieces.history.length, 0, 'Replacing the level clears set piece history.');
      for (const [index, piece] of pieces.entries()) placements.push(await drop(piece.id, (index + 0.5) * SPACING));
      await frames();
      const settled = await state();
      await frames();
      await frames();
      const idle = await state();
      for (const key of TERRAIN_COUNTERS) assert.equal(idle.rendering.terrain[key], settled.rendering.terrain[key], `Idle frames changed ${key}.`);
      assert.equal(idle.editor.draws, settled.editor.draws, 'Idle frames must not redraw editor guides.');
      assert.equal(idle.editor.setPieces.history.length, pieces.length);
      report.categories[category] = pieces.length;
    }
    report.pieces = placements.length;
    assert.equal(placements.length, catalog.length);

    // Galleries: groups of placed pieces laid out side by side for visual review.
    for (let offset = 0; offset < placements.length; offset += GALLERY_SIZE) {
      const group = placements.slice(offset, offset + GALLERY_SIZE);
      const objects = [];
      const labels = [];
      let cursor = 0;
      for (const { added, labels: pieceLabels, anchor } of group) {
        const parts = [...added, ...pieceLabels];
        const left = Math.min(...parts.map(part => extent(part).left));
        const right = Math.max(...parts.map(part => extent(part).right));
        const dx = cursor - left;
        objects.push(...added.map(object => ({ ...object, x: tidy(object.x + dx), y: tidy(object.y - anchor.y) })));
        labels.push(...pieceLabels.map(label => ({ ...label, x: tidy(label.x + dx), y: tidy(label.y - anchor.y) })));
        cursor = right + dx + GALLERY_GAP;
      }
      await importLevel(level(cursor - GALLERY_GAP + 2, { objects, labels }));
      await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
      await frames();
      const name = `set-pieces-${String(offset / GALLERY_SIZE + 1).padStart(2, '0')}.png`;
      await screenshotCanvas(name);
      report.galleries.push({ name, pieces: group.map(entry => entry.piece.id) });
    }

    // Mirroring: each part of a mirrored drop reflects its unmirrored twin about the anchor.
    await importLevel(level(120));
    const mirrorIds = ['orange-hell', 'updraft-ambush', 'the-snake', 'kicker-ramp'];
    for (const [index, id] of mirrorIds.entries()) {
      const toggle = index % 2 === 0 ? 'key' : 'checkbox';
      const normal = await drop(id, 8 + index * 28, { toggle });
      const mirrored = await drop(id, 22 + index * 28, { mirror: true, toggle });
      const part = placement => new Map(placement.added.map(object => [object.id.split('-').at(-1), object]));
      const originals = part(normal);
      const twins = part(mirrored);
      assert.equal(twins.size, originals.size);
      const local = (point, anchor, flip) => ({ x: (point.x - anchor.x) * (flip ? -1 : 1), y: point.y - anchor.y });
      for (const [key, object] of originals) {
        const twin = twins.get(key);
        assert.equal(twin.kind, object.kind);
        const message = `${id} part ${key} must mirror exactly.`;
        if (object.kind === 'terrain') {
          sameOutline(outline(twin).map(point => local(point, mirrored.anchor, true)),
            outline(object).map(point => local(point, normal.anchor, false)), message);
          assert.deepEqual([twin.color, twin.depth, twin.illusion], [object.color, object.depth, object.illusion], message);
        } else {
          const expected = local(object, normal.anchor, false);
          const actual = local(twin, mirrored.anchor, true);
          assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-3, message);
          if (object.kind === 'enemy') {
            assert.equal(twin.facing, object.facing === 'left' ? 'right' : 'left', message);
            assert.deepEqual([twin.species, twin.patrolDistance, twin.speed], [object.species, object.patrolDistance, object.speed]);
          } else {
            assert.deepEqual([twin.region, twin.events, twin.marker], [object.region, object.events, object.marker], message);
          }
        }
      }
      for (const [index, label] of normal.labels.entries()) {
        const twin = mirrored.labels[index];
        assert.equal(twin.text, label.text);
        const expected = local(label, normal.anchor, false);
        const actual = local(twin, mirrored.anchor, true);
        assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-3, `${id} label must mirror.`);
      }
      report.mirrored.push(id);
    }

    // Removing the last placed piece is one commit, skips parts deleted by hand, and takes its labels.
    const beforeUndo = await state();
    const history = beforeUndo.editor.setPieces.history;
    assert.equal(history.length, mirrorIds.length * 2);
    await page.locator('.level-set-piece-undo').click();
    const undone = await state();
    assert.equal(undone.editor.commits, beforeUndo.editor.commits + 1, 'Removing a set piece is one commit.');
    assert.equal(undone.definition.objects.length, beforeUndo.definition.objects.length - history.at(-1).ids.length);
    assert.ok(history.at(-1).ids.every(id => !undone.definition.objects.some(object => object.id === id)));
    assert.ok(undone.rendering.terrain.matrixWrites - beforeUndo.rendering.terrain.matrixWrites <= history.at(-1).ids.length);
    const trimmedEntry = undone.editor.setPieces.history.at(-1);
    const block = undone.definition.objects.find(object => object.id === trimmedEntry.ids.at(-1));
    await page.locator('[data-level-tool="select"]').click();
    const blockPoint = await project(block);
    await page.mouse.click(blockPoint.x, blockPoint.y);
    assert.equal((await state()).editor.selectedId, block.id);
    await page.keyboard.press('Delete');
    const trimmed = await state();
    assert.ok(!trimmed.definition.objects.some(object => object.id === block.id));
    await page.locator('.level-set-piece-undo').click();
    const cleared = await state();
    assert.equal(cleared.editor.commits, trimmed.editor.commits + 1);
    assert.ok(trimmedEntry.ids.every(id => !cleared.definition.objects.some(object => object.id === id)));
    const snakeEntry = cleared.editor.setPieces.history.at(-1);
    assert.equal(snakeEntry.labels.length, 1);
    await page.locator('.level-set-piece-undo').click();
    const unlabelled = await state();
    assert.equal(unlabelled.definition.labels.length, cleared.definition.labels.length - 1, 'Removing a piece removes its labels.');
    assert.ok(!unlabelled.definition.labels.some(label =>
      label.x === snakeEntry.labels[0].x && label.y === snakeEntry.labels[0].y && label.text === snakeEntry.labels[0].text));
    assert.match(await page.locator('.level-set-piece-status').textContent(), /Removed The snake/);

    // Snapping rests a piece on the exposed top of existing terrain; away from surfaces it floats.
    await importLevel(level(40));
    assert.equal((await state()).editor.setPieces.history.length, 0);
    assert.equal(await page.locator('.level-set-piece-undo').isDisabled(), true);
    const steps = await drop('rising-steps', 10);
    await drop('first-boulder', steps.anchor.x + 2, { y: 2.95, top: 2.7 });
    await chooseCategory('vertical');
    await pieceButton('orange-hell').click();
    await page.locator('.level-set-pieces').screenshot({ path: artifact('set-piece-panel.png') });
    await page.keyboard.press('Escape');
    await chooseCategory('descent');
    await pieceButton('the-snake').click();
    const quiet = await state();
    const high = await project({ x: 28, y: 14 });
    await page.mouse.move(high.x, high.y, { steps: 3 });
    const floating = (await state()).editor.setPieces;
    assert.equal(floating.snapped, false);
    assert.ok(Math.abs(floating.anchor.y - 14) < 0.5, 'Away from surfaces the piece follows the pointer.');
    await page.keyboard.press('m');
    const low = await project({ x: 28, y: 0.3 });
    await page.mouse.move(low.x, low.y, { steps: 3 });
    const ghost = await page.evaluate(() => {
      const node = document.querySelector('.level-set-piece-ghost');
      return node && {
        snapped: node.classList.contains('level-set-piece-snapped'), transform: node.getAttribute('transform'),
        polygons: node.querySelectorAll('.level-set-piece-terrain').length, text: node.querySelector('text')?.textContent,
      };
    });
    const armed = (await state()).editor.setPieces;
    assert.deepEqual(ghost, {
      snapped: true, transform: `translate(${armed.anchor.x} ${armed.anchor.y})`, polygons: 4, text: 'DO NOT RIDE SNAKE',
    });
    await screenshotCanvas('set-piece-ghost.png');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.level-set-piece-ghost').count(), 0, 'Escape removes the placement ghost.');
    assert.deepEqual((await state()).definition, quiet.definition);

    // Capacity: pieces that would exceed a level limit are disabled before anything is dropped.
    const labels = Array.from({ length: 16 }, (_, index) => ({ x: -60 + index * 3, y: 30, text: `Label ${index}` }));
    await importLevel(level(40, { labels }));
    for (const category of categories) {
      await chooseCategory(category);
      for (const piece of catalog.filter(entry => entry.category === category)) {
        assert.equal(await pieceButton(piece.id).isDisabled(), piece.counts.labels > 0, `${piece.id} label budget`);
      }
    }
    const filler = Array.from({ length: 998 }, (_, index) => ({
      kind: 'terrain', id: `filler-${index}`, shape: { type: 'box' }, x: -200 + (index % 50) * 2.5,
      y: 30 + Math.floor(index / 50) * 2.5, width: 1.5, height: 1.5, angle: 0, depth: 1, color: 0x71817a, illusion: false,
    }));
    await importLevel(level(40, { objects: filler }));
    for (const category of categories) {
      await chooseCategory(category);
      for (const piece of catalog.filter(entry => entry.category === category)) {
        assert.equal(await pieceButton(piece.id).isDisabled(), piece.counts.terrain > 1, `${piece.id} terrain budget`);
      }
    }
    const buildsBefore = (await state()).editor.setPieces.surfaceIndexBuilds;
    // Window capture and bubble listeners bracket the overlay's synchronous pointer handlers.
    await page.evaluate(() => {
      const timings = window.__setPieceTimings = { pointermove: [], pointerup: [] };
      let began = 0;
      for (const type of Object.keys(timings)) {
        window.addEventListener(type, () => { began = performance.now(); }, { capture: true });
        window.addEventListener(type, () => { timings[type].push(performance.now() - began); });
      }
    });
    const large = await drop('tutorial-note', 10);
    const timings = await page.evaluate(() => window.__setPieceTimings);
    report.largeLevel = {
      terrain: terrainOf(large.after.definition).length,
      surfaceIndexBuilds: large.after.editor.setPieces.surfaceIndexBuilds - buildsBefore,
      slowestPreviewMilliseconds: Math.max(...timings.pointermove),
      dropMilliseconds: timings.pointerup.at(-1),
    };
    assert.equal(report.largeLevel.terrain, 1000);
    assert.equal(report.largeLevel.surfaceIndexBuilds, 1, 'A large level builds the surface index once per change.');
    await chooseCategory('onboarding');
    assert.equal(await pieceButton('tutorial-note').isDisabled(), true, 'A full level disables every piece.');

    // Geometry templates: a drop that would need a 33rd template fails atomically with a notice.
    const templates = Array.from({ length: 31 }, (_, index) => ({
      kind: 'terrain', id: `template-${index}`, x: -100 + index * 3, y: 30, width: 2, height: 2, angle: 0,
      depth: 1, color: 0x71817a, illusion: false,
      shape: { type: 'polygon', vertices: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: -0.5 + (index + 1) / 32, y: 0.5 }] },
    }));
    await importLevel(level(40, { objects: templates }));
    await chooseCategory('onboarding');
    await pieceButton('first-boulder').click();
    const full = await state();
    const spot = await project({ x: 10, y: 0.4 });
    await page.mouse.click(spot.x, spot.y);
    await page.waitForFunction(() => document.querySelector('.notice-message')?.textContent.includes('distinct geometry templates'));
    const rejected = await state();
    assert.deepEqual(rejected.definition, full.definition, 'A rejected drop must leave the level unchanged.');
    assert.equal(rejected.editor.commits, full.editor.commits);
    assert.equal(rejected.editor.setPieces.history.length, 0);
    await page.keyboard.press('Escape');
    await drop('rising-steps', 20);

    assert.deepEqual(report.errors, [], 'Set piece scenarios must not log browser errors.');
    return report;
  } finally {
    await context.close();
  }
}
