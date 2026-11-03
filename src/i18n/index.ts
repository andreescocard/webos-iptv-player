import {
  EN_MESSAGES,
  type MessageCatalog,
  type MessageKey,
  type PluralCategory,
  type PluralMessage,
  type PluralMessageKey,
  type TextMessageKey,
} from './en';
import { pseudoLocalize } from './pseudo';
import { createLogger } from '../utils/logger';

export type { MessageKey, PluralMessageKey, TextMessageKey } from './en';
type Messages = Readonly<MessageCatalog>;
type Params = Record<string, string | number>;
type LocaleDefinition = {
  displayName: string;
  systemExact: readonly string[];
  systemPrefixes: readonly string[];
};

const LOCALES = {
  en: {
    displayName: 'English',
    systemExact: [],
    systemPrefixes: [],
  },
  de: {
    displayName: 'Deutsch',
    systemExact: [],
    systemPrefixes: ['de'],
  },
  es: {
    displayName: 'Español',
    systemExact: [],
    systemPrefixes: ['es'],
  },
  fr: {
    displayName: 'Français',
    systemExact: [],
    systemPrefixes: ['fr'],
  },
  it: {
    displayName: 'Italiano',
    systemExact: [],
    systemPrefixes: ['it'],
  },
  pl: {
    displayName: 'Polski',
    systemExact: [],
    systemPrefixes: ['pl'],
  },
  'pt-BR': {
    displayName: 'Português (Brasil)',
    systemExact: [],
    systemPrefixes: ['pt'],
  },
  ru: {
    displayName: 'Русский',
    systemExact: [],
    systemPrefixes: ['ru'],
  },
  tr: {
    displayName: 'Türkçe',
    systemExact: [],
    systemPrefixes: ['tr'],
  },
  uk: {
    displayName: 'Українська',
    systemExact: [],
    systemPrefixes: ['uk'],
  },
  'zh-CN': {
    displayName: '简体中文',
    systemExact: ['zh'],
    systemPrefixes: ['zh-cn', 'zh-sg', 'zh-hans'],
  },
} as const satisfies Record<string, LocaleDefinition>;

export type SupportedLocale = keyof typeof LOCALES;
export type LocalePreference = 'system' | SupportedLocale;
export const DEFAULT_LOCALE: SupportedLocale = 'en';

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system'
    || (typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCALES, value));
}

export function localeOptions(): { value: SupportedLocale; label: string }[] {
  return (Object.keys(LOCALES) as SupportedLocale[])
    .map(value => ({ value, label: LOCALES[value].displayName }));
}

const log = createLogger('I18n');

let currentLocale: SupportedLocale = DEFAULT_LOCALE;

// English ships in the app bundle; every other catalog is its own script
// (js/locales/<locale>.js) so the TV parses only the language in use.
const catalogs: Partial<Record<SupportedLocale, Messages>> = { en: EN_MESSAGES };
const pending: Partial<Record<SupportedLocale, Promise<boolean>>> = {};

type LocaleGlobal = { __iptvLocales?: Partial<Record<SupportedLocale, Messages>> };

export function registerLocaleMessages(locale: SupportedLocale, messages: Messages): void {
  catalogs[locale] = messages;
}

export function isLocaleLoaded(locale: SupportedLocale): boolean {
  return catalogs[locale] !== undefined;
}

export function loadLocale(locale: SupportedLocale): Promise<boolean> {
  if (catalogs[locale]) return Promise.resolve(true);
  const inFlight = pending[locale];
  if (inFlight) return inFlight;
  const request = new Promise<boolean>(resolve => {
    const script = document.createElement('script');
    script.charset = 'utf-8';
    script.src = `js/locales/${locale}.js`;
    script.onload = () => {
      const messages = (window as unknown as LocaleGlobal).__iptvLocales?.[locale];
      if (messages) catalogs[locale] = messages;
      resolve(messages !== undefined);
    };
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  }).then(loaded => {
    delete pending[locale];
    if (!loaded) log.warn('Locale catalog failed to load', 'event=i18n.load.failed', `locale=${locale}`);
    return loaded;
  });
  pending[locale] = request;
  return request;
}

