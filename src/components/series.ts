import type { Action, PlaylistEntry, SeriesCategory, SeriesItem, SeriesInfo, Episode, ResumeEntry, ResumeKind, VodQueueItem, WatchlistEntry } from '../types';
import { html, raw, Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { loadSeriesCategories, loadSeries, loadSeriesInfo } from '../services/xtream-catalog';
import { xtreamEpisodeUrl, type XtreamCredentials } from '../utils/xtream-url';
import { CatalogView, buildFacts, catalogButton, catalogFacts, type CatalogAction, type CatalogHandlers, type HeroMeta, type TrailerTarget } from './catalog-view';
import { PLAY_ICON, watchlistIcon } from './icons';
import { showToast } from './toast';
import { t, tp } from '../i18n';
import { VirtualList } from '../utils/virtual-list';
import { lazySrc } from '../utils/lazy-images';
import { cleanEpisodeTitle, episodeLine, parseEpisodeName } from '../utils/episode-name';

const EPISODE_GAP = 16;
const EPISODE_NO_PLOT_ESTIMATE = 138;
const EPISODE_PLOT_ESTIMATE = 216;
// A row with a 16:9 still is at least the still's height plus the row padding.
const EPISODE_THUMB_ESTIMATE = 206;
const EPISODE_OVERSCAN = 5;
// The whole detail page scrolls, so the fallback is the page viewport, not the
// space left under the header.
const EPISODE_VIEWPORT_FALLBACK = 984;

// The Series section: browse (Continue rail of resumed episodes + per-category
// rails + an "all categories" drill-in) → per-category poster grid → a detail
// screen with a season selector over an episode list. The browse/grid/nav
// machinery lives in CatalogView.
function seriesMinutes(info: SeriesInfo): string {
  return info.episodeRunTimeMins > 0 ? t('catalog.minutes', { count: info.episodeRunTimeMins }) : '';
}

export class Series extends CatalogView<SeriesCategory, SeriesItem> {
  protected get kicker(): string { return t('common.series'); }
  protected readonly resumeKind: ResumeKind = 'episode';
  protected readonly parentalKind = 'series' as const;
  protected scopeName(): string { return 'series'; }
  protected get emptyMessage(): string { return t('catalog.noSeries'); }
  protected get gridEmptyMessage(): string { return t('catalog.noSeriesCategory'); }
  protected itemCount(count: number): string { return tp('catalog.seriesCount', count); }

  private currentSeries: SeriesItem | null = null;
  private currentInfo: SeriesInfo | null = null;
  private selectedSeason = 0;
  private detailLoading = false;
  private episodeFocusIndex = 0;
  private episodeSource: Episode[] | null = null;
  private measuredEpisodes = new Set<number>();
  private detailController: AbortController | null = null;
  private readonly episodeVirtualizer = new VirtualList({
    overscan: EPISODE_OVERSCAN,
    fallbackViewportSize: EPISODE_VIEWPORT_FALLBACK,
  });
  private episodeScrollFrame: number | null = null;
  // A held key's reveal writes the list's offset without a smooth scroll.
  private instantEpisodeScroll = false;
  private heroPlayRequest = 0;

  constructor(container: HTMLElement, handlers: CatalogHandlers) {
    super(container, handlers);
  }

  protected loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<SeriesCategory[]> {
    return loadSeriesCategories(account, signal);
  }
  protected loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<SeriesItem[]> {
    return loadSeries(account, categoryId, signal);
  }
  protected itemId(s: SeriesItem): string { return s.seriesId; }
  protected itemName(s: SeriesItem): string { return s.name; }
  protected itemPoster(s: SeriesItem): string { return s.poster; }
  protected itemCategoryId(s: SeriesItem): string { return s.categoryId; }
  protected itemRating(s: SeriesItem): string { return s.rating; }

  protected async loadHeroMeta(
    account: PlaylistEntry,
    series: SeriesItem,
    signal: AbortSignal,
  ): Promise<HeroMeta | null> {
    const info = await loadSeriesInfo(account, series.seriesId, signal);
    if (!info) return null;
    return {
      backdrop: info.backdrop || '',
      plot: info.plot,
      genre: info.genre,
      year: info.year ? String(info.year) : '',
      rating: info.rating,
      duration: seriesMinutes(info),
      trailer: info.trailer,
      tmdbId: info.tmdbId,
    };
  }

  protected detailItem(): SeriesItem | null { return this.currentSeries; }

  protected trailerTarget(series: SeriesItem): TrailerTarget | null {
    const info = this.currentSeries === series ? this.currentInfo : null;
    const meta = this.heroMeta(series);
    return {
      kind: 'tv',
      title: series.name,
      year: info?.year ? String(info.year) : meta?.year,
      panelTrailer: info?.trailer ?? meta?.trailer,
      genre: info?.genre || meta?.genre || undefined,
      category: this.categories.find(c => c.id === series.categoryId)?.name,
      tmdbId: info?.tmdbId || meta?.tmdbId || undefined,
    };
  }

  // The most recent episode of this series left part-watched, if any.
  private resumeFor(series: SeriesItem): ResumeEntry | null {
    const focused = this.heroResume;
    if (focused?.watchlistOwner?.itemId === series.seriesId) return focused;
    return this.resume.find((r) => r.watchlistOwner?.kind === 'series'
      && r.watchlistOwner.itemId === series.seriesId) ?? null;
  }

  protected heroPlayLabel(series: SeriesItem): string {
    return t(this.resumeFor(series) ? 'common.resume' : 'catalog.play');
  }

  // Resumes the series where it was left, else plays its first episode; a
  // series without episodes opens its detail screen instead.
  protected playFromHero(series: SeriesItem): void {
    const resume = this.resumeFor(series);
    if (resume) {
      this.playResume(resume.itemId);
      return;
    }
    const account = this.account;
    const signal = this.requestSignal;
    if (!account || !signal) return;
    const request = ++this.heroPlayRequest;
    void loadSeriesInfo(account, series.seriesId, signal)
      .catch((): SeriesInfo | null => null)
      .then((info) => {
        if (signal.aborted || request !== this.heroPlayRequest || this.account?.id !== account.id) return;
        const first = info?.seasons.length ? (info.episodesBySeason[info.seasons[0]] ?? [])[0] : undefined;
        if (!info || !first) {
          void this.openDetail(series);
          return;
        }
        const saved = StorageService.getResume(account.id, 'episode', first.id);
        this.handlers.onPlayVod({
          ...this.episodePlayback(series, first),
          resumeSecs: saved && !saved.watched ? saved.position : 0,
          episodeQueue: this.episodesAfter(info, first.id, series),
        });
      });
  }
  protected clearDetail(): void {
    this.detailController?.abort();
    this.detailController = null;
    this.currentSeries = null;
  }
  protected onRequestSessionReset(): void {
    this.detailController?.abort();
    this.detailController = null;
  }

  protected continueRail(): Safe | '' {
    return this.resume.length
      ? this.rail('continue', t('catalog.continueWatching'), this.resume.map((r) => this.resumeTile(r)))
      : '';
  }

  protected watchlistRail(): Safe | '' {
    const entries = this.visibleWatchlist('series');
    return entries.length
      ? this.rail('watchlist', t('common.watchlist'), entries.map((entry) => this.tile(this.watchlistEntryToSeries(entry))))
      : '';
  }

  protected fallbackItem(seriesId: string): SeriesItem | null {
    const entry = this.visibleWatchlist('series')
      .find((item) => item.itemId === seriesId);
    return entry ? this.watchlistEntryToSeries(entry) : null;
  }

  protected heroFromResume(): SeriesItem | null {
    for (const r of this.resume) {
      const owner = r.watchlistOwner;
      if (owner?.kind !== 'series') continue;
      const found = this.findItem(r.categoryId ?? '', owner.itemId);
      if (found) return found;
    }
    return null;
  }

  protected heroFallback(): SeriesItem | null {
    const entry = this.visibleWatchlist('series')[0];
    return entry ? this.watchlistEntryToSeries(entry) : null;
  }

  private watchlistEntryToSeries(entry: WatchlistEntry): SeriesItem {
    return {
      accountId: entry.accountId,
      seriesId: entry.itemId,
      name: entry.name,
      poster: entry.poster,
      rating: entry.rating,
      categoryId: entry.categoryId,
    };
  }

  protected selectExtra(el: HTMLElement): boolean {
    if (el.dataset.action === 'watchlist') { this.toggleWatchlist(); return true; }
    if (el.dataset.resumeEpisode !== undefined) { this.playResume(el.dataset.resumeEpisode); return true; }
    if (el.dataset.season !== undefined) { this.selectSeason(Number(el.dataset.season)); return true; }
    if (el.dataset.episodeId !== undefined) { this.playEpisode(el.dataset.episodeId); return true; }
    return false;
  }

  private toggleWatchlist(): void {
    const series = this.currentSeries;
    const account = this.account;
    if (!series || !account) return;
    const added = StorageService.toggleWatchlist({
      accountId: account.id,
      kind: 'series',
      itemId: series.seriesId,
      name: series.name,
      poster: this.currentInfo?.poster || series.poster,
      rating: this.currentInfo?.rating || series.rating,
      categoryId: series.categoryId,
      addedAt: Date.now(),
    });
    showToast(t(added ? 'catalog.watchlistAdded' : 'catalog.watchlistRemoved'));
    this.renderDetail();
  }

  protected async openDetail(series: SeriesItem): Promise<void> {
    const account = this.account;
    if (!account || !this.requestSignal) return;
    this.detailController?.abort();
    this.detailController = new AbortController();
    const signal = this.detailController.signal;
    this.currentSeries = series;
    this.enterDetail();
    this.currentInfo = null;
    this.selectedSeason = 0;
    this.episodeFocusIndex = 0;
    this.episodeSource = null;
    this.episodeVirtualizer.setScrollOffset(0);
    this.detailLoading = true;
    this.renderDetail();
    try {
      this.currentInfo = await loadSeriesInfo(account, series.seriesId, signal);
    } catch (err) {
      if (!this.requestFailed('Series detail load', err, signal)) return;
      this.currentInfo = null;
    }
    if (this.mode === 'detail' && this.currentSeries === series) {
      this.detailLoading = false;
      this.selectedSeason = this.currentInfo?.seasons[0] ?? 0;
      this.renderDetail();
    }
  }

  private selectSeason(season: number): void {
    this.selectedSeason = season;
    this.episodeFocusIndex = 0;
    this.episodeSource = null;
    this.episodeVirtualizer.setScrollOffset(0);
    this.renderDetail();
  }

  // Back from the player on a finished episode: focus moves on to the one the
  // series now continues with, in its own season.
  protected refreshDetailPlayback(): void {
    const a = this.account;
    const series = this.currentSeries;
    const info = this.currentInfo;
    const key = this.focusedKey();
    const focused = key?.startsWith('ep:') ? key.slice(3) : null;
    const next = a && series && info && focused !== null
      && StorageService.getResume(a.id, 'episode', focused)?.watched
      ? StorageService.getResumeList(a.id).find((r) => r.kind === 'episode'
        && r.watchlistOwner?.kind === 'series' && r.watchlistOwner.itemId === series.seriesId)
      : undefined;
    const season = next && info
      ? info.seasons.find((n) => (info.episodesBySeason[n] ?? []).some((ep) => ep.id === next.itemId))
      : undefined;
    if (!next || season === undefined) {
      this.renderDetail();
      return;
    }
    if (season !== this.selectedSeason) {
      this.selectedSeason = season;
      this.episodeSource = null;
      this.episodeVirtualizer.setScrollOffset(0);
      // Sizes the new season's list before it is scrolled.
      this.renderDetail(false);
    }
    const index = this.selectedEpisodes().findIndex((ep) => ep.id === next.itemId);
    const list = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    this.episodeFocusIndex = index;
    this.episodeVirtualizer.ensureVisible(index, list?.clientHeight || EPISODE_VIEWPORT_FALLBACK);
    this.renderDetail(false);
    this.place(
      this.layer('detail').querySelector<HTMLElement>(
        `[data-episode-index="${index}"] [data-focusable]`,
      ),
      this.placementVia(),
    );
  }

  private findEpisode(episodeId: string): Episode | null {
    const info = this.currentInfo;
    if (!info) return null;
    for (const season of info.seasons) {
      const ep = (info.episodesBySeason[season] ?? []).find((e) => e.id === episodeId);
      if (ep) return ep;
    }
    return null;
  }

  private episodeLabel(series: SeriesItem, ep: Episode): string {
    const code = `S${ep.season}E${ep.episode}`;
    const title = cleanEpisodeTitle(ep.title, series.name);
    return title ? `${series.name} — ${code} — ${title}` : `${series.name} — ${code}`;
  }

  private episodePlayback(series: SeriesItem, ep: Episode): VodQueueItem {
    const a = this.account!;
    return {
      url: xtreamEpisodeUrl(this.creds(), ep.id, ep.containerExtension || 'mp4'),
      title: this.episodeLabel(series, ep),
      poster: ep.poster || series.poster,
      accountId: a.id,
      itemId: ep.id,
      kind: 'episode',
      categoryId: series.categoryId,
      parentalItemId: series.seriesId,
      subtitles: ep.subtitles,
      searchMeta: { season: ep.season, episode: ep.episode },
      watchlistOwner: { kind: 'series', itemId: series.seriesId },
    };
  }

  private episodesAfter(info: SeriesInfo | null, episodeId: string, series: SeriesItem): VodQueueItem[] {
    if (!info) return [];
    const episodes = info.seasons.reduce<Episode[]>(
      (all, season) => all.concat(info.episodesBySeason[season] ?? []), []);
    const index = episodes.findIndex((ep) => ep.id === episodeId);
    return index < 0 ? [] : episodes.slice(index + 1).map((ep) => this.episodePlayback(series, ep));
  }

  private playEpisode(episodeId: string): void {
    const ep = this.findEpisode(episodeId);
    const series = this.currentSeries;
    const a = this.account;
    if (!ep || !series || !a) return;
    const saved = StorageService.getResume(a.id, 'episode', ep.id);
    this.handlers.onPlayVod({
      ...this.episodePlayback(series, ep),
      resumeSecs: saved && !saved.watched ? saved.position : 0,
      episodeQueue: this.episodesAfter(this.currentInfo, ep.id, series),
    });
  }

  private creds(): XtreamCredentials {
    const a = this.account!;
    return { baseUrl: a.url, username: a.xtream!.username, password: a.xtream!.password };
  }

  // A Continue-rail tile carries only the resume entry (episode id + composed
  // label + poster + stored container extension), not the owning series, so it
  // resumes the episode directly using the stored ext (falling back to mp4).
  private playResume(episodeId: string): void {
    const a = this.account;
    const r = this.resume.find((e) => e.itemId === episodeId);
    if (!a || !r) return;
    const play = (episodeQueue: VodQueueItem[] | undefined): void => this.handlers.onPlayVod({
      url: xtreamEpisodeUrl(this.creds(), r.itemId, r.ext || 'mp4'),
      title: r.name,
      poster: r.poster,
      accountId: a.id,
      itemId: r.itemId,
      kind: 'episode',
      categoryId: r.categoryId,
      parentalItemId: r.watchlistOwner?.itemId,
      resumeSecs: r.position,
      subtitles: [],
      episodeQueue,
      watchlistOwner: r.watchlistOwner,
    });
    const series = this.resumeHeroItem(r);
    const signal = this.requestSignal;
    if (r.episodeQueue || !series || !signal) {
      play(r.episodeQueue);
      return;
    }
    // An entry saved without its queue rebuilds it, so finishing it still moves on.
    const request = ++this.heroPlayRequest;
    void loadSeriesInfo(a, series.seriesId, signal)
      .catch((): SeriesInfo | null => null)
      .then((info) => {
        if (signal.aborted || request !== this.heroPlayRequest || this.account?.id !== a.id) return;
        play(info ? this.episodesAfter(info, r.itemId, series) : undefined);
      });
  }

  protected resumeHeroItem(r: ResumeEntry): SeriesItem | null {
    const ownerId = r.watchlistOwner?.itemId;
    if (!ownerId) return null;
    return this.findItem(r.categoryId ?? '', ownerId) ?? {
      accountId: r.accountId,
      seriesId: ownerId,
      name: parseEpisodeName(r.name).series,
      poster: '',
      rating: '',
      categoryId: r.categoryId ?? '',
    };
  }

  // A resumed episode's own still when it has one; otherwise the series art.
  protected heroResumeArt(series: SeriesItem, r: ResumeEntry): string {
    return r.poster && r.poster !== series.poster ? r.poster : '';
  }

  protected heroResumeNote(_series: SeriesItem, r: ResumeEntry): Safe | '' {
    const label = episodeLine(parseEpisodeName(r.name));
    if (!label) return '';
    return html`
      <div class="catalog-hero-episode" data-key="hero-episode">
        <div class="catalog-hero-episode-name">${label}</div>
      </div>`;
  }

  private resumeTile(r: ResumeEntry): Safe {
    const parsed = parseEpisodeName(r.name);
    const label = episodeLine(parsed);
    return html`
      <div class="catalog-tile" data-focusable data-key="r:${r.itemId}" data-resume-episode="${r.itemId}">
        <div class="catalog-poster-wrap">${this.posterCell(r.name, r.poster)}${
          this.itemLockBadge(r.categoryId ?? '', r.watchlistOwner?.itemId ?? r.itemId)}${this.progressBar(r)}</div>
        ${label
          ? html`<div class="catalog-tile-name">${parsed.series}</div><div class="catalog-tile-episode">${label}</div>`
          : html`<div class="catalog-tile-name">${r.name}</div>`}
      </div>
    `;
  }

  // A 16:9 still with the play badge over it, and how far it was watched.
  // A still that fails to load leaves the neutral frame and the badge.
  private episodeThumb(ep: Episode, saved: ResumeEntry | null): Safe {
    const duration = saved ? saved.duration || ep.durationSecs : 0;
    const progress = saved?.watched ? 100 : saved && duration > 0 ? Math.min(100, Math.round((saved.position / duration) * 100)) : 0;
    return html`
      <div class="episode-thumb">
        <img class="episode-thumb-img" ${lazySrc(ep.poster)} alt="" onerror="this.style.display='none'">
        <span class="episode-thumb-play">${raw(PLAY_ICON)}</span>
        ${progress > 0 ? html`
          <div class="episode-progress"><div class="episode-progress-fill" style="width:${progress}%"></div></div>` : ''}
      </div>
    `;
  }

  private episodeRow(accountId: string, ep: Episode): Safe {
    const saved = StorageService.getResume(accountId, 'episode', ep.id);
    const mins = ep.durationSecs > 0 ? t('catalog.minutes', { count: Math.floor(ep.durationSecs / 60) }) : '';
    return html`
      <div class="episode-row ${ep.poster ? 'episode-row-thumb' : ''}" data-focusable data-key="ep:${ep.id}"
           data-episode-id="${ep.id}">
        ${ep.poster ? this.episodeThumb(ep, saved) : html`<span class="episode-badge">${raw(PLAY_ICON)}</span>`}
        <div class="episode-body">
          <div class="episode-title">
            <span class="episode-num">E${ep.episode}</span>
            <span class="episode-name">${ep.title}</span>
            ${saved?.watched ? html`<span class="episode-resume">${t('epg.watched')}</span>`
              : saved ? html`<span class="episode-resume">${t('common.resume')}</span>` : ''}
          </div>
          ${mins ? html`<div class="episode-meta">${mins}</div>` : ''}
          ${ep.plot ? html`<p class="episode-plot">${ep.plot}</p>` : ''}
        </div>
      </div>
    `;
  }

  protected renderDetail(restoreFocus = true): void {
    const series = this.currentSeries;
    const a = this.account;
    if (!series || !a) return;
    const info = this.currentInfo;
    const episodes = info ? (info.episodesBySeason[this.selectedSeason] ?? []) : [];
    const poster = info?.poster || series.poster;
    const year = info?.year ? String(info.year) : '';
    const facts = buildFacts({
      rating: info?.rating || series.rating,
      year,
      duration: info ? seriesMinutes(info) : '',
      genre: info?.genre,
    });
    if (episodes !== this.episodeSource) {
      this.episodeSource = episodes;
      this.measuredEpisodes.clear();
      this.episodeVirtualizer.setItemSizes(episodes.map(ep => Math.max(
        ep.plot ? EPISODE_PLOT_ESTIMATE : EPISODE_NO_PLOT_ESTIMATE,
        ep.poster ? EPISODE_THUMB_ESTIMATE : 0)));
    }
    const focusedKey = this.focusedKey();
    const watchlisted = StorageService.isWatchlisted(a.id, 'series', series.seriesId);
    const actions: CatalogAction[] = [{
      id: 'watchlist',
      label: t(watchlisted ? 'catalog.removeWatchlist' : 'catalog.addWatchlist'),
      icon: watchlistIcon(watchlisted),
    }];
    const previousScroller = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    const previousEpisodes = this.layer('detail').querySelector<HTMLElement>('.series-episodes');
    this.episodeVirtualizer.setLeadingSize(
      this.episodeListStart(previousScroller, previousEpisodes),
    );
    if (restoreFocus && previousScroller) {
      this.episodeVirtualizer.setScrollOffset(previousScroller.scrollTop);
    }
    const episodeViewport = previousScroller?.clientHeight || EPISODE_VIEWPORT_FALLBACK;
    const focusedEpisodeIndex = focusedKey === null ? -1 : this.episodeIndexOf(focusedKey);
    if (restoreFocus && focusedEpisodeIndex >= 0) this.episodeFocusIndex = focusedEpisodeIndex;
    this.episodeFocusIndex = Math.max(0, Math.min(this.episodeFocusIndex, episodes.length - 1));
    if (restoreFocus && focusedEpisodeIndex >= 0 && episodes.length) {
      this.episodeVirtualizer.ensureVisible(this.episodeFocusIndex, episodeViewport);
    }
    const episodeRange = this.episodeVirtualizer.getRange(episodes.length, episodeViewport);

    morph(this.layer('detail'), html`
      <div class="catalog-view series-detail" data-nav-container data-lazy-root>
        <div class="series-detail-head">
          <div class="detail-poster-wrap series-detail-poster">${this.posterCell(series.name, poster)}</div>
          <div class="detail-body">
            <h1 class="detail-title">${series.name}</h1>
            ${facts.length ? html`<div class="detail-meta">${catalogFacts(facts)}</div>` : ''}
            ${this.detailPlot(info?.plot ?? '')}
            ${info?.cast ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.cast')}</span> ${info.cast}</div>` : ''}
            ${info?.director ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.director')}</span> ${info.director}</div>` : ''}
            <div class="detail-actions">
              ${actions.concat(this.extraDetailActions()).map((action) => catalogButton(action, 'detail'))}
            </div>
            ${this.detailLoading
              ? html`<p class="catalog-hint">${t('common.loading')}</p>`
              : !info
                ? html`<p class="catalog-hint">${t('catalog.loadEpisodesFailed')}</p>`
                : info.seasons.length === 0
                  ? html`<p class="catalog-hint">${t('catalog.noEpisodes')}</p>`
                  : html`
                  <div class="series-seasons">
                    ${info.seasons.map((n) => html`
                      <button class="series-season-btn ${n === this.selectedSeason ? 'active' : ''}"
                              data-focusable data-key="season:${n}" data-season="${n}">${t('catalog.season', { number: n })}</button>
                    `)}
                  </div>
                `}
          </div>
        </div>
        ${info && info.seasons.length > 0 ? html`
          <div class="series-episodes">
            ${episodes.length === 0
              ? html`<p class="catalog-hint">${t('catalog.noSeasonEpisodes')}</p>`
              : html`
                <div class="series-episodes-spacer"
                     style="height:${this.episodeVirtualizer.getTotalSize(episodes.length)}px">
                  ${episodes.slice(episodeRange.start, episodeRange.end).map((ep, offset) => {
                    const index = episodeRange.start + offset;
                    return html`
                      <div class="series-episode-cell"
                           data-key="episode-cell:${ep.id}"
                           data-episode-index="${index}"
                           style="top:${this.episodeVirtualizer.getItemOffset(index)}px">
                        ${this.episodeRow(a.id, ep)}
                      </div>
                    `;
                  })}
                </div>
              `}
          </div>
        ` : ''}
      </div>
    `);
    if (this.measureDetailPlot()) return;
    const measuredSizes = Array.from(
      this.layer('detail').querySelectorAll<HTMLElement>('.series-episode-cell'),
    ).map(cell => ({
      cell,
      index: parseInt(cell.dataset.episodeIndex || '-1', 10),
    })).filter(item => item.index >= 0 && !this.measuredEpisodes.has(item.index))
      .map((item) => {
        this.measuredEpisodes.add(item.index);
        const row = item.cell.querySelector<HTMLElement>('.episode-row');
        return {
          index: item.index,
          size: row ? row.getBoundingClientRect().height + EPISODE_GAP : 0,
        };
      }).filter(item => item.index >= 0 && item.size > EPISODE_GAP);
    if (this.episodeVirtualizer.updateItemSizes(measuredSizes)) {
      this.renderDetail(restoreFocus);
      return;
    }
    const episodeList = this.layer('detail').querySelector<HTMLElement>('.series-episodes');
    const scroller = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    if (scroller) {
      this.episodeVirtualizer.setLeadingSize(this.episodeListStart(scroller, episodeList));
      this.scrollGuard.syncOffset(
        scroller,
        'vertical',
        this.episodeVirtualizer.scrollOffset,
        this.instantEpisodeScroll,
      );
    }
    if (restoreFocus) this.settleDetailFocus();
  }

  private selectedEpisodes(): Episode[] {
    return this.currentInfo?.episodesBySeason[this.selectedSeason] ?? [];
  }

  private episodeIndexOf(key: string): number {
    return this.selectedEpisodes().findIndex((ep) => `ep:${ep.id}` === key);
  }

  protected hasExtraKey(key: string): boolean {
    return this.episodeIndexOf(key) >= 0;
  }

  // An episode the list scrolled away renders again before it is shown.
  protected revealExtraKey(key: string, instant: boolean): boolean | null | undefined {
    const index = this.episodeIndexOf(key);
    if (index < 0 || this.layer('detail').querySelector(`[data-episode-index="${index}"]`)) {
      return undefined;
    }
    const list = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    const viewport = list?.clientHeight || EPISODE_VIEWPORT_FALLBACK;
    this.episodeFocusIndex = index;
    this.episodeVirtualizer.ensureVisible(index, viewport);
    if (instant) this.instantEpisodeScroll = true;
    try {
      this.renderDetail(false);
      // The render measured the rows the estimate had placed it by.
      if (this.episodeVirtualizer.ensureVisible(index, viewport)) this.renderDetail(false);
    } finally {
      this.instantEpisodeScroll = false;
    }
    return true;
  }

  protected moveExtraFocus(action: Action): boolean {
    if (this.mode !== 'detail' || (action !== 'up' && action !== 'down')) return false;
    const key = this.focusedKey();
    const current = key === null ? -1 : this.episodeIndexOf(key);
    if (current < 0) return false;
    const episodes = this.selectedEpisodes();
    const next = current + (action === 'up' ? -1 : 1);
    if (next < 0 || next >= episodes.length) return false;
    const list = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    this.episodeFocusIndex = next;
    this.episodeVirtualizer.ensureVisible(
      next,
      list?.clientHeight || EPISODE_VIEWPORT_FALLBACK,
    );
    this.renderDetail(false);
    this.place(
      this.layer('detail').querySelector<HTMLElement>(
        `[data-episode-index="${next}"] [data-focusable]`,
      ),
      'key',
    );
    return true;
  }

  protected handleExtraScroll(target: HTMLElement): boolean {
    if (this.mode !== 'detail' || !target.classList.contains('series-detail')) return false;
    const offset = this.scrollGuard.readUserOffset(target, 'vertical');
    if (offset === null) return true;
    this.episodeVirtualizer.setScrollOffset(offset);
    if (this.episodeScrollFrame === null) {
      this.episodeScrollFrame = requestAnimationFrame(() => {
        this.episodeScrollFrame = null;
        if (this.mode === 'detail') this.renderDetail(false);
      });
    }
    return true;
  }

  // Where the episode list starts inside the scrolling detail page, i.e. the
  // header the virtualizer has to skip before item 0. Both share an
  // offsetParent (the page is statically positioned), so the difference is the
  // in-content distance and stays correct while the page is scrolled.
  private episodeListStart(
    scroller: HTMLElement | null,
    list: HTMLElement | null,
  ): number {
    if (!scroller || !list) return 0;
    const top = list.offsetParent === scroller
      ? list.offsetTop
      : list.offsetTop - scroller.offsetTop;
    return Math.max(0, top);
  }
}
