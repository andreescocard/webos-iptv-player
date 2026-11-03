import { describe, expect, it } from 'vitest';
import { nameYear, newReleases, recentlyAdded, titleYear, topRated, uniqueTitles, type SmartTitle } from './smart-collections';

function title(name: string, extra: Partial<SmartTitle> = {}): SmartTitle {
  return { name, rating: '', ...extra };
}

describe('topRated', () => {
  it('keeps ratings of 7 and up, highest first, stable on ties', () => {
    const items = [
      title('Low', { rating: '6.9' }), title('Tie A', { rating: '8' }), title('Best', { rating: '9,5' }),
      title('Edge', { rating: '7' }), title('Tie B', { rating: '8.0' }), title('None'), title('Junk', { rating: 'n/a' }),
    ];
    expect(topRated(items, 10).map((item) => item.name)).toEqual(['Best', 'Tie A', 'Tie B', 'Edge']);
  });

  it('caps the list and returns nothing when nothing qualifies', () => {
    const items = [title('A', { rating: '8' }), title('B', { rating: '9' }), title('C', { rating: '7.5' })];
    expect(topRated(items, 2).map((item) => item.name)).toEqual(['B', 'A']);
    expect(topRated([title('Low', { rating: '3' })], 5)).toEqual([]);
  });
});

describe('recentlyAdded', () => {
  it('orders by added time and hides titles without one', () => {
    const items = [title('Old', { added: 100 }), title('None'), title('New', { added: 300 }), title('Zero', { added: 0 })];
    expect(recentlyAdded(items, 10).map((item) => item.name)).toEqual(['New', 'Old']);
  });

  it('is empty for an old cache that has no stamps', () => {
    expect(recentlyAdded([title('A'), title('B')], 10)).toEqual([]);
  });
});

describe('year parsing', () => {
  it('reads a year from the name when the item has none', () => {
    expect(nameYear('Alpha (2024)')).toBe(2024);
    expect(nameYear('Alpha [1999] HD')).toBe(1999);
    expect(nameYear('Alpha 2024')).toBe(0);
    expect(nameYear('Alpha (12345)')).toBe(0);
    expect(titleYear(title('Alpha (2021)', { year: 2023 }))).toBe(2023);
    expect(titleYear(title('Alpha (2021)'))).toBe(2021);
  });
});

describe('newReleases', () => {
  const now = new Date(2026, 5, 1);

  it('keeps this year and last year, newest first, using the year field or the name', () => {
    const items = [
      title('Older', { year: 2020 }), title('Last year', { year: 2025, rating: '5' }),
      title('This year (2026)'), title('Unknown'), title('Also last year (2025)', { rating: '9' }),
    ];
    expect(newReleases(items, 10, now).map((item) => item.name)).toEqual([
      'This year (2026)', 'Also last year (2025)', 'Last year',
    ]);
  });

  it('is empty when no title has a recent year', () => {
    expect(newReleases([title('A', { year: 2001 }), title('B')], 10, now)).toEqual([]);
  });
});

describe('uniqueTitles', () => {
  it('keeps one of each title across case, accents, quality, and year tags', () => {
    const items = [
      title('Alpha', { year: 2009 }), title('ALPHA [4K]'), title('Álpha (2009) FHD'),
      title('Bravo'), title('Alpha HDR', { year: 2009 }),
    ];
    expect(uniqueTitles(items).map((item) => item.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('keeps same-named titles whose years differ', () => {
    const items = [title('Charlie (1984)'), title('Charlie (2021)'), title('Charlie [2021]')];
    expect(uniqueTitles(items).map((item) => item.name)).toEqual(['Charlie (1984)', 'Charlie (2021)']);
  });

  it('shows a title once in the smart lists, at its best rank', () => {
    const items = [title('Delta', { rating: '7.5' }), title('Delta 4K', { rating: '9' }), title('Echo', { rating: '8' })];
    expect(topRated(items, 10).map((item) => item.name)).toEqual(['Delta 4K', 'Echo']);
  });
});
