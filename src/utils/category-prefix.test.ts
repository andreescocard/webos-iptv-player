import { describe, it, expect } from 'vitest';
import { sharedCategoryPrefix, stripCategoryPrefix } from './category-prefix';

const strip = (names: string[]) => {
  const prefix = sharedCategoryPrefix(names);
  return names.map((name) => stripCategoryPrefix(name, prefix));
};

describe('category prefix', () => {
  it('drops a word and unusual separator every category shares', () => {
    expect(strip(['Serie ∤ Alpha', 'Serie ∤ Bravo Max', 'Serie ∤ Charlie']))
      .toEqual(['Alpha', 'Bravo Max', 'Charlie']);
  });

  it('accepts common separators, glued colons, and mixed case', () => {
    expect(strip(['Movies | Alpha', 'MOVIES - Bravo', 'movies: Charlie', 'Movies • Delta']))
      .toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('keeps the categories that do not carry the shared prefix', () => {
    expect(strip(['VOD | Alpha', 'VOD | Bravo', 'VOD | Charlie', 'Delta']))
      .toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('leaves names alone when the prefix is not shared widely', () => {
    const names = ['Action - Classics', 'Action - Modern', 'Drama'];
    expect(sharedCategoryPrefix(names)).toBeNull();
    expect(strip(names)).toEqual(names);
  });

  it('never splits on a hyphen inside a word or plain words', () => {
    const names = ['Sci-Fi Alpha', 'Sci-Fi Bravo', 'New Releases'];
    expect(strip(names)).toEqual(names);
  });

  it('does not take a letter for a separator', () => {
    const names = ['Séries é Alpha', 'Séries é Bravo'];
    expect(sharedCategoryPrefix(names)).toBeNull();
  });

  it('needs at least two categories and a non-empty remainder', () => {
    expect(sharedCategoryPrefix(['Serie | Alpha'])).toBeNull();
    expect(stripCategoryPrefix('Serie |', 'serie')).toBe('Serie |');
  });
});
