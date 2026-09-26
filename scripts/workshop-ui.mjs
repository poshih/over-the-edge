/**
 * Workshop controls live in collapsible sections (`details[data-section]`). Scenarios reveal them
 * the way a person does: by opening each enclosing section heading, outermost first. Open sections
 * stay open across reloads in the same browser context.
 */
export async function openSection(page, ...ids) {
  for (const id of ids) {
    const chain = await page.locator(`details[data-section="${id}"]`).evaluate((section) => {
      const names = [];
      for (let node = section; node !== null; node = node.parentElement.closest('details[data-section]')) {
        names.unshift(node.dataset.section);
      }
      return names;
    });
    for (const name of chain) {
      const section = page.locator(`details[data-section="${name}"]`);
      if (!await section.evaluate((node) => node.open)) await section.locator(':scope > summary').click();
      await page.waitForFunction((key) => document.querySelector(`details[data-section="${key}"]`).open, name);
    }
  }
}
