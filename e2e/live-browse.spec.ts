import {
  test,
  expect,
  routePlaylist,
  routeLiveManifest,
  seedPlaylist,
  SEARCH_M3U,
  type Page,
} from './helpers';

// Live opens on catalog rails: Favorites, Recently Watched, then a rail per
// group, each of cards; See all and Groups open the full channel list.

function manyGroups(groups: number, perGroup: number): string {
  const lines = ['#EXTM3U'];
  for (let g = 0; g < groups; g++) {
    for (let c = 0; c < perGroup; c++) {
      lines.push(`#EXTINF:-1 group-title="Group ${g}",Ch ${g}-${c}`, `http://host/${g}/${c}.m3u8`);
    }
  }
  return lines.join('\n');
}

async function open(page: Page, m3u = SEARCH_M3U): Promise<void> {
  await routePlaylist(page, m3u);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels .live-rails')).toBeVisible();
}

const focused = (page: Page) => page.locator('#view-channels .live-card.focused');

test('Live opens on one catalog rail per group, without the sidebar', async ({ page }) => {
  await open(page);
  await expect(page.locator('#view-channels .sidebar')).toHaveCount(0);
  await expect(page.locator('.live-rail .catalog-rail-title'))
    .toHaveText(['News', 'Entertainment', 'Sports']);
  await expect(page.locator('.live-rail').first().locator('.live-card .catalog-tile-name'))
    .toHaveText(['Alpha News', 'Beta News']);
  await expect(focused(page)).toContainText('Alpha News');
});

test('a Favorites rail leads once a channel is a favorite', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ArrowRight');
  await expect(focused(page)).toContainText('Beta News');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 404, bubbles: true })));
  await expect(page.locator('.live-rail .catalog-rail-title').first()).toHaveText('Favorites');
  await expect(page.locator('.live-rail').first().locator('.catalog-tile-name'))
    .toHaveText(['Beta News']);
});

test('the D-pad walks a rail with Left/Right and steps rails with Up/Down', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ArrowRight');
  await expect(focused(page)).toContainText('Beta News');
  await page.keyboard.press('ArrowRight');
  await expect(focused(page)).toContainText('Beta News');
  await page.keyboard.press('ArrowDown');
  await expect(focused(page)).toContainText('Alpha Movies');
  await page.keyboard.press('ArrowDown');
  await expect(focused(page)).toContainText('Delta Sports');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(focused(page)).toContainText('Alpha News');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.live-browse-head .focused')).toHaveCount(1);
});

test('OK on a card plays its channel', async ({ page }) => {
  await routeLiveManifest(page);
  await open(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd')).toContainText('Alpha Movies');
});

test('a number plays that channel from the rails', async ({ page }) => {
  await routeLiveManifest(page);
  await open(page);
  await page.keyboard.press('4');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd')).toContainText('Delta Sports');
});

test('See all opens the channel list on the group, and Back returns to the card', async ({ page }) => {
  await open(page, manyGroups(2, 25));
  const first = page.locator('.live-rail').first();
  await expect(first.locator('.live-card[data-channel-index]')).toHaveCount(20);
  await expect(first.locator('[data-live-see-all]')).toHaveCount(1);
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-live-see-all].focused')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.channel-main .channel-item').first()).toContainText('Ch 0-0');
  await expect(page.locator('.group-item.active')).toContainText('Group 0');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-live-see-all].focused')).toBeVisible();
});

test('thousands of channels render only the rails in view', async ({ page }) => {
  await open(page, manyGroups(150, 20));
  const rendered = await page.locator('.live-rail').count();
  expect(rendered).toBeLessThan(10);
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowDown');
  await expect(focused(page)).toContainText('Ch 60-0');
  expect(await page.locator('.live-rail').count()).toBeLessThan(10);
  // The focused rail is fully in view.
  const inView = await focused(page).evaluate((card) => {
    const rail = card.closest('.live-rail')!.getBoundingClientRect();
    const view = card.closest('.live-rails')!.getBoundingClientRect();
    return rail.top >= view.top - 1 && rail.bottom <= view.bottom + 1;
  });
  expect(inView).toBe(true);
});

test('a malicious channel name is escaped on a card', async ({ page }) => {
  const evil = '<img src=x onerror="window.__railxss=true">';
  await open(page, ['#EXTM3U', `#EXTINF:-1 group-title="News",${evil}`, 'http://host/a.m3u8'].join('\n'));
  await expect(page.locator('.live-card .catalog-tile-name')).toContainText('<img src=x');
  await expect(page.locator('.live-card img:not(.channel-logo)')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __railxss?: boolean }).__railxss)).toBeUndefined();
});

test('Yellow edits on the list screen and Back closes to the rails', async ({ page }) => {
  await open(page);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  await expect(page.locator('.channel-view.editing .channel-main')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-channels .live-rails')).toBeVisible();
  await expect(focused(page)).toContainText('Alpha News');
});
