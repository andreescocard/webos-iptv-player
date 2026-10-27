import { describe, expect, it } from 'vitest';
import { cleanEpisodeTitle, episodeLine, parseEpisodeName } from './episode-name';

describe('cleanEpisodeTitle', () => {
  it('strips a repeated series name and episode code', () => {
    expect(cleanEpisodeTitle('Series One - S02E20 - Alpha', 'Series One')).toBe('Alpha');
    expect(cleanEpisodeTitle('series one – s02e20 – Alpha', 'Series One')).toBe('Alpha');
    expect(cleanEpisodeTitle('Series One: S2E5: Bravo', 'Series One')).toBe('Bravo');
    expect(cleanEpisodeTitle('S02E20 - Charlie', 'Series One')).toBe('Charlie');
  });

  it('leaves nothing when the title is only the prefix', () => {
    expect(cleanEpisodeTitle('Series One - S02E20', 'Series One')).toBe('');
  });

  it('keeps a plain title', () => {
    expect(cleanEpisodeTitle('Alpha', 'Series One')).toBe('Alpha');
  });
});

describe('parseEpisodeName', () => {
  it('reads the series, code and a cleaned title from a resume name', () => {
    const p = parseEpisodeName('Series One — S2E20 — Series One - S02E20 - Alpha');
    expect(p).toMatchObject({ series: 'Series One', code: 'S2E20', season: 2, episode: 20 });
    expect(episodeLine(p)).toBe('S2E20 · Alpha');
    expect(episodeLine(parseEpisodeName('Series One — S2E20 — Series One - S02E20'))).toBe('S2E20');
  });
});
