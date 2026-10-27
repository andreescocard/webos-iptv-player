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
import { CALENDAR_ICON, CLOCK_ICON, INFO_ICON, PLAY_ICON, SEE_ALL_ICON, STAR_ICON, TAG_ICON, TRAILER_ICON } from './icons';
import { showToast } from './toast';
import { TrailerOverlay } from './trailer-overlay';
import { formatRating, translateGenres } from '../utils/catalog-meta';
import { resolveTrailer, type TrailerKind } from '../services/trailer-service';
import { morph } from '../utils/morph';
import { lazySrc } from '../utils/lazy-images';
import { LruCache } from '../utils/lru';
import { sharedCategoryPrefix, stripCategoryPrefix } from '../utils/category-prefix';
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
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { createLogger } from '../utils/logger';

const log = createLogger('Catalog');

const CATALOG_GRID_COLUMN_STRIDE = 244;
const CATALOG_GRID_ROW_STRIDE = 395;
const CATALOG_GRID_OVERSCAN_ROWS = 2;
const CATALOG_GRID_VIEWPORT_WIDTH = 1760;
const CATALOG_GRID_VIEWPORT_HEIGHT = 900;
const GRID_SNAP_DELAY_MS = 95;

// Matches the rail track's padding and its end spacer in catalog-view.css.
const RAIL_EDGE_GUTTER = 24;

// One inline trailer player shared by Movies and Series.
const trailerOverlay = new TrailerOverlay('trailer-overlay');

export interface CatalogHandlers {
  onRevealTabBar: () => void;
  onBack: () => void;
  onPlayVod: (req: Omit<VodPlayback, 'onBack'>) => void;
}

type Mode = 'browse' | 'grid' | 'detail';

// What the browse hero shows beyond the list item, from the item's detail info.
export interface HeroMeta {
  backdrop: string;
  plot: string;
  genre: string;
  year: string;
  rating: string;
  duration?: string;
  trailer?: string;
  tmdbId?: string;
}

const EMPTY_HERO_META: HeroMeta = { backdrop: '', plot: '', genre: '', year: '', rating: '' };

// A button on the browse hero or a detail screen. Both render their row from a
// list, so a section adds an action (e.g. a trailer) by adding an entry.
export interface CatalogAction {
  id: string;
  label: string;
  icon: string; // trusted inline SVG
  primary?: boolean;
  busy?: boolean;
}

// What a trailer lookup needs from a catalog item.
export interface TrailerTarget {
  kind: TrailerKind;
  title: string;
  year?: string;
  panelTrailer?: string;
  genre?: string;
  category?: string;
  tmdbId?: string;
}

export interface MetaFact {
  id: string;
  icon: string; // trusted inline SVG
  text: string;
}

export function buildFacts(
  parts: { rating?: string; year?: string; duration?: string; genre?: string },
): MetaFact[] {
  const facts: MetaFact[] = [];
  const rating = formatRating(parts.rating);
  if (rating) facts.push({ id: 'rating', icon: STAR_ICON, text: rating });
  if (parts.year) facts.push({ id: 'year', icon: CALENDAR_ICON, text: parts.year });
  if (parts.duration) facts.push({ id: 'duration', icon: CLOCK_ICON, text: parts.duration });
  const genre = translateGenres(parts.genre ?? '');
  if (genre) facts.push({ id: 'genre', icon: TAG_ICON, text: genre });
  return facts;
}

export function catalogFacts(facts: MetaFact[]): Safe {
  return html`${facts.map((fact) => html`<span class="catalog-fact" data-key="fact:${fact.id}"><span class="catalog-fact-icon">${raw(fact.icon)}</span><span>${fact.text}</span></span>`)}`;
}

