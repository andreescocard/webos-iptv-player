import type { TextMessageKey } from '../i18n';
import { CLOCK_ICON, STAR_ICON, TAB_LIVE_ICON } from '../components/icons';
import { movieCategoryIcon, streamingCategory } from './movie-discovery';
import { stripCategoryPrefix } from './category-prefix';
import { stripCombiningDiacritics } from './unicode-text';

// Providers ship messy, duplicated categories ("AÇÃO", "Ação 4K", "FILMES |
// ACAO", "Acao Legendado"). This groups them into a few browsable collections:
// streaming services, canonical genres, and whatever matches neither.

export type GenreId =
  | 'action' | 'comedy' | 'drama' | 'horror' | 'romance' | 'scifi' | 'thriller'
  | 'animation' | 'adventure' | 'family' | 'kids' | 'documentary' | 'crime'
  | 'fantasy' | 'mystery' | 'war' | 'western' | 'history' | 'music' | 'reality'
  | 'soap' | 'news' | 'talk';

interface GenreRule {
  id: GenreId;
  key: TextMessageKey;
  english: string;
  words: string[];
}

// Browse priority: the earlier a genre, the earlier its rail. When a name
// mentions several genres ("Acao e Aventura") the earliest one claims it.
const GENRES: GenreRule[] = [
  { id: 'action', key: 'genre.action', english: 'Action', words: ['acao', 'action', 'accion'] },
  { id: 'comedy', key: 'genre.comedy', english: 'Comedy', words: ['comedia', 'comedias', 'comedy', 'humor', 'comedie'] },
  { id: 'drama', key: 'genre.drama', english: 'Drama', words: ['drama', 'dramas'] },
  { id: 'horror', key: 'genre.horror', english: 'Horror', words: ['terror', 'horror'] },
  { id: 'romance', key: 'genre.romance', english: 'Romance', words: ['romance', 'romantico', 'romanticos', 'romantica', 'romanticas'] },
  { id: 'scifi', key: 'genre.scifi', english: 'Sci-Fi', words: ['scifi', 'ficcao'] },
  { id: 'thriller', key: 'genre.thriller', english: 'Thriller', words: ['thriller', 'suspense'] },
  { id: 'animation', key: 'genre.animation', english: 'Animation', words: ['animacao', 'animacoes', 'animation', 'animados', 'animado', 'desenho', 'desenhos'] },
  { id: 'adventure', key: 'genre.adventure', english: 'Adventure', words: ['aventura', 'aventuras', 'adventure'] },
  { id: 'family', key: 'genre.family', english: 'Family', words: ['familia', 'family'] },
  { id: 'kids', key: 'genre.kids', english: 'Kids', words: ['infantil', 'infantis', 'kids', 'children', 'criancas'] },
  { id: 'documentary', key: 'genre.documentary', english: 'Documentary', words: ['documentario', 'documentarios', 'documentary', 'documentaries', 'documental'] },
  { id: 'crime', key: 'genre.crime', english: 'Crime', words: ['crime', 'crimes', 'policial'] },
  { id: 'fantasy', key: 'genre.fantasy', english: 'Fantasy', words: ['fantasia', 'fantasy'] },
  { id: 'mystery', key: 'genre.mystery', english: 'Mystery', words: ['misterio', 'mystery'] },
  { id: 'war', key: 'genre.war', english: 'War', words: ['guerra', 'war', 'belico'] },
  { id: 'western', key: 'genre.western', english: 'Western', words: ['faroeste', 'western'] },
  { id: 'history', key: 'genre.history', english: 'History', words: ['historia', 'historico', 'historicos', 'history', 'historical'] },
  { id: 'music', key: 'genre.music', english: 'Music', words: ['musica', 'musical', 'musicais', 'music'] },
  { id: 'reality', key: 'genre.reality', english: 'Reality', words: ['reality'] },
  { id: 'soap', key: 'genre.soap', english: 'Soap', words: ['novela', 'novelas', 'telenovela', 'telenovelas', 'soap'] },
  { id: 'news', key: 'genre.news', english: 'News', words: ['noticias', 'noticia', 'news', 'jornalismo'] },
  { id: 'talk', key: 'genre.talk', english: 'Talk', words: ['talk'] },
];

// Multi-word spellings that must read as one genre word.
const PHRASES: Array<[RegExp, string]> = [
  [/ficcao cientifica/g, 'scifi'],
  [/science fiction/g, 'scifi'],
  [/sci fi/g, 'scifi'],
];

