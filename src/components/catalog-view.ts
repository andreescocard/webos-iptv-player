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
import { preloadImage } from '../utils/preload-image';
import { sharedCategoryPrefix, stripCategoryPrefix } from '../utils/category-prefix';
import {
  collectionIcon, genreLabelKey, planCategories, SMART_IDS,
  type CollectionKind, type GenreId, type SmartKind,
} from '../utils/category-groups';
import { newReleases, recentlyAdded, topRated, uniqueTitles, withoutRepeatedTitles, type SmartTitle } from '../utils/smart-collections';
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

// One browsable entry of the "all categories" view and the rails: a smart list
// ("Top rated"), a streaming service, a canonical genre, or a category on its
// own. A collection of several provider categories has a virtual id; one of a
// single category keeps that category's id.
export interface Collection<C> {
  kind: CollectionKind;
  category: C;
  // Real provider category ids behind it; empty for a smart list.
  sourceIds: string[];
  smart?: SmartKind;
  service?: string;
  genre?: GenreId;
}

export interface CollectionSection<C> {
  key: string;
  title: string;
  collections: Collection<C>[];
}

const SMART_ORDER: SmartKind[] = ['recent', 'new', 'top'];

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
export abstract class CatalogView<C extends { id: string; name: string }, I extends SmartTitle> {
  protected nav: SpatialNav;
  protected account: PlaylistEntry | null = null;
  protected mode: Mode = 'browse';
  protected categories: C[] = [];
  protected collections: Collection<C>[] = [];
  // The account's whole list, once loaded; it feeds the smart lists and the tile counts.
  private allItems: I[] | null = null;
  private allByCategory: Map<string, I[]> | null = null;
  private readonly collectionCounts = new Map<string, number>();
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
  private gridReturnKey: string | null = null;
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
  // Suggestions survive a focused tile's temporary preview.
  private heroCarousel: I[] = [];
  private heroCarouselTimer: ReturnType<typeof setTimeout> | null = null;
  private heroController: AbortController | null = null;
  private prefetchController: AbortController | null = null;
  private heroFetchKey = '';
  private readonly heroMetaCache = new LruCache<string, HeroMeta>(CONFIG.XTREAM.HERO_META_CACHE_ITEMS);
  // The rail element focus last left for the hero; Down returns to it.
  private heroReturnKey: string | null = null;
  private restoringBrowse = false;

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
  protected abstract loadAllItems(account: PlaylistEntry, signal: AbortSignal): Promise<I[]>;
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
  // Back on a detail screen opened from another one; true when it went back there.
  protected detailBack(): boolean { return false; }
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
  protected smartKinds(): SmartKind[] { return SMART_ORDER; }
  protected readonly preserveInitialHero: boolean = false;
  protected initialHero(): I | null {
    return this.heroFromResume() ?? this.railGroups[0]?.items[0] ?? this.heroFallback();
  }
  // Titles the browse hero rotates through on open; none keeps initialHero().
  protected heroCarouselItems(): I[] { return []; }
  protected categoryHero(): I | null { return null; }
  protected onGridOpened(): void {}
  protected gridItems(): I[] {
    return this.gridCategory ? (this.itemsByCategory[this.gridCategory.id] ?? []) : [];
  }
  protected gridControls(): Safe | '' { return ''; }
  protected refreshGridOrder(): void {
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.renderGrid(false);
  }
  // Categories carry only an id and a name; a collection's category is made from them.
  protected makeCategory(id: string, name: string): C {
    return { id, name } as C;
  }
  protected categorySections(): CollectionSection<C>[] {
    // Secondary entry: once every collection has its own rail it is redundant.
    if (this.collections.length <= this.railGroups.length) return [];
    const of = (kind: CollectionKind): Collection<C>[] => this.collections.filter((c) => c.kind === kind);
    const sections = [
      { key: 'smart', title: t('catalog.discover'), collections: of('smart') },
      { key: 'streaming', title: t('catalog.streaming'), collections: of('streaming') },
      { key: 'genres', title: t('catalog.genres'), collections: of('genre') },
      { key: 'other', title: t('catalog.otherCategories'), collections: of('other') },
    ].filter((section) => section.collections.length > 0);
    if (sections.length === 1 && sections[0].key === 'other') {
      sections[0].title = t('catalog.allCategories');
    }
    return sections;
  }
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
    else if (this.mode === 'grid') this.renderCategoryHero();
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
  // A collection's name, or a category's name without the prefix every category shares.
  protected categoryLabel(category: C): string {
    const collection = this.collectionOf(category.id);
    if (collection && collection.kind !== 'other') return this.collectionLabel(collection);
    // Exotic separators (e.g. a slashed bar) can render as a blank box on the TV font.
    return stripCategoryPrefix(category.name, this.categoryPrefix).replace(/\s*[∤∣¦│┃‖]\s*/g, ' · ');
  }

