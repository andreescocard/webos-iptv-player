import { formatNumber, t, type TextMessageKey } from '../i18n';

const GENRE_KEYS: Record<string, TextMessageKey> = {
  'action': 'genre.action',
  'action & adventure': 'genre.actionAdventure',
  'adventure': 'genre.adventure',
  'animation': 'genre.animation',
  'comedy': 'genre.comedy',
  'crime': 'genre.crime',
  'documentary': 'genre.documentary',
  'drama': 'genre.drama',
  'family': 'genre.family',
  'fantasy': 'genre.fantasy',
  'history': 'genre.history',
  'horror': 'genre.horror',
  'kids': 'genre.kids',
  'music': 'genre.music',
  'mystery': 'genre.mystery',
  'news': 'genre.news',
  'reality': 'genre.reality',
  'romance': 'genre.romance',
  'sci-fi': 'genre.scifi',
  'science fiction': 'genre.scifi',
  'science-fiction': 'genre.scifi',
  'sci-fi & fantasy': 'genre.scifiFantasy',
  'soap': 'genre.soap',
  'talk': 'genre.talk',
  'thriller': 'genre.thriller',
  'tv movie': 'genre.tvMovie',
  'war': 'genre.war',
  'war & politics': 'genre.warPolitics',
  'western': 'genre.western',
};

// Panels list genres in English, separated by commas or slashes; unknown
// names pass through unchanged.
export function translateGenres(raw: string): string {
  return raw
    .split(/[,/]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const key = GENRE_KEYS[part.toLowerCase().replace(/\s+/g, ' ')];
      return key ? t(key) : part;
    })
    .join(', ');
}

// One decimal in the UI locale ("8,0" in pt-BR); '' for a missing or zero rating.
export function formatRating(raw: string | number | null | undefined): string {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return '';
  return formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
