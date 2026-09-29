import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { observeBrowserPage } from './verify-level.mjs';
import { openSection } from './workshop-ui.mjs';

// The theme's camera: orthographic by default, perspective on request, and in both the same course
// plane, so aiming, editing and picking are unchanged while depth reads as distance.
export async function verifyCamera(browser, address, artifacts) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const report = { errors: [] };
  await observeBrowserPage(page, report.errors);
  const camera = () => page.evaluate(() => window.gettingOver.level().rendering.camera);
  // How far course-plane points are drawn from where the plane's own mapping puts them, in pixels.
  const planeError = (points) => page.evaluate((points) => {
    const { x, y, width, height, worldHeight } = window.gettingOver.snapshot().camera;
    const rect = document.querySelector('#game').getBoundingClientRect();
    const scale = height / worldHeight;
    return Math.max(...points.map((point) => {
      const drawn = window.gettingOver.project(point);
      return Math.max(Math.abs(drawn.x - (rect.left + width / 2 + (point.x - x) * scale)),
        Math.abs(drawn.y - (rect.top + height / 2 - (point.y - y) * scale)));
    }));
  }, points);
  const workshopTab = async (name) => {
    const toggle = page.getByRole('button', { name: 'Workshop', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByRole('tab', { name, exact: true }).click();
  };
  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    const points = (await page.evaluate(() => window.gettingOver.level().definition.objects))
      .filter((object) => object.kind === 'terrain').slice(0, 12).map(({ x, y }) => ({ x, y }));
    const flat = await camera();
    assert.deepEqual({ perspective: flat.perspective, distance: flat.distance, fog: flat.fog }, { perspective: false, distance: 20, fog: { near: 35, far: 85 } },
      'The default theme keeps its orthographic camera and fog.');
    assert.ok(await planeError(points) < 0.5);

    await workshopTab('Project');
    await openSection(page, 'project-theme');
    await page.locator('#project-theme-camera-perspective').check();
    await page.waitForFunction(() => window.gettingOver.level().rendering.camera.perspective);
    const deep = await camera();
    const { worldHeight } = await page.evaluate(() => window.gettingOver.snapshot().camera);
    assert.ok(Math.abs(deep.distance - worldHeight / 2 / Math.tan(15 * Math.PI / 180)) < 1e-9, 'The course plane fills the view height.');
    assert.deepEqual(deep.fog, { near: deep.distance + 15, far: deep.distance + 65 }, 'Fog stays anchored to the course plane.');
    assert.deepEqual([deep.near, deep.far], [Math.max(0.1, deep.distance - 15), deep.distance + 1100]);
    assert.ok(await planeError(points) < 0.5, 'Perspective draws the course plane exactly where the orthographic camera does.');
    await page.screenshot({ path: fileURLToPath(new URL('camera-perspective.png', artifacts)) });

    // Editing in perspective: a block lands under the pointer, and clicking it there selects it.
    await workshopTab('Level');
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
    assert.ok((await camera()).perspective);
    const box = await page.locator('.level-overlay').boundingBox();
    const target = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.3 };
    await page.locator('[data-level-preset="box"]').click();
    await page.mouse.move(target.x, target.y, { steps: 4 });
    await page.mouse.click(target.x, target.y);
    const placed = (await page.evaluate(() => window.gettingOver.level().definition)).objects.at(-1);
    const drawn = await page.evaluate((point) => window.gettingOver.project(point), placed);
    assert.ok(Math.hypot(drawn.x - target.x, drawn.y - target.y) < 1, 'A placed block lands under the pointer.');
    await page.locator('[data-level-tool="select"]').click();
    await page.mouse.click(box.x + 8, box.y + 8);
    await page.mouse.click(target.x, target.y);
    assert.equal(await page.evaluate(() => window.gettingOver.level().editor.selectedId), placed.id, 'Clicking a block selects it.');
    await page.screenshot({ path: fileURLToPath(new URL('camera-perspective-editor.png', artifacts)) });

    await workshopTab('Project');
    await page.locator('#project-theme-camera-perspective').uncheck();
    await page.waitForFunction(() => !window.gettingOver.level().rendering.camera.perspective);
    assert.deepEqual((await camera()).fog, { near: 35, far: 85 });
    report.camera = { orthographic: flat.distance, perspective: deep.distance, planeError: 'under 0.5 px', placement: 'under the pointer' };
    assert.deepEqual(report.errors, []);
    return report;
  } finally {
    await context.close();
  }
}
