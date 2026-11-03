import { test, expect, enterTab, neuterVideo, type Page } from './helpers';
import { THEMES } from '../src/config/themes';

async function seedDiscovery(page: Page): Promise<void> {
  await neuterVideo(page);
  await page.route('**/get.php*', (route) => route.fulfill({
    contentType: 'application/x-mpegurl',
    body: '#EXTM3U\n#EXTINF:-1 tvg-id="ch1",Channel One\nhttp://host/live/ch1.m3u8',
  }));
  await page.route('**/xmltv.php*', (route) => route.fulfill({ contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (action === 'get_vod_categories') return json([
      { category_id: '1', category_name: 'Drama' },
      { category_id: '2', category_name: 'Category Two' },
      { category_id: '4', category_name: 'Documentary' },
      { category_id: '3', category_name: 'Category Three with a long descriptive label' },
    ]);
    if (action === 'get_vod_streams') {
      const category = url.searchParams.get('category_id');
      const items = [
        { stream_id: 10, name: 'Zulu', rating: '6.0', category_id: '1' },
        { stream_id: 11, name: 'Bravo', rating: '8.0', category_id: '1' },
        { stream_id: 12, name: 'Alpha', rating: '9.0', category_id: '1' },
        { stream_id: 20, name: 'Delta', rating: '7.5', category_id: '2' },
        { stream_id: 30, name: 'Echo', rating: '', category_id: '3' },
      ].map((item) => ({ ...item, stream_icon: '', container_extension: 'mp4' }));
      return json(category ? items.filter((item) => item.category_id === category) : items);
    }
    if (action === 'get_vod_info') return json({ info: {
      plot: `Plot ${url.searchParams.get('vod_id')}.`, genre: 'Drama', duration_secs: 3600,
    } });
    return json([]);
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'x1', name: 'Account One', source: 'xtream', url: 'http://host',
      xtream: { username: 'u', password: 'p' },
    }]));
    localStorage.setItem('iptv_watchlist', JSON.stringify({ 'x1|vod|10': {
      accountId: 'x1', kind: 'vod', itemId: '10', name: 'Zulu', poster: '', rating: '6.0',
      categoryId: '1', containerExtension: 'mp4', addedAt: 1000,
    } }));
  });
}

async function select(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ page }) => {
  await seedDiscovery(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
});

