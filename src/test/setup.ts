import { beforeEach } from 'vitest';
import { DEFAULT_LOCALE, registerLocaleMessages, setLocale, type SupportedLocale } from '../i18n';
import { ALL_CATALOGS } from '../i18n/catalogs';

for (const locale of Object.keys(ALL_CATALOGS) as SupportedLocale[]) {
  registerLocaleMessages(locale, ALL_CATALOGS[locale]);
}

beforeEach(() => {
  setLocale(DEFAULT_LOCALE);
});
