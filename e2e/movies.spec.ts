import { test, expect, routeLiveManifest, neuterVideo, SAMPLE_M3U, enterTab, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';

// A minimal ASS body with one dialogue active from t=0, so assjs renders it as
// soon as it initializes over the (paused, t=0) video.
const SAMPLE_ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:05:00.00,Default,,0,0,0,,ASS Cue 1',
  '',
].join('\n');

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Seed one Xtream account (enables the tab bar) and stub the player_api.php
// catalog calls + the get.php/xmltv.php the live path uses. With `subtitles`,
// get_vod_info advertises an SRT sidecar; with `ass`, an ASS sidecar. The routed
// .srt/.ass URLs serve small bodies.
async function seedMovies(
  page: import('@playwright/test').Page,
  opts: { subtitles?: boolean; ass?: boolean; streams?: number; posters?: boolean } = {},
): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    if (url.includes('get_vod_categories')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]) });
    }
    if (url.includes('get_vod_streams')) {
      const streams = opts.streams
        ? Array.from({ length: opts.streams }, (_, i) => (
          { stream_id: 100 + i, name: `Movie ${String(i)}`,
            stream_icon: opts.posters ? `http://host.example.com:8080/poster/${String(i)}.png` : '',
            container_extension: 'mp4', category_id: '1' }))
        : [{ stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(streams) });
    }
    if (url.includes('get_vod_info')) {
      const info: Record<string, unknown> = { plot: 'A plot.', duration_secs: 3600 };
      const subs: unknown[] = [];
      if (opts.subtitles) subs.push({ subtitle_id: '1', title: 'Track 1', language: 'l1',
        url: 'http://host.example.com:8080/subs/10.srt' });
      if (opts.ass) subs.push({ subtitle_id: '2', title: 'ASS 1', language: 'l2',
        url: 'http://host.example.com:8080/subs/10.ass' });
      if (subs.length) info.subtitles = subs;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ info }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  if (opts.subtitles || opts.ass) {
    await page.route('**/subs/**', (route) => {
      if (route.request().url().split('?')[0].endsWith('.ass')) {
        return route.fulfill({ status: 200, contentType: 'text/plain', body: SAMPLE_ASS });
      }
      return route.fulfill({ status: 200, contentType: 'application/x-subrip',
        body: '1\n00:00:01,000 --> 00:00:04,000\nHello\n\n2\n00:00:05,000 --> 00:00:07,000\nWorld\n' });
    });
  }
  if (opts.posters) {
    await page.route('**/poster/**', (route) => route.fulfill({
      status: 200, contentType: 'image/png', body: Buffer.from(TINY_PNG, 'base64') }));
  }
  // The movie file itself: a small response so play() doesn't hang the test.
  await page.route('**/movie/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

// Chromium before 91 drops a flex scroller's end padding from its scroll
// width. No engine Playwright drives has that quirk, so claim it the way
// src/engine-quirks.ts would on such an engine.
async function claimScrollEndQuirk(page: Page): Promise<void> {
  await page.evaluate(() => document.documentElement.classList.add('q-scroll-end-padding'));
}

test('keeps the focus ring clear of the rail edge at See all', async ({ page }) => {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await claimScrollEndQuirk(page);
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="100"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  const seeAll = page.locator('#view-movies .catalog-see-all');
  await expect(seeAll).toHaveClass(/focused/);
  await expect(seeAll).toContainText('30 movies');
  // The ring (2px offset + 3px outline + 6px glow) must sit inside the track.
  await expect.poll(() => seeAll.evaluate((el) => {
    const track = el.parentElement!.getBoundingClientRect();
    return Math.round(track.right - el.getBoundingClientRect().right);
  })).toBeGreaterThanOrEqual(11);
  // On such an engine the room past the last tile must come from content.
  // Drop the padding here to measure what it would scroll to.
  expect(await seeAll.evaluate((el) => {
    const track = el.parentElement!;
    track.style.paddingRight = '0';
    const room = track.scrollWidth - (el.offsetLeft + el.offsetWidth - track.offsetLeft);
    track.style.paddingRight = '';
    return room;
  })).toBeGreaterThanOrEqual(12);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
});

test('Back to See all jumps straight to it under full animation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('iptv_animation_mode', JSON.stringify('full')));
  await seedXtream(page, { catalog: 'large' });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  await expect(page.locator('html')).toHaveAttribute('data-animation', 'full');
  // Walk the rail with the remote, as a viewer would, so See all is scrolled
  // into view before it opens its grid.
  await page.locator('#view-movies [data-rail-key="cat:4"] .catalog-tile').first()
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  const seeAll = page.locator('#view-movies .catalog-see-all[data-category-id="4"]');
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await expect(seeAll).toHaveClass(/focused/);
  await expect.poll(() => seeAll.evaluate((el) => {
    const track = el.parentElement!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return box.left >= track.left && box.right <= track.right && box.top >= 0
      && box.bottom <= window.innerHeight;
  })).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat D');
  // Linger past FOCUS_REPEAT_WINDOW_MS, inside which SpatialNav scrolls
  // instantly anyway, as a held key would.
  await page.waitForTimeout(400);
  // Read the layout in the same task as Back: the resident browse must have
  // the tile in place already, with no scroll left to replay.
  const placement = await page.evaluate(() => {
    const back = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(back, 'keyCode', { get: () => 27 });
    document.dispatchEvent(back);
    const tile = document.querySelector<HTMLElement>('#view-movies .catalog-see-all[data-category-id="4"]')!;
    const track = tile.parentElement!.getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    return {
      focused: tile.classList.contains('focused'),
      inTrack: box.left >= track.left && box.right <= track.right,
      onScreen: box.top >= 0 && box.bottom <= window.innerHeight,
    };
  });
  expect(placement).toEqual({ focused: true, inTrack: true, onScreen: true });
});