  protected collectionOf(categoryId: string): Collection<C> | null {
    return this.collections.filter((c) => c.category.id === categoryId)[0] ?? null;
  }

  protected collectionLabel(collection: Collection<C>): string {
    if (collection.smart) {
      return t(collection.smart === 'top' ? 'catalog.topRated'
        : collection.smart === 'new' ? 'catalog.newReleases' : 'catalog.recentlyAdded');
    }
    if (collection.service) return collection.service;
    if (collection.genre) return t(genreLabelKey(collection.genre));
    return this.categoryLabel(collection.category);
  }

  // How many titles a collection holds, or null while that is still unknown.
  protected collectionCount(collection: Collection<C>): number | null {
    const cached = this.itemsByCategory[collection.category.id];
    if (collection.smart) return cached ? cached.length : null;
    if (this.allByCategory) {
      const id = collection.category.id;
      let count = this.collectionCounts.get(id);
      if (count === undefined) {
        count = this.sourceItems(collection.sourceIds).length;
        this.collectionCounts.set(id, count);
      }
      return count;
    }
    return cached ? cached.length : null;
  }

  // Groups the categories into collections; smart lists need the whole catalog.
  private organize(): void {
    const byId = new Map(this.categories.map((c) => [c.id, c] as [string, C]));
    const smart: Collection<C>[] = [];
    this.smartKinds().forEach((kind) => {
      const items = this.smartItems(kind);
      const id = SMART_IDS[kind];
      if (!items.length) {
        delete this.itemsByCategory[id];
        return;
      }
      this.itemsByCategory[id] = items;
      smart.push({ kind: 'smart', smart: kind, sourceIds: [], category: this.makeCategory(id, kind) });
    });
    const grouped = planCategories(this.categories, this.categoryPrefix).map((group): Collection<C> => {
      const real = byId.get(group.sourceIds[0])!;
      if (group.kind === 'other') return { kind: 'other', sourceIds: group.sourceIds, category: real };
      const id = group.sourceIds.length === 1 ? real.id : group.key;
      return {
        kind: group.kind,
        sourceIds: group.sourceIds,
        service: group.service,
        genre: group.genre,
        category: this.makeCategory(id, group.service ?? group.genre ?? ''),
      };
    });
    this.collections = [...smart, ...grouped];
  }

  private smartItems(kind: SmartKind): I[] {
    const all = this.allItems;
    if (!all) return [];
    const limit = CONFIG.XTREAM.SMART_ITEMS;
    if (kind === 'top') return topRated(all, limit);
    return kind === 'new' ? newReleases(all, limit) : recentlyAdded(all, limit);
  }

  // Smart lists always get a rail; the rest are capped.
  private railCollections(limit: number = CONFIG.XTREAM.RAIL_CATEGORIES): Collection<C>[] {
    let others = 0;
    return this.collections.filter((c) => c.kind === 'smart' || others++ < limit);
  }

