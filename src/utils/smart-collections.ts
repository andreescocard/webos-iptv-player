import { movieRating } from './movie-discovery';

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

// Chromium 53's Array.sort does not guarantee stable ties.
function sortedBy<T>(items: T[], score: (item: T) => number[], limit: number): T[] {
  const scored = items.map((item, index) => ({ item, index, score: score(item) }));
  scored.sort((left, right) => {
    for (let i = 0; i < left.score.length; i++) {
      if (left.score[i] !== right.score[i]) return right.score[i] - left.score[i];
    }
    return left.index - right.index;
  });
  return scored.slice(0, limit).map((entry) => entry.item);
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
