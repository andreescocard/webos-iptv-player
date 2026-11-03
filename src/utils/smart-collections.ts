import { movieRating } from './movie-discovery';
import { stripCombiningDiacritics } from './unicode-text';

// What the smart collections need from a title: Xtream lists carry `added`
// (unix seconds) and often `year`; titles cached before they were parsed lack both.
export interface SmartTitle {
  name: string;
  rating: string;
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

// A title's name without case, accents, punctuation, year, or quality tags.
export function titleNameKey(name: string): string {
  const folded = typeof name.normalize === 'function' ? stripCombiningDiacritics(name.normalize('NFD')) : name;
  return folded.toLowerCase()
    .replace(YEAR_TAG, ' ')
    .replace(QUALITY_TAG, '$1 ')
    .replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ')
    .trim();
}

// Providers list one title under several ids (a 4K copy, a second category);
// keeps the first of each, unless both carry a year and the years differ.
export function uniqueTitles<T extends SmartTitle>(items: T[]): T[] {
  const yearsByName = new Map<string, number[]>();
  return items.filter((item) => {
    const key = titleNameKey(item.name);
    if (!key) return true;
    const year = titleYear(item);
    const years = yearsByName.get(key);
    if (!years) {
      yearsByName.set(key, [year]);
      return true;
    }
    if (years.some((seen) => !seen || !year || seen === year)) return false;
    years.push(year);
    return true;
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
