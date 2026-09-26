import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { observeBrowserPage } from './verify-level.mjs';
import { openSection } from './workshop-ui.mjs';

const SECTIONS_KEY = 'over-the-edge:workshop:sections:v1';
// A tab should open as a short, scannable list: its default content fits in a few screens.
const MAX_SCREENS = 2.5;
// What each tab shows first, without scrolling.
const PRIMARY = {
  Physics: [['button', 'The ascent'], ['slider', 'Hammer head mass']],
  Character: [['combobox', 'Character type'], ['button', 'Use Avatar'], ['button', 'Load complete 2D example'],
    ['slider', 'Arm forward distance'], ['button', 'Save character profile']],
  Appearance: [['combobox', 'Body part'], ['button', 'Save alignment']],
  Sprites: [['combobox', 'Layer'], ['combobox', 'New layer anchor'], ['button', 'Save']],
  Level: [['button', 'Playtest'], ['button', 'Save level'], ['button', 'Select / move'], ['button', 'Block'],
    ['button', 'Draw shape'], ['button', 'Updraft'], ['button', 'Bird']],
};

export async function verifyWorkshop(browser, address, artifacts) {
  const report = { errors: [], tabs: {} };
  const artifact = name => fileURLToPath(new URL(name, artifacts));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await observeBrowserPage(page, report.errors);
  const snapshot = () => page.evaluate(() => window.gettingOver.snapshot());
  const search = page.getByRole('combobox', { name: 'Find a control', exact: true });
  const options = page.getByRole('listbox', { name: 'Matching controls', exact: true }).getByRole('option');
  const selectedTab = () => page.locator('[role="tab"][aria-selected="true"]').textContent();
  const isOpen = id => page.locator(`details[data-section="${id}"]`).evaluate(node => node.open);
  const focusedId = () => page.evaluate(() => document.activeElement?.id ?? '');
  const inView = locator => locator.evaluate((node) => {
    const scroller = node.closest('.workshop-scroll');
    const box = node.getBoundingClientRect();
    const view = (scroller ?? document.querySelector('.workshop')).getBoundingClientRect();
    return box.height > 0 && box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
  });
  const find = async (query) => {
    await search.fill('');
    await search.fill(query);
    await page.waitForFunction(() => !document.querySelector('.workshop-search-panel').hidden);
  };
  const firstOption = async () => ({
    label: await options.first().locator('.workshop-search-label').textContent(),
    path: await options.first().locator('.workshop-search-path').textContent(),
  });
  try {
    await page.goto(address, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0 && !window.gettingOver.sprites().restoring);
    assert.equal(await page.locator('.workshop').isVisible(), true, 'The desktop Workshop opens by default.');

    // 1. Each tab opens on its primary controls; everything else waits in named, collapsed sections.
    for (const [tab, controls] of Object.entries(PRIMARY)) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      if (tab === 'Level') await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
      for (const [role, name] of controls) {
        const control = page.getByRole(role, { name, exact: true });
        assert.equal(await control.count(), 1, `${tab} must show one ${role} "${name}".`);
        assert.ok(await inView(control), `${tab} must show "${name}" without scrolling.`);
      }
      for (const name of ['Overlay', 'Recenter camera', 'Close workshop']) {
        assert.ok(await page.getByRole('button', { name, exact: true }).isVisible(), `"${name}" must stay reachable in ${tab}.`);
      }
      const layout = await page.evaluate((id) => {
        const pane = document.getElementById(id);
        const scroller = pane.querySelector('.workshop-scroll');
        const sections = [...pane.querySelectorAll('details[data-section]')];
        return {
          screens: scroller.scrollHeight / scroller.clientHeight,
          sections: sections.filter(section => !section.parentElement.closest('details[data-section]')).map(section => ({
            id: section.dataset.section, open: section.open,
            title: section.querySelector(':scope > summary .workshop-section-title').textContent,
          })),
        };
      }, `${tab.toLowerCase()}-pane`);
      assert.ok(layout.screens <= MAX_SCREENS, `${tab} opens ${layout.screens.toFixed(2)} screens tall.`);
      assert.ok(layout.sections.some(section => !section.open), `${tab} must collapse its secondary sections.`);
      report.tabs[tab] = { screens: Number(layout.screens.toFixed(2)), sections: layout.sections };
      await page.screenshot({ path: artifact(`workshop-${tab.toLowerCase()}.png`) });
    }
    const palette = await page.locator('.level-palette button').evaluateAll(buttons => buttons.map(button => button.textContent.trim()));
    assert.deepEqual([palette[0], palette.at(-1)], ['Block', 'Draw shape'], 'Focus order must follow the visual palette order.');
    const closed = page.getByRole('button', { name: 'Remove course labels', exact: true });
    assert.equal(await closed.count(), 0, 'Controls inside a collapsed section stay out of the way.');
    await openSection(page, 'level-labels');
    assert.equal(await closed.count(), 1);

    await page.getByRole('tab', { name: 'Physics', exact: true }).click();
    const unpaused = (await snapshot()).pauseReasons;
    await page.locator('details[data-section="physics-input"] > summary').focus();
    await page.keyboard.press('Space');
    assert.equal(await isOpen('physics-input'), true, 'Space on a section heading opens it.');
    assert.deepEqual((await snapshot()).pauseReasons, unpaused, 'Space on a section heading must not pause the game.');
    await page.keyboard.press('Space');
    assert.equal(await isOpen('physics-input'), false);

    // 2. View tools work from any tab.
    const overlay = page.getByRole('button', { name: 'Overlay', exact: true });
    assert.equal((await snapshot()).debug, false);
    await overlay.click();
    assert.equal((await snapshot()).debug, true);
    await page.waitForFunction(() => document.querySelector('[data-action="debug"]').getAttribute('aria-pressed') === 'true');
    await overlay.click();
    assert.equal((await snapshot()).debug, false);
    await page.getByRole('button', { name: 'Recenter camera', exact: true }).click();

    // 3. "/" finds a control in any tab; Enter selects its tab, opens its section and focuses it.
    await page.getByRole('tab', { name: 'Physics', exact: true }).click();
    await page.locator('#game').focus();
    await page.keyboard.press('/');
    assert.equal(await focusedId(), 'workshop-search');
    const before = await snapshot();
    await page.keyboard.type('rpd1');
    const typed = await snapshot();
    for (const key of ['practice', 'paused', 'debug']) assert.equal(typed[key], before[key], 'Typing a search must not run game shortcuts.');
    const timing = await page.evaluate(() => {
      const input = document.getElementById('workshop-search');
      input.blur();
      input.focus();
      input.value = 'hammer';
      const start = performance.now();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return performance.now() - start;
    });
    assert.ok(timing < 150, `Indexing and searching every control took ${timing} ms.`);
    report.searchMs = Number(timing.toFixed(2));
    await find('friction');
    assert.deepEqual(await firstOption(), { label: 'Hammer friction', path: 'Physics › Materials' });
    assert.equal(await search.getAttribute('aria-expanded'), 'true');
    await page.screenshot({ path: artifact('workshop-search.png') });
    assert.equal(await isOpen('physics-materials'), false);
    await search.press('Enter');
    assert.equal(await focusedId(), 'tuning-gripFriction');
    assert.equal(await isOpen('physics-materials'), true);
    assert.ok(await inView(page.locator('#tuning-gripFriction')));
    assert.equal(await page.locator('.tuning-field:has(#tuning-gripFriction)').evaluate(row => row.classList.contains('is-found')), true);
    assert.equal(await page.locator('.workshop-search-panel').isHidden(), true);
    await page.keyboard.press('/');
    assert.equal(await focusedId(), 'workshop-search', '"/" searches again right after revealing a slider.');

    await find('pot glb');
    assert.deepEqual(await firstOption(), { label: 'Pot GLB', path: 'Character › Pot model (GLB)' });
    await options.first().click();
    assert.equal(await selectedTab(), 'Character');
    assert.equal(await isOpen('character-pot'), true);
    assert.equal(await focusedId(), 'character-pot-file');

    await search.focus();
    await find('set piece');
    assert.deepEqual(await firstOption(), { label: 'Set piece library', path: 'Level' });
    await search.press('Enter');
    await page.waitForFunction(() => window.gettingOver.level().editor.mode === 'edit');
    assert.equal(await selectedTab(), 'Level');
    assert.equal(await isOpen('level-set-pieces'), true);
    assert.equal(await page.evaluate(() => document.activeElement?.matches('details[data-section="level-set-pieces"] > summary')), true);

    await page.getByRole('tab', { name: 'Physics', exact: true }).click();
    await search.focus();
    await find('save level');
    assert.deepEqual(await firstOption(), { label: 'Save level', path: 'Level' },
      'Controls of an inactive tab are found without being reported unavailable.');
    await find('offset');
    await search.press('ArrowDown');
    const second = await options.nth(1).getAttribute('id');
    assert.equal(await search.getAttribute('aria-activedescendant'), second);
    assert.equal(await options.nth(1).getAttribute('aria-selected'), 'true');
    await page.emulateMedia({ forcedColors: 'active' });
    const outlined = await page.evaluate(() => getComputedStyle(document.querySelector('.workshop-search-option[aria-selected="true"]')).outlineStyle);
    await page.emulateMedia({ forcedColors: 'none' });
    assert.notEqual(outlined, 'none', 'Forced colors must still show which result Enter picks.');
    for (const hidden of ['discard bone map', 'patrol radius']) {
      await find(hidden);
      assert.deepEqual(await options.allTextContents(), [], `Hidden controls such as "${hidden}" are not offered.`);
    }
    await find('zzqx');
    assert.equal(await options.count(), 0);
    assert.match(await page.locator('.workshop-search-note').textContent(), /No controls match/);
    assert.equal(await search.getAttribute('aria-expanded'), 'false');
    await search.press('Escape');
    assert.equal(await search.inputValue(), '');
    assert.equal(await page.locator('.workshop').isVisible(), true, 'The first Escape only clears the search.');
    await search.press('Escape');
    assert.equal(await page.locator('.workshop').isVisible(), false, 'Escape in an empty search closes the Workshop as before.');
    await page.locator('#game').focus();
    await page.keyboard.press('/');
    assert.equal(await page.locator('.workshop').isVisible(), true, '"/" opens a closed Workshop.');
    assert.equal(await focusedId(), 'workshop-search');

    // 4. Open and closed sections are remembered per browser, storing only departures from defaults.
    await page.getByRole('tab', { name: 'Physics', exact: true }).click();
    await page.locator('details[data-section="physics-mass"] > summary').click();
    await page.waitForFunction(() => !document.querySelector('details[data-section="physics-mass"]').open);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    assert.equal(await isOpen('physics-mass'), false);
    assert.equal(await isOpen('physics-materials'), true);
    assert.equal(await isOpen('physics-motors'), true);
    const stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), SECTIONS_KEY));
    assert.equal(stored['physics-mass'], false);
    assert.equal(stored['physics-motors'], undefined, 'Untouched defaults are not stored.');
    await openSection(page, 'physics-mass');
    assert.equal(JSON.parse(await page.evaluate(key => localStorage.getItem(key), SECTIONS_KEY))['physics-mass'], undefined);
    await page.evaluate((key) => {
      const original = Storage.prototype.setItem;
      window.restoreSectionWrites = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Section quota probe', 'QuotaExceededError');
        return original.call(this, name, value);
      };
    }, SECTIONS_KEY);
    try {
      await openSection(page, 'physics-response');
      assert.equal(await isOpen('physics-response'), true, 'Unavailable storage only forgets the layout.');
    } finally {
      await page.evaluate(() => window.restoreSectionWrites());
    }
    await page.evaluate(key => localStorage.setItem(key, '{broken'), SECTIONS_KEY);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
    assert.equal(await isOpen('physics-mass'), true, 'An unreadable layout falls back to the defaults.');
    report.sections = { remembered: true, defaultsNotStored: true, storageFailureTolerated: true, corruptFallsBack: true };

    // 5. On a phone the same search reveals a control inside the bottom sheet.
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    });
    try {
      const touch = await phone.newPage();
      await observeBrowserPage(touch, report.errors);
      await touch.goto(address, { waitUntil: 'networkidle' });
      await touch.waitForFunction(() => window.gettingOver?.snapshot().time > 0);
      await touch.getByRole('button', { name: 'Workshop', exact: true }).tap();
      const touchSearch = touch.getByRole('combobox', { name: 'Find a control', exact: true });
      await touchSearch.tap();
      await touchSearch.fill('sensitivity');
      const option = touch.getByRole('listbox', { name: 'Matching controls', exact: true }).getByRole('option').first();
      assert.equal(await option.locator('.workshop-search-label').textContent(), 'Control sensitivity');
      assert.ok((await option.boundingBox()).height >= 48, 'Search results keep touch-sized targets.');
      const sheet = await touch.locator('.workshop').boundingBox();
      const panel = await touch.locator('.workshop-search-panel').boundingBox();
      assert.ok(panel.y + panel.height <= sheet.y + sheet.height + 1, 'Results stay inside the bottom sheet.');
      await touch.screenshot({ path: artifact('workshop-mobile-search.png') });
      await option.tap();
      assert.equal(await touch.evaluate(() => document.activeElement?.id), 'tuning-mouseSensitivity');
      assert.equal(await touch.locator('details[data-section="physics-input"]').evaluate(node => node.open), true);
      assert.equal(await touch.evaluate(() => document.querySelector('#app').scrollTop), 0, 'Revealing scrolls only the Workshop.');
      report.mobile = { found: true, touchTargets: true, insideSheet: true };
    } finally {
      await phone.close();
    }
    assert.deepEqual(report.errors, []);
    return report;
  } finally {
    await writeFile(new URL('workshop-report.json', artifacts), JSON.stringify(report, null, 2));
    await context.close();
  }
}
