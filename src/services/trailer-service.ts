import { getLocale } from '../i18n';
import { fetchWithTimeout } from '../utils/fetch-helper';

export type TrailerKind = 'movie' | 'tv';
export type TrailerResult =
  | { kind: 'video'; videoId: string; source: 'panel' | 'tmdb' | 'youtube' }
  | { kind: 'search'; query: string }
  // Nothing resolved to a playable video.
  | { kind: 'none' };

export interface TrailerRequest {
  kind: TrailerKind;
  title: string;
  year?: string | number;
  /** Raw Xtream `youtube_trailer` value. */
  panelTrailer?: string;
  /** Raw genre string from the item's info; drives animation detection. */
  genre?: string;
  /** Name of the category the item was browsed under. */
  category?: string;
  tmdbId?: string | number;
  /** TMDB language override; defaults to the UI locale. */
  language?: string;
  signal?: AbortSignal;
}

type Verdict = 'ok' | 'broken' | 'unknown';

const TMDB_KEY_STORAGE = 'iptv_tmdb_api_key';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const OEMBED_TIMEOUT_MS = 6000;
const TMDB_TIMEOUT_MS = 8000;
const CACHE_SIZE = 200;
const MAX_CANDIDATES = 3;
const SCRAPE_TIMEOUT_MS = 8000;
const SCRAPE_CANDIDATES = 5;

class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value as string);
    }
  }
  clear(): void { this.map.clear(); }
}

const verdicts = new Lru<'ok' | 'broken'>(CACHE_SIZE);
const results = new Lru<TrailerResult>(CACHE_SIZE);

export function clearTrailerCache(): void {
  verdicts.clear();
  results.clear();
}

export function getTmdbApiKey(): string {
  try { return (localStorage.getItem(TMDB_KEY_STORAGE) ?? '').trim(); } catch { return ''; }
}

export function setTmdbApiKey(key: string): void {
  try {
    const value = key.trim();
    if (value) localStorage.setItem(TMDB_KEY_STORAGE, value);
    else localStorage.removeItem(TMDB_KEY_STORAGE);
  } catch { /* storage unavailable */ }
  results.clear();
}

const ID_RE = /^[\w-]{11}$/;
const URL_ID_RE =
  /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})(?![\w-])/i;

export function normalizeYoutubeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (ID_RE.test(value)) return value;
  const match = URL_ID_RE.exec(value);
  return match ? match[1] : null;
}

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

// fetchWithTimeout owns its own signal, so caller aborts are raced instead.
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort);
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function httpStatus(err: unknown): number | null {
  const m = /^HTTP (\d{3})/.exec(err instanceof Error ? err.message : '');
  return m ? Number(m[1]) : null;
}

