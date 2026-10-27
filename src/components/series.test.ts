// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PlaylistEntry, WatchlistEntry, WatchlistKind } from '../types';

const { catalogMock, storageMock, watchlistState, toastMock } = vi.hoisted(() => {
  const watchlistState = { entries: [] as WatchlistEntry[] };
  return {
    catalogMock: { loadSeriesCategories: vi.fn(), loadSeries: vi.fn(), loadSeriesInfo: vi.fn(), getCatalogFill: vi.fn((): { done: number; total: number } | null => null), onCatalogFillChanged: vi.fn() },
    watchlistState,
    storageMock: {
      getResumeList: vi.fn(() => [] as unknown[]),
      getResume: vi.fn(() => null),
      getWatchlist: vi.fn(() => watchlistState.entries),
      isWatchlisted: vi.fn((_accountId: string, _kind: WatchlistKind, itemId: string) =>
        watchlistState.entries.some((entry) => entry.itemId === itemId)),
      toggleWatchlist: vi.fn((entry: WatchlistEntry) => {
        const index = watchlistState.entries.findIndex((item) => item.itemId === entry.itemId);
        if (index >= 0) {
          watchlistState.entries.splice(index, 1);
          return false;
        }
        watchlistState.entries.unshift(entry);
        return true;
      }),
    },
    toastMock: { showToast: vi.fn() },
  };
});
vi.mock('../services/xtream-catalog', () => catalogMock);
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('./toast', () => ({ showToast: toastMock.showToast }));

import { Series } from './series';
import { Focus } from '../navigation/focus-scope';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};
const series = (id: string, name: string, categoryId = '1') => ({
  accountId: 'x1', seriesId: id, name, poster: '', rating: '', categoryId,
});

let container: HTMLElement;
function eventLines(spy: { mock: { calls: unknown[][] } }, code: string): string[] {
  return spy.mock.calls.map((args) => args.join(' ')).filter((l) => l.includes(`event=${code} `));
}