test('All categories wraps into a grid that D-pad walks row to row', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  const cats = page.locator('#view-movies .catalog-category-grid .catalog-cat');
  await expect(cats).toHaveCount(8);
  const layout = await cats.evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), right: r.right, left: Math.round(r.left) };
  }));
  const perRow = layout.filter((c) => c.top === layout[0].top).length;
  // Wrapped onto more than one row, with no tile cut off at the right edge.
  expect(perRow).toBeLessThan(8);
  expect(Math.max(...layout.map((c) => c.right))).toBeLessThanOrEqual(1920);
  expect(await page.locator('#view-movies .catalog-category-grid').evaluate(
    (el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const focusedKey = () => page.locator('#view-movies .focused').getAttribute('data-key');
  await cats.first().evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await expect.poll(focusedKey).toBe('c:1');
  await page.keyboard.press('ArrowRight');
  await expect.poll(focusedKey).toBe('c:2');
  await page.keyboard.press('ArrowDown');
  await expect.poll(focusedKey).toBe('c:' + String(perRow + 2));
  await page.keyboard.press('ArrowUp');
  await expect.poll(focusedKey).toBe('c:2');
  await expect(page.locator('#view-movies .focused')).toHaveCount(1);
});

test('gives a scroll-end spacer only to flex containers', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await claimScrollEndQuirk(page);
  // Outside a flex container the spacer is an inline box with margins, which
  // Chromium 53 lays out as an extra line that overflows a fixed-height rail.
  const misplaced = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')]
    .filter((el) => {
      const after = getComputedStyle(el, '::after');
      return after.content !== 'none' && after.content !== 'normal' && after.flexBasis === '1px'
        && !/flex/.test(getComputedStyle(el).display);
    })
    .map((el) => el.className));
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-category-grid')).toBeVisible();
  expect(await misplaced()).toEqual([]);
  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg .epg-date-list')).toBeVisible();
  expect(await misplaced()).toEqual([]);
});

