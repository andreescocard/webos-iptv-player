import { EN_MESSAGES, type MessageCatalog } from './en';
import { DE_MESSAGES } from './de';
import { ES_MESSAGES } from './es';
import { FR_MESSAGES } from './fr';
import { IT_MESSAGES } from './it';
import { PL_MESSAGES } from './pl';
import { PT_BR_MESSAGES } from './pt-BR';
import { RU_MESSAGES } from './ru';
import { TR_MESSAGES } from './tr';
import { UK_MESSAGES } from './uk';
import { ZH_CN_MESSAGES } from './zh-CN';
import type { SupportedLocale } from './index';

// Every catalog at once, for tests. The app loads one per locale instead.
export const ALL_CATALOGS: Record<SupportedLocale, Readonly<MessageCatalog>> = {
  en: EN_MESSAGES,
  de: DE_MESSAGES,
  es: ES_MESSAGES,
  fr: FR_MESSAGES,
  it: IT_MESSAGES,
  pl: PL_MESSAGES,
  'pt-BR': PT_BR_MESSAGES,
  ru: RU_MESSAGES,
  tr: TR_MESSAGES,
  uk: UK_MESSAGES,
  'zh-CN': ZH_CN_MESSAGES,
};
