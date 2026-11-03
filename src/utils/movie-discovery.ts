import type { VodItem } from '../types';
import {
  AUDIO_ICON, CLOCK_ICON, GLOBE_ICON, STAR_ICON,
  TAB_LIVE_ICON, TAB_MOVIES_ICON, TAG_ICON,
} from '../components/icons';
import { isLetterOrNumber, stripCombiningDiacritics } from './unicode-text';

export type MovieSort = 'original' | 'az' | 'za' | 'rating';

function movieRating(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const rating = Number(text);
  return rating > 0 && rating <= 10 ? rating : null;
}

// Chromium 53's Array.sort does not guarantee stable ties.
export function sortMovies(items: VodItem[], order: MovieSort): VodItem[] {
  if (order === 'original') return items;
  const positions = new Map<VodItem, number>();
  const ratings = new Map<VodItem, number>();
  items.forEach((item, index) => {
    if (!positions.has(item)) positions.set(item, index);
    if (order === 'rating') ratings.set(item, movieRating(item.rating) ?? -1);
  });
  return items.slice().sort((left, right) => {
    const comparison = order === 'rating'
      ? ratings.get(right)! - ratings.get(left)!
      : left.name.localeCompare(right.name) * (order === 'za' ? -1 : 1);
    return comparison || positions.get(left)! - positions.get(right)!;
  });
}

export function randomGoodMovie(items: VodItem[], previousId?: string): VodItem | null {
  let eligible = 0;
  let alternatives = 0;
  for (const item of items) {
    const rating = movieRating(item.rating);
    if (rating === null || rating < 7) continue;
    eligible++;
    if (item.streamId !== previousId) alternatives++;
  }
  if (eligible === 0) return null;
  const avoidPrevious = eligible > 1 && alternatives > 0;
  let selected = Math.floor(Math.random() * (avoidPrevious ? alternatives : eligible));
  for (const item of items) {
    const rating = movieRating(item.rating);
    if (rating === null || rating < 7 || (avoidPrevious && item.streamId === previousId)) continue;
    if (selected-- === 0) return item;
  }
  return null;
}

// Up to `count` distinct good movies in random order; the previous stream
// comes last, only when nothing else is left.
export function randomGoodMovies(items: VodItem[], count: number, previousId?: string): VodItem[] {
  const picks: VodItem[] = [];
  let pool = items;
  while (picks.length < count) {
    const item = randomGoodMovie(pool, previousId);
    if (!item) break;
    picks.push(item);
    pool = pool.filter((other) => other.streamId !== item.streamId);
  }
  return picks;
}

// Other titles from the movie's category: good-rated ones in random order
// first, then the rest in catalog order.
export function relatedMovies(movie: VodItem, items: VodItem[], limit: number): VodItem[] {
  const seen = new Set<string>([movie.streamId]);
  const pool = items.filter((item) => {
    if (seen.has(item.streamId)) return false;
    seen.add(item.streamId);
    return true;
  });
  const picks = randomGoodMovies(pool, limit);
  const picked = new Set(picks);
  for (const item of pool) {
    if (picks.length >= limit) break;
    if (!picked.has(item)) picks.push(item);
  }
  return picks;
}

// Only explicit service labels: bare "prime", missing plus signs, and partial
// words are not evidence of a service category. Longer labels precede aliases.
const STREAMING_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'Netflix', pattern: /netflix/gi },
  { name: 'Prime Video', pattern: /prime\s+video|amazon\s+prime/gi },
  { name: 'Disney+', pattern: /disney\s*\+/gi },
  { name: 'Apple TV+', pattern: /apple\s+tv\s*\+/gi },
  { name: 'Max', pattern: /hbo\s+max|max/gi },
  { name: 'Paramount+', pattern: /paramount\s*\+/gi },
  { name: 'Globoplay', pattern: /globoplay/gi },
];

export function streamingCategory(name: string): string | null {
  for (const rule of STREAMING_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(name)) !== null) {
      const end = match.index + match[0].length;
      if ((match.index === 0 || !isLetterOrNumber(name.charAt(match.index - 1)))
        && (end === name.length || !isLetterOrNumber(name.charAt(end)))) return rule.name;
    }
  }
  return null;
}

const HEART_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 21 3.5 12.5a5.3 5.3 0 0 1 7.5-7.5l1 1 1-1a5.3 5.3 0 0 1 7.5 7.5z"/></svg>';
const ACTION_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-7z"/></svg>';
const COMEDY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 9h.01M16 9h.01M7 14c2 5 8 5 10 0"/></svg>';
const FAMILY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="7" r="3"/><circle cx="17" cy="10" r="2"/><path d="M2 21v-4a6 6 0 0 1 12 0v4M15 15a4 4 0 0 1 7 3v3"/></svg>';
const MYSTERY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 1 1 4 3c-1 .5-1 1-1 3M12 17h.01"/></svg>';

const CATEGORY_ICONS: Array<{ pattern: RegExp; icon: string }> = [
  { pattern: /\b(action|acao|adventure|aventura|war|guerra|western|faroeste)\b/, icon: ACTION_ICON },
  { pattern: /\b(comedy|comedias?|humor)\b/, icon: COMEDY_ICON },
  { pattern: /\b(romance|romantic[oa]s?|drama)\b/, icon: HEART_ICON },
  { pattern: /\b(family|familia|kids|children|infantil|infantis|animation|animacao|desenhos?)\b/, icon: FAMILY_ICON },
  { pattern: /\b(horror|terror|thriller|suspense|mystery|misterio|crime)\b/, icon: MYSTERY_ICON },
  { pattern: /\b(documentar(?:y|ies|io|ios)|history|historia|science fiction|sci[ -]fi|ficcao|fantasy|fantasia)\b/, icon: GLOBE_ICON },
  { pattern: /\b(music|musica|musicais|musical|concerts?|shows?)\b/, icon: AUDIO_ICON },
  { pattern: /\b(top|rated|rating|avaliados|favorites|favoritos|destaques)\b/, icon: STAR_ICON },
  { pattern: /\b(new|recent|releases|recentes|lancamentos|novidades|classics|classicos)\b/, icon: CLOCK_ICON },
  { pattern: /\b(movies|films?|filmes|cinema|all|todos)\b/, icon: TAB_MOVIES_ICON },
];

// Category text never enters the returned SVG markup.
export function movieCategoryIcon(name: string): string {
  if (streamingCategory(name)) return TAB_LIVE_ICON;
  const folded = stripCombiningDiacritics(name.normalize('NFD')).toLowerCase();
  for (const rule of CATEGORY_ICONS) {
    if (rule.pattern.test(folded)) return rule.icon;
  }
  return TAG_ICON;
}
