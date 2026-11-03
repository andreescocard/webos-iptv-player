import { describe, expect, it } from 'vitest';
import { categoryWords, canonicalGenre, collectionIcon, planCategories } from './category-groups';
import { TAB_LIVE_ICON, STAR_ICON, CLOCK_ICON, TAG_ICON } from '../components/icons';

describe('categoryWords', () => {
  it('folds accents and case and drops quality and audio qualifiers', () => {
    expect(categoryWords('Ação 4K')).toEqual(['acao']);
    expect(categoryWords('FILMES | ACAO')).toEqual(['acao']);
    expect(categoryWords('Acao Legendado')).toEqual(['acao']);
    expect(categoryWords('Drama UHD H265 Dual Audio')).toEqual(['drama']);
    expect(categoryWords('Comedy [FHD] (DUB)')).toEqual(['comedy']);
  });

  it('reads multi-word science fiction spellings as one genre word', () => {
    expect(categoryWords('Ficção Científica')).toEqual(['scifi']);
    expect(categoryWords('Science Fiction')).toEqual(['scifi']);
    expect(categoryWords('Sci-Fi')).toEqual(['scifi']);
  });
});

describe('canonicalGenre', () => {
  it('merges messy spellings of one genre', () => {
    for (const name of ['AÇÃO', 'Ação 4K', 'FILMES | ACAO', 'Acao Legendado', 'Action HD', 'Filmes de Ação']) {
      expect(canonicalGenre(name)).toBe('action');
    }
    for (const name of ['Terror', 'HORROR FHD', 'Filmes | Terror Dublado']) {
      expect(canonicalGenre(name)).toBe('horror');
    }
    expect(canonicalGenre('Ficção Científica 4K')).toBe('scifi');
    expect(canonicalGenre('Documentários')).toBe('documentary');
  });

  it('lets the higher-priority genre claim a combined name', () => {
    expect(canonicalGenre('Ação e Aventura')).toBe('action');
    expect(canonicalGenre('Aventura & Ação')).toBe('action');
    expect(canonicalGenre('Comédia Romântica')).toBe('comedy');
  });

  it('leaves specific or unrelated names alone', () => {
    for (const name of ['Drama Coreano', 'Lançamentos 2024', 'Category Two', 'Esportes', '', '4K', 'Filmes']) {
      expect(canonicalGenre(name)).toBeNull();
    }
  });
});

describe('planCategories', () => {
  const cat = (id: string, name: string) => ({ id, name });

  it('merges duplicate genres, keeps provider order within a group, and orders groups by priority', () => {
    const plan = planCategories([
      cat('1', 'Drama'),
      cat('2', 'AÇÃO'),
      cat('3', 'Custom Picks'),
      cat('4', 'FILMES | ACAO'),
      cat('5', 'Ação 4K'),
      cat('6', 'Comedy'),
    ], null);
    expect(plan.map((group) => group.key)).toEqual(['g:action', 'g:comedy', 'g:drama', '3']);
    expect(plan[0].sourceIds).toEqual(['2', '4', '5']);
    expect(plan[3].kind).toBe('other');
  });

  it('puts streaming categories in service groups ahead of genres, never in genres', () => {
    const plan = planCategories([
      cat('1', 'Drama'),
      cat('2', 'Netflix | Drama'),
      cat('3', 'NETFLIX Ação'),
      cat('4', 'Disney+ Kids'),
    ], null);
    expect(plan.map((group) => group.key)).toEqual(['s:Netflix', 's:Disney+', 'g:drama']);
    expect(plan[0].sourceIds).toEqual(['2', '3']);
    expect(plan[2].sourceIds).toEqual(['1']);
  });

  it('strips a shared provider prefix before matching genres', () => {
    const plan = planCategories([cat('1', 'Serie | Drama'), cat('2', 'Serie | Custom Picks')], 'serie');
    expect(plan.map((group) => group.key)).toEqual(['g:drama', '2']);
  });

  it('puts each category in exactly one group', () => {
    const categories = ['Netflix', 'Action', 'Action 4K', 'Custom', 'Max Originals'].map((name, i) => cat(String(i), name));
    const ids = planCategories(categories, null).flatMap((group) => group.sourceIds).sort();
    expect(ids).toEqual(['0', '1', '2', '3', '4']);
  });
});

describe('collectionIcon', () => {
  it('chooses by kind without using the label as markup', () => {
    expect(collectionIcon('streaming', { label: 'Netflix' })).toBe(TAB_LIVE_ICON);
    expect(collectionIcon('smart', { smart: 'top', label: 'x' })).toBe(STAR_ICON);
    expect(collectionIcon('smart', { smart: 'new', label: 'x' })).toBe(CLOCK_ICON);
    expect(collectionIcon('genre', { genre: 'action', label: 'Aktion' })).not.toBe(TAG_ICON);
    expect(collectionIcon('other', { label: 'Custom Picks' })).toBe(TAG_ICON);
  });
});
