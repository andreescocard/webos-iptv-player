import type {
  Action,
  PlaylistEntry,
  ResumeEntry,
  ResumeKind,
  VodPlayback,
  WatchlistEntry,
  WatchlistKind,
} from '../types';
import { SpatialNav, isFocusMove } from '../navigation/spatial-nav';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { FocusRing, ringShown } from '../navigation/focus-ring';
import { InputMode } from '../navigation/input-mode';
import { html, raw, Safe, withInstantScroll } from '../utils/dom';
import { categoryLockBadge, lockBadge } from './parental-badge';
import { SEE_ALL_ICON } from './icons';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import {
  catalogParentalRequest,
  isResumeConcealed,
  isWatchlistConcealed,
  ParentalControlService,
} from '../services/parental-control';
import { getCatalogFill, onCatalogFillChanged } from '../services/xtream-catalog';
import { CONFIG } from '../config';
import { t } from '../i18n';
import { VirtualGrid } from '../utils/virtual-grid';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { createLogger } from '../utils/logger';

const log = createLogger('Catalog');

const CATALOG_GRID_COLUMN_STRIDE = 244;
const CATALOG_GRID_ROW_STRIDE = 395;
const CATALOG_GRID_OVERSCAN_ROWS = 2;
const CATALOG_GRID_VIEWPORT_WIDTH = 1760;
const CATALOG_GRID_VIEWPORT_HEIGHT = 900;
const CATEGORY_RAIL_STRIDE = 320;
const CATEGORY_RAIL_VIEWPORT = 1760;
const GRID_SNAP_DELAY_MS = 95;

// Matches the rail track's padding and its end spacer in catalog-view.css.
const RAIL_EDGE_GUTTER = 12;

export interface CatalogHandlers {
  onRevealTabBar: () => void;
  onBack: () => void;
  onPlayVod: (req: Omit<VodPlayback, 'onBack'>) => void;
}

type Mode = 'browse' | 'grid' | 'detail';

interface BrowseReturn {
  el: HTMLElement;
  railKey: string;
  index: number;
}

// Tile keys repeat across rails (a resumed title is also in its category) and
// detail buttons across items, so a focus key names the mode and rail too.
interface CatalogKey {
  mode: Mode;
  rail: string;
  key: string;
}

function parseKey(key: string | null): CatalogKey | null {
  if (key === null) return null;
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 3) return null;
    const [mode, rail, item] = parts as unknown[];
    if (mode !== 'browse' && mode !== 'grid' && mode !== 'detail') return null;
    if (typeof rail !== 'string' || typeof item !== 'string') return null;
    return { mode, rail, key: item };
  } catch {
    return null;
  }
}

function isScroller(overflow: string): boolean {
  return overflow === 'auto' || overflow === 'scroll';
}

// Shared browse/grid/detail machinery for the Xtream catalog sections (Movies,
// Series): a hero + poster rails browse view, a per-category poster grid, and a
// detail screen. One focus scope holds the focused tile or button across all
// modes, and a SpatialNav only picks the next one geometrically. Up at the top
// row hands off to the tab bar; Back walks detail -> grid -> browse -> Live.
// Each mode renders into its own stacked layer. Browse stays resident (hidden,
// not rebuilt) while a grid or detail is open, so Back finds its rails, scroll
// positions, and focused tile exactly as they were.
// Subclasses supply the catalog loaders, item accessors, and the detail
// rendering / playback specifics.
export abstract class CatalogView<C extends { id: string; name: string }, I> {
  protected nav: SpatialNav;
  protected account: PlaylistEntry | null = null;
  protected mode: Mode = 'browse';
  protected categories: C[] = [];
  protected railGroups: { category: C; items: I[] }[] = [];
  protected resume: ResumeEntry[] = [];
  protected itemsByCategory: Record<string, I[]> = {};
  protected gridCategory: C | null = null;
  protected deepLinkBack: (() => void) | null = null;
  private gridFocusIndex = 0;
  // The browse tile that opened a grid or detail, refocused on Back.
  private readonly gridVirtualizer = new VirtualGrid({
    columnStride: CATALOG_GRID_COLUMN_STRIDE,
    rowStride: CATALOG_GRID_ROW_STRIDE,
    overscanRows: CATALOG_GRID_OVERSCAN_ROWS,
    fallbackViewportWidth: CATALOG_GRID_VIEWPORT_WIDTH,
    fallbackViewportHeight: CATALOG_GRID_VIEWPORT_HEIGHT,
  });
  private gridScrollFrame: number | null = null;
  private readonly categoryVirtualizer = new VirtualList({
    itemSize: CATEGORY_RAIL_STRIDE,
    overscan: 4,
    fallbackViewportSize: CATEGORY_RAIL_VIEWPORT,
  });
  private categoryScrollFrame: number | null = null;
  protected readonly scrollGuard = new VirtualScrollGuard();
  private gridSnapTimer: ReturnType<typeof setTimeout> | null = null;
  private requestController: AbortController | null = null;
  private readonly layers: Record<Mode, HTMLElement>;
  private browseReturn: BrowseReturn | null = null;
  private gridRequest = 0;
  private browseStale = false;
  // False while the first browse render is still loading, so a fill tick can't paint it early.
  private browseRendered = false;
  readonly focusScope: FocusScope;
  // How the element SpatialNav is picking was asked for; null only follows it.
  private pickVia: Via | null = null;
  private lastRevealKey: string | null = null;
  private lastRevealAt = 0;
  private lastRevealInstant = false;

