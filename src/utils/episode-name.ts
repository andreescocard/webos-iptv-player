import type { ResumeEntry } from '../types';

export interface EpisodeName {
  series: string;
  code: string;
  season: number;
  episode: number;
  title: string;
}

const SEPARATORS = /^[\s\-–—:|·.]+/;

function stripPrefix(text: string, prefix: string): string {
  return prefix && text.toLowerCase().indexOf(prefix.toLowerCase()) === 0
    ? text.slice(prefix.length).replace(SEPARATORS, '')
    : text;
}

// Xtream episode titles often repeat "<Series> - S02E20 - " ahead of the real title.
export function cleanEpisodeTitle(title: string, series: string): string {
  let rest = stripPrefix(title.trim(), series.trim());
  const code = /^S\d+\s*E\d+/i.exec(rest);
  if (code) rest = rest.slice(code[0].length).replace(SEPARATORS, '');
  return rest.trim();
}

// Resume names are composed as "<Series> — S2E5 — <Title>" (see Series.episodeLabel).
export function parseEpisodeName(name: string): EpisodeName {
  const m = /^(.*?) [—-] S(\d+)E(\d+)(?: [—-] (.*))?$/.exec(name);
  if (!m) return { series: name, code: '', season: 0, episode: 0, title: '' };
  const season = Number(m[2]);
  const episode = Number(m[3]);
  return {
    series: m[1], code: `S${season}E${episode}`, season, episode,
    title: cleanEpisodeTitle(m[4] ?? '', m[1]),
  };
}

export function episodeLine(p: { code: string; title: string }): string {
  return p.code ? (p.title ? `${p.code} · ${p.title}` : p.code) : '';
}

function seriesName(e: ResumeEntry): string {
  const p = parseEpisodeName(e.name);
  return p.code ? p.series.trim().toLowerCase() : '';
}

// Two episode entries share a series by owner id; an entry saved without one
// falls back to the series name parsed from its label.
export function sameSeries(a: ResumeEntry, b: ResumeEntry): boolean {
  const ida = a.watchlistOwner?.itemId;
  const idb = b.watchlistOwner?.itemId;
  if (ida && idb) return ida === idb;
  const name = seriesName(a);
  return name !== '' && name === seriesName(b);
}

// Season/episode position for ordering within a series; null when the name carries no code.
export function episodeOrder(e: ResumeEntry): number | null {
  const p = parseEpisodeName(e.name);
  return p.code ? p.season * 100000 + p.episode : null;
}