export function catalogButton(action: CatalogAction, surface: 'detail' | 'hero'): Safe {
  const base = action.primary ? 'detail-btn detail-btn-primary' : 'detail-btn';
  const cls = action.busy ? `${base} detail-btn-busy` : base;
  const content = html`<span class="detail-btn-icon">${raw(action.icon)}</span><span>${action.label}</span>`;
  return surface === 'hero'
    ? html`<button class="${cls}" data-focusable data-key="hero:${action.id}"
        data-hero-action="${action.id}" aria-busy="${action.busy ? 'true' : 'false'}">${content}</button>`
    : html`<button class="${cls}" data-focusable data-key="${action.id}"
        data-action="${action.id}" aria-busy="${action.busy ? 'true' : 'false'}">${content}</button>`;
}

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
  private categoryPrefix: string | null = null;
  // The item the browse hero shows, and the one it follows once focus rests.
  private heroItem: I | null = null;
  private heroPending: I | null = null;
  // The Continue entry the hero was raised for, so it can show that episode.
  protected heroResume: ResumeEntry | null = null;
  private heroPendingResume: ResumeEntry | null = null;
  private heroTimer: ReturnType<typeof setTimeout> | null = null;
  private heroController: AbortController | null = null;
  private heroFetchKey = '';
  private readonly heroMetaCache = new LruCache<string, HeroMeta>(CONFIG.XTREAM.HERO_META_CACHE_ITEMS);
  // The rail element focus last left for the hero; Down returns to it.
  private heroReturnKey: string | null = null;

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
  // The most recently watched item, preferred over the first rail item; default none.
  protected heroFromResume(): I | null { return null; }
  // The item a Continue tile raises in the hero; default none.
  protected resumeHeroItem(_entry: ResumeEntry): I | null { return null; }
  // Extra hero line for the focused Continue entry (e.g. the episode); default none.
  protected heroResumeNote(_item: I, _entry: ResumeEntry): Safe | '' { return ''; }
  // Landscape artwork the Continue entry brings itself (an episode still), else ''.
  protected heroResumeArt(_item: I, _entry: ResumeEntry): string { return ''; }
  protected itemRating(_item: I): string { return ''; }
  // The hero's extra facts, from the item's detail info (null when it has none).
  protected abstract loadHeroMeta(
    account: PlaylistEntry,
    item: I,
    signal: AbortSignal,
  ): Promise<HeroMeta | null>;
  protected abstract heroPlayLabel(item: I): string;
  protected abstract playFromHero(item: I): void;
  // The hero's button row; a section may add its own actions.
  protected heroActions(item: I): CatalogAction[] {
    const trailer = this.trailerAction(item);
    return [
      { id: 'play', label: this.heroPlayLabel(item), icon: PLAY_ICON, primary: true },
      ...(trailer ? [trailer] : []),
      { id: 'info', label: t('catalog.moreInfo'), icon: INFO_ICON },
    ];
  }
  protected heroAction(id: string, item: I): void {
    if (id === 'play') this.playFromHero(item);
    else if (id === 'trailer') this.startTrailer(item);
    else if (id === 'info') void this.openDetail(item);
  }
  // Buttons a section appends to its detail screen's action row.
  protected extraDetailActions(): CatalogAction[] {
    const item = this.detailItem();
    const trailer = item ? this.trailerAction(item) : null;
    return trailer ? [trailer] : [];
  }
  // The item the open detail screen shows.
  protected detailItem(): I | null { return null; }
  // What a trailer lookup needs for this item; null hides the Trailer button.
  protected trailerTarget(_item: I): TrailerTarget | null { return null; }
  protected heroMeta(item: I): HeroMeta | undefined {
    return this.heroMetaCache.get(this.heroMetaKey(item));
  }
  private trailerController: AbortController | null = null;

  private trailerAction(item: I): CatalogAction | null {
    if (!this.trailerTarget(item)) return null;
    const busy = this.trailerController !== null;
    return { id: 'trailer', label: t(busy ? 'common.loading' : 'catalog.trailer'), icon: TRAILER_ICON, busy };
  }

  protected startTrailer(item: I): void {
    const target = this.trailerTarget(item);
    if (!target || this.trailerController) return;
    const controller = new AbortController();
    this.trailerController = controller;
    this.refreshTrailerUi();
    const done = (): boolean => {
      if (controller.signal.aborted) return false;
      this.trailerController = null;
      this.refreshTrailerUi();
      return true;
    };
    resolveTrailer({ ...target, signal: controller.signal }).then((result) => {
      if (!done()) return;
      if (result.kind !== 'video') {
        showToast(t('catalog.trailerNotFound'));
        return;
      }
      trailerOverlay.show(result.videoId, { onFallback: () => showToast(t('catalog.trailerUnavailable')) });
    }, () => {
      if (done()) showToast(t('catalog.trailerFailed'));
    });
  }

  private abortTrailer(): void {
    trailerOverlay.hide();
    this.trailerController?.abort();
    this.trailerController = null;
  }

  private refreshTrailerUi(): void {
    if (this.mode === 'detail') this.renderDetail();
    else if (this.mode === 'browse' && this.browseRendered) this.renderHero();
  }

  private plotExpanded = false;
  private readonly plotOverflow = new Map<string, boolean>();

  // The synopsis, clamped to three lines with a toggle once it measures as longer.
  protected detailPlot(plot: string): Safe | '' {
    if (!plot) return '';
    const overflow = this.plotOverflow.get(plot) === true;
    const clamped = !this.plotExpanded;
    return html`<p class="detail-plot ${clamped ? 'detail-plot-clamped' : ''}" data-key="detail-plot">${plot}</p>${
      overflow ? html`<button class="detail-link" data-focusable data-key="plot-toggle"
        data-action="plot-toggle">${t(clamped ? 'catalog.showMore' : 'catalog.showLess')}</button>` : ''}`;
  }

  // Measures a fresh synopsis after a render; true when it re-rendered to add the toggle.
  protected measureDetailPlot(): boolean {
    const el = this.layer('detail').querySelector<HTMLElement>('.detail-plot');
    const text = el?.textContent ?? '';
    if (!el || this.plotOverflow.has(text) || !el.clientHeight || this.plotExpanded) return false;
    const overflow = el.scrollHeight > el.clientHeight + 1;
    this.plotOverflow.set(text, overflow);
    if (!overflow) return false;
    this.renderDetail();
    return true;
  }
  // Category names without a provider prefix every category shares.
  protected categoryLabel(category: C): string {
    // Exotic separators (e.g. a slashed bar) can render as a blank box on the TV font.
    return stripCategoryPrefix(category.name, this.categoryPrefix).replace(/\s*[∤∣¦│┃‖]\s*/g, ' · ');
  }

  // The active mode's layer; hidden layers keep their DOM but never take focus.
  protected layer(mode: Mode = this.mode): HTMLElement {
    return this.layers[mode];
  }

  protected showLayer(mode: Mode): void {
    if (this.mode === 'browse' && mode !== 'browse') {
      this.leaveBrowse();
      // A hero still following focus catches up when browse shows again.
      this.cancelHeroTimer();
    }
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
    this.plotExpanded = false;
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
    const first = this.firstTarget();
    return first ? this.keyFor(first) : null;
  }

  // Browse starts on the first rail tile, not on the hero buttons above it.
  private firstTarget(): HTMLElement | null {
    if (this.mode === 'browse') {
      const tile = this.layers.browse.querySelector<HTMLElement>('.catalog-rails-body [data-focusable]');
      if (tile) return tile;
    }
    return this.nav.first();
  }

  // Keys the virtualized grid or episode list may not render.
  private hasKey(key: string): boolean {
    const parsed = parseKey(key);
    if (!parsed || parsed.mode !== this.mode) return false;
    if (parsed.mode === 'grid') return this.gridIndexOf(parsed.key) >= 0;
    if (parsed.mode === 'browse') return false;
    return this.hasExtraKey(parsed.key);
  }

  private gridIndexOf(key: string): number {
    const cat = this.gridCategory;
    const items = cat ? (this.itemsByCategory[cat.id] ?? []) : [];
    return items.findIndex((it) => `i:${this.itemCategoryId(it)}:${this.itemId(it)}` === key);
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
    if (parsed.mode === 'browse' && parsed.rail === 'hero') return this.revealHero(instant) ? true : null;
    // The grid's window owns its scroll offset; it alone brings a cell in.
    if (parsed.mode === 'grid') return this.revealGridIndex(this.gridIndexOf(parsed.key)) ? true : null;
    if (parsed.mode === 'detail') {
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

  // Scrolls each scroller around `el` just enough to show it whole; a rail
  // tile also keeps a gutter beside it. True when anything scrolled.
  private revealElement(el: HTMLElement, instant: boolean): boolean {
    // A rail tile scales up on focus; its track's padding holds the scaled
    // tile and ring, so the track is what has to be in view.
    const parent = el.parentElement;
    const r = (parent?.classList.contains('catalog-rail-track') ? parent : el).getBoundingClientRect();
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
    this.place(this.firstTarget(), via);
  }

  setAccount(account: PlaylistEntry): void {
    if (this.account?.id !== account.id) {
      this.requestController?.abort();
      this.stopHero();
      this.abortTrailer();
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
    this.stopHero();
    this.abortTrailer();
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
    this.stopHero();
    this.abortTrailer();
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
    this.categoryPrefix = null;
    this.railGroups = [];
    this.itemsByCategory = {};
    this.gridCategory = null;
    this.heroItem = null;
    this.heroPending = null;
    this.heroResume = null;
    this.heroPendingResume = null;
    this.heroReturnKey = null;
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
      this.categoryPrefix = sharedCategoryPrefix(this.categories.map((c) => c.name));
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
    if (this.moveHeroFocus(action)) return;
    if (this.mode === 'browse' && (action === 'left' || action === 'right')
        && this.moveRailFocus(action)) return;
    if (this.mode === 'grid'
        && (action === 'up' || action === 'down' || action === 'left' || action === 'right')) {
      if (this.moveGridFocus(action)) return;
      if (action === 'up') this.handlers.onRevealTabBar();
      return;
    }
    switch (action) {
      case 'up': {
        const fromRails = !this.heroFocused();
        if (!this.nav.move('up')) this.handlers.onRevealTabBar();
        // Entering the hero from below lands on its first, primary button.
        else if (fromRails && this.heroFocused()) {
          this.place(this.layers.browse.querySelector<HTMLElement>('.catalog-hero-actions [data-focusable]'), 'key');
        }
        return;
      }
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
    if (el.dataset.heroAction !== undefined) {
      if (this.heroItem) this.heroAction(el.dataset.heroAction, this.heroItem);
      return;
    }
    if (el.dataset.action === 'trailer') {
      const item = this.detailItem();
      if (item) this.startTrailer(item);
      return;
    }
    if (el.dataset.action === 'plot-toggle') {
      this.plotExpanded = !this.plotExpanded;
      this.renderDetail();
      return;
    }
    if (this.selectExtra(el)) return;
    if (el.dataset.itemId !== undefined) {
      const item = this.findItem(el.dataset.categoryId ?? '', el.dataset.itemId);
      if (item) void this.openDetail(item);
    }
  }

  // SpatialNav picked `el`: hand it to the scope, and let the browse hero
  // follow the focused item tile once focus rests. Other tiles and the hero's
  // own buttons leave it on the item it shows.
  private onFocusChanged(el: HTMLElement | null): void {
    this.request(el ? this.keyFor(el) : null, this.pickVia);
    const gridCell = el?.closest<HTMLElement>('[data-grid-index]');
    if (this.mode === 'grid' && gridCell?.dataset.gridIndex !== undefined) {
      this.gridFocusIndex = parseInt(gridCell.dataset.gridIndex, 10);
      return;
    }
    if (this.mode !== 'browse' || !el) return;
    if (el.closest('.catalog-hero-body')) {
      // Its buttons act on what it shows, so a pending switch lands first.
      this.flushHero();
      return;
    }
    this.heroReturnKey = this.keyFor(el);
    if (el.dataset.resumeEpisode !== undefined) {
      const entry = this.resume.find(r => r.itemId === el.dataset.resumeEpisode);
      const owner = entry ? this.resumeHeroItem(entry) : null;
      if (entry && owner) this.followHero(owner, entry);
      return;
    }
    const id = el.dataset.itemId;
    if (id === undefined || el.closest('[data-category-virtual-index]')) return;
    const item = this.findItem(el.dataset.categoryId ?? '', id);
    if (item) this.followHero(item);
  }

  private heroFocused(): boolean {
    const parsed = parseKey(this.focusScope.focusKey);
    return this.mode === 'browse' && !!parsed && parsed.mode === 'browse' && parsed.rail === 'hero';
  }

  // Left/Right stay on the hero's buttons, and Down returns to the rail
  // tile focus came from rather than the one nearest the buttons.
  private moveHeroFocus(action: Action): boolean {
    if (!this.heroFocused()) return false;
    const current = this.current();
    if (!current) return false;
    if (action === 'left' || action === 'right') {
      const buttons = Array.from(
        this.layers.browse.querySelectorAll<HTMLElement>('.catalog-hero-actions [data-focusable]'),
      );
      const next = buttons[buttons.indexOf(current) + (action === 'left' ? -1 : 1)];
      if (next) this.place(next, 'key');
      return true;
    }
    if (action !== 'down') return false;
    const back = this.heroReturnKey === null ? null : this.resolveKey(this.heroReturnKey);
    if (!back) return false;
    this.place(back, 'key');
    return true;
  }

  // The hero's buttons sit at the top of the rails' scroller; showing them
  // shows the whole hero.
  private revealHero(instant: boolean): boolean {
    const rails = this.layers.browse.querySelector<HTMLElement>('.catalog-rails');
    if (!rails || rails.scrollTop <= 0) return false;
    if (instant) withInstantScroll([rails], () => { rails.scrollTop = 0; });
    else rails.scrollTop = 0;
    return true;
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

  // Fast D-pad travel across a rail must not swap artwork and fetch details
  // for every tile it passes, so the hero follows only once focus rests.
  private followHero(item: I, resume: ResumeEntry | null = null): void {
    this.cancelHeroTimer();
    if (this.heroItem && this.itemId(this.heroItem) === this.itemId(item)
      && (this.heroResume?.itemId ?? '') === (resume?.itemId ?? '')) {
      this.heroPending = null;
      this.heroPendingResume = null;
      return;
    }
    this.heroPending = item;
    this.heroPendingResume = resume;
    this.heroTimer = setTimeout(() => {
      this.heroTimer = null;
      this.flushHero();
    }, CONFIG.XTREAM.HERO_FOLLOW_DELAY_MS);
  }

  private flushHero(): void {
    this.cancelHeroTimer();
    const item = this.heroPending;
    this.heroPending = null;
    const resume = this.heroPendingResume;
    this.heroPendingResume = null;
    if (!item) return;
    this.heroItem = item;
    this.heroResume = resume;
    this.renderHero();
    this.fetchHeroMeta(item);
  }

  private cancelHeroTimer(): void {
    if (this.heroTimer === null) return;
    clearTimeout(this.heroTimer);
    this.heroTimer = null;
  }

  private stopHero(): void {
    this.cancelHeroTimer();
    this.heroController?.abort();
    this.heroController = null;
  }

  private heroMetaKey(item: I): string {
    return `${this.account?.id ?? ''}|${this.itemId(item)}`;
  }

  private fetchHeroMeta(item: I): void {
    const account = this.account;
    const key = this.heroMetaKey(item);
    if (!account || this.heroMetaCache.has(key)) return;
    if (this.heroController && this.heroFetchKey === key) return;
    this.heroController?.abort();
    const controller = new AbortController();
    this.heroController = controller;
    this.heroFetchKey = key;
    const done = (meta: HeroMeta | null): void => {
      if (controller.signal.aborted) return;
      this.heroController = null;
      // A failed fetch is not cached, so the next visit asks again.
      if (meta) this.heroMetaCache.set(key, meta);
      if (this.heroItem === item && this.account?.id === account.id) this.renderHero();
    };
    this.loadHeroMeta(account, item, controller.signal).then(
      (meta) => done(meta ?? EMPTY_HERO_META),
      () => done(null),
    );
  }

  private renderHero(): void {
    const art = this.layers.browse.querySelector<HTMLElement>('.catalog-hero');
    const body = this.layers.browse.querySelector<HTMLElement>('.catalog-hero-body');
    if (!art || !body) return;
    morph(art, this.heroArt());
    morph(body, this.heroText(this.fillNote()));
  }

  private heroArt(): Safe {
    const item = this.heroItem;
    const meta = item ? this.heroMetaCache.get(this.heroMetaKey(item)) : undefined;
    const still = item && this.heroResume ? this.heroResumeArt(item, this.heroResume) : '';
    const backdrop = still || meta?.backdrop || '';
    const poster = item ? this.itemPoster(item) : '';
    const scrim = html`<div class="catalog-hero-scrim" data-key="scrim"></div>`;
    if (backdrop) {
      return html`
        <img class="catalog-hero-art catalog-hero-backdrop" data-key="backdrop:${backdrop}"
             src="${backdrop}" alt="" onerror="this.style.display='none'">
        ${scrim}`;
    }
    // A portrait poster is never stretched to fill a landscape hero.
    if (poster) {
      return html`
        <div class="catalog-hero-glow" data-key="glow"></div>
        <img class="catalog-hero-art catalog-hero-poster" data-key="poster:${poster}"
             src="${poster}" alt="" onerror="this.style.display='none'">
        ${scrim}`;
    }
    return scrim;
  }

  private heroText(fillNote: Safe | ''): Safe {
    const item = this.heroItem;
    const meta = item ? this.heroMetaCache.get(this.heroMetaKey(item)) : undefined;
    const facts = item
      ? buildFacts({
        rating: meta?.rating || this.itemRating(item),
        year: meta?.year,
        duration: meta?.duration,
        genre: meta?.genre,
      })
      : [];
    return html`
      <div class="catalog-hero-text" data-key="hero-text">
        <h1 class="catalog-hero-title" data-key="hero-title">${item ? this.itemName(item) : this.kicker}</h1>
        ${item && this.heroResume ? this.heroResumeNote(item, this.heroResume) : ''}
        ${facts.length ? html`<div class="catalog-hero-meta" data-key="hero-meta">${catalogFacts(facts)}</div>` : ''}
        ${meta?.plot ? html`<p class="catalog-hero-plot" data-key="hero-plot">${meta.plot}</p>` : ''}
        ${item ? html`
          <div class="catalog-hero-actions" data-key="hero-actions">${
            this.heroActions(item).map((action) => catalogButton(action, 'hero'))}</div>` : ''}
        ${fillNote}
      </div>
    `;
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
      ? html`<img class="catalog-poster" ${lazySrc(poster)} alt="" onerror="this.style.display='none'">`
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

  // Thin watched-progress bar over the foot of a Continue card; none until started.
  protected progressBar(r: { position: number; duration: number }): Safe | '' {
    const pct = r.duration > 0 ? Math.min(100, Math.round((r.position / r.duration) * 100)) : 0;
    return pct > 0
      ? html`<div class="catalog-tile-progress"><div class="catalog-tile-progress-fill" style="width:${pct}%"></div></div>`
      : '';
  }

  protected tile(item: I, progress: Safe | '' = ''): Safe {
    const id = this.itemId(item);
    const cat = this.itemCategoryId(item);
    return html`
      <div class="catalog-tile" data-focusable data-key="i:${cat}:${id}"
           data-item-id="${id}" data-category-id="${cat}">
        <div class="catalog-poster-wrap">${this.posterCell(this.itemName(item), this.itemPoster(item))}${
          this.itemLockBadge(cat, id)}${progress}</div>
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
    return this.rail(`cat:${id}`, this.categoryLabel(group.category), tiles);
  }

  protected rail(key: string, title: string, items: Safe[]): Safe {
    return html`
      <div class="catalog-rail" data-key="rail:${key}" data-rail-key="${key}">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="catalog-rail-track" data-lazy-root>${items}</div>
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
    return html`<div class="catalog-fill" data-key="fill" role="status">${fill.total
      ? t('catalog.loadingProgress', { done: fill.done, total: fill.total })
      : t('catalog.loadingCatalog')}</div>`;
  }

  protected renderBrowse(restoreFocus = true): void {
    this.browseRendered = true;
    this.showLayer('browse');
    const browse = this.layers.browse;
    this.resume = this.visibleResume(this.account!.id);
    if (this.heroPending && this.heroTimer === null) {
      this.heroItem = this.heroPending;
      this.heroResume = this.heroPendingResume;
      this.heroPending = null;
      this.heroPendingResume = null;
    }
    if (!this.heroItem) this.heroItem = this.heroFromResume() ?? this.railGroups[0]?.items[0] ?? this.heroFallback();
    const continueRail = this.continueRail();
    const watchlistRail = this.watchlistRail();
    const fillNote = this.fillNote();
    const hasContent = this.categories.length > 0 || !!continueRail || !!watchlistRail;
    // Once some categories have no rail, "All Categories" lists every category,
    // rails included, so it is the one complete index of the catalog.
    const moreCats = this.categories.length > this.railGroups.length ? this.categories : [];

    morph(browse, html`
      <div class="catalog-view catalog-browse" data-nav-container>
        ${!hasContent
          ? html`<p class="catalog-hint catalog-empty">${
              fillNote ? t('catalog.loadingCatalog') : this.emptyMessage}</p>`
          : html`
            <div class="catalog-hero" data-key="hero">${this.heroArt()}</div>
            <div class="catalog-rails" data-key="rails" data-lazy-root>
              <div class="catalog-rails-spacer catalog-hero-body" data-key="hero-body"
                   data-rail-key="hero">${this.heroText(fillNote)}</div>
              <div class="catalog-rails-body" data-key="rails-body">
                ${continueRail}
                ${watchlistRail}
                ${this.railGroups.map((r) => this.categoryRail(r))}
                ${moreCats.length ? html`
                  <div class="catalog-rail" data-key="rail:all-categories"
                       data-rail-key="all-categories">
                    <h2 class="catalog-rail-title">${t('catalog.allCategories')}</h2>
                    <div class="catalog-category-grid">
                      ${moreCats.map((c) => html`
                        <div class="catalog-cat" data-focusable
                             data-key="c:${c.id}" data-category-id="${c.id}">${
                          raw(categoryLockBadge(this.parentalKind, this.account!.id, c.id))
                        }${this.categoryLabel(c)}</div>
                      `)}
                    </div>
                  </div>
                ` : ''}
              </div>
            </div>
          `}
      </div>
    `);
    if (this.heroItem) this.fetchHeroMeta(this.heroItem);
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
      <div class="catalog-view catalog-grid" data-nav-container data-lazy-root>
        <h1 class="catalog-grid-title">${cat ? this.categoryLabel(cat) : this.kicker}</h1>
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

  // Left/Right walk a rail in order and stop at its ends, rather than
  // jumping geometrically to a neighbor rail or the hero's buttons.
  private moveRailFocus(direction: 'left' | 'right'): boolean {
    const current = this.current();
    const track = current?.parentElement;
    if (!current || !track || !track.classList.contains('catalog-rail-track')) return false;
    const tiles = Array.from(track.children)
      .filter((el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute('data-focusable'));
    const next = tiles[tiles.indexOf(current) + (direction === 'left' ? -1 : 1)];
    if (next) this.place(next, 'key');
    else this.request(this.focusScope.focusKey, 'key');
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
