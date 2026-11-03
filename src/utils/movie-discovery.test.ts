import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VodItem } from '../types';
import { TAG_ICON } from '../components/icons';
import {
  movieCategoryIcon, randomGoodMovie, randomGoodMovies, relatedMovies, sortMovies, streamingCategory,
} from './movie-discovery';

function movie(streamId: string, name = streamId, rating = ''): VodItem {
  return {
    accountId: 'account-alpha', streamId, name, rating,
    poster: '', categoryId: 'category-alpha', containerExtension: 'mp4',
  };
}

afterEach(() => vi.restoreAllMocks());

describe('sortMovies', () => {
  it('sorts names in both directions without modifying the input or item objects', () => {
    const items = [movie('item-charlie', 'Charlie'), movie('item-alpha', 'Alpha'), movie('item-bravo', 'Bravo')];
    const ascending = sortMovies(items, 'az');
    expect(ascending).not.toBe(items);
    expect(ascending).toEqual([items[1], items[2], items[0]]);
    expect(ascending[0]).toBe(items[1]);
    expect(sortMovies(items, 'za')).toEqual([items[0], items[2], items[1]]);
    expect(items.map(item => item.streamId)).toEqual(['item-charlie', 'item-alpha', 'item-bravo']);
  });

  it('keeps equal names in original position in either direction', () => {
    const first = movie('item-first', 'Alpha');
    const second = movie('item-second', 'Alpha');
    const last = movie('item-last', 'Bravo');
    expect(sortMovies([first, second, last], 'az')).toEqual([first, second, last]);
    expect(sortMovies([first, second, last], 'za')).toEqual([last, first, second]);
  });

  it('orders numeric ratings with stable ties, keeping missing, zero, and invalid ratings together last', () => {
    const missing = movie('item-missing');
    const tiedFirst = movie('item-first', 'Zulu', '8,5');
    const invalid = movie('item-invalid', 'Alpha', 'not-rated');
    const tiedSecond = movie('item-second', 'Alpha', '8.5');
    const perfect = movie('item-perfect', 'Bravo', ' 10 ');
    const zero = movie('item-zero', 'Charlie', '0');
    const negative = movie('item-negative', 'Delta', '-1');
    const excessive = movie('item-excessive', 'Echo', '10.1');
    const partial = movie('item-partial', 'Foxtrot', '9 points');
    const infinite = movie('item-infinite', 'Golf', 'Infinity');
    const malformed = movie('item-malformed', 'Hotel', '8,5,1');
    const hexadecimal = movie('item-hex', 'India', '0x9');
    const items = [missing, tiedFirst, invalid, tiedSecond, perfect, zero, negative, excessive, partial, infinite, malformed, hexadecimal];
    expect(sortMovies(items, 'rating')).toEqual([
      perfect, tiedFirst, tiedSecond,
      missing, invalid, zero, negative, excessive, partial, infinite, malformed, hexadecimal,
    ]);
    expect(items[0]).toBe(missing);
  });

  it('supports empty lists and repeated references', () => {
    const item = movie('item-alpha', 'Alpha', '8');
    expect(sortMovies([], 'rating')).toEqual([]);
    expect(sortMovies([item, item], 'rating')).toEqual([item, item]);
  });
});

describe('randomGoodMovies', () => {
  it('picks distinct good movies up to the count, the previous one last', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const previous = movie('item-previous', 'Alpha', '9');
    const items = [previous, movie('item-low', 'Bravo', '5'), movie('item-b', 'Charlie', '8'),
      movie('item-c', 'Delta', '7'), movie('item-b', 'Charlie', '8')];
    expect(randomGoodMovies(items, 5, previous.streamId).map((item) => item.streamId))
      .toEqual(['item-b', 'item-c', 'item-previous']);
    expect(randomGoodMovies(items, 2).map((item) => item.streamId)).toEqual(['item-previous', 'item-b']);
    expect(randomGoodMovies([], 5)).toEqual([]);
  });
});

describe('relatedMovies', () => {
  it('leaves out the movie itself and repeats, good-rated first, up to the limit', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const current = movie('item-current', 'Alpha', '9');
    const items = [movie('item-a', 'Bravo', ''), current, movie('item-b', 'Charlie', '8'),
      movie('item-a', 'Bravo', ''), movie('item-c', 'Delta', '6'), movie('item-d', 'Echo', '')];
    expect(relatedMovies(current, items, 3).map((item) => item.streamId))
      .toEqual(['item-b', 'item-a', 'item-c']);
    expect(relatedMovies(current, [current], 3)).toEqual([]);
  });
});