  private buildRailGroups(): { category: C; items: I[] }[] {
    const collections = this.railCollections(CONFIG.XTREAM.MAX_RAILS)
      .filter((c) => (this.itemsByCategory[c.category.id] ?? []).length > 0);
    // Discovery rails share titles; the first rail to hold one keeps it.
    const smartIndexes = collections.map((c, i) => (c.smart ? i : -1)).filter((i) => i >= 0);
    const smartItems = withoutRepeatedTitles(
      smartIndexes.map((i) => this.itemsByCategory[collections[i].category.id]),
      (item) => this.itemId(item),
      CONFIG.XTREAM.RAIL_ITEMS,
    );
    const groups: { category: C; items: I[] }[] = [];
    collections.forEach((c, i) => {
      const smartAt = smartIndexes.indexOf(i);
      const items = smartAt >= 0 ? smartItems[smartAt] : this.itemsByCategory[c.category.id].slice(0, CONFIG.XTREAM.RAIL_ITEMS);
      if (items.length) groups.push({ category: c.category, items });
    });
    return groups;
  }

  // Every title of a collection's categories, once each, in provider order.
  private loadCollectionItems(
    account: PlaylistEntry,
    collection: Collection<C>,
    signal: AbortSignal,
  ): Promise<I[]> {
    if (collection.smart) return Promise.resolve(this.itemsByCategory[collection.category.id] ?? []);
    if (collection.sourceIds.length === 1) {
      return this.loadVisibleItems(account, collection.sourceIds[0], signal);
    }
    return this.mergeCategoryItems(collection.sourceIds, signal);
  }

  private async mergeCategoryItems(sourceIds: string[], signal: AbortSignal): Promise<I[]> {
    const settled = await Promise.all(sourceIds.map((id) =>
      this.categoryItems(id, signal).then((items): I[] | Error => items, (err: unknown) => err as Error)));
    const failure = settled.filter((r): r is Error => r instanceof Error)[0];
    if (failure && settled.every((r) => r instanceof Error)) throw failure;
    const merged: I[] = [];
    settled.forEach((result) => {
      if (!(result instanceof Error)) merged.push(...result);
    });
    return uniqueTitles(merged, (item) => this.itemId(item));
  }

  // Loads the whole catalog in the background; it unlocks the smart lists and counts.
  private async loadWholeCatalog(account: PlaylistEntry, signal: AbortSignal): Promise<void> {
    let all: I[];
    try {
      all = await this.loadAllItems(account, signal);
    } catch (err) {
      if (!signal.aborted) {
        log.warn(
          'Catalog list load failed',
          'event=xtream.view.load.failed',
          'operation=all',
          `mode=${this.parentalKind}`,
          err,
        );
      }
      return;
    }
    if (signal.aborted || this.account?.id !== account.id) return;
    const visible = this.withoutConcealed(account, all, '');
    this.allItems = visible;
    const byCategory = new Map<string, I[]>();
    visible.forEach((item) => {
      const id = this.itemCategoryId(item);
      const list = byCategory.get(id);
      if (list) list.push(item);
      else byCategory.set(id, [item]);
    });
    this.allByCategory = byCategory;
    this.collectionCounts.clear();
    this.organize();
    // The whole list builds every other rail without another request.
    this.railCollections(CONFIG.XTREAM.MAX_RAILS).forEach((c) => {
      const id = c.category.id;
      if (c.smart || this.itemsByCategory[id]) return;
      const items = this.sourceItems(c.sourceIds);
      if (items.length) this.itemsByCategory[id] = items;
    });
    this.railGroups = this.buildRailGroups();
    if (!this.browseRendered) return;
    this.paintBrowse();
  }