// Quality, audio, and container words that say how a title is delivered, not
// what it is about.
const QUALIFIERS = new Set([
  '4k', '8k', 'uhd', 'fhd', 'hd', 'sd', 'qhd', 'hdr', 'hdr10', 'dv', 'sdr',
  '2160p', '1440p', '1080p', '720p', '480p', '60fps', '50fps', 'h264', 'h265',
  'x264', 'x265', 'hevc', 'avc', 'remux', 'bluray', 'webdl', 'web',
  'dublado', 'dublados', 'dublada', 'dubladas', 'dub', 'dubbed',
  'legendado', 'legendados', 'legendada', 'legendadas', 'leg', 'sub', 'subs', 'subbed', 'subtitled',
  'dual', 'audio', 'multi', 'multilang',
]);

// Words that name the content type or only join genres.
const FILLERS = new Set([
  'filmes', 'filme', 'movies', 'movie', 'films', 'film', 'series', 'serie', 'seriados',
  'e', 'de', 'do', 'da', 'dos', 'das', 'and', 'the', 'y', 'et', 'o', 'a', 'os', 'as',
]);

const GENRE_BY_WORD = new Map<string, GenreRule>();
GENRES.forEach((genre) => genre.words.forEach((word) => GENRE_BY_WORD.set(word, genre)));

function foldName(name: string): string {
  return stripCombiningDiacritics(name.normalize('NFD')).toLowerCase();
}

// The words of a category name, folded and without quality or audio
// qualifiers ("FILMES | ACAO 4K Legendado" -> ["acao"]).
export function categoryWords(name: string): string[] {
  let text = foldName(name).replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [pattern, word] of PHRASES) text = text.replace(pattern, word);
  return text.split(' ').filter((word) => word !== '' && !QUALIFIERS.has(word) && !FILLERS.has(word));
}

function genreRule(words: string[]): GenreRule | null {
  if (!words.length) return null;
  let best: GenreRule | null = null;
  for (const word of words) {
    const rule = GENRE_BY_WORD.get(word);
    // One unknown word ("Drama Coreano") makes it a specific list, not the genre.
    if (!rule) return null;
    if (!best || GENRES.indexOf(rule) < GENRES.indexOf(best)) best = rule;
  }
  return best;
}

// The canonical genre a category name belongs to, or null.
export function canonicalGenre(name: string): GenreId | null {
  return genreRule(categoryWords(name))?.id ?? null;
}

export function genreLabelKey(id: GenreId): TextMessageKey {
  return GENRES.filter((genre) => genre.id === id)[0].key;
}

export type CollectionKind = 'smart' | 'streaming' | 'genre' | 'other';

export interface PlannedGroup {
  kind: 'streaming' | 'genre' | 'other';
  // Stable across loads: 's:<service>', 'g:<genre>', or the category id.
  key: string;
  service?: string;
  genre?: GenreId;
  sourceIds: string[];
}

interface Named {
  id: string;
  name: string;
}

// Groups categories: streaming services first (in service order), then genres
// (in priority order), then every other category on its own in provider order.
// A category lands in exactly one group.
export function planCategories(categories: Named[], prefix: string | null): PlannedGroup[] {
  const services = new Map<string, PlannedGroup>();
  const genres = new Map<GenreId, PlannedGroup>();
  const others: PlannedGroup[] = [];
  for (const category of categories) {
    const name = stripCategoryPrefix(category.name, prefix);
    const service = streamingCategory(category.name);
    if (service) {
      const group = services.get(service);
      if (group) group.sourceIds.push(category.id);
      else services.set(service, { kind: 'streaming', key: `s:${service}`, service, sourceIds: [category.id] });
      continue;
    }
    const genre = canonicalGenre(name);
    if (genre) {
      const group = genres.get(genre);
      if (group) group.sourceIds.push(category.id);
      else genres.set(genre, { kind: 'genre', key: `g:${genre}`, genre, sourceIds: [category.id] });
      continue;
    }
    others.push({ kind: 'other', key: category.id, sourceIds: [category.id] });
  }
  const orderedServices = Array.from(services.values());
  const orderedGenres = GENRES
    .map((genre) => genres.get(genre.id))
    .filter((group): group is PlannedGroup => !!group);
  return [...orderedServices, ...orderedGenres, ...others];
}

export type SmartKind = 'top' | 'recent' | 'new';

export const SMART_IDS: Record<SmartKind, string> = { top: 'v:top', recent: 'v:recent', new: 'v:new' };

// Category text never enters the returned SVG markup.
export function collectionIcon(
  kind: CollectionKind,
  group: { genre?: GenreId; smart?: SmartKind; label: string },
): string {
  if (kind === 'smart') return group.smart === 'top' ? STAR_ICON : CLOCK_ICON;
  if (kind === 'streaming') return TAB_LIVE_ICON;
  if (kind === 'genre' && group.genre) {
    return movieCategoryIcon(GENRES.filter((genre) => genre.id === group.genre)[0].english);
  }
  return movieCategoryIcon(group.label);
}