describe('randomGoodMovie', () => {
  it('returns null when nothing has a valid good rating', () => {
    expect(randomGoodMovie([])).toBeNull();
    expect(randomGoodMovie(['', '0', '6.99', '-7', '10.01', 'NaN', 'Infinity', '8 points']
      .map((rating, index) => movie(`item-${index}`, 'Alpha', rating)))).toBeNull();
  });

  it('uses equal random intervals for every eligible movie and never mutates the list', () => {
    const first = movie('item-alpha', 'Alpha', '7');
    const second = movie('item-bravo', 'Bravo', '8,5');
    const third = movie('item-charlie', 'Charlie', '10');
    const items = [movie('item-low', 'Delta', '6'), first, movie('item-invalid', 'Echo', '11'), second, third];
    const original = items.slice();
    const random = vi.spyOn(Math, 'random');
    for (const [sample, expected] of [
      [0, first], [0.333333, first], [1 / 3, second], [0.666666, second], [2 / 3, third], [0.999999, third],
    ] as const) {
      random.mockReturnValue(sample);
      expect(randomGoodMovie(items)).toBe(expected);
    }
    expect(items).toEqual(original);
  });

  it('avoids the previous stream whenever another eligible choice exists', () => {
    const previous = movie('item-previous', 'Alpha', '9');
    const first = movie('item-first', 'Bravo', '7');
    const second = movie('item-second', 'Charlie', '10');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(randomGoodMovie([previous, first, second], previous.streamId)).toBe(first);
    random.mockReturnValue(0.999999);
    expect(randomGoodMovie([previous, first, second], previous.streamId)).toBe(second);
  });

  it('keeps the sole eligible choice even when it was previous', () => {
    const previous = movie('item-previous', 'Alpha', '7,0');
    expect(randomGoodMovie([movie('item-low', 'Bravo', '6'), previous], previous.streamId)).toBe(previous);
  });
});

describe('streamingCategory', () => {
  it('does not infer a service from generic, partial, or unknown category text', () => {
    for (const name of [
      '', 'prime', 'Prime cuts', 'maximum', 'IMAX', 'climax', 'maximal',
      'primetime', 'Movies | Alpha Plus', 'Streaming | Fictional Provider',
      'Quality | 4K', 'Action', 'Family', 'Movies <script>alert(1)</script>',
    ]) {
      expect(streamingCategory(name)).toBeNull();
    }
  });
});

describe('movieCategoryIcon', () => {
  it('recognizes accented genre labels and their equivalents', () => {
    expect(movieCategoryIcon('Ação')).toBe(movieCategoryIcon('Action'));
    expect(movieCategoryIcon('Comédia')).toBe(movieCategoryIcon('Comedy'));
    expect(movieCategoryIcon('Animação')).toBe(movieCategoryIcon('Animation'));
    expect(movieCategoryIcon('Ficção científica')).toBe(movieCategoryIcon('Science Fiction'));
    expect(movieCategoryIcon('Ação')).not.toBe(TAG_ICON);
    expect(movieCategoryIcon('Terror')).not.toBe(TAG_ICON);
  });

  it('does not interpolate supplied markup or require callers to escape the icon', () => {
    const payload = '<img src=x onerror="alert(1)"><script>untrusted-payload</script>';
    expect(movieCategoryIcon(payload)).toBe(TAG_ICON);
    const recognized = movieCategoryIcon(`Action ${payload}`);
    expect(recognized).toBe(movieCategoryIcon('Action'));
    expect(recognized).toContain('<svg');
    expect(recognized).not.toContain(payload);
    expect(recognized).not.toContain('untrusted-payload');
    expect(recognized).not.toContain('onerror');
  });
});

describe('streamingCategory services', () => {
  it('recognizes each service label, ignoring case and accents', () => {
    const cases: Array<[string, string]> = [
      ['Filmes | NETFLIX', 'Netflix'], ['Amazon Prime Video', 'Prime Video'], ['Prime Video 4K', 'Prime Video'],
      ['Amazon', 'Prime Video'], ['Disney+', 'Disney+'], ['Disney Plus', 'Disney+'], ['Apple TV+', 'Apple TV+'],
      ['HBO Max', 'Max'], ['HBO', 'Max'], ['Max Originals', 'Max'], ['Paramount+', 'Paramount+'],
      ['Globoplay', 'Globoplay'], ['Star+', 'Star+'], ['Crunchyroll', 'Crunchyroll'],
      ['Discovery+', 'Discovery+'], ['Pluto TV', 'Pluto TV'], ['Telecine', 'Telecine'], ['Looke', 'Looke'],
      ['Claro tv+', 'Claro tv+'], ['Claro Vídeo', 'Claro tv+'], ['Lionsgate+', 'Lionsgate+'], ['Starz', 'Lionsgate+'],
      ['Hulu', 'Hulu'], ['Peacock', 'Peacock'], ['AMC+', 'AMC+'], ['MUBI', 'MUBI'],
      ['Univer Video', 'Univer Video'], ['Univer', 'Univer Video'], ['Universal+', 'Universal+'],
    ];
    for (const [name, service] of cases) expect(streamingCategory(name)).toBe(service);
  });

  it('rejects near misses', () => {
    for (const name of ['Universal', 'Universe', 'Star', 'Starship', 'Hulukai', 'Claro', 'Discovery', 'Peacocks']) {
      expect(streamingCategory(name)).toBeNull();
    }
  });
});