test('keeps a good-rated suggestion above the saved movies and changes it on reentry', async ({ page }) => {
  const hero = page.locator('#view-movies .catalog-layer-browse .catalog-hero-title');
  await expect(hero).toHaveText(/^(Alpha|Bravo|Delta)$/);
  await expect(page.locator('#view-movies .catalog-layer-browse .catalog-hero-plot')).toHaveText(/Plot (11|12|20)\./);
  const first = await hero.textContent();
  expect(await page.locator('#view-movies .catalog-rails').evaluate((rails) => {
    const heroBody = rails.querySelector('.catalog-hero-body')!;
    const watchlist = rails.querySelector('[data-rail-key="watchlist"]')!;
    return !!(heroBody.compareDocumentPosition(watchlist) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  // Let automatic initial focus settle; it must not replace the suggestion with the low-rated saved tile.
  await page.waitForTimeout(650);
  await expect(hero).toHaveText(first!);
  await enterTab(page, 'live');
  await enterTab(page, 'movies');
  await expect(hero).toHaveText(/^(Alpha|Bravo|Delta)$/);
  await expect(hero).not.toHaveText(first!);
});

test('opens a category suggestion, sorts its movies, and restores focus after details', async ({ page }) => {
  await select(page, '#view-movies .catalog-cat[data-category-id="2"]');
  const grid = page.locator('#view-movies .catalog-grid');
  await expect(grid.locator('.catalog-hero-title')).toHaveText('Delta');
  await expect(grid.locator('.catalog-hero-plot')).toHaveText('Plot 20.');
  await expect(grid.locator('[data-hero-action="play"]')).toHaveClass(/focused/);
  await select(page, '#view-movies .catalog-grid [data-hero-action="info"]');
  await expect(page.locator('#view-movies .movies-detail .detail-title')).toHaveText('Delta');
  await page.keyboard.press('Escape');
  await expect(grid.locator('[data-hero-action="info"]')).toHaveClass(/focused/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-movies .catalog-cat[data-category-id="2"]')).toHaveClass(/focused/);
  await select(page, '#view-movies .catalog-cat[data-category-id="1"]');
  await expect(grid.locator('.catalog-hero-title')).toHaveText(/^(Alpha|Bravo)$/);
  const names = () => grid.locator('.catalog-grid-track .catalog-tile-name').allTextContents();
  await select(page, '#view-movies .catalog-grid [data-movie-sort="rating"]');
  await expect.poll(names).toEqual(['Alpha', 'Bravo', 'Zulu']);
  await page.keyboard.press('ArrowDown');
  await expect(grid.locator('[data-item-id="12"]')).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .movies-detail .detail-title')).toHaveText('Alpha');
  await page.keyboard.press('Escape');
  await expect(grid.locator('[data-item-id="12"]')).toHaveClass(/focused/);
  await select(page, '#view-movies .catalog-grid [data-movie-sort="za"]');
  await expect.poll(names).toEqual(['Zulu', 'Bravo', 'Alpha']);
  await select(page, '#view-movies .catalog-grid [data-movie-sort="original"]');
  await expect.poll(names).toEqual(['Zulu', 'Bravo', 'Alpha']);
  await select(page, '#view-movies .catalog-grid [data-movie-sort="az"]');
  await expect.poll(names).toEqual(['Alpha', 'Bravo', 'Zulu']);
  await expect(grid.locator('.focused')).toHaveCount(1);
});

test('keeps small category catalogs reachable and does not invent a rating for unrated movies', async ({ page }) => {
  await expect(page.locator('#view-movies .catalog-category-grid .catalog-cat')).toHaveCount(4);
  await select(page, '#view-movies .catalog-cat[data-category-id="3"]');
  const grid = page.locator('#view-movies .catalog-grid');
  await expect(grid.locator('.catalog-category-feature')).toHaveCount(0);
  await expect(grid.locator('.catalog-tile-name')).toHaveText('Echo');
  await page.keyboard.press('ArrowUp');
  await expect(grid.locator('[data-movie-sort] .focused, [data-movie-sort].focused')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(grid.locator('[data-item-id="30"]')).toHaveClass(/focused/);
});

test('draws outline category icons rather than solid black silhouettes', async ({ page }) => {
  const icon = page.locator('#view-movies .catalog-cat[data-category-id="4"] .catalog-cat-icon svg');
  const colors = await icon.evaluate((el) => ({
    fill: getComputedStyle(el).fill,
    stroke: getComputedStyle(el).stroke,
    inherited: getComputedStyle(el.parentElement!).color,
  }));
  expect(colors.fill).toBe('none');
  expect(colors.stroke).toBe(colors.inherited);
});

test('keeps category names readable in every theme, with and without the focus ring', async ({ page }) => {
  await page.addStyleTag({ content: '.catalog-cat { transition: none !important; }' });
  await page.locator('#view-movies .catalog-cat').first()
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (const theme of THEMES) {
    await page.evaluate((id) => document.documentElement.setAttribute('data-theme', id), theme.id);
    const contrasts = () => page.locator('#view-movies .catalog-cat').evaluateAll((cards) => {
      const luminance = (color: string): number => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      return cards.map((card) => {
        const style = getComputedStyle(card);
        const background = luminance(style.backgroundColor);
        return {
          text: ratio(luminance(style.color), background),
          icon: ratio(luminance(getComputedStyle(card.querySelector('.catalog-cat-icon')!).color), background),
        };
      });
    });
    await expect.poll(async () => Math.min(...(await contrasts()).map((value) => value.text)),
      { message: `${theme.id} category text`, timeout: 1000 }).toBeGreaterThanOrEqual(4.5);
    await expect.poll(async () => Math.min(...(await contrasts()).map((value) => value.icon)),
      { message: `${theme.id} category icons`, timeout: 1000 }).toBeGreaterThanOrEqual(3);
  }
});

test('fits two-line category labels at the largest text size', async ({ page }) => {
  await page.evaluate(() => document.documentElement.setAttribute('data-text-size', '150'));
  const sizes = await page.locator('#view-movies .catalog-cat[data-category-id="3"]').evaluate((card) => {
    const style = getComputedStyle(card);
    return {
      available: card.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      needed: card.querySelector('.catalog-cat-name')!.getBoundingClientRect().height,
    };
  });
  expect(sizes.needed).toBeLessThanOrEqual(sizes.available);
});

test('keeps category hero arrows in the action row and reaches sorting before posters', async ({ page }) => {
  await select(page, '#view-movies .catalog-cat[data-category-id="1"]');
  const grid = page.locator('#view-movies .catalog-grid');
  await expect(grid.locator('[data-hero-action="play"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  await expect(grid.locator('[data-hero-action="trailer"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  await expect(grid.locator('[data-hero-action="info"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  await expect(grid.locator('[data-hero-action="info"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  await expect(grid.locator('[data-movie-sort="original"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowUp');
  await expect(grid.locator('[data-hero-action="play"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowLeft');
  await expect(grid.locator('[data-hero-action="play"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  await expect(grid.locator('[data-movie-sort="original"]')).toHaveClass(/focused/);
});

test('reaches related movies below a detail with the D-pad, and Back returns to the first movie', async ({ page }) => {
  await select(page, '#view-movies .catalog-cat[data-category-id="1"]');
  await select(page, '#view-movies .catalog-grid [data-item-id="10"]');
  const detail = page.locator('#view-movies .movies-detail');
  await expect(detail.locator('.detail-title')).toHaveText('Zulu');
  const rail = detail.locator('[data-rail-key="related"]');
  await expect(rail.locator('.catalog-rail-title')).toHaveText('Related Movies');
  await expect(rail.locator('.catalog-tile-name')).toHaveText([/^(Alpha|Bravo)$/, /^(Alpha|Bravo)$/]);
  await expect(detail.locator('[data-action="play"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  const first = rail.locator('.catalog-tile').first();
  await expect(first).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  await expect(rail.locator('.catalog-tile').nth(1)).toHaveClass(/focused/);
  await page.keyboard.press('ArrowLeft');
  const name = await first.locator('.catalog-tile-name').textContent();
  await page.keyboard.press('Enter');
  await expect(detail.locator('.detail-title')).toHaveText(name!);
  await expect(rail.locator('.catalog-tile-name')).toContainText(['Zulu']);
  await expect(detail).toHaveJSProperty('scrollTop', 0);
  await page.keyboard.press('Escape');
  await expect(detail.locator('.detail-title')).toHaveText('Zulu');
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-movies .catalog-grid [data-item-id="10"]')).toHaveClass(/focused/);
});
