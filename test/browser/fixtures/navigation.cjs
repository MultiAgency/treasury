/** Open the responsive navigation explicitly; never alter app state from the fixture. */
async function openWorkspaceNavigation(page) {
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible() && !await page.getByRole('dialog', { name: 'Workspace navigation' }).isVisible()) {
    await menu.click();
    await page.getByRole('dialog', { name: 'Workspace navigation' }).waitFor();
  }
}
module.exports = { openWorkspaceNavigation };
