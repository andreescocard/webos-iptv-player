import type { ManualEpgSource, PlaylistEntry, XtreamLiveCategoryFilter, XtreamLiveCategorySnapshot } from '../types';
import { html, raw, type Safe } from '../utils/dom';
import {
  REFRESH_INTERVAL_HOUR_OPTIONS,
  StorageService,
  XTREAM_CATALOG_REFRESH_HOUR_OPTIONS,
} from '../services/storage-service';
import { newLiveCategoryIds, normalizeLiveCategoryFilter } from '../utils/xtream-category-filter';
import { normalizeXtreamLiveOutputPreference } from '../utils/xtream-url';
import { isSourceEnabled } from '../utils/playlist';
import type { ThemeMeta } from '../config/themes';
import { sourceToggle } from './toggle-controls';
import { dropdown } from './dropdown';
import qrcode from 'qrcode-generator';
import {
  formatNumber,
  localeOptions,
  t,
  tp,
  type LocalePreference,
  type TextMessageKey,
} from '../i18n';
import {
  ANIMATION_MODES,
  type AnimationMode,
} from '../services/motion-service';
import {
  ADVANCED_ICON,
  APPEARANCE_ICON,
  CHEVRON_DOWN,
  CHEVRON_UP,
  CAPTIONS_ICON,
  DATABASE_ICON,
  GLOBE_ICON,
  GUIDE_ICON,
  PLAYBACK_ICON,
  SOURCES_ICON,
} from './icons';


export type EpgScopePlaylist = Pick<PlaylistEntry, 'id' | 'name' | 'url'>;

/** Generate a PNG data URL containing a QR code for the given text. */
export function qrDataUrl(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 4);
}