beforeEach(() => {
  Focus.uninstall();
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  // clearAllMocks clears calls but not implementations; re-establish defaults so a
  // prior test's mockReturnValue override doesn't leak (order-safety).
  storageMock.getResumeList.mockReturnValue([]);
  storageMock.getResume.mockReturnValue(null);
  catalogMock.getCatalogFill.mockReturnValue(null);
  watchlistState.entries = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

async function openWith(cats = [{ id: '1', name: 'Cat A' }], items = [series('s1', 'Series One')]) {
  catalogMock.loadSeriesCategories.mockResolvedValue(cats);
  catalogMock.loadSeries.mockResolvedValue(items);
  const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
  const view = new Series(container, handlers);
  Focus.setBase(() => view.focusScope);
  await view.open(account);
  return { view, handlers };
}

describe('Series browse + grid', () => {
  it('labels See all with the series count', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], Array.from({ length: 21 }, (_, i) => series(`s${String(i)}`, `Series ${String(i)}`)));
    expect(container.querySelector('.catalog-see-all')?.textContent).toContain('21 series');
  });

  it('renders a rail per preloaded category with poster tiles', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], [series('s1', 'Series One')]);
    expect(container.querySelector('.catalog-rail-title')?.textContent).toContain('Cat A');
    expect(container.querySelector('.catalog-tile[data-item-id="s1"]')?.textContent).toContain('Series One');
  });

  describe('hero', () => {
    const s1 = { ...series('s1', 'Series One'), poster: 'http://host/a1.jpg' };
    const s2 = { ...series('s2', 'Series Two'), poster: 'http://host/a2.jpg', rating: '8.1' };
    const ep = (id: string, n: number, poster = '') => ({
      id, title: `Episode ${String(n)}`, season: 1, episode: n, containerExtension: 'mkv',
      durationSecs: 600, plot: '', poster, subtitles: [],
    });
    const info = (extra: Record<string, unknown> = {}) => ({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', episodeRunTimeMins: 0,
      poster: '', backdrop: '', rating: '', imdbId: '', tmdbId: '', year: 0,
      seasons: [1], episodesBySeason: { 1: [ep('e1', 1), ep('e2', 2)] }, ...extra,
    });
    const hover = (selector: string) => container.querySelector(selector)!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    const title = () => container.querySelector('.catalog-hero-title')?.textContent;
    const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('follows the focused series after a pause, with its backdrop and facts', async () => {
      catalogMock.loadSeriesInfo.mockImplementation((_a: unknown, id: string) => Promise.resolve(id === 's2'
        ? info({ backdrop: 'http://host/w2.jpg', genre: 'Drama', year: 2021, plot: 'A series plot.' })
        : info()));
      await openWith([{ id: '1', name: 'Cat A' }], [s1, s2]);
      await settle();
      expect(container.querySelector('.catalog-hero-poster')?.getAttribute('src')).toBe('http://host/a1.jpg');
      hover('.catalog-tile[data-item-id="s2"]');
      expect(title()).toBe('Series One');
      vi.advanceTimersByTime(500);
      expect(title()).toBe('Series Two');
      await settle();
      expect(container.querySelector('.catalog-hero-backdrop')?.getAttribute('src')).toBe('http://host/w2.jpg');
      expect(Array.from(container.querySelectorAll('.catalog-hero-meta .catalog-fact')).map((el) => el.textContent)).toEqual(['8.1', '2021', 'Drama']);
      expect(container.querySelector('.catalog-hero-plot')?.textContent).toBe('A series plot.');
    });

    describe('Continue Watching episode', () => {
      const entry = (extra: Record<string, unknown> = {}) => ({
        accountId: 'x1', kind: 'episode', itemId: 'e2', name: 'Series Two — S2E5 — Episode Five',
        poster: 'http://host/still.jpg', ext: 'mkv', position: 300, duration: 600, updatedAt: 1,
        categoryId: '1', watchlistOwner: { kind: 'series', itemId: 's2' }, ...extra,
      });

      it('shows the series, the episode and its still in the hero when focused', async () => {
        storageMock.getResumeList.mockReturnValue([entry()]);
        catalogMock.loadSeriesInfo.mockResolvedValue(info({ backdrop: 'http://host/w2.jpg' }));
        await openWith([{ id: '1', name: 'Cat A' }], [s1, s2]);
        await settle();
        hover('.catalog-tile[data-resume-episode="e2"]');
        vi.advanceTimersByTime(500);
        await settle();
        expect(title()).toBe('Series Two');
        expect(container.querySelector('.catalog-hero-episode-name')?.textContent).toBe('S2E5 · Episode Five');
        expect(container.querySelector<HTMLElement>('.catalog-hero-episode-progress .episode-progress-fill')?.style.width).toBe('50%');
        expect(container.querySelector('.catalog-hero-backdrop')?.getAttribute('src')).toBe('http://host/still.jpg');
      });

      it('falls back to the series art when the episode has no still of its own', async () => {
        storageMock.getResumeList.mockReturnValue([entry({ poster: 'http://host/a2.jpg' })]);
        catalogMock.loadSeriesInfo.mockResolvedValue(info({ backdrop: 'http://host/w2.jpg' }));
        await openWith([{ id: '1', name: 'Cat A' }], [s1, s2]);
        await settle();
        hover('.catalog-tile[data-resume-episode="e2"]');
        vi.advanceTimersByTime(500);
        await settle();
        expect(title()).toBe('Series Two');
        expect(container.querySelector('.catalog-hero-backdrop')?.getAttribute('src')).toBe('http://host/w2.jpg');
      });

      it('splits the card into series and episode lines with a progress bar', async () => {
        storageMock.getResumeList.mockReturnValue([entry()]);
        catalogMock.loadSeriesInfo.mockResolvedValue(info());
        await openWith([{ id: '1', name: 'Cat A' }], [s1, s2]);
        const tile = container.querySelector('.catalog-tile[data-resume-episode="e2"]')!;
        expect(tile.querySelector('.catalog-tile-name')?.textContent).toBe('Series Two');
        expect(tile.querySelector('.catalog-tile-episode')?.textContent).toBe('S2E5 · Episode Five');
        expect(tile.querySelector<HTMLElement>('.catalog-tile-progress-fill')?.style.width).toBe('50%');
      });

      it('draws no progress bar for a next episode not started yet', async () => {
        storageMock.getResumeList.mockReturnValue([entry({ position: 0, duration: 0 })]);
        catalogMock.loadSeriesInfo.mockResolvedValue(info());
        await openWith([{ id: '1', name: 'Cat A' }], [s1, s2]);
        expect(container.querySelector('.catalog-tile[data-resume-episode="e2"] .catalog-tile-progress')).toBeNull();
      });
    });

    it('plays the first episode when nothing was started', async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue(info());
      const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [s1]);
      await settle();
      const play = container.querySelector<HTMLElement>('[data-hero-action="play"]')!;
      expect(play.textContent).toContain('Play');
      hover('[data-hero-action="play"]');
      view.handleAction('select');
      await settle();
      expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
        itemId: 'e1', kind: 'episode', parentalItemId: 's1', resumeSecs: 0,
        episodeQueue: [expect.objectContaining({ itemId: 'e2' })],
      }));
    });

    it('resumes the episode the series was left on', async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue(info());
      storageMock.getResumeList.mockReturnValue([{
        accountId: 'x1', kind: 'episode', itemId: 'e2', name: 'Series One — S1E2', poster: '', ext: 'mkv',
        position: 300, duration: 600, updatedAt: 1, watchlistOwner: { kind: 'series', itemId: 's1' },
      }]);
      const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [s1]);
      expect(container.querySelector('[data-hero-action="play"]')?.textContent).toContain('Resume');
      hover('[data-hero-action="play"]');
      view.handleAction('select');
      expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'e2', resumeSecs: 300 }));
    });

    it('opens on the last watched series instead of the first listed', async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue(info());
      storageMock.getResumeList.mockReturnValue([{
        accountId: 'x1', kind: 'episode', itemId: 'e2', name: 'Series Two — S1E2', poster: '', ext: 'mkv',
        position: 300, duration: 600, updatedAt: 1, categoryId: '1', watchlistOwner: { kind: 'series', itemId: 's2' },
      }]);
      await openWith([{ id: '1', name: 'Cat A' }], [s1, s2]);
      expect(title()).toBe('Series Two');
      expect(container.querySelector('[data-hero-action="play"]')?.textContent).toContain('Resume');
    });

    it('opens the detail when the series has no episodes to play', async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue(info({ seasons: [], episodesBySeason: {} }));
      const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [s1]);
      hover('[data-hero-action="play"]');
      view.handleAction('select');
      await settle();
      expect(handlers.onPlayVod).not.toHaveBeenCalled();
      expect(container.querySelector('.series-detail .detail-title')?.textContent).toBe('Series One');
    });
  });

  describe('episode stills', () => {
    const openDetailWith = async (episodes: unknown[], resume: unknown = null) => {
      catalogMock.loadSeriesInfo.mockResolvedValue({
        plot: '', cast: '', director: '', genre: '', releaseDate: '', episodeRunTimeMins: 0,
        poster: '', rating: '', imdbId: '', tmdbId: '', year: 0,
        seasons: [1], episodesBySeason: { 1: episodes },
      });
      storageMock.getResume.mockImplementation(((_a: string, _k: string, id: string) =>
        (id === 'e1' ? resume : null)) as never);
      const { view } = await openWith();
      container.querySelector('.catalog-tile[data-item-id="s1"]')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      view.handleAction('select');
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      return view;
    };
    const episode = (id: string, poster: string) => ({
      id, title: `Episode ${id}`, season: 1, episode: 1, containerExtension: 'mp4',
      durationSecs: 600, plot: '', poster, subtitles: [],
    });

    it('shows a still with the play badge and resume progress over it', async () => {
      await openDetailWith([episode('e1', 'http://host/still1.jpg')], { position: 150, duration: 600 });
      const row = container.querySelector('.episode-row[data-episode-id="e1"]')!;
      const img = row.querySelector('.episode-thumb img.episode-thumb-img')!;
      expect(img.getAttribute('src') ?? img.getAttribute('data-lazy-src')).toBe('http://host/still1.jpg');
      expect(row.querySelector('.episode-thumb .episode-thumb-play svg')).not.toBeNull();
      expect(row.querySelector<HTMLElement>('.episode-progress-fill')?.style.width).toBe('25%');
      expect(row.querySelector('.episode-badge')).toBeNull();
      expect(row.closest('[data-lazy-root]')?.classList.contains('series-detail')).toBe(true);
    });

    it('keeps the plain badge row without a still', async () => {
      await openDetailWith([episode('e1', '')]);
      const row = container.querySelector('.episode-row[data-episode-id="e1"]')!;
      expect(row.querySelector('.episode-thumb')).toBeNull();
      expect(row.querySelector('.episode-badge svg')).not.toBeNull();
    });
  });

  it('drops a category prefix the provider puts on every category', async () => {
    const cats = [{ id: '1', name: 'Serie ∤ Alpha' }, { id: '2', name: 'Serie ∤ Bravo Max' }];
    catalogMock.loadSeriesInfo.mockResolvedValue(null);
    await openWith(cats, [series('s1', 'Series One')]);
    const titles = Array.from(container.querySelectorAll('.catalog-rail-title')).map((el) => el.textContent);
    expect(titles).toEqual(['Alpha', 'Bravo Max']);
  });

  it('shows a Continue rail from the episode resume list and resumes an episode directly', async () => {
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One — S1E1 — Episode One', poster: '', ext: 'mkv', position: 300, duration: 1500, updatedAt: 1 },
    ]);
    const { view, handlers } = await openWith();
    expect(container.textContent).toContain('Continue Watching');
    const tile = container.querySelector('.catalog-tile[data-resume-episode="e1"]') as HTMLElement;
    expect(tile).not.toBeNull();
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e1', accountId: 'x1', kind: 'episode', resumeSecs: 300,
      url: 'http://host:8080/series/u/p/e1.mkv',
    }));
  });

  it('shows a Watchlist rail from stored series snapshots', async () => {
    watchlistState.entries = [{
      accountId: 'x1', kind: 'series', itemId: 's9', name: 'Saved Series',
      poster: '', rating: '', categoryId: '9', addedAt: 2,
    }];
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith();
    expect(container.textContent).toContain('Watchlist');
    const tile = container.querySelector('.catalog-tile[data-item-id="s9"]') as HTMLElement;
    expect(tile.textContent).toContain('Saved Series');
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.series-detail')?.textContent).toContain('Saved Series');
  });

  it('reveals the tab bar when Up cannot move within the view', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('up');
    expect(handlers.onRevealTabBar).toHaveBeenCalled();
  });

  it('drills into a non-rail category grid and back to browse', async () => {
    // 7 categories: the first RAIL_CATEGORIES (6) become poster rails; the 7th
    // is a non-rail tile in the "All Categories" rail — the drill-in target.
    const cats = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i + 1}` }));
    const { view, handlers } = await openWith(cats, [series('s1', 'Series One')]);
    const cat = container.querySelector('.catalog-cat[data-category-id="7"]') as HTMLElement;
    expect(cat).not.toBeNull();
    cat.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    catalogMock.loadSeries.mockResolvedValue([series('s2', 'Series Two', '7')]);
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.catalog-grid')).not.toBeNull();
    expect(container.querySelector('.catalog-tile[data-item-id="s2"]')).not.toBeNull();
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    expect(handlers.onBack).not.toHaveBeenCalled();
  });

  it('opens a series detail on select and backs out to browse', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view, handlers } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="s1"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('Series One');
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    expect(handlers.onBack).not.toHaveBeenCalled();
  });

  it('returns from a removed Watchlist series to its rail neighbor, not its category twin', async () => {
    const saved = (id: string, addedAt: number): WatchlistEntry => ({
      accountId: 'x1', kind: 'series', itemId: id, name: `Series ${id}`, poster: '',
      rating: '', categoryId: '1', addedAt,
    });
    watchlistState.entries = [saved('s0', 3), saved('s1', 2), saved('s2', 1)];
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith(
      [{ id: '1', name: 'Cat A' }],
      [series('s0', 'Series s0'), series('s1', 'Series s1'), series('s2', 'Series s2')],
    );
    const watchlist = container.querySelector('[data-rail-key="watchlist"]')!;
    watchlist.querySelector('[data-item-id="s1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    container.querySelector('[data-action="watchlist"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    view.handleAction('back');

    const focused = container.querySelector<HTMLElement>('.catalog-browse .focused');
    expect(focused?.closest('[data-rail-key]')?.getAttribute('data-rail-key')).toBe('watchlist');
    expect(focused?.dataset.itemId).toBe('s2');
  });

  it('goes back to Live from the browse top level', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('back');
    expect(handlers.onBack).toHaveBeenCalled();
  });

  it('refreshes the Continue rail from storage on each browse render', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith();
    expect(container.textContent).not.toContain('Continue Watching');
    // An episode is watched, so a resume entry now exists; walking detail -> browse
    // should surface it without re-entering the section.
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One — S1E1', poster: '', ext: 'mp4', position: 300, duration: 1500, updatedAt: 1 },
    ]);
    const tile = container.querySelector('.catalog-tile[data-item-id="s1"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    view.handleAction('back'); // detail -> browse re-render
    expect(container.textContent).toContain('Continue Watching');
  });
});

const SERIES_INFO = {
  plot: 'Series plot.',
  cast: 'Actor 1, Actor 2',
  director: 'Director 1',
  genre: 'Drama',
  releaseDate: '2021-02-03',
  episodeRunTimeMins: 45,
  poster: 'http://host/series.jpg',
  rating: '8.4',
  imdbId: '1234567',
  tmdbId: '7654',
  year: 2021,
  seasons: [1, 2],
  episodesBySeason: {
    1: [{ id: 'e1', title: 'Episode One', season: 1, episode: 1, containerExtension: 'mp4', durationSecs: 1500, plot: 'Ep plot.', poster: '' }],
    2: [{ id: 'e2', title: 'Episode Two', season: 2, episode: 1, containerExtension: 'mkv', durationSecs: 1600, plot: '', poster: '' }],
  },
};

async function openDetail(view: Series) {
  const tile = container.querySelector('.catalog-tile[data-item-id="s1"]') as HTMLElement;
  tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  view.handleAction('select');
  await Promise.resolve(); await Promise.resolve(); // info-less render, then the loaded render
}

describe('Series detail', () => {
  it('renders a bounded episode window for a 50,000-item season', async () => {
    const episodes = Array.from({ length: 50_000 }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Episode ${String(index)}`,
      season: 1,
      episode: index + 1,
      containerExtension: 'mp4',
      durationSecs: 1500,
      plot: '',
      poster: '',
      subtitles: [],
    }));
    catalogMock.loadSeriesInfo.mockResolvedValue({
      seasons: [1],
      episodesBySeason: { 1: episodes },
    });
    const { view } = await openWith();
    await openDetail(view);

    expect(container.querySelectorAll('.episode-row').length).toBeLessThan(20);
    expect(container.querySelector<HTMLElement>('.series-episodes-spacer')?.style.height)
      .toBe('6900000px');

    const detail = container.querySelector<HTMLElement>('.series-detail')!;
    detail.scrollTop = 100 * 138;
    detail.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const episode = container.querySelector<HTMLElement>(
      '[data-episode-index="100"] .episode-row',
    )!;
    episode.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

    view.refreshPlaybackState();
    Focus.flush();

    expect(container.querySelector<HTMLElement>('.focused')?.dataset.key).toBe('ep:e100');
  });

  it('brings in an episode the list scrolled away instantly when a held key reaches it', async () => {
    const episodes = Array.from({ length: 500 }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Episode ${String(index)}`,
      season: 1,
      episode: index + 1,
      containerExtension: 'mp4',
      durationSecs: 1500,
      plot: '',
      poster: '',
      subtitles: [],
    }));
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [1], episodesBySeason: { 1: episodes } });
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { view } = await openWith();
      await openDetail(view);
      const detail = container.querySelector<HTMLElement>('.series-detail')!;
      const keyOf = (index: number): string => {
        const row = container.querySelector<HTMLElement>(`[data-episode-index="${String(index)}"] [data-key]`)!;
        const rail = row.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey ?? '';
        return JSON.stringify(['detail', rail, row.dataset.key]);
      };
      const first = keyOf(0);
      view.focusScope.focus(keyOf(1), 'key');
      Focus.flush();

      let top = 0;
      const behaviors: string[] = [];
      Object.defineProperty(detail, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => { top = value; behaviors.push(detail.style.scrollBehavior); },
      });
      top = 100 * 138;
      detail.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(container.querySelector('[data-episode-index="0"]')).toBeNull();
      behaviors.length = 0;

      view.focusScope.focus(first, 'key');
      Focus.flush();

      expect(container.querySelector('[data-episode-index="0"]')).not.toBeNull();
      expect(behaviors.length).toBeGreaterThan(0);
      expect(behaviors).toEqual(behaviors.map(() => 'auto'));
    } finally {
      clock.mockRestore();
    }
  });

  it('scrolls smoothly again when a later input reveals the same episode a held key reached', async () => {
    const episodes = Array.from({ length: 500 }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Episode ${String(index)}`,
      season: 1,
      episode: index + 1,
      containerExtension: 'mp4',
      durationSecs: 1500,
      plot: '',
      poster: '',
      subtitles: [],
    }));
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [1], episodesBySeason: { 1: episodes } });
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { view } = await openWith();
      await openDetail(view);
      const detail = container.querySelector<HTMLElement>('.series-detail')!;
      const keyOf = (index: number): string => {
        const row = container.querySelector<HTMLElement>(`[data-episode-index="${String(index)}"] [data-key]`)!;
        const rail = row.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey ?? '';
        return JSON.stringify(['detail', rail, row.dataset.key]);
      };
      const first = keyOf(0);
      view.focusScope.focus(keyOf(1), 'key');
      Focus.flush();

      let top = 0;
      const behaviors: string[] = [];
      Object.defineProperty(detail, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => { top = value; behaviors.push(detail.style.scrollBehavior); },
      });
      const scrollAway = async (): Promise<void> => {
        top = 100 * 138;
        detail.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(container.querySelector('[data-episode-index="0"]')).toBeNull();
        behaviors.length = 0;
      };
      await scrollAway();
      now += 50;
      view.focusScope.focus(first, 'key');
      Focus.flush();
      expect(behaviors.length).toBeGreaterThan(0);
      expect(behaviors).toEqual(behaviors.map(() => 'auto'));

      for (let frame = 0; frame < 2; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      await scrollAway();
      now += 1_000;
      view.focusScope.focus(first, 'key');
      Focus.flush();

      expect(container.querySelector('[data-episode-index="0"]')).not.toBeNull();
      expect(behaviors.length).toBeGreaterThan(0);
      expect(behaviors).not.toContain('auto');
    } finally {
      clock.mockRestore();
    }
  });

  it('brings a scrolled-away episode fully in when its rows measure taller than estimated', async () => {
    const episodes = Array.from({ length: 500 }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Episode ${String(index)}`,
      season: 1,
      episode: index + 1,
      containerExtension: 'mp4',
      durationSecs: 1500,
      plot: '',
      poster: '',
      subtitles: [],
    }));
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [1], episodesBySeason: { 1: episodes } });
    const rect = Element.prototype.getBoundingClientRect;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (!this.classList.contains('episode-row')) return rect.call(this);
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 184, width: 0, height: 184, toJSON: () => ({}) };
    });
    try {
      const { view } = await openWith();
      await openDetail(view);
      const row = container.querySelector<HTMLElement>('[data-episode-index="0"] [data-key]')!;
      const rail = row.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey ?? '';
      expect(container.querySelector('[data-episode-index="40"]')).toBeNull();

      view.focusScope.focus(JSON.stringify(['detail', rail, 'ep:e40']), 'key');
      Focus.flush();

      const list = (view as unknown as {
        episodeVirtualizer: { scrollOffset: number; getItemOffset(index: number): number };
      }).episodeVirtualizer;
      const viewport = 984;
      expect(list.getItemOffset(41) - list.getItemOffset(40)).toBe(200);
      expect(list.getItemOffset(41)).toBeLessThanOrEqual(list.scrollOffset + viewport);
      expect(list.getItemOffset(40)).toBeGreaterThanOrEqual(list.scrollOffset);
      expect(container.querySelector<HTMLElement>('.series-detail')!.scrollTop).toBe(list.scrollOffset);
      expect(container.querySelector<HTMLElement>('.focused')?.dataset.key).toBe('ep:e40');
    } finally {
      spy.mockRestore();
    }
  });

  it('adds and removes the series from Watchlist without losing button focus', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view } = await openWith();
    await openDetail(view);

    const button = container.querySelector('[data-action="watchlist"]') as HTMLElement;
    button.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(storageMock.toggleWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'x1', kind: 'series', itemId: 's1', name: 'Series One',
    }));
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Remove from Watchlist');
    Focus.flush();
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Added to Watchlist');

    view.handleAction('select');
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Add to Watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Removed from Watchlist');
  });

  it('renders a season selector and the first season\'s episodes, and plays from the start', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view, handlers } = await openWith();
    await openDetail(view);

    expect(Array.from(container.querySelectorAll('.detail-meta .catalog-fact')).map((el) => el.textContent)).toEqual(['8.4', '2021', '45 min', 'Drama']);
    expect(container.querySelector('.detail-plot')?.textContent).toBe('Series plot.');
    expect(container.querySelectorAll('.detail-cast')[0]?.textContent)
      .toContain('Cast Actor 1, Actor 2');
    expect(container.querySelectorAll('.detail-cast')[1]?.textContent)
      .toContain('Director Director 1');
    expect(container.querySelector<HTMLImageElement>('.series-detail-poster img')?.src)
      .toBe('http://host/series.jpg');
    expect(container.querySelector('.series-season-btn[data-season="1"]')?.textContent).toContain('Season 1');
    expect(container.querySelector('.series-season-btn[data-season="2"]')).not.toBeNull();
    expect(container.querySelector('.episode-row[data-episode-id="e1"]')?.textContent).toContain('Episode One');
    expect(container.textContent).toContain('Ep plot.');

    const row = container.querySelector('.episode-row[data-episode-id="e1"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e1', accountId: 'x1', kind: 'episode', resumeSecs: 0,
      url: 'http://host:8080/series/u/p/e1.mp4',
      title: expect.stringContaining('S1E1'),
      watchlistOwner: { kind: 'series', itemId: 's1' },
      episodeQueue: [
        expect.objectContaining({
          itemId: 'e2',
          url: 'http://host:8080/series/u/p/e2.mkv',
          title: expect.stringContaining('S2E1'),
          watchlistOwner: { kind: 'series', itemId: 's1' },
        }),
      ],
    }));
  });

  it('renders the normalized year when no release date is available', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({
      ...SERIES_INFO,
      releaseDate: '',
      year: 2022,
    });
    const { view } = await openWith();
    await openDetail(view);

    expect(Array.from(container.querySelectorAll('.detail-meta .catalog-fact')).map((el) => el.textContent)).toEqual(['8.4', '2022', '45 min', 'Drama']);
  });

  it('switches season and plays that season\'s episode with its own container extension', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view, handlers } = await openWith();
    await openDetail(view);

    const season2 = container.querySelector('.series-season-btn[data-season="2"]') as HTMLElement;
    season2.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(container.querySelector('.episode-row[data-episode-id="e2"]')).not.toBeNull();
    expect(container.querySelector('.episode-row[data-episode-id="e1"]')).toBeNull();

    const row = container.querySelector('.episode-row[data-episode-id="e2"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e2', kind: 'episode', url: 'http://host:8080/series/u/p/e2.mkv',
    }));
  });

  it('marks an episode with a resume point and passes its saved position', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    storageMock.getResume.mockImplementation((_a: string, _k: string, id: string) =>
      id === 'e1' ? { accountId: 'x1', kind: 'episode', itemId: 'e1', name: '', poster: '', position: 450, duration: 1500, updatedAt: 1 } : null);
    const { view, handlers } = await openWith();
    await openDetail(view);

    expect(container.querySelector('.episode-row[data-episode-id="e1"] .episode-resume')).not.toBeNull();
    const row = container.querySelector('.episode-row[data-episode-id="e1"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'e1', resumeSecs: 450 }));
  });

  it('restores the remaining episode queue from Continue Watching', async () => {
    const next = {
      url: 'http://host:8080/series/u/p/e2.mkv', title: 'Series One — S2E1 — Episode Two',
      poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode', subtitles: [],
    };
    storageMock.getResumeList.mockReturnValue([
      {
        accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One — S1E1',
        poster: '', ext: 'mp4', position: 450, duration: 1500, updatedAt: 1,
        episodeQueue: [next],
        watchlistOwner: { kind: 'series', itemId: 's1' },
      },
    ]);
    const { view, handlers } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-resume-episode="e1"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      episodeQueue: [next],
      watchlistOwner: { kind: 'series', itemId: 's1' },
    }));
  });

  it('shows an empty state when the series has no seasons', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('No episodes available');
  });

  it('shows a failed state instead of a perpetual Loading when info is null', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(null);
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('Unable to load episodes.');
    expect(container.textContent).not.toContain('Loading…');
  });
});

describe('Series deep-link (openItem)', () => {
  it('opens a series detail directly and Back returns to Search via the callback', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
    const onDetailBack = vi.fn();
    const view = new Series(container, handlers);
    Focus.setBase(() => view.focusScope);
    await view.openItem(account, series('s9', 'Deep Series', '9'), onDetailBack);
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('Deep Series');
    expect(container.querySelector('.catalog-browse')).toBeNull();
    const logs = vi.spyOn(console, 'log');
    view.handleAction('back');
    Focus.flush();
    expect(eventLines(logs, 'nav.focus.repaired')).toEqual([]);
    logs.mockRestore();
    expect(onDetailBack).toHaveBeenCalledTimes(1);
    expect(handlers.onBack).not.toHaveBeenCalled();
  });
});

describe('Series catalog fill indicator', () => {
  it('shows progress for the series catalog only, and drops it when done', async () => {
    await openWith();
    const fillChanged = catalogMock.onCatalogFillChanged.mock.calls[0][0] as
      (accountId: string, resource: string) => void;
    catalogMock.getCatalogFill.mockReturnValue({ done: 12, total: 35 });
    fillChanged('x1', 'vod_all');
    expect(container.querySelector('.catalog-fill')).toBeNull();
    fillChanged('x1', 'series_all');
    expect(container.querySelector('.catalog-fill')?.textContent).toBe('Loading catalog… 12/35');
    expect(container.querySelector('.catalog-tile')).not.toBeNull();
    catalogMock.getCatalogFill.mockReturnValue(null);
    fillChanged('x1', 'series_all');
    expect(container.querySelector('.catalog-fill')).toBeNull();
  });
});
