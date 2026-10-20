import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { formatRating, translateGenres } from './catalog-meta';

afterEach(() => setLocale('en'));

describe('translateGenres', () => {
  it('translates known genres case-insensitively and splits on commas and slashes', () => {
    setLocale('pt-BR');
    expect(translateGenres('crime, DRAMA / Sci-Fi & Fantasy')).toBe(
      'Crime, Drama, Ficção científica e fantasia',
    );
  });

  it('maps TMDB aliases to one label', () => {
    setLocale('pt-BR');
    expect(translateGenres('Science Fiction, Sci-Fi')).toBe('Ficção científica, Ficção científica');
  });

  it('passes unknown genres through unchanged', () => {
    setLocale('pt-BR');
    expect(translateGenres('Action, Zzz Genre')).toBe('Ação, Zzz Genre');
  });

  it('keeps English as written and returns empty for blank input', () => {
    expect(translateGenres('War & Politics')).toBe('War & Politics');
    expect(translateGenres(' , ')).toBe('');
  });
});

describe('formatRating', () => {
  it('formats one decimal in the UI locale', () => {
    expect(formatRating('8')).toBe('8.0');
    setLocale('pt-BR');
    expect(formatRating('8')).toBe('8,0');
    expect(formatRating('7,46')).toBe('7,5');
  });

  it('hides missing, zero, and non-numeric ratings', () => {
    expect(formatRating('')).toBe('');
    expect(formatRating('0')).toBe('');
    expect(formatRating('n/a')).toBe('');
    expect(formatRating(undefined)).toBe('');
  });
});