/** "UTC+08:00" / "UTC-05:00" / "UTC" for a feed offset in minutes. */
export function formatOffset(min: number): string {
  if (!min) return 'UTC';
  const sign = min > 0 ? '+' : '-';
  const abs = Math.abs(min);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function correctedTime(min: number): string {
  const total = 20 * 60 + min;
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

export function correctionPreview(min: number): Safe {
  return html`${t('settings.timeCorrectionExample')}: 20:00 -> ${correctedTime(min)}`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** "MyList — 12 channels" when count is known, otherwise just the name. */
export function uploadLabel(pl: PlaylistEntry): string {
  if (typeof pl.count === 'number') {
    return `${pl.name} — ${tp('channel.count', pl.count)}`;
  }
  return pl.name;
}

/** One theme swatch tile: a mini mock of the app (tab bar, a focused channel
 *  tile, list rows, status dots) plus the theme name. It carries its own
 *  `data-theme` so every `var(--…)` inside resolves to that theme's colors,
 *  independent of the app's active theme. The mock is decorative (aria-hidden);
 *  the button's aria-label names the theme. */
export function themeSwatch(theme: ThemeMeta, activeId: string): Safe {
  return html`
    <button class="theme-swatch ${theme.id === activeId ? 'active' : ''}" data-focusable
            data-theme-id="${theme.id}" data-theme="${theme.id}" aria-label="${theme.name} theme">
      <span class="theme-swatch-preview" aria-hidden="true">
        <span class="tsp-tabs">
          <span class="tsp-tab active">${t('nav.live')}</span>
          <span class="tsp-tab">${t('nav.movies')}</span>
          <span class="tsp-tab">${t('nav.series')}</span>
        </span>
        <span class="tsp-tiles">
          <span class="tsp-tile focus">ch1</span>
          <span class="tsp-tile">ch2</span>
          <span class="tsp-tile">ch3</span>
        </span>
        <span class="tsp-rows">
          <span class="tsp-row">${t('settings.previewChannelOne')}</span>
          <span class="tsp-row muted">${t('settings.previewChannelTwo')}</span>
        </span>
        <span class="tsp-foot">
          <span class="tsp-epg">${t('settings.previewEpgNow')}</span>
          <span class="tsp-dots">
            <span class="tsp-dot dn"></span>
            <span class="tsp-dot su"></span>
            <span class="tsp-dot wa"></span>
          </span>
        </span>
      </span>
      <span class="theme-swatch-name">${theme.name}</span>
    </button>`;
}

/** Preferred-subtitle-language options for the online-subtitle search ranking.
 *  '' = no preference. Endonyms render on the TV's fonts (Latin/Cyrillic/CJK/Hangul). */
export function subtitleLanguages(): { value: string; label: string }[] {
  return [
    { value: '', label: t('settings.any') },
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'zh-TW', label: '繁體中文' },
    { value: 'es', label: 'Español' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'pt', label: 'Português' },
    { value: 'ru', label: 'Русский' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
  ];
}

export function languageOptions(): { value: LocalePreference; label: string }[] {
  return [
    { value: 'system', label: t('settings.languageSystem') },
    ...localeOptions(),
  ];
}

export function languageHeading(): string {
  const localized = t('settings.language');
  return localized === 'Language' ? localized : `${localized} / Language`;
}

export function refreshIntervalOptions(): { value: string; label: string }[] {
  return REFRESH_INTERVAL_HOUR_OPTIONS.map(hours => ({
    value: String(hours),
    label: hours === 0
      ? t('common.off')
      : tp('settings.refreshHours', hours),
  }));
}

export function xtreamCatalogRefreshIntervalOptions(): { value: string; label: string }[] {
  return XTREAM_CATALOG_REFRESH_HOUR_OPTIONS.map(hours => ({
    value: String(hours),
    label: tp('settings.refreshHours', hours),
  }));
}

export const ANIMATION_MODE_LABELS: Record<AnimationMode, TextMessageKey> = {
  essential: 'settings.animationEssential',
  reduced: 'settings.animationReduced',
  full: 'settings.animationFull',
};

export function animationModeOptions(): { value: AnimationMode; label: string }[] {
  return ANIMATION_MODES.map(value => ({
    value,
    label: t(ANIMATION_MODE_LABELS[value]),
  }));
}

export function timeoutOptions(values: readonly number[]): { value: string; label: string }[] {
  return values.map(value => {
    const seconds = value / 1000;
    return {
      value: String(value),
      label: tp('settings.durationSeconds', seconds, {
        seconds: formatNumber(seconds, { maximumFractionDigits: 1 }),
      }),
    };
  });
}

export type SettingsCategory = 'general' | 'sources' | 'guide' | 'appearance'
  | 'playback' | 'subtitles' | 'data' | 'advanced';

export const SETTINGS_CATEGORIES: readonly {
  id: SettingsCategory;
  label: TextMessageKey;
  icon: Safe;
}[] = [
  {
    id: 'general',
    label: 'settings.general',
    icon: raw(GLOBE_ICON),
  },
  {
    id: 'sources',
    label: 'settings.sources',
    icon: raw(SOURCES_ICON),
  },
  {
    id: 'guide',
    label: 'settings.guide',
    icon: raw(GUIDE_ICON),
  },
  {
    id: 'appearance',
    label: 'settings.appearance',
    icon: raw(APPEARANCE_ICON),
  },
  {
    id: 'playback',
    label: 'settings.playback',
    icon: raw(PLAYBACK_ICON),
  },
  {
    id: 'subtitles',
    label: 'settings.onlineSubtitles',
    icon: raw(CAPTIONS_ICON),
  },
  {
    id: 'advanced',
    label: 'settings.advanced',
    icon: raw(ADVANCED_ICON),
  },
  {
    id: 'data',
    label: 'settings.dataManagement',
    icon: raw(DATABASE_ICON),
  },
];

export function settingsNavItem(category: typeof SETTINGS_CATEGORIES[number], active: boolean): Safe {
  return html`
    <button class="settings-nav-item ${active ? 'active' : ''}" data-focusable
            data-settings-target="${category.id}">
      <span class="settings-nav-icon">${category.icon}</span>
      <span>${t(category.label)}</span>
    </button>
  `;
}

export function disabledDropdown(id: string, label: string): Safe {
  return html`
    <div class="dropdown epg-offset-unavailable" id="${id}" data-value="">
      <span class="dropdown-sizer" aria-hidden="true"><span>${label}</span></span>
      <button class="dropdown-trigger" disabled>
        <span class="dropdown-current">${label}</span>
        <span class="dropdown-caret"></span>
      </button>
    </div>`;
}

export function uploadRow(pl: PlaylistEntry, enabled = isSourceEnabled(pl)): Safe {
    return html`
      <div class="settings-row ${enabled ? '' : 'source-disabled'}"
           data-key="${pl.url}" data-id="${pl.id}" data-source-entry>
        <div class="settings-field wide">
          <label>${uploadLabel(pl)}</label>
        </div>
        ${sourceToggle(enabled)}
        <button class="btn btn-danger remove-upload" data-focusable
                data-url="${pl.url}">${t('common.remove')}</button>
      </div>
    `;
}

export function withEnabledState(entry: PlaylistEntry, enabled: boolean): PlaylistEntry {
  if (!enabled) return { ...entry, enabled: false };
  const copy = { ...entry };
  delete copy.enabled;
  return copy;
}

/** The card button's summary: "All", "{kept} of {total}" when the catalog
 *  size is known, and a badge for categories the user has not reviewed. */
export function liveCategoriesButtonContent(
  filter: XtreamLiveCategoryFilter | undefined,
  snapshot: XtreamLiveCategorySnapshot | null,
  catalogIds?: readonly string[],
): Safe {
  const ids = catalogIds ?? (snapshot ? Object.keys(snapshot.counts) : []);
  let value = '';
  if (!filter) {
    value = t('liveCategories.all');
  } else if (ids.length) {
    const listed = new Set(filter.ids);
    const matched = ids.filter(id => listed.has(id)).length;
    value = t('liveCategories.summary', {
      count: filter.mode === 'include' ? matched : ids.length - matched,
      total: ids.length,
    });
  }
  const fresh = newLiveCategoryIds(filter, snapshot, snapshot ? Object.keys(snapshot.counts) : []).length;
  return html`<span>${t('liveCategories.title')}</span>${value
    ? html`<span class="xtream-live-categories-value">${value}</span>` : ''}${fresh
    ? html`<em class="xtream-live-categories-new">${tp('liveCategories.newBadge', fresh)}</em>` : ''}`;
}

/** One editable Xtream account: its fields grouped in a card
 *  keyed by the entry's stable id. Untrusted values interpolate through `html`. */
export function xtreamCard(pl: Partial<PlaylistEntry>) {
  const liveOutput = normalizeXtreamLiveOutputPreference(pl.xtream?.liveOutput);
  const enabled = pl.enabled !== false;
  return html`
    <div class="xtream-card ${enabled ? '' : 'source-disabled'}"
         data-id="${pl.id || ''}" data-source-entry>
      <div class="xtream-fields">
        <div class="settings-field">
          <label>${t('settings.label')}</label>
          <input type="text" class="settings-input xtream-name" data-focusable
                 aria-label="${t('settings.accountLabel')}" placeholder="${t('settings.myProvider')}" value="${pl.name || ''}">
        </div>
        <div class="settings-field wide">
          <label>${t('settings.serverUrl')}</label>
          <input type="url" class="settings-input xtream-url" data-focusable
                 aria-label="${t('settings.serverUrl')}" placeholder="http://host:port" value="${pl.url || ''}">
        </div>
        <div class="settings-field">
          <label>${t('settings.username')}</label>
          <input type="text" class="settings-input xtream-username" data-focusable
                 aria-label="${t('settings.username')}" placeholder="username" value="${pl.xtream?.username || ''}">
        </div>
        <div class="settings-field">
          <label>${t('settings.password')}</label>
          <input type="password" class="settings-input xtream-password" data-focusable
                 aria-label="${t('settings.password')}" placeholder="password" value="${pl.xtream?.password || ''}">
        </div>
        <div class="settings-field xtream-output">
          <label>${t('settings.streamFormat')}</label>
          ${dropdown(`xtream-output-${pl.id || ''}`, [
            { value: 'ts', label: t('settings.streamFormatTs') },
            { value: 'm3u8', label: t('settings.streamFormatHls') },
            { value: 'auto', label: t('settings.streamFormatAuto') },
          ], liveOutput)}
        </div>
      </div>
      <div class="xtream-card-foot">
        ${sourceToggle(enabled)}
        <button class="btn btn-secondary check-xtream" data-focusable>${t('settings.check')}</button>
        <button class="btn btn-secondary xtream-live-categories" data-focusable>${liveCategoriesButtonContent(
          normalizeLiveCategoryFilter(pl.xtream?.liveCategories),
          pl.id ? StorageService.getLiveCategorySnapshot(pl.id) : null,
        )}</button>
        <button class="btn btn-danger remove-xtream" data-focusable>${t('common.remove')}</button>
        <div class="xtream-status"></div>
      </div>
    </div>`;
}

export function manualEpgSourceRow(
  source: ManualEpgSource,
  playlists: EpgScopePlaylist[],
  index: number,
  sourceCount: number,
): Safe {
  const canMoveEarlier = index > 0;
  const canMoveLater = index < sourceCount - 1;
  const key = manualEpgKey(index);
  return html`
    <div class="manual-epg-source" data-manual-epg-source data-key="${key}">
      <div class="manual-epg-source-head">
        <span class="manual-epg-priority">${index + 1}</span>
        <input type="url" class="settings-input manual-epg-url" data-focusable
               aria-label="${t('settings.xmltvUrl')}" value="${source.url}"
               placeholder="http://host/guide.xml">
        <button class="btn btn-secondary move-epg-earlier" data-key="${key}:earlier"
                ${raw(canMoveEarlier ? 'data-focusable' : 'disabled')}
                aria-label="${t('settings.moveEarlier')}">${raw(CHEVRON_UP)}</button>
        <button class="btn btn-secondary move-epg-later" data-key="${key}:later"
                ${raw(canMoveLater ? 'data-focusable' : 'disabled')}
                aria-label="${t('settings.moveLater')}">${raw(CHEVRON_DOWN)}</button>
        <button class="btn btn-danger remove-epg-source" data-focusable data-key="${key}:remove">
          ${t('common.remove')}
        </button>
      </div>
      <div class="manual-epg-scope">
        <span class="manual-epg-scope-label">${t('settings.epgAppliesTo')}</span>
        ${manualEpgScopeOptions(source, playlists, key)}
      </div>
    </div>`;
}

export function manualEpgKey(index: number): string {
  return `manual-epg-${index}`;
}

export function manualEpgScopeOptions(
  source: ManualEpgSource,
  playlists: EpgScopePlaylist[],
  rowKey: string,
): Safe {
  const allPlaylists = source.playlistIds.length === 0;
  return html`
    <div class="manual-epg-scope-options">
      <button class="epg-scope-option ${allPlaylists ? 'active' : ''}"
              data-focusable data-scope-all data-key="${rowKey}:all">
        ${t('settings.allPlaylists')}
      </button>
      ${playlists.map(playlist => html`
        <button class="epg-scope-option ${
          source.playlistIds.includes(playlist.id) ? 'active' : ''
        }" data-focusable data-playlist-id="${playlist.id}"
                data-key="${rowKey}:playlist:${playlist.id}">
          ${playlist.name || playlist.url}
        </button>
      `)}
    </div>`;
}

/** "expires 2026-08-01" (UTC) or "never expires" for a unix-seconds expiry. */
export function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return t('settings.neverExpires');
  const d = new Date(expiresAt * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return t('settings.expires', {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
  });
}

/** What the app does after Settings closes: reload = re-fetch playlist/EPG;
 *  apply = re-render for display-only changes; reset = erase local app data;
 *  edit-channels = open the channel list in edit mode; cancel = discard. */
export type SaveAction = 'reload' | 'apply' | 'reset' | 'cancel' | 'edit-channels';