  // The whole list's titles of these categories, in provider order, once each.
  private sourceItems(sourceIds: string[]): I[] {
    const byCategory = this.allByCategory;
    if (!byCategory) return [];
    const sources = new Set(sourceIds);
    const visible = this.allItems ?? [];
    if (sourceIds.length === 1) return uniqueTitles(byCategory.get(sourceIds[0]) ?? [], (item) => this.itemId(item));
    return uniqueTitles(visible.filter((item) => sources.has(this.itemCategoryId(item))), (item) => this.itemId(item));
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
      this.cancelCarousel();
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
    if (this.mode !== 'detail') this.gridReturnKey = this.mode === 'grid' ? this.focusedKey() : null;
    this.plotExpanded = false;
    this.showLayer('detail');
    // A detail opened from another one starts at its top.
    const page = this.layers.detail.querySelector<HTMLElement>('.catalog-view');
    if (page) page.scrollTop = 0;
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
    const items = this.gridItems();
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
    // The grid's window owns its scroll offset; header controls scroll normally.
    if (parsed.mode === 'grid') {
      const index = this.gridIndexOf(parsed.key);
      if (index >= 0) return this.revealGridIndex(index) ? true : null;
    }
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
    const changed = this.gridVirtualizer.ensureVisible(
      index,
      track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH,
      view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT,
    );
    if (changed) this.renderGrid(false);
    const tile = this.layers.grid.querySelector<HTMLElement>(
      `[data-grid-index="${index}"] [data-focusable]`,
    );
    return (tile ? this.revealElement(tile, true) : false) || changed;
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
    if (this.mode === 'grid') {
      this.renderCategoryHero();
      return;
    }
    if (this.mode === 'detail') {
      this.renderDetail();
      return;
    }
    if (this.mode !== 'browse' || !this.browseRendered || !this.account) return;
    // Playback just saved or advanced the resume entry; the browse layer
    // kept the one it rendered before the player took over.
    const shown = this.heroResume;
    if (shown) {
      const owner = shown.watchlistOwner?.itemId;
      this.heroResume = this.visibleResume(this.account.id).find((r) => owner
        ? r.watchlistOwner?.itemId === owner
        : r.itemId === shown.itemId) ?? null;
    }
    this.leaveBrowse();
    this.renderBrowse();
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
    this.collections = [];
    this.allItems = null;
    this.allByCategory = null;
    this.collectionCounts.clear();
    this.categoryPrefix = null;
    this.railGroups = [];
    this.itemsByCategory = {};
    this.gridCategory = null;
    this.heroItem = null;
    this.heroPending = null;
    this.heroResume = null;
    this.heroPendingResume = null;
    this.heroReturnKey = null;
    this.heroCarousel = [];
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
      this.organize();
      void this.loadWholeCatalog(account, signal);
      const railCats = this.railCollections().filter((c) => !c.smart);
      // Settle each rail on its own: one failing category must not blank the rest.
      const loaded = await Promise.all(
        railCats.map((c) => this.loadCollectionItems(account, c, signal).then(
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
      let kept = 0;
      railCats.forEach((collection, i) => {
        const items = loaded[i];
        if (!items) return;
        kept++;
        this.itemsByCategory[collection.category.id] = items;
      });
      this.railGroups = this.buildRailGroups();
      if (kept < railCats.length) {
        log.warn(
          'Catalog rails partially loaded',
          'event=xtream.view.rails.partial',
          `mode=${this.parentalKind}`,
          `kept=${String(kept)}`,
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
    // A key holds the shown suggestion for another full interval.
    if (this.heroCarouselTimer !== null) this.scheduleCarousel();
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
    if ((this.mode === 'browse' || this.mode === 'detail') && (action === 'left' || action === 'right')
        && this.moveRailFocus(action)) return;
    if (this.mode === 'grid'
        && (action === 'up' || action === 'down' || action === 'left' || action === 'right')) {
      const current = this.current();
      const inGrid = !!current?.closest('[data-grid-index]');
      if (inGrid) {
        if (this.moveGridFocus(action)) return;
        if (action !== 'up') return;
        const sort = this.layers.grid.querySelector<HTMLElement>('.catalog-sort .active');
        if (sort) { this.place(sort, 'key'); return; }
      } else if (action === 'down' && current?.closest('.catalog-sort')) {
        this.revealGridIndex(this.gridFocusIndex);
        this.place(this.layers.grid.querySelector<HTMLElement>(
          `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
        ), 'key');
        return;
      } else if (action === 'up' && current?.closest('.catalog-sort') && this.categoryHero()) {
        this.place(this.layers.grid.querySelector<HTMLElement>('.catalog-hero-actions [data-focusable]'), 'key');
        return;
      }
      if (!this.nav.move(action) && action === 'up') this.handlers.onRevealTabBar();
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
      if (this.detailBack()) return;
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
      const item = this.mode === 'grid' ? this.categoryHero() : this.heroItem;
      if (item) this.heroAction(el.dataset.heroAction, item);
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
    if (this.restoringBrowse && this.preserveInitialHero) return;
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
    if (this.mode === 'grid') return !!this.current()?.closest('.catalog-category-feature');
    const parsed = parseKey(this.focusScope.focusKey);
    return this.mode === 'browse' && !!parsed && parsed.mode === 'browse' && parsed.rail === 'hero';
  }

  // Hero actions stay in their row; Down returns to content or category sorting.
  private moveHeroFocus(action: Action): boolean {
    if (!this.heroFocused()) return false;
    const current = this.current();
    if (!current) return false;
    if (action === 'left' || action === 'right') {
      const buttons = Array.from(
        this.layers[this.mode].querySelectorAll<HTMLElement>('.catalog-hero-actions [data-focusable]'),
      );
      const next = buttons[buttons.indexOf(current) + (action === 'left' ? -1 : 1)];
      if (next) this.place(next, 'key');
      return true;
    }
    if (action !== 'down') return false;
    const back = this.mode === 'grid'
      ? this.layers.grid.querySelector<HTMLElement>('.catalog-sort .active')
      : this.heroReturnKey === null ? null : this.resolveKey(this.heroReturnKey);
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
    this.scheduleCarousel();
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
    this.cancelCarousel();
    this.heroController?.abort();
    this.heroController = null;
    this.prefetchController?.abort();
    this.prefetchController = null;
  }

  private scheduleCarousel(): void {
    this.cancelCarousel();
    if (this.heroCarousel.length < 2 || this.mode !== 'browse') return;
    this.heroCarouselTimer = setTimeout(() => {
      this.heroCarouselTimer = null;
      this.advanceCarousel();
    }, CONFIG.XTREAM.HERO_CAROUSEL_INTERVAL_MS);
  }

  private cancelCarousel(): void {
    if (this.heroCarouselTimer === null) return;
    clearTimeout(this.heroCarouselTimer);
    this.heroCarouselTimer = null;
  }

  private advanceCarousel(): void {
    const index = this.heroItem ? this.heroCarousel.indexOf(this.heroItem) : -1;
    if (this.mode !== 'browse' || this.heroCarousel.length < 2) return;
    // Playback, a trailer, or a hidden section holds the shown title.
    if (this.container.closest('.hidden') || trailerOverlay.visible) {
      this.scheduleCarousel();
      return;
    }
    this.cancelHeroTimer();
    this.heroPending = null;
    this.heroPendingResume = null;
    const item = this.heroCarousel[(index + 1) % this.heroCarousel.length];
    this.heroItem = item;
    this.heroResume = null;
    this.renderHero();
    this.fetchHeroMeta(item);
    this.prefetchNextHero();
    this.scheduleCarousel();
  }

  // Warms the next suggestion's detail info and artwork so it paints at once.
  private prefetchNextHero(): void {
    const account = this.account;
    const index = this.heroItem ? this.heroCarousel.indexOf(this.heroItem) : -1;
    if (!account || index < 0 || this.heroCarousel.length < 2) return;
    const item = this.heroCarousel[(index + 1) % this.heroCarousel.length];
    preloadImage(this.itemPoster(item));
    const key = this.heroMetaKey(item);
    const cached = this.heroMetaCache.get(key);
    if (cached) {
      preloadImage(cached.backdrop);
      return;
    }
    this.prefetchController?.abort();
    const controller = new AbortController();
    this.prefetchController = controller;
    this.loadHeroMeta(account, item, controller.signal).then((meta) => {
      if (controller.signal.aborted || !meta) return;
      preloadImage(meta.backdrop, () => {
        if (!controller.signal.aborted) this.heroMetaCache.set(key, meta);
      });
    }, () => undefined);
  }

  // Which suggestion the hero shows; not focusable, so it never takes a key.
  private carouselDots(): Safe | '' {
    const index = this.heroItem ? this.heroCarousel.indexOf(this.heroItem) : -1;
    if (this.heroCarousel.length < 2 || index < 0) return '';
    return html`<div class="catalog-hero-dots" data-key="hero-dots" aria-hidden="true">${
      this.heroCarousel.map((_, i) => html`<span class="catalog-hero-dot ${i === index ? 'active' : ''}"
        data-key="dot:${i}"></span>`)}</div>`;
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
    const apply = (meta: HeroMeta | null): void => {
      if (controller.signal.aborted) return;
      this.heroController = null;
      // A failed fetch is not cached, so the next visit asks again.
      if (meta) this.heroMetaCache.set(key, meta);
      if (this.heroItem === item && this.account?.id === account.id) this.renderHero();
      if (this.categoryHero() === item && this.account?.id === account.id && this.mode === 'grid') {
        this.renderCategoryHero();
      }
    };
    // The backdrop replaces the poster only once it can paint, so it never
    // blinks in over an empty frame.
    const done = (meta: HeroMeta | null): void => {
      if (meta?.backdrop) preloadImage(meta.backdrop, () => apply(meta));
      else apply(meta);
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
    morph(body, this.heroText(html`${this.carouselDots()}${this.fillNote()}`));
  }

  private renderCategoryHero(): void {
    const item = this.categoryHero();
    const art = this.layers.grid.querySelector<HTMLElement>('.catalog-hero');
    const body = this.layers.grid.querySelector<HTMLElement>('.catalog-hero-body');
    if (!item || !art || !body) return;
    morph(art, this.heroArt(item, null));
    morph(body, this.heroText('', item, null));
  }

  private heroArt(item: I | null = this.heroItem, resume: ResumeEntry | null = this.heroResume): Safe {
    const meta = item ? this.heroMetaCache.get(this.heroMetaKey(item)) : undefined;
    const still = item && resume ? this.heroResumeArt(item, resume) : '';
    const poster = item ? this.itemPoster(item) : '';
    const backdrop = still || meta?.backdrop || (this.parentalKind === 'vod' ? poster : '');
    const scrim = html`<div class="catalog-hero-scrim" data-key="scrim"></div>`;
    if (backdrop) {
      return html`
        <img class="catalog-hero-art catalog-hero-backdrop" data-key="backdrop:${backdrop}"
             src="${backdrop}" alt="" onerror="this.style.display='none'">
        ${scrim}`;
    }
    // Series keep a portrait fallback when no episode still or backdrop exists.
    if (poster) {
      return html`
        <div class="catalog-hero-glow" data-key="glow"></div>
        <img class="catalog-hero-art catalog-hero-poster" data-key="poster:${poster}"
             src="${poster}" alt="" onerror="this.style.display='none'">
        ${scrim}`;
    }
    return scrim;
  }

  private heroText(
    fillNote: Safe | '',
    item: I | null = this.heroItem,
    resume: ResumeEntry | null = this.heroResume,
  ): Safe {
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
        ${item && resume ? this.heroResumeNote(item, resume) : ''}
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
    return uniqueTitles(this.withoutConcealed(account, await this.loadItems(account, categoryId, signal), categoryId));
  }

  private withoutConcealed(account: PlaylistEntry, items: I[], categoryId: string): I[] {
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

  // A category's titles, loaded once and kept for its grid.
  protected async categoryItems(categoryId: string, signal: AbortSignal): Promise<I[]> {
    const account = this.account;
    const cached = this.itemsByCategory[categoryId];
    if (cached || !account) return cached ?? [];
    const items = await this.loadVisibleItems(account, categoryId, signal);
    if (!signal.aborted && this.account?.id === account.id) this.itemsByCategory[categoryId] = items;
    return items;
  }

  private visibleResume(accountId: string): ResumeEntry[] {
    const seenOwners = new Set<string>();
    return StorageService.getResumeList(accountId)
      .filter(entry => entry.kind === this.resumeKind && !isResumeConcealed(entry))
      .filter((entry) => {
        const owner = entry.watchlistOwner;
        if (!owner) return true;
        const key = `${owner.kind}:${owner.itemId}`;
        if (seenOwners.has(key)) return false;
        seenOwners.add(key);
        return true;
      });
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
    const collection = this.collectionOf(categoryId);
    this.gridCategory = collection?.category ?? this.categories.find((c) => c.id === categoryId) ?? null;
    const request = ++this.gridRequest;
    this.gridReturnKey = null;
    this.clearLayer('grid');
    if (!this.itemsByCategory[categoryId]) {
      this.renderLoading('grid');
      try {
        this.itemsByCategory[categoryId] = collection
          ? await this.loadCollectionItems(account, collection, signal)
          : await this.loadVisibleItems(account, categoryId, signal);
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
    this.onGridOpened();
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

  private isSmartRail(group: { category: C }): boolean {
    return !!this.collectionOf(group.category.id)?.smart;
  }

  private railLockBadge(id: string): Safe | '' {
    const collection = this.collectionOf(id);
    if (collection && (collection.smart || collection.sourceIds.length !== 1)) return '';
    return raw(categoryLockBadge(this.parentalKind, this.account!.id, collection ? collection.sourceIds[0] : id));
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
            ${this.railLockBadge(id)}
            ${raw(SEE_ALL_ICON)}
            <div class="catalog-see-all-label">${t('catalog.seeAll')}</div>
            <div class="catalog-see-all-count">${this.itemCount(total)}</div>
          </div>
        </div>
      `);
    }
    return this.rail(`cat:${id}`, this.categoryLabel(group.category), tiles);
  }

  // A tile of the "all categories" view: icon, name, and how many titles.
  private collectionTile(collection: Collection<C>): Safe {
    const id = collection.category.id;
    const count = this.collectionCount(collection);
    const icon = collectionIcon(collection.kind, {
      genre: collection.genre,
      smart: collection.smart,
      label: this.categoryLabel(collection.category),
    });
    const single = collection.sourceIds.length === 1 && collection.kind !== 'smart';
    return html`
      <div class="catalog-cat catalog-cat-with-icon" data-focusable
           data-key="c:${id}" data-category-id="${id}">${
        single ? raw(categoryLockBadge(this.parentalKind, this.account!.id, collection.sourceIds[0])) : ''
      }<span class="catalog-cat-icon">${raw(icon)}</span>
        <span class="catalog-cat-text">
          <span class="catalog-cat-name">${this.categoryLabel(collection.category)}</span>${
            count === null ? '' : html`<span class="catalog-cat-count">${this.itemCount(count)}</span>`}
        </span>
      </div>
    `;
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
    this.resume = this.visibleResume(this.account!.id);
    if (this.heroPending && this.heroTimer === null) {
      this.heroItem = this.heroPending;
      this.heroResume = this.heroPendingResume;
      this.heroPending = null;
      this.heroPendingResume = null;
    }
    if (!this.heroItem) {
      this.heroCarousel = this.heroCarouselItems();
      this.heroItem = this.heroCarousel[0] ?? this.initialHero();
    }
    this.paintBrowse();
    if (this.heroItem) this.fetchHeroMeta(this.heroItem);
    this.prefetchNextHero();
    if (this.heroCarouselTimer === null) this.scheduleCarousel();
    if (restoreFocus) {
      this.restoringBrowse = true;
      try { this.restoreBrowseFocus(); } finally { this.restoringBrowse = false; }
    }
  }

  // Redraws the browse layer in place, even while a grid or detail covers it.
  private paintBrowse(): void {
    const browse = this.layers.browse;
    const continueRail = this.continueRail();
    const watchlistRail = this.watchlistRail();
    const fillNote = this.fillNote();
    const hasContent = this.categories.length > 0 || !!continueRail || !!watchlistRail;
    const categorySections = this.categorySections();

    morph(browse, html`
      <div class="catalog-view catalog-browse" data-nav-container>
        ${!hasContent
          ? html`<p class="catalog-hint catalog-empty">${
              fillNote ? t('catalog.loadingCatalog') : this.emptyMessage}</p>`
          : html`
            <div class="catalog-hero" data-key="hero">${this.heroArt()}</div>
            <div class="catalog-rails" data-key="rails" data-lazy-root>
              <div class="catalog-rails-spacer catalog-hero-body" data-key="hero-body"
                   data-rail-key="hero">${this.heroText(html`${this.carouselDots()}${fillNote}`)}</div>
              <div class="catalog-rails-body" data-key="rails-body">
                ${continueRail}
                ${this.railGroups.filter((r) => this.isSmartRail(r)).map((r) => this.categoryRail(r))}
                ${watchlistRail}
                ${this.railGroups.filter((r) => !this.isSmartRail(r)).map((r) => this.categoryRail(r))}
                ${categorySections.map((section) => html`
                  <div class="catalog-rail" data-key="rail:${section.key}"
                       data-rail-key="${section.key}">
                    <h2 class="catalog-rail-title">${section.title}</h2>
                    <div class="catalog-category-grid">
                      ${section.collections.map((c) => this.collectionTile(c))}
                    </div>
                  </div>
                `)}
              </div>
            </div>
          `}
      </div>
    `);
  }

  protected renderGrid(restoreFocus = true): void {
    this.showLayer('grid');
    const gridLayer = this.layers.grid;
    const cat = this.gridCategory;
    const items = this.gridItems();
    const featured = this.categoryHero();
    const previousKey = this.focusedKey() ?? this.gridReturnKey;
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
        ${featured ? html`
          <div class="catalog-category-feature" data-key="category-feature" data-nav-container>
            <div class="catalog-hero">${this.heroArt(featured, null)}</div>
            <div class="catalog-hero-body">${this.heroText('', featured, null)}</div>
          </div>` : ''}
        ${this.gridControls()}
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
    const leading = this.gridTrackStart(view, track);
    const viewOffset = this.gridVirtualizer.scrollOffset === 0
      ? Math.min(previousView?.scrollTop ?? 0, leading)
      : this.gridVirtualizer.scrollOffset + leading;
    if (view) this.scrollGuard.syncOffset(view, 'vertical', viewOffset);
    if (featured) this.fetchHeroMeta(featured);
    if (restoreFocus) {
      this.gridReturnKey = null;
      const header = previousKey && !previousKey.startsWith('i:')
        ? this.focusableByKey(gridLayer, previousKey)
        : null;
      const firstHero = !previousView && featured
        ? gridLayer.querySelector<HTMLElement>('.catalog-hero-actions [data-focusable]')
        : null;
      const focused = header ?? firstHero ?? gridLayer.querySelector<HTMLElement>(
        `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
      );
      this.place(focused, this.placementVia());
    }
  }

  private moveGridFocus(direction: Action & ('up' | 'down' | 'left' | 'right')): boolean {
    const items = this.gridItems();
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
      const items = this.gridItems();
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