  constructor(protected container: HTMLElement, protected handlers: CatalogHandlers) {
    const layer = (mode: Mode): HTMLElement => {
      const el = document.createElement('div');
      el.className = `catalog-layer catalog-layer-${mode}`;
      if (mode !== 'browse') el.classList.add('catalog-layer-hidden');
      container.appendChild(el);
      return el;
    };
    this.layers = { browse: layer('browse'), grid: layer('grid'), detail: layer('detail') };
    this.nav = new SpatialNav(container, (el) => this.onFocusChanged(el), { follow: false });
    this.nav.setRestrict(this.layers.browse);
    this.focusScope = Focus.register({
      id: `${this.scopeName()}.catalog`,
      root: container,
      leaveFor: { up: 'tabbar' },
      defaultKey: () => this.defaultKey(),
      resolve: (key) => this.resolveKey(key),
      has: (key) => this.hasKey(key),
      reveal: (key) => this.revealKey(key),
      concealOnLeave: true,
    });
    // The pointer lights a tile or button where it rests, without scrolling.
    this.container.addEventListener('nav:hover', (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.hasAttribute('data-focusable') || !this.layers[this.mode].contains(target)) return;
      this.place(target, 'pointer');
    });
    // A ring the pointer left stays off; the next key only shows it again.
    this.container.addEventListener('nav:unhover', (e: Event) => {
      if (e.target === this.current()) this.focusScope.conceal();
    });
    onCatalogFillChanged((accountId, resource) => {
      if (this.account?.id !== accountId || resource !== this.fillResource()) return;
      if (this.browseRendered && this.mode === 'browse') this.renderBrowse(false);
    });
    this.container.addEventListener('scroll', (event: Event) => {
      const target = event.target as HTMLElement;
      if (this.handleExtraScroll(target)) return;
      if (this.mode === 'browse' && target.classList.contains('catalog-category-rail')) {
        const offset = this.scrollGuard.readUserOffset(target, 'horizontal');
        if (offset === null) return;
        this.categoryVirtualizer.setScrollOffset(offset);
        if (this.categoryScrollFrame === null) {
          this.categoryScrollFrame = requestAnimationFrame(() => {
            this.categoryScrollFrame = null;
            if (this.mode === 'browse') this.renderBrowse(false);
          });
        }
        return;
      }
      if (this.mode !== 'grid' || !target.classList.contains('catalog-grid')) return;
      const scrollTop = this.scrollGuard.readUserOffset(target, 'vertical');
      if (scrollTop === null) return;
      const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, scrollTop - this.gridTrackStart(target, track)),
      );
      this.scheduleGridSnap(target);
      if (this.gridScrollFrame !== null) return;
      this.gridScrollFrame = requestAnimationFrame(() => {
        this.gridScrollFrame = null;
        if (this.mode === 'grid') this.renderGrid(false);
      });
    }, true);
  }

  // --- subclass configuration ---
  // The focus scope's prefix, e.g. 'movies'; a method, as the constructor reads it.
  protected abstract scopeName(): string;
  protected abstract readonly kicker: string;             // hero/grid label, e.g. 'Movies'
  protected abstract readonly resumeKind: ResumeKind;     // which resume entries this section owns
  protected abstract readonly emptyMessage: string;       // no catalog on the account
  protected abstract readonly gridEmptyMessage: string;   // empty category grid
  protected abstract loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<C[]>;
  protected abstract loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<I[]>;
  protected abstract itemId(item: I): string;
  protected abstract itemName(item: I): string;
  protected abstract itemPoster(item: I): string;
  protected abstract itemCategoryId(item: I): string;
  protected abstract itemCount(count: number): string;
  protected abstract readonly parentalKind: 'vod' | 'series';
  protected abstract openDetail(item: I): Promise<void>;
  protected abstract renderDetail(restoreFocus?: boolean): void;
  protected abstract clearDetail(): void;                 // drop detail state on deep-link back
  // Section-specific selects (play/resume/season/episode). Returns true if handled.
  protected abstract selectExtra(el: HTMLElement): boolean;
  protected moveExtraFocus(_action: Action): boolean { return false; }
  // A detail key the subclass virtualizes: whether it is still listed, and
  // bringing it into view (true when that scrolled, null when nothing had to).
  protected hasExtraKey(_key: string): boolean { return false; }
  protected revealExtraKey(_key: string, _instant: boolean): boolean | null | undefined {
    return undefined;
  }
  protected handleExtraScroll(_target: HTMLElement): boolean { return false; }
  protected onRequestSessionReset(): void {}
  // The Continue Watching rail (or '' when there is nothing to resume).
  protected abstract continueRail(): Safe | '';
  // The Watchlist rail (or '' when it is empty).
  protected abstract watchlistRail(): Safe | '';
  // A tile id that isn't in a loaded category (Continue/Watchlist); default none.
  protected fallbackItem(_id: string): I | null { return null; }
  // Hero when no rail item exists (Movies falls back to a resumed item); default none.
  protected heroFallback(): I | null { return null; }

  // The active mode's layer; hidden layers keep their DOM but never take focus.
  protected layer(mode: Mode = this.mode): HTMLElement {
    return this.layers[mode];
  }

  protected showLayer(mode: Mode): void {
    if (this.mode === 'browse' && mode !== 'browse') this.leaveBrowse();
    this.mode = mode;
    (Object.keys(this.layers) as Mode[]).forEach((key) => {
      this.layers[key].classList.toggle('catalog-layer-hidden', key !== mode);
    });
    this.nav.setRestrict(this.layers[mode]);
  }

  // Keys embed provider ids, so compare rather than build a selector from them.
  protected focusableByKey(root: HTMLElement, key: string): HTMLElement | null {
    return Array.from(root.querySelectorAll<HTMLElement>('[data-focusable][data-key]'))
      .find((el) => el.getAttribute('data-key') === key) ?? null;
  }

  protected clearLayer(mode: Mode): void {
    morph(this.layers[mode], html``);
  }

  // Detail entry for subclasses: remembers where browse focus was first.
  protected enterDetail(): void {
    this.showLayer('detail');
    // A new item's detail starts on its first button.
    this.focusScope.track(null);
  }

  // --- focus ---

  private keyFor(el: HTMLElement): string {
    const rail = el.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey ?? '';
    return JSON.stringify([this.mode, rail, el.getAttribute('data-key') ?? '']);
  }

  // The focused item's own data-key, while the focus belongs to the shown mode.
  protected focusedKey(): string | null {
    const parsed = parseKey(this.focusScope.focusKey);
    return parsed && parsed.mode === this.mode ? parsed.key : null;
  }

  // The element that holds the focus, if it is rendered in the shown mode.
  protected current(): HTMLElement | null {
    const key = this.focusScope.focusKey;
    return key === null ? null : this.resolveKey(key);
  }

  private resolveKey(key: string): HTMLElement | null {
    const parsed = parseKey(key);
    if (!parsed || parsed.mode !== this.mode) return null;
    const layer = this.layers[parsed.mode];
    const rail = parsed.rail
      ? Array.from(layer.querySelectorAll<HTMLElement>('[data-rail-key]'))
        .find((el) => el.dataset.railKey === parsed.rail) ?? null
      : layer;
    return rail ? this.focusableByKey(rail, parsed.key) : null;
  }

  private defaultKey(): string | null {
    const first = this.nav.first();
    return first ? this.keyFor(first) : null;
  }

  // Keys the virtualized grid, category rail, or episode list may not render.
  private hasKey(key: string): boolean {
    const parsed = parseKey(key);
    if (!parsed || parsed.mode !== this.mode) return false;
    if (parsed.mode === 'grid') return this.gridIndexOf(parsed.key) >= 0;
    if (parsed.mode === 'browse') {
      return parsed.rail === 'all-categories' && this.categoryIndexOf(parsed.key) >= 0;
    }
    return this.hasExtraKey(parsed.key);
  }

  private gridIndexOf(key: string): number {
    const cat = this.gridCategory;
    const items = cat ? (this.itemsByCategory[cat.id] ?? []) : [];
    return items.findIndex((it) => `i:${this.itemCategoryId(it)}:${this.itemId(it)}` === key);
  }

  private categoryIndexOf(key: string): number {
    return this.categories.findIndex((c) => `c:${c.id}` === key);
  }

  // Keeps the focus in view; a virtualized list scrolls its window first.
  private revealKey(key: string): boolean | null {
    const parsed = parseKey(key);
    if (!parsed || parsed.mode !== this.mode) return null;
    const now = Date.now();
    if (key !== this.lastRevealKey) {
      // A held key steps instantly, so the focus never outruns its scroll.
      this.lastRevealInstant = this.lastRevealAt !== 0
        && now - this.lastRevealAt <= CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS;
      this.lastRevealKey = key;
      this.lastRevealAt = now;
    } else if (now - this.lastRevealAt > CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS) {
      // A later input that only reveals the same key scrolls smoothly again.
      this.lastRevealInstant = false;
    }
    const instant = this.lastRevealInstant;
    let scrolled = false;
    // The grid's window owns its scroll offset; it alone brings a cell in.
    if (parsed.mode === 'grid') return this.revealGridIndex(this.gridIndexOf(parsed.key)) ? true : null;
    if (parsed.mode === 'browse' && parsed.rail === 'all-categories') {
      scrolled = this.revealCategoryIndex(this.categoryIndexOf(parsed.key));
    } else if (parsed.mode === 'detail') {
      const extra = this.revealExtraKey(parsed.key, instant);
      if (extra !== undefined) return extra;
    }
    const el = this.resolveKey(key);
    if (el && this.revealElement(el, instant)) scrolled = true;
    return scrolled ? true : null;
  }

  // Compares against the window's recorded offset, not the live scrollTop,
  // which lags a smooth scroll the last step started. Past the scroll
  // guard's two frames, the rest of that scroll reads as a user scroll and
  // moves the recorded offset with it.
  private revealGridIndex(index: number): boolean {
    if (index < 0) return false;
    this.gridFocusIndex = index;
    const view = this.layers.grid.querySelector<HTMLElement>('.catalog-grid');
    const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
    if (!this.gridVirtualizer.ensureVisible(
      index,
      track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH,
      view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT,
    )) return false;
    this.renderGrid(false);
    return true;
  }

  private revealCategoryIndex(index: number): boolean {
    if (index < 0) return false;
    const rail = this.layers.browse.querySelector<HTMLElement>('.catalog-category-rail');
    if (!this.categoryVirtualizer.ensureVisible(index, rail?.clientWidth || CATEGORY_RAIL_VIEWPORT)) {
      return false;
    }
    this.renderBrowse(false);
    return true;
  }

  // Scrolls each scroller around `el` just enough to show it whole; a rail
  // tile also keeps a gutter beside it. True when anything scrolled.
  private revealElement(el: HTMLElement, instant: boolean): boolean {
    const r = el.getBoundingClientRect();
    let scrolled = false;
    for (let n = el.parentElement; n && n !== this.container; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (n === el.parentElement && n.classList.contains('catalog-rail-track')) {
        if (this.revealRailGutter(el, instant)) scrolled = true;
      }
      if (!isScroller(style.overflowY) || n.scrollHeight <= n.clientHeight) continue;
      const box = n.getBoundingClientRect();
      const top = box.top + n.clientTop;
      const bottom = top + n.clientHeight;
      let delta = 0;
      if (r.top < top) delta = r.top - top;
      else if (r.bottom > bottom) delta = Math.min(r.bottom - bottom, r.top - top);
      if (Math.abs(delta) < 1) continue;
      const target = n.scrollTop + delta;
      const scroller = n;
      if (instant) withInstantScroll([scroller], () => { scroller.scrollTop = target; });
      else scroller.scrollTop = target;
      scrolled = true;
    }
    return scrolled;
  }

  // Follows the element SpatialNav picked into the focus scope.
  protected place(el: HTMLElement | null, via: Via | null): void {
    this.pick(via, () => this.nav.focus(el));
  }

  private pick(via: Via | null, fn: () => void): void {
    const outer = this.pickVia;
    this.pickVia = via;
    try {
      fn();
    } finally {
      this.pickVia = outer;
    }
  }

  // How a render that settles focus on its own asks for it: in keys mode it
  // may bring it into view, otherwise it lights it where it is. Under a
  // surface that owns the keys it only follows the focus.
  private placementVia(): Via | null {
    if (Focus.owner() !== this.focusScope) return null;
    return InputMode.current === 'keys' ? 'key' : 'pointer';
  }

  // A focus request reaches the scope only while it owns the keys; otherwise
  // the scope just follows it, so no reveal waits for later.
  private request(key: string | null, via: Via | null): void {
    // A pointer request never reveals, so it may wait for the keys.
    if (via === 'pointer' && Focus.owner() !== this.focusScope) {
      this.focusScope.focus(key, via);
      return;
    }
    if (via === null || Focus.owner() !== this.focusScope) {
      this.focusScope.track(key);
      return;
    }
    this.focusScope.focus(key, via);
    Focus.flush();
  }

  // Detail info lands, or a button changes: keep a key that is still there,
  // else start on the first button. A button that vanished only moves the
  // key, so a ring the pointer hid stays hidden.
  protected settleDetailFocus(): void {
    if (this.current()) return;
    this.pick(this.focusScope.focusKey === null ? this.placementVia() : null, () => {
      if (!this.nav.focusFirst()) this.nav.focus(null);
    });
  }

  // Back into the section from the tab bar: the focus Up left, in view.
  resumeFocus(): void {
    this.focusScope.focus(this.focusScope.focusKey, 'resume');
  }

  // SpatialNav picks from where the scope's focus is, which a fallback may have moved.
  private syncNav(): void {
    const el = this.current();
    if (el && el !== this.nav.focused) this.place(el, null);
  }

  // After the pointer left, the first key only shows where focus is.
  private ringHidden(): boolean {
    const el = this.current();
    return !!el && Focus.owner() === this.focusScope && !FocusRing.deferred && !ringShown(el);
  }

  private leaveBrowse(): void {
    const el = this.current();
    if (!el || !this.layers.browse.contains(el)) return;
    const rail = el.closest<HTMLElement>('[data-rail-key]');
    const tiles = rail
      ? Array.from(rail.querySelectorAll<HTMLElement>('[data-focusable]'))
      : [];
    this.browseReturn = {
      el,
      railKey: rail?.dataset.railKey ?? '',
      index: Math.max(0, tiles.indexOf(el)),
    };
  }

  // Back lands on the tile browse was left from. A tile that is gone (e.g. a
  // title removed from the Watchlist) hands focus to its neighbor in the same
  // rail, and a rail that is gone falls back to the first tile.
  private restoreBrowseFocus(): void {
    const origin = this.browseReturn;
    this.browseReturn = null;
    const browse = this.layers.browse;
    const via = this.placementVia();
    if (origin && origin.el.isConnected && browse.contains(origin.el)) {
      this.place(origin.el, via);
      return;
    }
    // Rail keys embed provider category ids, so compare rather than build a selector.
    const rail = origin?.railKey
      ? Array.from(browse.querySelectorAll<HTMLElement>('[data-rail-key]'))
        .find((el) => el.dataset.railKey === origin.railKey) ?? null
      : null;
    const tiles = rail
      ? Array.from(rail.querySelectorAll<HTMLElement>('[data-focusable]'))
      : [];
    if (origin && tiles.length) {
      this.place(tiles[Math.min(origin.index, tiles.length - 1)], via);
      return;
    }
    this.place(this.nav.first(), via);
  }

  setAccount(account: PlaylistEntry): void {
    if (this.account?.id !== account.id) {
      this.requestController?.abort();
      this.onRequestSessionReset();
      this.nav.resetRecovery();
    }
    this.account = account;
  }

  protected get requestSignal(): AbortSignal | null {
    return this.requestController?.signal ?? null;
  }

  protected requestFailed(context: string, err: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    log.error(
      `${context} failed`,
      'event=xtream.view.load.failed',
      `operation=${context.toLowerCase().replace(/\s+/g, '_')}`,
      err,
    );
    return true;
  }

  private beginRequests(): AbortSignal {
    this.requestController?.abort();
    this.onRequestSessionReset();
    this.requestController = new AbortController();
    return this.requestController.signal;
  }

  refreshPlaybackState(): void {
    if (this.mode === 'detail') this.renderDetail();
  }

  deactivate(): void {
    this.requestController?.abort();
    this.requestController = null;
    this.onRequestSessionReset();
  }

  async open(account: PlaylistEntry): Promise<void> {
    const signal = this.beginRequests();
    this.account = account;
    this.deepLinkBack = null;
    this.browseReturn = null;
    this.browseStale = false;
    this.clearLayer('grid');
    this.clearLayer('detail');
    this.categories = [];
    this.railGroups = [];
    this.itemsByCategory = {};
    this.gridCategory = null;
    this.categoryVirtualizer.setScrollOffset(0);
    this.gridVirtualizer.setScrollOffset(0);
    this.resume = this.visibleResume(account.id);
    this.clearLayer('browse');
    this.browseRendered = false;
    this.renderLoading('browse');
    try {
      const categories = await this.loadCategories(account, signal);
      if (signal.aborted || this.account?.id !== account.id) return;
      this.categories = categories.filter(category => !ParentalControlService.isCategoryConcealed({
        kind: this.parentalKind === 'vod' ? 'vod-category' : 'series-category',
        accountId: account.id,
        categoryId: category.id,
      }));
      const railCats = this.categories.slice(0, CONFIG.XTREAM.RAIL_CATEGORIES);
      // Settle each rail on its own: one failing category must not blank the rest.
      const loaded = await Promise.all(
        railCats.map((c) => this.loadVisibleItems(account, c.id, signal).then(
          (items): I[] | null => items,
          (err: unknown): null => {
            if (!signal.aborted) {
              log.error(
                'Catalog rail load failed',
                'event=xtream.view.load.failed',
                'operation=rail',
                `mode=${this.parentalKind}`,
                err,
              );
            }
            return null;
          },
        )),
      );
      if (signal.aborted || this.account?.id !== account.id) return;
      const groups: { category: C; items: I[] }[] = [];
      railCats.forEach((category, i) => {
        const items = loaded[i];
        if (!items) return;
        this.itemsByCategory[category.id] = items;
        groups.push({ category, items: items.slice(0, CONFIG.XTREAM.RAIL_ITEMS) });
      });
      this.railGroups = groups;
      if (groups.length < railCats.length) {
        log.warn(
          'Catalog rails partially loaded',
          'event=xtream.view.rails.partial',
          `mode=${this.parentalKind}`,
          `kept=${String(groups.length)}`,
          `total=${String(railCats.length)}`,
        );
      }
      this.renderBrowse();
    } catch (err) {
      if (signal.aborted) return;
      log.error(
        'Catalog browse load failed',
        'event=xtream.view.load.failed',
        'operation=browse',
        err,
      );
      if (this.account?.id === account.id) this.renderBrowse();
    }
  }

  // Deep-link entry (from Search): open this item's detail directly. Back returns
  // to the caller via onDetailBack (no browse is loaded underneath).
  async openItem(account: PlaylistEntry, item: I, onDetailBack: () => void): Promise<void> {
    this.beginRequests();
    // Showing this detail; deep-link Back recomputes whether browse is stale.
    this.browseStale = false;
    if (this.account && this.account.id !== account.id
        && this.layers.browse.querySelector('.catalog-view')) {
      this.gridCategory = null;
      this.browseReturn = null;
      this.clearLayer('grid');
      morph(this.layers.browse, this.loadingMarkup());
    }
    this.account = account;
    this.deepLinkBack = onDetailBack;
    await this.openDetail(item);
  }

  // A Search deep link opens over whatever this section last showed. Put that
  // back, so showing the section again never lands on an empty detail layer.
  // A detail the deep link replaced is not restored: Back skips to its grid or
  // browse.
  private restoreBeneathDeepLink(): void {
    if (this.gridCategory && this.layers.grid.querySelector('.catalog-grid')) {
      this.renderGrid();
      return;
    }
    this.gridCategory = null;
    this.clearLayer('grid');
    if (this.layers.browse.querySelector('.catalog-browse')) {
      this.renderBrowse();
      return;
    }
    // The deep link aborted a browse load (or switched accounts). Reload it
    // only if the section is shown again (ensureLoaded), not behind Search.
    this.browseStale = !!this.layers.browse.querySelector('.catalog-loading');
    this.showLayer('browse');
    // Nothing to land on until browse loads; the detail's key is gone.
    if (parseKey(this.focusScope.focusKey)?.mode !== 'browse') this.focusScope.track(null);
  }

  // For re-showing the section without open(), e.g. when Search closes: reload
  // an interrupted browse, or one left on an account no longer active.
  ensureLoaded(account: PlaylistEntry | null): void {
    if (!account) return;
    if (!this.browseStale && this.account?.id === account.id) return;
    log.debug(
      'Catalog browse reloading',
      'event=xtream.view.reload',
      'operation=browse',
      `mode=${this.parentalKind}`,
      `reason=${this.browseStale ? 'stale' : 'account'}`,
    );
    void this.open(account);
  }

  // Search is closing over this section: drop a deep-linked detail it left
  // here and show what it opened over.
  leaveDeepLink(): void {
    if (!this.deepLinkBack) return;
    this.beginRequests();
    this.deepLinkBack = null;
    this.clearDetail();
    this.restoreBeneathDeepLink();
    this.clearLayer('detail');
  }

  handleAction(action: Action): void {
    this.syncNav();
    if (isFocusMove(action) && this.ringHidden()) {
      this.request(this.focusScope.focusKey, 'key');
      return;
    }
    this.pickVia = 'key';
    try {
      this.route(action);
    } finally {
      this.pickVia = null;
    }
  }

  private route(action: Action): void {
    if (this.moveExtraFocus(action)) return;
    if (this.mode === 'browse' && (action === 'left' || action === 'right')
        && this.moveCategoryFocus(action)) return;
    if (this.mode === 'grid'
        && (action === 'up' || action === 'down' || action === 'left' || action === 'right')) {
      if (this.moveGridFocus(action)) return;
      if (action === 'up') this.handlers.onRevealTabBar();
      return;
    }
    switch (action) {
      case 'up':
        if (!this.nav.move('up')) this.handlers.onRevealTabBar();
        return;
      case 'down':
      case 'left':
      case 'right':
        this.nav.move(action);
        return;
      case 'select':
        this.onSelect();
        return;
      case 'back':
        this.onBack();
        return;
      default:
        return;
    }
  }

  private onBack(): void {
    if (this.mode === 'detail') {
      this.clearDetail();
      if (this.deepLinkBack) {
        const back = this.deepLinkBack;
        this.deepLinkBack = null;
        this.restoreBeneathDeepLink();
        this.clearLayer('detail');
        back();
        return;
      }
      this.gridCategory ? this.renderGrid() : this.renderBrowse();
      this.clearLayer('detail');
      return;
    }
    if (this.mode === 'grid') {
      this.gridCategory = null;
      this.renderBrowse();
      this.clearLayer('grid');
      return;
    }
    this.handlers.onBack();
  }

  private onSelect(): void {
    const el = this.current();
    if (!el || !this.account) return;
    if (el.dataset.categoryId !== undefined
        && (el.classList.contains('catalog-cat') || el.classList.contains('catalog-see-all'))) {
      void this.openGrid(el.dataset.categoryId);
      return;
    }
    if (this.selectExtra(el)) return;
    if (el.dataset.itemId !== undefined) {
      const item = this.findItem(el.dataset.categoryId ?? '', el.dataset.itemId);
      if (item) void this.openDetail(item);
    }
  }

  // SpatialNav picked `el`: hand it to the scope, and keep the browse hero
  // (title + backdrop) in sync with the focused item tile. Category tiles and
  // non-browse modes leave the hero unchanged.
  private onFocusChanged(el: HTMLElement | null): void {
    this.request(el ? this.keyFor(el) : null, this.pickVia);
    const gridCell = el?.closest<HTMLElement>('[data-grid-index]');
    if (this.mode === 'grid' && gridCell?.dataset.gridIndex !== undefined) {
      this.gridFocusIndex = parseInt(gridCell.dataset.gridIndex, 10);
      return;
    }
    const categoryCell = el?.closest<HTMLElement>('[data-category-virtual-index]');
    if (this.mode === 'browse' && categoryCell) return;
    if (this.mode !== 'browse' || !el) return;
    const id = el.dataset.itemId;
    if (id === undefined) return;
    const item = this.findItem(el.dataset.categoryId ?? '', id);
    if (item) this.updateHero(this.itemName(item), this.itemPoster(item));
  }

  // A tile flush with the rail's scrollport would clip its focus ring; keep a
  // gutter visible beside it. True when the rail scrolled.
  private revealRailGutter(el: HTMLElement, instant: boolean): boolean {
    const track = el.parentElement;
    if (!track || !track.classList.contains('catalog-rail-track')) return false;
    const start = el.getBoundingClientRect().left - track.getBoundingClientRect().left
      - track.clientLeft + track.scrollLeft;
    const end = start + el.offsetWidth;
    const current = track.scrollLeft;
    let target: number;
    if (start - RAIL_EDGE_GUTTER < current) target = Math.max(0, start - RAIL_EDGE_GUTTER);
    else if (end + RAIL_EDGE_GUTTER > current + track.clientWidth) {
      target = end + RAIL_EDGE_GUTTER - track.clientWidth;
    } else return false;
    if (Math.abs(target - current) < 1) return false;
    // A tile already in view only needs an instant nudge; otherwise retarget
    // the running smooth scroll so it moves once.
    if (instant || (start >= current && end <= current + track.clientWidth)) {
      withInstantScroll([track], () => { track.scrollLeft = target; });
    } else {
      track.scrollLeft = target;
    }
    return true;
  }

  private updateHero(name: string, poster: string): void {
    const hero = this.layers.browse.querySelector<HTMLElement>('.catalog-hero');
    if (!hero) return;
    const title = this.layers.browse.querySelector<HTMLElement>('.catalog-hero-title');
    if (title) title.textContent = name; // textContent escapes untrusted names
    // Poster sits inside a CSS url('…') string; percent-encode the characters
    // that could break out of it (matches renderBrowse's heroBg).
    const bg = poster ? poster.replace(/["'()\\\s]/g, encodeURIComponent) : '';
    hero.style.backgroundImage = bg ? `url('${bg}')` : 'none';
  }

  // Concealed titles are dropped at load, so every rail, grid, and hero built
  // from these lists stays free of them without per-render checks.
  private async loadVisibleItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<I[]> {
    const items = await this.loadItems(account, categoryId, signal);
    if (!ParentalControlService.concealing) return items;
    return items.filter(item => !ParentalControlService.isConcealed(
      catalogParentalRequest(this.parentalKind, {
        accountId: account.id,
        categoryId: this.itemCategoryId(item) || categoryId,
        name: this.itemName(item),
        id: this.itemId(item),
      }),
    ));
  }

  private visibleResume(accountId: string): ResumeEntry[] {
    return StorageService.getResumeList(accountId)
      .filter(entry => entry.kind === this.resumeKind && !isResumeConcealed(entry));
  }

  protected visibleWatchlist(kind: WatchlistKind): WatchlistEntry[] {
    return StorageService.getWatchlist(this.account!.id, kind)
      .filter(entry => !isWatchlistConcealed(entry));
  }

  protected findItem(categoryId: string, id: string): I | null {
    const inCat = this.itemsByCategory[categoryId] ?? [];
    return inCat.find((x) => this.itemId(x) === id) ?? this.fallbackItem(id);
  }

  private async openGrid(categoryId: string): Promise<void> {
    if (!this.account) return;
    const account = this.account;
    const signal = this.requestSignal;
    if (!signal || signal.aborted) return;
    this.gridCategory = this.categories.find((c) => c.id === categoryId) ?? null;
    const request = ++this.gridRequest;
    this.clearLayer('grid');
    if (!this.itemsByCategory[categoryId]) {
      this.renderLoading('grid');
      try {
        this.itemsByCategory[categoryId] = await this.loadVisibleItems(
          account,
          categoryId,
          signal,
        );
      } catch (err) {
        if (signal.aborted) return;
        log.error(
          'Catalog category load failed',
          'event=xtream.view.load.failed',
          'operation=category',
          `mode=${this.parentalKind}`,
          err,
        );
      }
      if (signal.aborted || this.account?.id !== account.id) return;
      // Back (or another category) may have superseded this grid meanwhile.
      if (this.mode !== 'grid' || request !== this.gridRequest) {
        log.debug(
          'Catalog category load superseded',
          'event=xtream.view.load.superseded',
          'operation=category',
          `mode=${this.parentalKind}`,
          `reason=${this.mode !== 'grid' ? 'left' : 'replaced'}`,
        );
        return;
      }
      this.clearLayer('grid');
    }
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.renderGrid();
  }

  protected posterCell(name: string, poster: string): Safe {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  protected itemLockBadge(categoryId: string, id: string): Safe {
    return raw(lockBadge(ParentalControlService.lockState(
      catalogParentalRequest(this.parentalKind, {
        accountId: this.account?.id ?? '',
        categoryId,
        name: '',
        id,
      }),
    )));
  }

  // Lock badges follow the unlock session without changing what is listed.
  refreshLocks(): void {
    if (!this.layer().querySelector('.catalog-view')) return;
    if (this.mode === 'browse') this.renderBrowse(false);
    else if (this.mode === 'grid') this.renderGrid(false);
  }

  protected tile(item: I): Safe {
    const id = this.itemId(item);
    const cat = this.itemCategoryId(item);
    return html`
      <div class="catalog-tile" data-focusable data-key="i:${cat}:${id}"
           data-item-id="${id}" data-category-id="${cat}">
        <div class="catalog-poster-wrap">${this.posterCell(this.itemName(item), this.itemPoster(item))}${
          this.itemLockBadge(cat, id)}</div>
        <div class="catalog-tile-name">${this.itemName(item)}</div>
      </div>
    `;
  }

  // A rail shows the first RAIL_ITEMS titles; a trailing tile opens the full grid.
  private categoryRail(group: { category: C; items: I[] }): Safe {
    const id = group.category.id;
    const total = this.itemsByCategory[id]?.length ?? group.items.length;
    const tiles = group.items.map((it) => this.tile(it));
    if (total > group.items.length) {
      tiles.push(html`
        <div class="catalog-tile catalog-see-all" data-focusable data-key="all:${id}"
             data-category-id="${id}">
          <div class="catalog-poster-wrap catalog-see-all-card">
            ${raw(categoryLockBadge(this.parentalKind, this.account!.id, id))}
            ${raw(SEE_ALL_ICON)}
            <div class="catalog-see-all-label">${t('catalog.seeAll')}</div>
            <div class="catalog-see-all-count">${this.itemCount(total)}</div>
          </div>
        </div>
      `);
    }
    return this.rail(`cat:${id}`, group.category.name, tiles);
  }

  protected rail(key: string, title: string, items: Safe[]): Safe {
    return html`
      <div class="catalog-rail" data-key="rail:${key}" data-rail-key="${key}">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="catalog-rail-track">${items}</div>
      </div>
    `;
  }

  private loadingMarkup(): Safe {
    return html`
      <div class="catalog-view catalog-loading" data-nav-container>
        <p class="catalog-hint">${t('common.loading')}</p>
      </div>
    `;
  }

  private renderLoading(mode: Mode): void {
    this.showLayer(mode);
    // Drop focus from the hidden layer so OK can't reselect it meanwhile.
    this.place(null, this.placementVia());
    morph(this.layers[mode], this.loadingMarkup());
  }

  private fillResource(): 'vod_all' | 'series_all' {
    return this.parentalKind === 'vod' ? 'vod_all' : 'series_all';
  }

  // A passive status line: not focusable, so it never takes a ring or a key.
  private fillNote(): Safe | '' {
    const fill = getCatalogFill(this.account!.id, this.fillResource());
    if (!fill) return '';
    return html`<div class="catalog-fill" role="status">${fill.total
      ? t('catalog.loadingProgress', { done: fill.done, total: fill.total })
      : t('catalog.loadingCatalog')}</div>`;
  }

  protected renderBrowse(restoreFocus = true): void {
    this.browseRendered = true;
    this.showLayer('browse');
    const browse = this.layers.browse;
    this.resume = this.visibleResume(this.account!.id);
    const hero = this.railGroups[0]?.items[0] ?? this.heroFallback();
    const continueRail = this.continueRail();
    const watchlistRail = this.watchlistRail();
    const fillNote = this.fillNote();
    const hasContent = this.categories.length > 0 || !!continueRail || !!watchlistRail;
    // A poster URL sits inside a CSS url('…') string, where the html escaper's
    // entity encoding is decoded before CSS parses it; percent-encode the
    // characters that could break out of the string.
    const heroBg = hero ? this.itemPoster(hero).replace(/["'()\\\s]/g, encodeURIComponent) : '';
    // Once some categories have no rail, "All Categories" lists every category,
    // rails included, so it is the one complete index of the catalog.
    const moreCats = this.categories.length > this.railGroups.length ? this.categories : [];
    const previousCategoryRail = browse.querySelector<HTMLElement>('.catalog-category-rail');
    if (restoreFocus && previousCategoryRail) {
      this.categoryVirtualizer.setScrollOffset(previousCategoryRail.scrollLeft);
    }
    const categoryViewport = previousCategoryRail?.clientWidth || CATEGORY_RAIL_VIEWPORT;
    const categoryRange = this.categoryVirtualizer.getRange(moreCats.length, categoryViewport);

    morph(browse, html`
      <div class="catalog-view catalog-browse" data-nav-container>
        ${!hasContent
          ? html`<p class="catalog-hint catalog-empty">${
              fillNote ? t('catalog.loadingCatalog') : this.emptyMessage}</p>`
          : html`
            <div class="catalog-hero" style="background-image: url('${heroBg}')">
              <div class="catalog-hero-scrim"></div>
            </div>
            <div class="catalog-hero-body">
              <div class="catalog-hero-kicker">${this.kicker}</div>
              <h1 class="catalog-hero-title">${hero ? this.itemName(hero) : this.kicker}</h1>
              ${fillNote}
            </div>
            <div class="catalog-rails">
              <div class="catalog-rails-spacer"></div>
              <div class="catalog-rails-body">
                ${continueRail}
                ${watchlistRail}
                ${this.railGroups.map((r) => this.categoryRail(r))}
                ${moreCats.length ? html`
                  <div class="catalog-rail" data-key="rail:all-categories"
                       data-rail-key="all-categories">
                    <h2 class="catalog-rail-title">${t('catalog.allCategories')}</h2>
                    <div class="catalog-rail-track catalog-category-rail">
                      <div class="catalog-category-rail-spacer"
                           style="width:${this.categoryVirtualizer.getTotalSize(moreCats.length)}px">
                        ${moreCats.slice(categoryRange.start, categoryRange.end)
                          .map((c, offset) => {
                            const index = categoryRange.start + offset;
                            return html`
                              <div class="catalog-category-rail-cell"
                                   data-key="category-cell:${c.id}"
                                   data-category-virtual-index="${index}"
                                   style="left:${this.categoryVirtualizer.getItemOffset(index)}px">
                                <div class="catalog-cat" data-focusable
                                     data-key="c:${c.id}" data-category-id="${c.id}">${
                                  raw(categoryLockBadge(this.parentalKind, this.account!.id, c.id))
                                }${c.name}</div>
                              </div>
                            `;
                          })}
                      </div>
                    </div>
                  </div>
                ` : ''}
              </div>
            </div>
          `}
      </div>
    `);
    const categoryRail = browse.querySelector<HTMLElement>('.catalog-category-rail');
    if (categoryRail) {
      this.scrollGuard.syncOffset(
        categoryRail,
        'horizontal',
        this.categoryVirtualizer.scrollOffset,
      );
    }
    if (restoreFocus) this.restoreBrowseFocus();
  }

  protected renderGrid(restoreFocus = true): void {
    this.showLayer('grid');
    const gridLayer = this.layers.grid;
    const cat = this.gridCategory;
    const items = cat ? (this.itemsByCategory[cat.id] ?? []) : [];
    this.gridFocusIndex = Math.max(0, Math.min(this.gridFocusIndex, items.length - 1));
    const previousView = gridLayer.querySelector<HTMLElement>('.catalog-grid');
    const previousTrack = gridLayer.querySelector<HTMLElement>('.catalog-grid-track');
    if (restoreFocus && previousView) {
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, previousView.scrollTop - this.gridTrackStart(previousView, previousTrack)),
      );
    }
    const viewportWidth = previousTrack?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const viewportHeight = previousView?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
    if (restoreFocus && items.length) {
      this.gridVirtualizer.ensureVisible(this.gridFocusIndex, viewportWidth, viewportHeight);
    }
    const range = this.gridVirtualizer.getRange(items.length, viewportWidth, viewportHeight);
    morph(gridLayer, html`
      <div class="catalog-view catalog-grid" data-nav-container>
        <h1 class="catalog-grid-title">${cat ? cat.name : this.kicker}</h1>
        ${items.length === 0
          ? html`<p class="catalog-hint">${this.gridEmptyMessage}</p>`
          : html`
            <div class="catalog-grid-track"
                 style="height:${this.gridVirtualizer.getTotalSize(items.length, viewportWidth)}px">
              ${items.slice(range.start, range.end).map((it, offset) => {
                const index = range.start + offset;
                const position = this.gridVirtualizer.getItemPosition(index, range.columns);
                return html`
                  <div class="catalog-grid-cell"
                       data-key="grid:${this.itemId(it)}"
                       data-grid-index="${index}"
                       style="left:${position.left}px;top:${position.top}px">
                    ${this.tile(it)}
                  </div>
                `;
              })}
            </div>
          `}
      </div>
    `);
    const view = gridLayer.querySelector<HTMLElement>('.catalog-grid');
    const track = gridLayer.querySelector<HTMLElement>('.catalog-grid-track');
    const viewOffset = this.gridVirtualizer.scrollOffset === 0
      ? 0
      : this.gridVirtualizer.scrollOffset + this.gridTrackStart(view, track);
    if (view) this.scrollGuard.syncOffset(view, 'vertical', viewOffset);
    if (restoreFocus) {
      const focused = gridLayer.querySelector<HTMLElement>(
        `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
      );
      this.place(focused, this.placementVia());
    }
  }

  private moveGridFocus(direction: Action & ('up' | 'down' | 'left' | 'right')): boolean {
    const cat = this.gridCategory;
    const items = cat ? (this.itemsByCategory[cat.id] ?? []) : [];
    if (!items.length) return false;
    const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
    const view = this.layers.grid.querySelector<HTMLElement>('.catalog-grid');
    const viewportWidth = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const next = this.gridVirtualizer.getAdjacentIndex(
      this.gridFocusIndex,
      direction,
      items.length,
      viewportWidth,
    );
    if (next === this.gridFocusIndex) return false;
    this.gridFocusIndex = next;
    const viewportHeight = view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
    // Measured against the window's recorded offset, as revealGridIndex is,
    // which a smooth scroll still moves once the guard's frames pass.
    const scrolled = this.gridVirtualizer.ensureVisible(next, viewportWidth, viewportHeight);
    if (!scrolled && this.gridScrollFrame === null) {
      const cell = this.layers.grid.querySelector<HTMLElement>(
        `[data-grid-index="${next}"] [data-focusable]`,
      );
      // Same window and same offset: renderGrid() would morph byte-identical
      // markup, since tiles carry no focus state - the scope owns the class.
      // The channel list already moves focus this way (moveVirtualFocus).
      if (cell) {
        this.place(cell, 'key');
        return true;
      }
    }
    this.renderGrid(false);
    this.place(
      this.layers.grid.querySelector<HTMLElement>(`[data-grid-index="${next}"] [data-focusable]`),
      'key',
    );
    return true;
  }

  private moveCategoryFocus(direction: 'left' | 'right'): boolean {
    const parsed = parseKey(this.focusScope.focusKey);
    if (!parsed || parsed.mode !== 'browse' || parsed.rail !== 'all-categories') return false;
    const categories = this.categories;
    const current = this.categoryIndexOf(parsed.key);
    if (current < 0) return false;
    const next = current + (direction === 'left' ? -1 : 1);
    // At either end, stay put: SpatialNav would jump to another rail's tile.
    if (next < 0 || next >= categories.length) return true;
    const rail = this.layers.browse.querySelector<HTMLElement>('.catalog-category-rail');
    this.categoryVirtualizer.ensureVisible(
      next,
      rail?.clientWidth || CATEGORY_RAIL_VIEWPORT,
    );
    this.renderBrowse(false);
    this.place(
      this.layers.browse.querySelector<HTMLElement>(
        `[data-category-virtual-index="${next}"] [data-focusable]`,
      ),
      'key',
    );
    return true;
  }

  private scheduleGridSnap(view: HTMLElement): void {
    if (this.gridSnapTimer !== null) clearTimeout(this.gridSnapTimer);
    this.gridSnapTimer = setTimeout(() => {
      this.gridSnapTimer = null;
      if (this.mode !== 'grid') return;
      const category = this.gridCategory;
      const items = category ? (this.itemsByCategory[category.id] ?? []) : [];
      const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
      const viewportWidth = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
      const viewportHeight = view.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
      const maxOffset = Math.max(
        0,
        this.gridVirtualizer.getTotalSize(items.length, viewportWidth) - viewportHeight,
      );
      const snapped = Math.min(
        maxOffset,
        Math.round(this.gridVirtualizer.scrollOffset / CATALOG_GRID_ROW_STRIDE)
          * CATALOG_GRID_ROW_STRIDE,
      );
      if (snapped === this.gridVirtualizer.scrollOffset) return;
      this.gridVirtualizer.setScrollOffset(snapped);
      this.renderGrid(false);
    }, GRID_SNAP_DELAY_MS);
  }

  private gridTrackStart(
    view: HTMLElement | null,
    track: HTMLElement | null,
  ): number {
    if (!view || !track) return 0;
    return Math.max(
      0,
      track.getBoundingClientRect().top
        - view.getBoundingClientRect().top
        + view.scrollTop,
    );
  }
}
