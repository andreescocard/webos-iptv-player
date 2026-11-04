import { movieRating } from './movie-discovery';
import { stripCombiningDiacritics } from './unicode-text';

// What the smart collections need from a title: Xtream lists carry `added`
// (unix seconds) and often `year`; titles cached before they were parsed lack both.
export interface SmartTitle {
  name: string;
  rating: string;
  poster?: string;
  added?: number;
  year?: number;
}

export const TOP_RATED_MIN = 7;

// "Title (2024)" or "Title [2024]"; the last such year wins.
export function nameYear(name: string): number {
  const pattern = /[([](19\d{2}|20\d{2})[)\]]/g;
  let year = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(name)) !== null) year = Number(match[1]);
  return year;
}

export function titleYear(item: SmartTitle): number {
  return item.year && item.year > 1800 ? item.year : nameYear(item.name);
}

const YEAR_TAG = /[([]\s*(?:19|20)\d{2}\s*[)\]]/g;
const QUALITY_TAG = /(^|[^a-z0-9])(?:4k|uhd|fhd|hd|sd|hdr\d*|1080p|720p|2160p|480p|h\.?26[45]|hevc|x26[45])(?=$|[^a-z0-9])/g;
const TAG_WORDS = String.raw`4k|uhd|fhd|hd|sd|hdr\d*|1080p|720p|2160p|480p|hevc|dublado|dub|legendado|leg|dual audio|dual|multi|latino|nacional|pt-br|ptbr|pt|br|eng|en|esp|lat|web-dl|webrip|bluray|vip`;
const BRACKET_TAG = new RegExp(String.raw`[(\[]\s*(?:${TAG_WORDS})(?:[\s,/|+-]+(?:${TAG_WORDS}))*\s*[)\]]`, 'g');
const PREFIX_TAG = new RegExp(String.raw`^\s*(?:${TAG_WORDS})\s*[|:–—-]\s*`);
const SUFFIX_TAG = new RegExp(String.raw`\s+[|:–—-]\s*(?:${TAG_WORDS})\s*$`);

// A title's name without case, accents, punctuation, year, or quality/language tags.
export function titleNameKey(name: string): string {
  const folded = typeof name.normalize === 'function' ? stripCombiningDiacritics(name.normalize('NFD')) : name;
  let text = folded.toLowerCase().replace(YEAR_TAG, ' ').replace(BRACKET_TAG, ' ').trim();
  for (let previous = ''; previous !== text;) {
    previous = text;
    text = text.replace(PREFIX_TAG, '').replace(SUFFIX_TAG, '').trim();
  }
  return text
    .replace(QUALITY_TAG, '$1 ')
    .replace(/[^a-z0-9À-￿]+/g, ' ')
    .trim();
}

function metadataScore(item: SmartTitle): number[] {
  const rating = movieRating(item.rating) ?? 0;
  const known = (rating ? 1 : 0) + (item.year ? 1 : 0) + (item.added ? 1 : 0) + (item.poster ? 1 : 0);
  return [known, rating];
}

function betterThan(candidate: SmartTitle, current: SmartTitle): boolean {
  const left = metadataScore(candidate);
  const right = metadataScore(current);
  return left[0] > right[0] || (left[0] === right[0] && left[1] > right[1]);
}

// Providers list one title under several ids (a 4K copy, a dubbed copy, a
// second category). Keeps one per id and per name key, the one with the most
// metadata (then the best rating) at the first copy's position, unless both
// carry a year and the years differ.
export function uniqueTitles<T extends SmartTitle>(items: T[], idOf?: (item: T) => string): T[] {
  const kept: T[] = [];
  const ids = new Map<string, number>();
  const byName = new Map<string, Array<{ year: number; index: number }>>();
  items.forEach((item) => {
    const id = idOf ? idOf(item) : '';
    const key = titleNameKey(item.name);
    const year = titleYear(item);
    let index = id ? ids.get(id) : undefined;
    if (index === undefined && key) {
      const seen = byName.get(key);
      const match = seen ? seen.filter((s) => !s.year || !year || s.year === year)[0] : undefined;
      if (match) {
        index = match.index;
        if (!match.year) match.year = year;
      }
    }
    if (index !== undefined) {
      if (betterThan(item, kept[index])) kept[index] = item;
      if (id) ids.set(id, index);
      return;
    }
    index = kept.length;
    kept.push(item);
    if (id) ids.set(id, index);
    if (key) {
      const seen = byName.get(key);
      if (seen) seen.push({ year, index });
      else byName.set(key, [{ year, index }]);
    }
  });
  return kept;
}

// For auto-generated rails on one page: each title shows in the first rail
// that has it, matched by id and by name key.
export function withoutRepeatedTitles<T extends SmartTitle>(
  rails: T[][], idOf: (item: T) => string, limit: number,
): T[][] {
  const ids = new Set<string>();
  const names = new Map<string, number[]>();
  return rails.map((rail) => {
    const shown = rail.filter((item) => {
      const id = idOf(item);
      const key = titleNameKey(item.name);
      const year = titleYear(item);
      if (ids.has(id)) return false;
      const years = key ? names.get(key) : undefined;
      return !(years && years.some((seen) => !seen || !year || seen === year));
    }).slice(0, limit);
    shown.forEach((item) => {
      ids.add(idOf(item));
      const key = titleNameKey(item.name);
      if (!key) return;
      const years = names.get(key);
      if (years) years.push(titleYear(item));
      else names.set(key, [titleYear(item)]);
    });
    return shown;
  });
}

// Chromium 53's Array.sort does not guarantee stable ties.
function sortedBy<T extends SmartTitle>(items: T[], score: (item: T) => number[], limit: number): T[] {
  const scored = items.map((item, index) => ({ item, index, score: score(item) }));
  scored.sort((left, right) => {
    for (let i = 0; i < left.score.length; i++) {
      if (left.score[i] !== right.score[i]) return right.score[i] - left.score[i];
    }
    return left.index - right.index;
  });
  return uniqueTitles(scored.map((entry) => entry.item)).slice(0, limit);
}

export function topRated<T extends SmartTitle>(items: T[], limit: number): T[] {
  const rated = items.filter((item) => (movieRating(item.rating) ?? 0) >= TOP_RATED_MIN);
  return sortedBy(rated, (item) => [movieRating(item.rating) ?? 0], limit);
}

export function recentlyAdded<T extends SmartTitle>(items: T[], limit: number): T[] {
  return sortedBy(items.filter((item) => (item.added ?? 0) > 0), (item) => [item.added ?? 0], limit);
}

// Titles from this year or the year before, newest year first.
export function newReleases<T extends SmartTitle>(items: T[], limit: number, now = new Date()): T[] {
  const since = now.getFullYear() - 1;
  const fresh = items.filter((item) => titleYear(item) >= since);
  return sortedBy(fresh, (item) => [titleYear(item), item.added ?? 0, movieRating(item.rating) ?? 0], limit);
}
