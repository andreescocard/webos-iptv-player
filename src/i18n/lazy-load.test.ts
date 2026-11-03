// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CATALOGS } from './catalogs';

type I18n = typeof import('./index');
type LocaleWindow = Window & { __iptvLocales?: Record<string, unknown> };

// A fresh module holds only English, as the shipped app bundle does.
async function freshI18n(): Promise<I18n> {
  vi.resetModules();
  return import('./index');
}

function lastScript(): HTMLScriptElement {
  const scripts = document.head.querySelectorAll('script');
  return scripts[scripts.length - 1];
}

describe('locale catalogs loaded on demand', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    delete (window as LocaleWindow).__iptvLocales;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ships only English until a catalog is loaded', async () => {
    const i18n = await freshI18n();
    expect(i18n.isLocaleLoaded('en')).toBe(true);
    expect(i18n.isLocaleLoaded('de')).toBe(false);
    i18n.setLocale('de');
    expect(i18n.t('channel.recentlyWatched')).toBe('Recently Watched');
    expect(i18n.tp('channel.count', 2)).toBe('2 channels');
  });

  it('loads the locale script once and applies its catalog', async () => {
    const i18n = await freshI18n();
    const first = i18n.applyLocale('de');
    const second = i18n.loadLocale('de');
    expect(document.head.querySelectorAll('script')).toHaveLength(1);
    const script = lastScript();
    expect(script.getAttribute('src')).toBe('js/locales/de.js');
    (window as LocaleWindow).__iptvLocales = { de: ALL_CATALOGS.de };
    script.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBe('de');
    await expect(second).resolves.toBe(true);
    expect(i18n.getLocale()).toBe('de');
    expect(i18n.t('channel.recentlyWatched')).toBe(ALL_CATALOGS.de['channel.recentlyWatched']);
    await expect(i18n.loadLocale('de')).resolves.toBe(true);
    expect(document.head.querySelectorAll('script')).toHaveLength(1);
  });

  it('falls back to English and logs when the script fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const i18n = await freshI18n();
    const applied = i18n.initLocale('ru');
    lastScript().dispatchEvent(new Event('error'));
    await expect(applied).resolves.toBe('en');
    expect(i18n.getLocale()).toBe('en');
    expect(warn.mock.calls.map(args => args.join(' ')).join('\n'))
      .toContain('event=i18n.load.failed locale=ru');
  });

  it('falls back when the script loads without registering its catalog', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const i18n = await freshI18n();
    const applied = i18n.applyLocale('fr');
    lastScript().dispatchEvent(new Event('load'));
    await expect(applied).resolves.toBe('en');
  });

  it('retries a locale after a failed load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const i18n = await freshI18n();
    const failed = i18n.loadLocale('it');
    lastScript().dispatchEvent(new Event('error'));
    await expect(failed).resolves.toBe(false);
    const retry = i18n.loadLocale('it');
    expect(document.head.querySelectorAll('script')).toHaveLength(2);
    (window as LocaleWindow).__iptvLocales = { it: ALL_CATALOGS.it };
    lastScript().dispatchEvent(new Event('load'));
    await expect(retry).resolves.toBe(true);
  });
});