test('browse Movies, open a detail, and start playback', async ({ page }) => {
  await seedMovies(page);
  await routeLiveManifest(page);
  // Keep VOD alive so the empty mock movie file doesn't fire `error` and
  // auto-eject the player, which would race this test's own Back navigation.
  await neuterVideo(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Enter Movies via the docked tab bar.
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();

  await expect(page.locator('#view-movies .catalog-rail-title')).toContainText('Cat A');
  await expect(page.locator('.catalog-tile[data-item-id="10"]')).toContainText('Movie One');

  // Focus the poster and open its detail. Dispatch an explicit bubbling
  // nav:hover so SpatialNav's container-bound listener receives it.
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');

  // Play, then Back returns to the Movies view.
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  // Back key (CONFIG.KEYS.BACK = 461). press('Escape') is swallowed by Chromium
  // in this combo, so dispatch a raw keydown like the other specs do.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-movies')).toBeVisible();
  // The detail screen survives the player round-trip (Movies isn't re-rendered on return).
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
});

test('Back walks Movies detail -> browse -> Live instead of ejecting', async ({ page }) => {
  await seedMovies(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Enter Movies via the docked tab bar.
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();

  await expect(page.locator('.catalog-tile[data-item-id="10"]')).toContainText('Movie One');

  // Open the movie detail.
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');

  // First Back steps detail -> browse: still inside Movies, not ejected to Live.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-movies')).toBeVisible();
  await expect(page.locator('#view-movies .catalog-browse')).toBeVisible();
  await expect(page.locator('#view-channels')).toBeHidden();

  // Second Back from the browse top level returns to Live.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-channels')).toBeVisible();
});

test('Back from a detail finds browse scrolled and focused as it was left', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('iptv_animation_mode', JSON.stringify('full')));
  await seedMovies(page, { streams: 20 });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  await expect(page.locator('html')).toHaveAttribute('data-animation', 'full');
  await page.locator('.catalog-tile[data-item-id="100"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight');
  const tile = page.locator('#view-movies .catalog-tile[data-item-id="115"]');
  await expect(tile).toHaveClass(/focused/);
  const track = page.locator('#view-movies .catalog-browse .catalog-rail-track').first();
  // Let the smooth scroll settle before recording where browse was left.
  let left = -1;
  await expect.poll(async () => {
    const now = await track.evaluate((el) => el.scrollLeft);
    const settled = now > 0 && now === left;
    left = now;
    return settled;
  }, { intervals: [150] }).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  // Read in the same task as Back: a rebuilt browse would sit at offset 0
  // and only glide back to the tile afterward.
  const back = await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true }));
    const el = document.querySelector<HTMLElement>('#view-movies .catalog-tile[data-item-id="115"]')!;
    return {
      focused: el.classList.contains('focused'),
      scrollLeft: el.parentElement!.scrollLeft,
    };
  });
  expect(back).toEqual({ focused: true, scrollLeft: left });
});