export async function checkYoutubeVideo(
  videoId: string,
  signal?: AbortSignal,
): Promise<Verdict> {
  const cached = verdicts.get(videoId);
  if (cached) return cached;
  const target = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
  try {
    await abortable(fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${target}&format=json`,
      {},
      OEMBED_TIMEOUT_MS,
    ), signal);
    verdicts.set(videoId, 'ok');
    return 'ok';
  } catch (err) {
    if (signal?.aborted) throw err;
    const status = httpStatus(err);
    if (status === 401 || status === 403 || status === 404) {
      verdicts.set(videoId, 'broken');
      return 'broken';
    }
    return 'unknown';
  }
}

interface TmdbVideo {
  key?: string;
  name?: string;
  site?: string;
  type?: string;
  official?: boolean;
  published_at?: string;
}

export function isTmdbBearerToken(key: string): boolean {
  return key.indexOf('eyJ') === 0 || key.length > 40;
}

// A dubbed cut is what a Portuguese viewer wants over a subtitled one.
const DUBBED_RE = /dublad|\bdub\b|\bdubbed\b/i;

export function pickTmdbVideos(videos: TmdbVideo[], preferDubbed = false): string[] {
  const dubbed = (v: TmdbVideo): number => (preferDubbed && DUBBED_RE.test(v.name ?? '') ? 1 : 0);
  const rank = (v: TmdbVideo): number =>
    (v.type === 'Trailer' ? 2 : v.type === 'Teaser' ? 1 : 0);
  return videos
    .filter(v => v.site === 'YouTube' && typeof v.key === 'string'
      && ID_RE.test(v.key) && rank(v) > 0)
    .sort((a, b) => {
      const byType = rank(b) - rank(a);
      if (byType) return byType;
      const byDub = dubbed(b) - dubbed(a);
      if (byDub) return byDub;
      const byOfficial = Number(!!b.official) - Number(!!a.official);
      if (byOfficial) return byOfficial;
      return (Date.parse(b.published_at ?? '') || 0)
        - (Date.parse(a.published_at ?? '') || 0);
    })
    .map(v => v.key as string);
}

async function tmdbGet<T>(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<T> {
  const query: string[] = [];
  const headers: Record<string, string> = {};
  if (isTmdbBearerToken(apiKey)) headers.Authorization = `Bearer ${apiKey}`;
  else query.push(`api_key=${encodeURIComponent(apiKey)}`);
  for (const k of Object.keys(params)) {
    query.push(`${k}=${encodeURIComponent(params[k])}`);
  }
  const res = await abortable(
    fetchWithTimeout(`${TMDB_BASE}${path}?${query.join('&')}`, { headers }, TMDB_TIMEOUT_MS),
    signal,
  );
  return (await abortable(res.json(), signal)) as T;
}

function uiLanguage(preferred?: string): string {
  const ui: string = preferred || getLocale();
  return ui === 'en' ? 'en-US' : ui;
}

function normalizeTitle(s: string): string {
  let out = s.toLowerCase();
  if (typeof out.normalize === 'function') out = out.normalize('NFD');
  return out.replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

interface TmdbSearchHit {
  id?: number;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
}

async function searchTmdbId(req: TrailerRequest, apiKey: string): Promise<string | null> {
  const title = normalizeTitle(req.title);
  if (!title) return null;
  const year = String(req.year ?? '').slice(0, 4);
  const params: Record<string, string> = { query: req.title };
  if (/^\d{4}$/.test(year)) {
    params[req.kind === 'movie' ? 'year' : 'first_air_date_year'] = year;
  }
  const data = await tmdbGet<{ results?: TmdbSearchHit[] }>(
    `/search/${req.kind}`, params, apiKey, req.signal,
  );
  const top = data.results?.[0];
  if (!top || typeof top.id !== 'number') return null;
  const names = [top.title, top.original_title, top.name, top.original_name]
    .filter((n): n is string => typeof n === 'string')
    .map(normalizeTitle);
  return names.indexOf(title) !== -1 ? String(top.id) : null;
}

interface TmdbState {
  volatile: boolean;
  id?: string | null;
}

async function tmdbId(req: TrailerRequest, apiKey: string, state: TmdbState): Promise<string | null> {
  if (state.id !== undefined) return state.id;
  const given = req.tmdbId !== undefined ? String(req.tmdbId).trim() : '';
  if (/^\d+$/.test(given)) {
    state.id = given;
    return given;
  }
  try {
    state.id = await searchTmdbId(req, apiKey);
  } catch (err) {
    if (req.signal?.aborted) throw err;
    state.volatile = true;
    return null;
  }
  return state.id;
}

async function tmdbTrailer(
  req: TrailerRequest,
  apiKey: string,
  state: TmdbState,
  language: string,
): Promise<string | null> {
  const id = await tmdbId(req, apiKey, state);
  if (!id) return null;
  let candidates: string[];
  try {
    const data = await tmdbGet<{ results?: TmdbVideo[] }>(
      `/${req.kind}/${id}/videos`, { language }, apiKey, req.signal,
    );
    candidates = pickTmdbVideos(data.results ?? [], language.toLowerCase().indexOf('pt') === 0);
  } catch (err) {
    if (req.signal?.aborted) throw err;
    state.volatile = true;
    return null;
  }
  for (const videoId of candidates.slice(0, MAX_CANDIDATES)) {
    const verdict = await checkYoutubeVideo(videoId, req.signal);
    if (verdict !== 'broken') return videoId;
  }
  return null;
}

export function trailerSearchQuery(
  title: string,
  year?: string | number,
  suffix?: string,
  keyword?: string,
): string {
  const y = String(year ?? '').slice(0, 4);
  return [title.trim(), /^\d{4}$/.test(y) ? y : '', keyword ?? '', 'trailer', suffix ?? '']
    .filter(Boolean).join(' ');
}

const ANIMATED_RE = /anim|anime|desenho|cartoon/i;
const ANIME_RE = /anime/i;

function isAnimated(req: TrailerRequest): boolean {
  return ANIMATED_RE.test(`${req.genre ?? ''} ${req.category ?? ''}`);
}

// Portuguese viewers get the dubbed cut first, then whatever YouTube ranks.
// An animated item adds its genre word so live-action trailers rank lower.
function scrapeQueries(req: TrailerRequest, language: string): string[] {
  const dubbed = language.toLowerCase().indexOf('pt') === 0;
  let keyword = '';
  if (isAnimated(req)) {
    if (ANIME_RE.test(`${req.genre ?? ''} ${req.category ?? ''}`)) keyword = 'anime';
    else keyword = dubbed ? 'animação' : 'animated';
  }
  const plain = trailerSearchQuery(req.title, req.year, '', keyword);
  return dubbed ? [trailerSearchQuery(req.title, req.year, 'dublado', keyword), plain] : [plain];
}

// "pt-BR" -> { hl: "pt", gl: "BR" }; a bare "pt" leaves the region out.
function innertubeLocale(language: string): { hl: string; gl?: string } {
  const [hl, gl] = language.split(/[-_]/);
  const lang = (hl || 'en').toLowerCase();
  return gl && /^[A-Za-z]{2}$/.test(gl) ? { hl: lang, gl: gl.toUpperCase() } : { hl: lang };
}

export interface ScrapedVideo {
  videoId: string;
  title: string;
  /** Undefined when the result shows no length (live, unlisted, or a bare fallback scan). */
  durationSec?: number;
}

// "2:31" -> 151, "1:45:02" -> 6302; anything else is unknown.
function durationSeconds(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function titleText(title: unknown): string {
  if (!title || typeof title !== 'object') return '';
  const t = title as { runs?: unknown; simpleText?: unknown };
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (!Array.isArray(t.runs)) return '';
  return t.runs.map((r: { text?: unknown } | null) =>
    (r && typeof r.text === 'string' ? r.text : '')).join('');
}

function walkVideos(node: unknown, out: ScrapedVideo[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walkVideos(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const renderer = obj.videoRenderer as
    { videoId?: unknown; title?: unknown; lengthText?: { simpleText?: unknown } } | undefined;
  if (renderer && typeof renderer.videoId === 'string' && ID_RE.test(renderer.videoId)) {
    out.push({
      videoId: renderer.videoId,
      title: titleText(renderer.title),
      durationSec: durationSeconds(renderer.lengthText?.simpleText),
    });
    return;
  }
  for (const key of Object.keys(obj)) walkVideos(obj[key], out);
}

// Regex fallback for a body that is not the expected JSON shape: each id takes
// the first title that follows it.
const SCAN_RE = /"videoId":"([A-Za-z0-9_-]{11})"|"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
function scanVideos(text: string): ScrapedVideo[] {
  const out: ScrapedVideo[] = [];
  const re = new RegExp(SCAN_RE.source, 'g');
  let last: ScrapedVideo | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1]) {
      last = { videoId: match[1], title: '' };
      out.push(last);
    } else if (last && !last.title) {
      try { last.title = JSON.parse(`"${match[2]}"`) as string; } catch { last.title = match[2]; }
    }
  }
  return out;
}

export function parseSearchVideos(text: string): ScrapedVideo[] {
  let found: ScrapedVideo[] = [];
  try {
    walkVideos(JSON.parse(text), found);
  } catch { found = []; }
  return found.length ? found : scanVideos(text);
}

// Words split on spaces and ASCII/Latin-1 punctuation, so non-Latin words survive.
function titleWords(s: string): string[] {
  let out = s.toLowerCase();
  if (typeof out.normalize === 'function') out = out.normalize('NFD');
  return out.replace(/[̀-ͯ]/g, '')
    .split(/[\s!-\/:-@[-`{-~¡-¿‐-‧]+/)
    .filter(Boolean);
}

const MAX_TRAILER_SECONDS = 360;
const UNKNOWN_LENGTH_PENALTY = 3;
const FULL_MOVIE_RE = /\b(filme completo|full movie|completo dublado|pelicula completa|film complet)\b/;

// Keeps only titles containing every significant word of the item, best first.
export function rankScrapedVideos(
  videos: ScrapedVideo[],
  itemTitle: string,
  animated: boolean,
): string[] {
  const words = titleWords(itemTitle);
  const significant = words.filter(w => w.length > 2);
  const needed = significant.length ? significant : words;
  if (!needed.length) return [];
  const scored: { id: string; score: number; index: number }[] = [];
  const seen: string[] = [];
  videos.forEach((video, index) => {
    if (!ID_RE.test(video.videoId) || seen.indexOf(video.videoId) !== -1) return;
    seen.push(video.videoId);
    const have = titleWords(video.title);
    if (!needed.every(w => have.indexOf(w) !== -1)) return;
    const text = have.join(' ');
    if (FULL_MOVIE_RE.test(text)) return;
    if (video.durationSec !== undefined && video.durationSec > MAX_TRAILER_SECONDS) return;
    let score = /trailer|teaser/.test(text) ? 2 : 0;
    // An unknown length ranks below any candidate whose short length is shown.
    if (video.durationSec === undefined) score -= UNKNOWN_LENGTH_PENALTY;
    if (animated) {
      if (/\blive action\b|\bfilme live\b/.test(text)) score -= 5;
    } else if (have.some(w => w === 'anime' || w === 'animacao')) {
      score -= 3;
    }
    scored.push({ id: video.videoId, score, index });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map(c => c.id);
}

// Keyless fallback: the JSON search endpoint returns videos in its response body.
async function scrapeYoutubeSearch(
  query: string,
  language: string,
  signal?: AbortSignal,
): Promise<ScrapedVideo[]> {
  const body = {
    context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', ...innertubeLocale(language) } },
    query,
  };
  const res = await abortable(fetchWithTimeout(
    'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
    {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    SCRAPE_TIMEOUT_MS,
  ), signal);
  return parseSearchVideos(await abortable(res.text(), signal));
}

async function scrapeTrailer(
  req: TrailerRequest,
  language: string,
  state: TmdbState,
): Promise<string | null> {
  if (!req.title.trim()) return null;
  for (const query of scrapeQueries(req, language)) {
    let videos: ScrapedVideo[];
    try {
      videos = await scrapeYoutubeSearch(query, language, req.signal);
    } catch (err) {
      if (req.signal?.aborted) throw err;
      state.volatile = true;
      continue;
    }
    const ranked = rankScrapedVideos(videos, req.title, isAnimated(req));
    for (const videoId of ranked.slice(0, SCRAPE_CANDIDATES)) {
      const verdict = await checkYoutubeVideo(videoId, req.signal);
      if (verdict === 'ok') return videoId;
      if (verdict === 'unknown') state.volatile = true;
    }
  }
  return null;
}

// Order: TMDB in the app language (a dub for Portuguese, key only), then the
// panel's own link, then a keyless YouTube search, then TMDB in English. Nothing
// resolving is `none`, never a search.
export async function resolveTrailer(req: TrailerRequest): Promise<TrailerResult> {
  if (req.signal?.aborted) throw abortError();
  const panelId = normalizeYoutubeId(req.panelTrailer);
  const tmdbKey = getTmdbApiKey();
  const language = uiLanguage(req.language);
  const cacheKey = [req.kind, req.tmdbId ?? '', panelId ?? '', req.title, req.year ?? '',
    language, tmdbKey ? 't' : '', isAnimated(req) ? 'a' : ''].join('|');
  const cached = results.get(cacheKey);
  if (cached) return cached;

  const state: TmdbState = { volatile: false };
  let result: TrailerResult | null = null;

  if (tmdbKey) {
    const videoId = await tmdbTrailer(req, tmdbKey, state, language);
    if (videoId) result = { kind: 'video', videoId, source: 'tmdb' };
  }
  if (!result && panelId) {
    const verdict = await checkYoutubeVideo(panelId, req.signal);
    if (verdict === 'ok') result = { kind: 'video', videoId: panelId, source: 'panel' };
    else if (verdict === 'unknown') state.volatile = true;
  }
  if (!result) {
    const videoId = await scrapeTrailer(req, language, state);
    if (videoId) result = { kind: 'video', videoId, source: 'youtube' };
  }
  if (!result && tmdbKey && language !== 'en-US') {
    const videoId = await tmdbTrailer(req, tmdbKey, state, 'en-US');
    if (videoId) result = { kind: 'video', videoId, source: 'tmdb' };
  }
  if (!result) result = { kind: 'none' };
  if (!state.volatile) results.set(cacheKey, result);
  return result;
}