function messagesFor(locale: SupportedLocale): Messages {
  return catalogs[locale] ?? EN_MESSAGES;
}

function pseudoLocaleRequested(): boolean {
  return typeof location !== 'undefined' && /(?:^|[?&])pseudo=1(?:&|$)/.test(location.search);
}

export function resolveLocale(
  preference: LocalePreference,
  browserLanguage = typeof navigator === 'undefined' ? DEFAULT_LOCALE : navigator.language,
): SupportedLocale {
  if (preference !== 'system') return preference;
  const language = browserLanguage.toLowerCase();
  for (const locale of Object.keys(LOCALES) as SupportedLocale[]) {
    const definition = LOCALES[locale];
    if (definition.systemExact.some(value => language === value)
        || definition.systemPrefixes.some(prefix =>
          language === prefix || language.startsWith(`${prefix}-`))) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}

export function setLocale(locale: SupportedLocale): void {
  currentLocale = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.lang =
      __ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested() ? 'en-XA' : locale;
  }
}

// Loads the catalog first; falls back to English when it cannot load.
export async function applyLocale(locale: SupportedLocale): Promise<SupportedLocale> {
  const applied = await loadLocale(locale) ? locale : DEFAULT_LOCALE;
  setLocale(applied);
  return applied;
}

export function initLocale(preference: LocalePreference): Promise<SupportedLocale> {
  return applyLocale(resolveLocale(preference));
}

export function getLocale(): SupportedLocale {
  return currentLocale;
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  const locale = __ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested()
    ? DEFAULT_LOCALE
    : currentLocale;
  return new Intl.NumberFormat(locale, options).format(value);
}

export function t(key: TextMessageKey, params?: Params): string {
  let message = messagesFor(currentLocale)[key] as string;
  if (__ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested()) {
    message = pseudoLocalize(EN_MESSAGES[key]);
  }
  if (!params) return message;
  return interpolate(message, params);
}

export function tp(key: PluralMessageKey, count: number, params?: Params): string {
  const pseudo = __ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested();
  const locale = pseudo || !isLocaleLoaded(currentLocale) ? DEFAULT_LOCALE : currentLocale;
  const forms = messagesFor(locale)[key] as PluralMessage;
  const category = new Intl.PluralRules(locale).select(count);
  const message = forms[category] ?? forms.other;
  return interpolate(pseudo ? pseudoLocalize(message) : message, { ...params, count });
}

function interpolate(message: string, params: Params): string {
  return message.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) =>
    params[name] === undefined ? token : String(params[name]));
}

function placeholders(message: string): string[] {
  const names: string[] = [];
  const pattern = /\{([A-Za-z0-9_]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null) names.push(match[1]);
  return names.sort();
}

export function validateTranslations(
  all: Partial<Record<SupportedLocale, Messages>> = catalogs,
): string[] {
  const errors: string[] = [];
  const keys = Object.keys(EN_MESSAGES) as MessageKey[];
  for (const locale of Object.keys(all) as SupportedLocale[]) {
    const messages = all[locale]!;
    for (const key of keys) {
      const source = EN_MESSAGES[key];
      const value = messages[key];
      if (typeof source === 'string') {
        const message = value as string;
        if (!message.trim()) {
          errors.push(`${locale}:${key} is empty`);
          continue;
        }
        const expected = placeholders(source).join(',');
        const actual = placeholders(message).join(',');
        if (actual !== expected) {
          errors.push(`${locale}:${key} placeholders [${actual}] do not match [${expected}]`);
        }
      } else {
        const forms = value as PluralMessage;
        const expected = placeholders(source.other).join(',');
        for (const category of Object.keys(forms) as PluralCategory[]) {
          const message = forms[category];
          if (!message) continue;
          if (!message.trim()) errors.push(`${locale}:${key}:${category} is empty`);
          const actual = placeholders(message).join(',');
          if (actual !== expected) {
            errors.push(`${locale}:${key}:${category} placeholders [${actual}] do not match [${expected}]`);
          }
        }
      }
    }
  }
  return errors;
}