test('VOD playback suppresses the live channel sidebar and shows a VOD-only menu at the pointer edges', async ({ page }) => {
  await seedMovies(page);
  await routeLiveManifest(page);
  // Keep VOD alive in the player: neuter the <video> so the empty mock movie
  // file doesn't fire `error` and eject back to Movies before we probe the edges.
  await neuterVideo(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Enter Movies, open a detail, and start playback (VOD mode).
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  // Wait until VOD playback has fully settled (the VOD OSD shows the title and,
  // being paused, stays up) so the pointer probe isn't racing the transition.
  await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();

  // The left edge opens the channel switcher during live playback; VOD has no
  // channels, so the pointer must not summon it. Check once (not a retrying
  // wait) — the sidebar auto-hides, which would mask a wrong show.
  await page.mouse.move(10, 540);
  await page.waitForTimeout(200);
  expect(await page.locator('#player-sidebar.visible').count()).toBe(0);

  // The right edge opens the VOD menu with playback speed, but never the live
  // channel rows or the "Playing:" channel name.
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Title Info');
  await expect(menu).toContainText('Settings');
  await expect(menu).toContainText('Playback Speed');
  expect(await menu.textContent()).not.toContain('Program Guide');
  expect(await menu.textContent()).not.toContain('Toggle Favorite');
  expect(await menu.textContent()).not.toContain('Playing:');

  await menu.locator('[data-menu-action="__speed_open__"]').click();
  await menu.locator('[data-playback-rate="1.5"]').click();
  await expect.poll(() => page.locator('#video-player')
    .evaluate((video: HTMLVideoElement) => video.playbackRate)).toBe(1.5);
});

test('a VOD sidecar subtitle creates its application track when selected', async ({ page }) => {
  await seedMovies(page, { subtitles: true });
  await routeLiveManifest(page);
  // Keep VOD alive so the neutered <video> doesn't eject before we probe tracks.
  await neuterVideo(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();

  // Sidecars are synthetic picker entries, so the reusable renderer track is
  // not created until the first selection.
  const initialTrackCount = await page.evaluate(() => {
    const v = document.getElementById('video-player') as HTMLVideoElement;
    return v.textTracks.length;
  });
  expect(initialTrackCount).toBe(0);

  // Open the right-edge menu into the Subtitles sub-menu; the sidecar is listed.
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown'); // Title Info -> Settings
  await page.keyboard.press('ArrowDown'); // Settings -> Playback Speed
  await page.keyboard.press('ArrowDown'); // Playback Speed -> Subtitles
  await page.keyboard.press('Enter');     // open the Subtitles sub-menu
  await expect(menu).toContainText('Track 1');

  // Select the sidecar; it starts showing and its cues load from the routed SRT.
  await page.keyboard.press('ArrowDown'); // Off -> Track 1
  await page.keyboard.press('Enter');
  await expect.poll(async () => page.evaluate(() => {
    const t = (document.getElementById('video-player') as HTMLVideoElement).textTracks[0];
    return t && t.mode === 'showing' && t.cues
      ? { count: t.cues.length, label: t.label }
      : null;
  })).toEqual({ count: 2, label: 'Track 1' });
});

test('a VOD ASS sidecar renders through the assjs overlay when selected', async ({ page }) => {
  await seedMovies(page, { ass: true });
  await routeLiveManifest(page);
  // Keep VOD alive so the neutered <video> doesn't eject before we probe the overlay.
  await page.addInitScript(() => {
    const P = HTMLMediaElement.prototype;
    P.load = function () { /* no-op */ };
    P.play = function () { return Promise.resolve(); };
    Object.defineProperty(P, 'src', { configurable: true, set() { /* no-op */ }, get() { return ''; } });
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();

  // Open the right-edge menu into the Subtitles sub-menu; the ASS sidecar is listed
  // (it never becomes a native <track>, so this proves the synthetic-option path).
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown'); // Title Info -> Settings
  await page.keyboard.press('ArrowDown'); // Settings -> Playback Speed
  await page.keyboard.press('ArrowDown'); // Playback Speed -> Subtitles
  await page.keyboard.press('Enter');     // open the Subtitles sub-menu
  await expect(menu).toContainText('ASS 1');

  // Select the ASS sidecar; assjs lazily loads and draws its cue into #ass-overlay.
  await page.keyboard.press('ArrowDown'); // Off -> ASS 1
  await page.keyboard.press('Enter');
  await expect(page.locator('#ass-overlay')).toContainText('ASS Cue 1');
});

// Opening a detail with no remembered key focuses its first control in DOM
// order, with no geometry to fall back on, so measurement is the only thing
// keeping focus off a hidden one. A stylesheet rule is the case no selector on
// the element itself can catch, and jsdom applies no CSS.
test('a detail whose first control is hidden focuses the next visible one', async ({ page }) => {
  await seedMovies(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();

  await page.addStyleTag({
    content: '#view-movies .detail-btn[data-key="play"] { display: none; }',
  });

  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');

  const focused = await page.evaluate(() =>
    document.querySelector('#view-movies .focused')?.getAttribute('data-key') ?? null);
  expect(focused).toBe('watchlist');
});

// Hover a row, then let the pointer leave it: the highlight hides but focus stays.
async function hoverThenLeave(el: import('@playwright/test').Locator): Promise<void> {
  await el.evaluate((node) => {
    node.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    node.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
  });
}

test('after the pointer leaves a grid tile, the first key shows it and the next one moves', async ({ page }) => {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="100"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');

  const tile = (index: number) => page.locator(`#view-movies [data-grid-index="${String(index)}"] .catalog-tile`);
  await hoverThenLeave(tile(0));
  await expect(page.locator('#view-movies .catalog-tile.focused')).toHaveCount(0);

  await page.keyboard.press('ArrowRight');
  await expect(tile(0)).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowRight');
  await expect(tile(1)).toHaveClass(/\bfocused\b/);
});

test('CH+/CH- leave a pointer-hidden tile hidden in the catalog', async ({ page }) => {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="100"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');

  const tile = (index: number) => page.locator(`#view-movies [data-grid-index="${String(index)}"] .catalog-tile`);
  await hoverThenLeave(tile(0));
  await expect(page.locator('#view-movies .catalog-tile.focused')).toHaveCount(0);

  // The movies view ignores CH+/CH- (a wheel over the tab bar sends them).
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageDown');
  await expect(page.locator('#view-movies .catalog-tile.focused')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(tile(0)).toHaveClass(/\bfocused\b/);
});

test('a revealed grid tile keeps its ring after the reveal scrolls the grid', async ({ page }) => {
  await seedMovies(page, { streams: 60 });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="100"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');

  const tile = page.locator('#view-movies [data-grid-index="0"] .catalog-tile');
  await hoverThenLeave(tile);
  await expect(page.locator('#view-movies .catalog-tile.focused')).toHaveCount(0);
  // A wheel with the pointer in a gap scrolls the tile out of view, still rendered.
  const grid = page.locator('#view-movies .catalog-grid');
  const box = await tile.boundingBox();
  if (!box) throw new Error('no layout');
  await grid.evaluate((el, top) => { el.scrollTop = top; }, box.height + 40);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  await expect(tile).toHaveCount(1);

  await page.keyboard.press('ArrowDown');
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBeLessThan(box.height);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  await expect(tile).toHaveClass(/\bfocused\b/);
});

test('Up into the tab bar takes the ring off the catalog tile', async ({ page }) => {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  const tile = page.locator('#view-movies .catalog-tile[data-item-id="100"]');
  await tile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await expect(tile).toHaveClass(/\bfocused\b/);

  for (let i = 0; i < 4 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  await expect(page.locator('.tab-bar-item.focused')).toHaveCount(1);
  await expect(page.locator('#view-movies .focused')).toHaveCount(0);
});

test('Down from the tab bar rings a tile at once, and one Right moves', async ({ page }) => {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  const tile = page.locator('#view-movies .catalog-tile[data-item-id="100"]');
  await tile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 4 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  await expect(page.locator('.tab-bar-item.focused')).toHaveCount(1);
  await expect(page.locator('#view-movies .focused')).toHaveCount(0);

  await page.keyboard.press('ArrowDown');
  const focused = page.locator('#view-movies .focused');
  await expect(focused).toHaveCount(1);
  const first = await focused.getAttribute('data-key');
  await page.keyboard.press('ArrowRight');
  await expect(focused).toHaveCount(1);
  await expect(focused).not.toHaveAttribute('data-key', first ?? '');
});

async function upToTabBar(page: Page): Promise<void> {
  for (let i = 0; i < 8 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  await expect(page.locator('.tab-bar-item[data-section="movies"].focused')).toHaveCount(1);
}

async function openCategoryGrid(page: Page): Promise<void> {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  const seeAll = page.locator('#view-movies .catalog-see-all');
  await seeAll.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
  await expect(gridFocus(page)).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(gridFocus(page)).toHaveAttribute('data-item-id', '101');
}

const gridFocus = (page: Page) => page.locator('#view-movies .catalog-grid .catalog-tile.focused');

test.describe('Down from the tab bar resumes Movies as Up left it', () => {
  test('in a category grid', async ({ page }) => {
    await openCategoryGrid(page);
    await upToTabBar(page);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
    await expect(gridFocus(page)).toHaveAttribute('data-item-id', '101');
  });

  test('with the tile it left scrolled half out of view', async ({ page }) => {
    await seedXtream(page, { catalog: 'large' });
    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();
    await enterTab(page, 'movies');
    const tile = page.locator('#view-movies .catalog-tile').first();
    await tile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await expect(tile).toHaveClass(/\bfocused\b/);
    await upToTabBar(page);
    // Scroll the parked tile half under the top edge of the catalog.
    const left = page.locator('#view-movies .focused-parked');
    await expect(left).toHaveCount(1);
    const clipped = await left.evaluate((el) => {
      let scroller = el.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
      if (!scroller) return false;
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += top + el.getBoundingClientRect().height / 2;
      return el.getBoundingClientRect().top < scroller.getBoundingClientRect().top;
    });
    expect(clipped).toBe(true);

    await page.keyboard.press('ArrowDown');
    const focused = page.locator('#view-movies .focused');
    await expect(focused).toHaveCount(1);
    await expect.poll(() => focused.evaluate((el) => {
      let scroller = el.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
      return el.getBoundingClientRect().top >= (scroller?.getBoundingClientRect().top ?? 0) - 1;
    })).toBe(true);
  });

  test('in a category grid Search was opened over', async ({ page }) => {
    await openCategoryGrid(page);
    await enterTab(page, 'search');
    await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.tab-bar-search.expanded')).toHaveCount(0);
    await expect(page.locator('.tab-bar-item[data-section="movies"].focused')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
    await expect(gridFocus(page)).toHaveAttribute('data-item-id', '101');
  });
});

async function openAccountMenuOverMovies(page: Page): Promise<void> {
  await seedXtream(page, { catalog: 'large' });
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  // Reach Movies from the tab bar with keys alone.
  await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 8 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  for (let i = 0; i < 6 && !(await page.locator('.tab-bar-item[data-section="movies"].focused').count()); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(page.locator('.tab-bar-item[data-section="movies"].focused')).toHaveCount(1);
  await expect(page.locator('#view-movies .catalog-tile').first()).toBeVisible();
  const avatar = (await page.locator('.account-avatar').boundingBox())!;
  await page.mouse.click(avatar.x + avatar.width / 2, avatar.y + avatar.height / 2);
  await expect(page.locator('.account-menu')).toBeVisible();
}

test('a tile lights under the pointer while the account menu stays open', async ({ page }) => {
  await openAccountMenuOverMovies(page);
  const tile = page.locator('#view-movies .catalog-tile').first();
  const box = (await tile.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);

  await expect(tile).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.account-menu')).toBeVisible();
});

test('a tile the pointer left under the account menu stays dark once the menu closes', async ({ page }) => {
  await openAccountMenuOverMovies(page);
  const tile = page.locator('#view-movies .catalog-tile').first();
  const box = (await tile.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await expect(tile).toHaveClass(/\bfocused\b/);
  // Off the tiles onto empty catalog space, then the avatar closes the menu.
  await page.mouse.move(960, 300);
  const avatar = (await page.locator('.account-avatar').boundingBox())!;
  await page.mouse.click(avatar.x + avatar.width / 2, avatar.y + avatar.height / 2);
  await expect(page.locator('.account-menu')).toBeHidden();
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#view-movies .focused:not(.focused-parked)')).toHaveCount(0);
});

test('rail posters load only as their rail scrolls them near', async ({ page }) => {
  await seedMovies(page, { streams: 20, posters: true });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  const poster = (i: number) => page.locator(
    `#view-movies .catalog-browse .catalog-tile[data-item-id="${String(100 + i)}"] img.catalog-poster`);
  await expect(poster(0)).toHaveAttribute('src', /poster\/0\.png$/);
  // One track width ahead of the visible tiles is fetched; the far end waits.
  await expect(poster(12)).toHaveAttribute('src', /poster\/12\.png$/);
  await expect(poster(19)).not.toHaveAttribute('src');
  await expect(poster(19)).toHaveAttribute('data-lazy-src', /poster\/19\.png$/);

  await page.locator('#view-movies .catalog-browse .catalog-rail-track').first()
    .evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect(poster(19)).toHaveAttribute('src', /poster\/19\.png$/);
  await expect(poster(19)).not.toHaveAttribute('data-lazy-src');
});

test('the hero Play button plays the movie it shows', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  const view = page.locator('#view-movies');
  await expect(view.locator('.catalog-hero-title')).toHaveText('Movie One');
  await expect(view.locator('.catalog-hero-plot')).toHaveText('A plot.');
  await page.keyboard.press('ArrowDown');
  await expect(view.locator('.catalog-tile[data-item-id="10"].focused')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(view.locator('[data-hero-action="play"].focused')).toHaveCount(1);
  await expect(view.locator('.focused')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
});

// The trailer wrapper page and oEmbed check are stubbed: tests never reach
// YouTube. The stub stands in for the wrapper and echoes each command it
// receives to the page, and can raise the player's embedding error once the
// app starts listening.
async function stubTrailerEmbed(page: Page, mode: 'ok' | 'error'): Promise<void> {
  await page.route('https://www.youtube.com/oembed**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: '{}',
  }));
  await page.route('https://andreescocard.github.io/webos-iptv-player/pages/trailer.html**', (route) => route.fulfill({
    status: 200, contentType: 'text/html',
    body: `<!doctype html><script>window.addEventListener('message', function (e) {
      var d = {}; try { d = JSON.parse(e.data); } catch (x) {}
      if (${mode === 'error' ? 'd.event === "listening"' : 'false'}) {
        parent.postMessage(JSON.stringify({ event: 'onError', info: 150 }), '*');
      }
      parent.postMessage(JSON.stringify({ event: 'stub-cmd', func: d.func || d.event }), '*');
    });</script>`,
  }));
  await page.addInitScript(() => {
    const w = window as unknown as { __cmds: string[]; __opened: string[] };
    w.__cmds = [];
    w.__opened = [];
    window.addEventListener('message', (e) => {
      try {
        const d = JSON.parse(String(e.data)) as { event?: string; func?: string };
        if (d.event === 'stub-cmd' && d.func) w.__cmds.push(d.func);
      } catch { /* not ours */ }
    });
    window.open = ((url?: string | URL) => { w.__opened.push(String(url)); return {} as Window; }) as typeof window.open;
  });
}

async function openHeroTrailer(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  const view = page.locator('#view-movies');
  await expect(view.locator('.catalog-hero-plot')).toHaveText('A plot.');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await expect(view.locator('[data-hero-action="trailer"].focused')).toHaveCount(1);
  await page.keyboard.press('Enter');
}

test('the hero Trailer plays inline; OK pauses and Back closes', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await stubTrailerEmbed(page, 'ok');
  await openHeroTrailer(page);
  const frame = page.locator('.trailer-frame');
  await expect(frame).toHaveAttribute('src', /trailer\.html\?v=abcdefghijk$/);
  // Commands sent before the frame has loaded would be dropped.
  await expect.poll(() => page.evaluate(
    () => (window as unknown as { __cmds: string[] }).__cmds)).toContain('listening');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(
    () => (window as unknown as { __cmds: string[] }).__cmds)).toContain('pauseVideo');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(
    () => (window as unknown as { __cmds: string[] }).__cmds)).toContain('playVideo');
  await page.keyboard.press('Escape');
  await expect(frame).toHaveCount(0);
  await expect(page.locator('#view-movies [data-hero-action="trailer"].focused')).toHaveCount(1);
});

test('a disabled embed closes the player and shows the unavailable notice', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await stubTrailerEmbed(page, 'error');
  await openHeroTrailer(page);
  await expect(page.locator('.toast.visible', { hasText: 'Trailer unavailable' })).toBeVisible();
  await expect(page.locator('.trailer-frame')).toHaveCount(0);
  await expect.poll(() => page.evaluate(
    () => (window as unknown as { __opened: string[] }).__opened)).toEqual([]);
});
