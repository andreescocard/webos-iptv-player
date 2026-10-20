// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkYoutubeVideo,
  clearTrailerCache,
  isTmdbBearerToken,
  normalizeYoutubeId,
  pickTmdbVideos,
  rankScrapedVideos,
  resolveTrailer,
  setTmdbApiKey,
} from './trailer-service';

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown } | Promise<never>;

function stubFetch(handler: Handler) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const res = handler(url, init);
    if (res instanceof Promise) return res;
    return Promise.resolve({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: 'x',
      json: () => Promise.resolve(res.body ?? {}),
      text: () => Promise.resolve(typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {})),
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const isOembed = (u: string) => u.indexOf('youtube.com/oembed') !== -1;
const isSearch = (u: string) => u.indexOf('youtubei/v1/search') !== -1;
const searchCall = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls.find(c => isSearch(c[0] as string)) as [string, RequestInit];
const searchQueries = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls
  .filter(c => isSearch(c[0] as string))
  .map(c => JSON.parse((c[1] as RequestInit).body as string).query);
const GOOD = 'abcdefghijk';
const BAD = 'zzzzzzzzzzz';

// Innertube-shaped search body: one videoRenderer per [videoId, title] pair.
const results = (...pairs: [string, string][]) => JSON.stringify({
  contents: pairs.map(([videoId, title]) => ({
    videoRenderer: { videoId, title: { runs: [{ text: title }] } },
  })),
});

// Same shape with each renderer's lengthText, when the row has one.
const timedResults = (...rows: [string, string, string?][]) => JSON.stringify({
  contents: rows.map(([videoId, title, length]) => ({
    videoRenderer: {
      videoId,
      title: { runs: [{ text: title }] },
      ...(length ? { lengthText: { simpleText: length } } : {}),
    },
  })),
});

beforeEach(() => {
  clearTrailerCache();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('normalizeYoutubeId', () => {
  it('accepts bare ids and URL shapes', () => {
    expect(normalizeYoutubeId(GOOD)).toBe(GOOD);
    expect(normalizeYoutubeId(` ${GOOD} `)).toBe(GOOD);
    expect(normalizeYoutubeId(`https://www.youtube.com/watch?v=${GOOD}`)).toBe(GOOD);
    expect(normalizeYoutubeId(`https://www.youtube.com/watch?feature=x&v=${GOOD}&t=3`)).toBe(GOOD);
    expect(normalizeYoutubeId(`https://youtu.be/${GOOD}?t=3`)).toBe(GOOD);
    expect(normalizeYoutubeId(`https://www.youtube.com/embed/${GOOD}`)).toBe(GOOD);
    expect(normalizeYoutubeId(`https://www.youtube-nocookie.com/embed/${GOOD}`)).toBe(GOOD);
  });

  it('rejects junk', () => {
    expect(normalizeYoutubeId('')).toBeNull();
    expect(normalizeYoutubeId('   ')).toBeNull();
    expect(normalizeYoutubeId(undefined)).toBeNull();
    expect(normalizeYoutubeId(42)).toBeNull();
    expect(normalizeYoutubeId('short')).toBeNull();
    expect(normalizeYoutubeId('http://host/a')).toBeNull();
    expect(normalizeYoutubeId('https://www.youtube.com/watch?v=tooShort')).toBeNull();
  });
});

describe('checkYoutubeVideo', () => {
  it('maps statuses to verdicts', async () => {
    stubFetch(() => ({ status: 200 }));
    expect(await checkYoutubeVideo('vid00000001')).toBe('ok');
    for (const [status, verdict] of [[401, 'broken'], [403, 'broken'], [404, 'broken'], [500, 'unknown'], [429, 'unknown']] as const) {
      clearTrailerCache();
      stubFetch(() => ({ status }));
      expect(await checkYoutubeVideo('vid00000002')).toBe(verdict);
    }
  });

  it('treats a network error as unknown and does not cache it', async () => {
    const fn = stubFetch(() => Promise.reject(new TypeError('offline')));
    expect(await checkYoutubeVideo('vid00000003')).toBe('unknown');
    expect(await checkYoutubeVideo('vid00000003')).toBe('unknown');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('treats a timeout as unknown', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }));
    const p = checkYoutubeVideo('vid00000004');
    await vi.advanceTimersByTimeAsync(7000);
    expect(await p).toBe('unknown');
  });

  it('caches ok and broken verdicts', async () => {
    const fn = stubFetch(u => ({ status: u.indexOf(BAD) !== -1 ? 404 : 200 }));
    await checkYoutubeVideo(GOOD);
    await checkYoutubeVideo(GOOD);
    await checkYoutubeVideo(BAD);
    await checkYoutubeVideo(BAD);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects when the caller aborts', async () => {
    stubFetch(() => new Promise(() => {}) as Promise<never>);
    const ctl = new AbortController();
    const p = checkYoutubeVideo('vid00000005', ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('TMDB helpers', () => {
  it('orders trailers, officials, then recency; drops non-YouTube', () => {
    const ids = pickTmdbVideos([
      { key: 'teaser00001', site: 'YouTube', type: 'Teaser', official: true, published_at: '2024-01-01' },
      { key: 'vimeo000001', site: 'Vimeo', type: 'Trailer', official: true },
      { key: 'old00000001', site: 'YouTube', type: 'Trailer', official: true, published_at: '2020-01-01' },
      { key: 'new00000001', site: 'YouTube', type: 'Trailer', official: true, published_at: '2023-01-01' },
      { key: 'unof0000001', site: 'YouTube', type: 'Trailer', official: false, published_at: '2025-01-01' },
      { key: 'clip0000001', site: 'YouTube', type: 'Clip', official: true },
    ]);
    expect(ids).toEqual(['new00000001', 'old00000001', 'unof0000001', 'teaser00001']);
  });

  it('prefers a dubbed video among equals for Portuguese only', () => {
    const videos = [
      { key: 'sub00000001', name: 'Trailer Legendado', site: 'YouTube', type: 'Trailer', official: true },
      { key: 'dub00000001', name: 'Trailer Dublado', site: 'YouTube', type: 'Trailer', official: false },
    ];
    expect(pickTmdbVideos(videos, true)).toEqual(['dub00000001', 'sub00000001']);
    expect(pickTmdbVideos(videos)).toEqual(['sub00000001', 'dub00000001']);
  });

  it('detects bearer tokens by format', () => {
    expect(isTmdbBearerToken('0123456789abcdef0123456789abcdef')).toBe(false);
    expect(isTmdbBearerToken('eyJhbGciOi.payload.sig')).toBe(true);
    expect(isTmdbBearerToken('x'.repeat(60))).toBe(true);
  });
});

describe('resolveTrailer', () => {
  const base = { kind: 'movie' as const, title: 'Alpha', year: 2020 };
  const KEY = '0123456789abcdef0123456789abcdef';

  it('uses a valid panel trailer without calling TMDB when no key is set', async () => {
    const fn = stubFetch(() => ({ status: 200 }));
    const r = await resolveTrailer({ ...base, panelTrailer: `https://youtu.be/${GOOD}`, tmdbId: 1 });
    expect(r).toEqual({ kind: 'video', videoId: GOOD, source: 'panel' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('prefers TMDB in the app language over the panel link', async () => {
    const OTHER = 'otherotherX';
    stubFetch(u => (isOembed(u)
      ? { status: 200 }
      : { status: 200, body: { results: [{ key: OTHER, site: 'YouTube', type: 'Trailer' }] } }));
    setTmdbApiKey(KEY);
    const r = await resolveTrailer({ ...base, panelTrailer: GOOD, tmdbId: 1, language: 'pt-BR' });
    expect(r).toEqual({ kind: 'video', videoId: OTHER, source: 'tmdb' });
  });

  it('tries the panel link before TMDB English', async () => {
    const fn = stubFetch(u => {
      if (isOembed(u)) return { status: 200 };
      return { status: 200, body: { results: u.indexOf('language=pt-BR') !== -1 ? [] : [{ key: BAD, site: 'YouTube', type: 'Trailer' }] } };
    });
    setTmdbApiKey(KEY);
    const r = await resolveTrailer({ ...base, panelTrailer: GOOD, tmdbId: 1, language: 'pt-BR' });
    expect(r).toEqual({ kind: 'video', videoId: GOOD, source: 'panel' });
    expect(fn.mock.calls.some(c => c[0].indexOf('language=en-US') !== -1)).toBe(false);
  });

  it('falls to TMDB English after a broken panel link', async () => {
    stubFetch(u => {
      if (isOembed(u)) return { status: u.indexOf(BAD) !== -1 ? 404 : 200 };
      return { status: 200, body: { results: u.indexOf('language=pt-BR') !== -1 ? [] : [{ key: GOOD, site: 'YouTube', type: 'Trailer' }] } };
    });
    setTmdbApiKey(KEY);
    const r = await resolveTrailer({ ...base, panelTrailer: BAD, tmdbId: 1, language: 'pt-BR' });
    expect(r).toEqual({ kind: 'video', videoId: GOOD, source: 'tmdb' });
  });

  it('falls to TMDB with api_key when the panel trailer is broken', async () => {
    const fn = stubFetch(u => {
      if (isOembed(u)) return { status: u.indexOf(BAD) !== -1 ? 404 : 200 };
      return { status: 200, body: { results: [{ key: GOOD, site: 'YouTube', type: 'Trailer' }] } };
    });
    setTmdbApiKey(KEY);
    const r = await resolveTrailer({ ...base, panelTrailer: BAD, tmdbId: '77', language: 'en-US' });
    expect(r).toEqual({ kind: 'video', videoId: GOOD, source: 'tmdb' });
    const tmdbCall = fn.mock.calls.find(c => c[0].indexOf('api.themoviedb.org') !== -1)!;
    expect(tmdbCall[0]).toContain('/movie/77/videos');
    expect(tmdbCall[0]).toContain(`api_key=${KEY}`);
  });

  it('sends a v4 token as a bearer header', async () => {
    const token = 'eyJhbGciOi.payload.sig';
    const fn = stubFetch(u => (isOembed(u)
      ? { status: 200 }
      : { status: 200, body: { results: [{ key: GOOD, site: 'YouTube', type: 'Trailer' }] } }));
    setTmdbApiKey(token);
    await resolveTrailer({ ...base, kind: 'tv', tmdbId: 5, language: 'en-US' });
    const call = fn.mock.calls.find(c => c[0].indexOf('api.themoviedb.org') !== -1)!;
    expect(call[0]).toContain('/tv/5/videos');
    expect(call[0]).not.toContain('api_key');
    expect((call[1]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it('tries the UI language first, then en-US', async () => {
    const fn = stubFetch(u => {
      if (isOembed(u)) return { status: 200 };
      if (u.indexOf('language=pt-BR') !== -1) return { status: 200, body: { results: [] } };
      return { status: 200, body: { results: [{ key: GOOD, site: 'YouTube', type: 'Trailer' }] } };
    });
    setTmdbApiKey(KEY);
    const r = await resolveTrailer({ ...base, tmdbId: 9, language: 'pt-BR' });
    expect(r).toMatchObject({ kind: 'video', source: 'tmdb' });
    const langs = fn.mock.calls.filter(c => c[0].indexOf('/videos') !== -1)
      .map(c => /language=([\w-]+)/.exec(c[0])![1]);
    expect(langs).toEqual(['pt-BR', 'en-US']);
  });

  it('skips a broken TMDB candidate for the next one', async () => {
    stubFetch(u => {
      if (isOembed(u)) return { status: u.indexOf(BAD) !== -1 ? 404 : 200 };
      return { status: 200, body: { results: [
        { key: BAD, site: 'YouTube', type: 'Trailer', official: true },
        { key: GOOD, site: 'YouTube', type: 'Trailer', official: false },
      ] } };
    });
    setTmdbApiKey(KEY);
    const r = await resolveTrailer({ ...base, tmdbId: 3, language: 'en-US' });
    expect(r).toMatchObject({ videoId: GOOD });
  });

  it('searches TMDB by title and year only on a close title match', async () => {
    const fn = stubFetch(u => {
      if (isOembed(u)) return { status: 200 };
      if (u.indexOf('/search/movie') !== -1) {
        return { status: 200, body: { results: [{ id: 42, title: 'ALPHA!' }] } };
      }
      return { status: 200, body: { results: [{ key: GOOD, site: 'YouTube', type: 'Trailer' }] } };
    });
    setTmdbApiKey(KEY);
    const r = await resolveTrailer({ ...base, language: 'en-US' });
    expect(r).toMatchObject({ videoId: GOOD, source: 'tmdb' });
    const search = fn.mock.calls.find(c => c[0].indexOf('/search/movie') !== -1)![0];
    expect(search).toContain('year=2020');
    expect(fn.mock.calls.some(c => c[0].indexOf('/movie/42/videos') !== -1)).toBe(true);
  });

  it('ignores a TMDB search hit with a different title', async () => {
    stubFetch(u => (u.indexOf('/search/') !== -1
      ? { status: 200, body: { results: [{ id: 42, title: 'Bravo' }] } }
      : { status: 200 }));
    setTmdbApiKey(KEY);
    const r = await resolveTrailer({ ...base, language: 'en-US' });
    expect(r).toEqual({ kind: 'none' });
  });

  it('resolves to none, not a search, when nothing resolves', async () => {
    const fn = stubFetch(() => ({ status: 404 }));
    const r = await resolveTrailer({ kind: 'tv', title: 'Charlie', panelTrailer: 'junk' });
    expect(r).toEqual({ kind: 'none' });
    expect(fn.mock.calls.every(c => c[0].indexOf('youtubei/v1/search') !== -1)).toBe(true);
  });

  it('finds a trailer by scraping YouTube search when there is no key', async () => {
    const page = results([BAD, 'Bravo trailer'], [GOOD, 'Alpha trailer'], [GOOD, 'Alpha trailer']);
    const fn = stubFetch(u => (isOembed(u)
      ? { status: u.indexOf(BAD) !== -1 ? 404 : 200 }
      : { status: 200, body: page }));
    const r = await resolveTrailer({ ...base, language: 'en-US' });
    expect(r).toEqual({ kind: 'video', videoId: GOOD, source: 'youtube' });
    const [url, init] = searchCall(fn);
    expect(url).toBe('https://www.youtube.com/youtubei/v1/search?prettyPrint=false');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      context: { client: { clientName: 'WEB', hl: 'en', gl: 'US' } },
      query: 'Alpha 2020 trailer',
    });
    expect(fn.mock.calls.some(c => c[0].indexOf('api.themoviedb.org') !== -1)).toBe(false);
  });

  it('tries the dubbed query first for pt-BR', async () => {
    const fn = stubFetch((u, init) => (isOembed(u)
      ? { status: 200 }
      : { status: 200, body: String(init?.body).indexOf('dublado') !== -1 ? results([GOOD, 'Alpha trailer dublado']) : '{}' }));
    const r = await resolveTrailer({ ...base, language: 'pt-BR' });
    expect(r).toEqual({ kind: 'video', videoId: GOOD, source: 'youtube' });
    expect(searchQueries(fn)).toEqual(['Alpha 2020 trailer dublado']);
    expect(JSON.parse(searchCall(fn)[1].body as string).context.client)
      .toMatchObject({ hl: 'pt', gl: 'BR' });
  });

  it('falls back to the plain query for pt-BR when no dub is found', async () => {
    const fn = stubFetch((u, init) => (isOembed(u)
      ? { status: 200 }
      : { status: 200, body: String(init?.body).indexOf('dublado') !== -1 ? '{}' : results([GOOD, 'Alpha trailer']) }));
    const r = await resolveTrailer({ kind: 'movie', title: 'Alpha', language: 'pt-BR' });
    expect(r).toEqual({ kind: 'video', videoId: GOOD, source: 'youtube' });
    expect(searchQueries(fn)).toEqual(['Alpha trailer dublado', 'Alpha trailer']);
  });

  it('adds anime to the queries for an anime genre', async () => {
    const fn = stubFetch(u => (isOembed(u) ? { status: 200 } : { status: 200, body: '{}' }));
    await resolveTrailer({ ...base, genre: 'Anime, Ação', language: 'pt-BR' });
    expect(searchQueries(fn)).toEqual(['Alpha 2020 anime trailer dublado', 'Alpha 2020 anime trailer']);
  });

  it('adds the animated keyword for an animated category outside anime', async () => {
    const fn = stubFetch(u => (isOembed(u) ? { status: 200 } : { status: 200, body: '{}' }));
    await resolveTrailer({ kind: 'movie', title: 'Alpha', category: 'Desenhos', language: 'pt-BR' });
    expect(searchQueries(fn)).toEqual(['Alpha animação trailer dublado', 'Alpha animação trailer']);
  });

  it('uses the English animated keyword outside Portuguese', async () => {
    const fn = stubFetch(u => (isOembed(u) ? { status: 200 } : { status: 200, body: '{}' }));
    await resolveTrailer({ ...base, genre: 'Cartoon', language: 'en-US' });
    expect(searchQueries(fn)).toEqual(['Alpha 2020 animated trailer']);
  });

  it('skips a live-action candidate for an anime item', async () => {
    const fn = stubFetch(u => (isOembed(u) ? { status: 200 } : {
      status: 200,
      body: results([BAD, 'Alpha live action trailer'], [GOOD, 'Alpha anime trailer']),
    }));
    const r = await resolveTrailer({ ...base, genre: 'Anime', language: 'en-US' });
    expect(r).toEqual({ kind: 'video', videoId: GOOD, source: 'youtube' });
    const oembeds = fn.mock.calls.map(c => c[0]).filter(isOembed);
    expect(oembeds).toHaveLength(1);
    expect(oembeds[0]).toContain(GOOD);
  });

  it('ranks a non-animated item away from anime titles', async () => {
    const fn = stubFetch(u => (isOembed(u) ? { status: 200 } : {
      status: 200,
      body: results([BAD, 'Alpha anime trailer'], [GOOD, 'Alpha trailer']),
    }));
    const r = await resolveTrailer({ kind: 'movie', title: 'Alpha', language: 'en-US' });
    expect(r).toEqual({ kind: 'video', videoId: GOOD, source: 'youtube' });
    const oembedOrder = fn.mock.calls.map(c => c[0]).filter(u => isOembed(u));
    expect(oembedOrder[0]).toContain(GOOD);
  });

  it('returns none when no candidate title matches the item', async () => {
    const fn = stubFetch(u => (isOembed(u) ? { status: 200 } : {
      status: 200,
      body: results([BAD, 'Bravo trailer'], [GOOD, 'Charlie trailer']),
    }));
    expect(await resolveTrailer({ ...base, language: 'en-US' })).toEqual({ kind: 'none' });
    expect(fn.mock.calls.some(c => isOembed(c[0]))).toBe(false);
  });

  it('skips a full-length movie upload for the trailer below it', async () => {
    const fn = stubFetch(u => (isOembed(u) ? { status: 200 } : {
      status: 200,
      body: timedResults(
        [BAD, 'Alpha Trailer Filme Completo Dublado', '1:52:10'],
        [GOOD, 'Alpha Trailer Oficial Dublado', '2:10'],
      ),
    }));
    expect(await resolveTrailer({ ...base, language: 'en-US' }))
      .toEqual({ kind: 'video', videoId: GOOD, source: 'youtube' });
    const oembeds = fn.mock.calls.map(c => c[0]).filter(isOembed);
    expect(oembeds).toHaveLength(1);
    expect(oembeds[0]).toContain(GOOD);
  });

  it('falls through to none when the only title match is a long upload', async () => {
    const fn = stubFetch(u => (isOembed(u) ? { status: 200 } : {
      status: 200,
      body: timedResults([BAD, 'Alpha Full Movie', '1:45:02']),
    }));
    expect(await resolveTrailer({ ...base, language: 'en-US' })).toEqual({ kind: 'none' });
    expect(fn.mock.calls.some(c => isOembed(c[0]))).toBe(false);
  });

  it('matches accented and short-word titles on significant words', () => {
    const videos = [
      { videoId: BAD, title: 'Elan trailer' },
      { videoId: GOOD, title: 'Élan of the Alpha Trailer' },
    ];
    expect(rankScrapedVideos(videos, 'Élan of Alpha', false)).toEqual([GOOD]);
  });

  it('falls through to none when the scrape fetch fails', async () => {
    stubFetch(u => (isSearch(u) ? Promise.reject(new TypeError('offline')) : { status: 404 }));
    expect(await resolveTrailer({ ...base, language: 'en-US' })).toEqual({ kind: 'none' });
  });

  it('falls through to none on an HTTP error from the results page', async () => {
    stubFetch(() => ({ status: 503 }));
    expect(await resolveTrailer({ ...base, language: 'en-US' })).toEqual({ kind: 'none' });
  });

  it('omits the region when the language has none', async () => {
    const fn = stubFetch(u => (isOembed(u) ? { status: 404 } : { status: 200, body: '{}' }));
    await resolveTrailer({ kind: 'movie', title: 'Alpha', language: 'pt' });
    expect(JSON.parse(searchCall(fn)[1].body as string).context.client)
      .toEqual({ clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'pt' });
  });

  it('only considers the first five unique ids', async () => {
    const ids = ['id0000000a0', 'id0000000a1', 'id0000000a2', 'id0000000a3', 'id0000000a4', 'id0000000a5'];
    const page = results(...ids.map((id): [string, string] => [id, 'Alpha trailer']));
    const fn = stubFetch(u => (isOembed(u) ? { status: 404 } : { status: 200, body: page }));
    expect(await resolveTrailer({ ...base, language: 'en-US' })).toEqual({ kind: 'none' });
    expect(fn.mock.calls.filter(c => isOembed(c[0]))).toHaveLength(5);
  });

  it('aborts the scrape when the caller aborts', async () => {
    stubFetch(() => new Promise(() => {}) as Promise<never>);
    const ctl = new AbortController();
    const p = resolveTrailer({ ...base, language: 'en-US', signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('caches resolved results but not network-uncertain ones', async () => {
    const fn = stubFetch(() => ({ status: 200 }));
    const req = { ...base, panelTrailer: GOOD };
    await resolveTrailer(req);
    await resolveTrailer(req);
    expect(fn).toHaveBeenCalledTimes(1);

    clearTrailerCache();
    const flaky = stubFetch(() => Promise.reject(new TypeError('offline')));
    expect((await resolveTrailer(req)).kind).toBe('none');
    await resolveTrailer(req);
    expect(flaky.mock.calls.filter(c => isOembed(c[0]))).toHaveLength(2);
  });

  it('rejects when already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(resolveTrailer({ ...base, signal: ctl.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
