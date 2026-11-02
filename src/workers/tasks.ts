import type {
  Channel,
  EpgChannel,
  ParsedEpg,
  ParsedPlaylist,
  Programme,
} from '../types';
import type { XMLTVParseStats } from '../parsers/xmltv-parser';
import type { XtreamLiveReference } from '../utils/xtream-live-match';
import type { XtreamGroupNameFilter } from '../utils/xtream-category-filter';

export interface M3UWorkerRequest {
  url: string;
  timeout: number;
  xtreamLive?: XtreamLiveReference[];
  xtreamBaseUrl?: string;
  xtreamGroupFilter?: XtreamGroupNameFilter;
}

export interface M3UWorkerResponse {
  data: ParsedPlaylist;
  metrics: {
    transport: 'stream' | 'array_buffer';
    filter: 'none' | 'unavailable' | 'live_catalog';
    inputBytes: number;
    chunks: number;
    channelsKept: number;
    channelsDropped: number;
    elapsedMs: number;
  };
}

export type M3UWorkerChunk =
  | {
      kind: 'channels';
      channels: Channel[];
      inputBytes: number;
      chunks: number;
      channelsEmitted: number;
      channelsDropped: number;
    }
  | {
      kind: 'progress';
      inputBytes: number;
      chunks: number;
      channelsEmitted: number;
      channelsDropped: number;
    };

export interface XMLTVWorkerRequest {
  url: string;
  timeout: number;
  options: {
    nowMs?: number;
    channelIds?: string[];
    channelNames?: string[];
    retainChannelCatalog?: boolean;
    maxProgrammes?: number;
  };
}

export interface XMLTVWorkerResponse {
  data: ParsedEpg;
  stats: XMLTVParseStats;
  metrics: {
    transport: 'stream' | 'array_buffer';
    encoding: 'gzip' | 'plain';
    attempts: number;
    inputBytes: number;
    chunks: number;
    elapsedMs: number;
  };
}

export type XMLTVWorkerChunk =
  | { kind: 'reset'; attempt: number }
  | { kind: 'channels'; attempt: number; entries: Array<[string, EpgChannel]> }
  | { kind: 'programmes'; attempt: number; entries: Array<[string, Programme[]]> }
  | {
      kind: 'progress';
      attempt: number;
      encoding: 'gzip' | 'plain';
      inputBytes: number;
      chunks: number;
    };

export type SearchIndexSource = 'channels' | 'movies' | 'series';

export interface SearchCacheRecord {
  store: 'playlist-cache' | 'catalog-cache';
  key: string;
  timestamp: number;
}

/** A few documents as the main thread sees them, to catch a drifted record. */
export interface SearchDocumentSamples {
  indices: number[];
  documents: string[][];
}

/** Channel documents read from the playlist-cache record. */
export interface SearchCachedChannels {
  record: SearchCacheRecord;
  length: number;
  /** Record index of each document, in display order. */
  selection: Uint32Array;
  /** Documents whose display fields differ from the source name and group. */
  overrideIndices: number[];
  overrides: string[][];
  samples: SearchDocumentSamples;
}

/** Name documents read from a catalog-cache record. */
export interface SearchCachedNames {
  record: SearchCacheRecord;
  length: number;
  /** Record index of each document; null keeps every record item in order. */
  selection: Uint32Array | null;
  samples: SearchDocumentSamples;
}

/**
 * One slice of a source posted from the main thread. The worker stages slices
 * in order and swaps the source in once `total` documents have arrived.
 */
export interface SearchIndexChunk {
  source: SearchIndexSource;
  start: number;
  total: number;
  /** Channel field lists. */
  documents?: string[][];
  /** Movie or series names. */
  names?: string[];
}

export interface SearchIndexRequest {
  sessionId: number;
  reset?: boolean;
  chunk?: SearchIndexChunk;
  cachedChannels?: SearchCachedChannels;
  cachedMovies?: SearchCachedNames;
  cachedSeries?: SearchCachedNames;
}

export interface SearchIndexUnresolved {
  source: SearchIndexSource;
  reason: string;
}

export interface SearchIndexResponse {
  accepted: boolean;
  /** Cached sources the worker could not read; post them as arrays instead. */
  unresolved?: SearchIndexUnresolved[];
  /** Source indexes the worker built and could store, pending a reservation. */
  persist?: SearchIndexCandidate[];
  /** Source records served from a prepared index vs folded from the record. */
  loaded?: { persisted: number; built: number };
}

/** A built source index, sized for the page's cache reservation. */
export interface SearchIndexCandidate {
  key: string;
  /** Key prefix shared by every index of the same source record. */
  prefix: string;
  bytes: number;
}

export interface SearchIndexPersistEntry {
  key: string;
  prefix: string;
  /** Cache bookkeeping fields the page reserved for the record. */
  fields: Record<string, unknown>;
}

export interface SearchIndexPersistRequest {
  entries: SearchIndexPersistEntry[];
}

export interface SearchIndexPersistResponse {
  written: string[];
  /** Writes that failed; the worker cannot log to the TV's page console. */
  failed?: Array<{ key: string; reason: string }>;
}

/** A source cache record to index ahead of Search; no timestamp means look it up. */
export interface SearchPrewarmSource {
  store: SearchCacheRecord['store'];
  key: string;
  timestamp?: number;
}

export interface SearchPrewarmRequest {
  sources: SearchPrewarmSource[];
}

export interface SearchPrewarmResponse {
  persist: SearchIndexCandidate[];
  skipped?: Array<{ store: SearchCacheRecord['store']; reason: string }>;
}

export interface SearchQueryRequest {
  sessionId: number;
  query: string;
  limit: number;
  includeCatalog: boolean;
}

export interface SearchRankedIndices {
  indices: number[];
  hasMore: boolean;
}

export interface SearchQueryResponse {
  channels: SearchRankedIndices;
  movies: SearchRankedIndices;
  series: SearchRankedIndices;
}

export interface ListSearchIndexRequest {
  owner: string;
  sessionId: number;
  mode: 'fields' | 'names';
  documents: string[][];
}

export interface ListSearchQueryRequest {
  owner: string;
  sessionId: number;
  query: string;
}

export interface ScopedSearchReleaseRequest {
  owner: string;
  sessionId: number;
}

export interface MappingSearchDocument {
  id: string;
  channelId: string;
  name: string;
  fields: string[];
  sourceIndex: number;
}

export interface MappingSearchIndexRequest {
  owner: string;
  sessionId: number;
  documents: MappingSearchDocument[];
}

export interface MappingSearchQueryRequest {
  owner: string;
  sessionId: number;
  query: string;
  selectedId: string;
}

export interface AppWorkerTasks {
  'm3u.load': {
    request: M3UWorkerRequest;
    response: M3UWorkerResponse;
    chunk: M3UWorkerChunk;
  };
  'xmltv.load': {
    request: XMLTVWorkerRequest;
    response: XMLTVWorkerResponse;
    chunk: XMLTVWorkerChunk;
  };
  'search.index': {
    request: SearchIndexRequest;
    response: SearchIndexResponse;
  };
  'search.query': {
    request: SearchQueryRequest;
    response: SearchQueryResponse | null;
  };
  'search.prewarm': {
    request: SearchPrewarmRequest;
    response: SearchPrewarmResponse;
  };
  'search.persist': {
    request: SearchIndexPersistRequest;
    response: SearchIndexPersistResponse;
  };
  'list-search.index': {
    request: ListSearchIndexRequest;
    response: SearchIndexResponse;
  };
  'list-search.query': {
    request: ListSearchQueryRequest;
    response: SearchRankedIndices | null;
  };
  'list-search.release': {
    request: ScopedSearchReleaseRequest;
    response: SearchIndexResponse;
  };
  'mapping-search.index': {
    request: MappingSearchIndexRequest;
    response: SearchIndexResponse;
  };
  'mapping-search.query': {
    request: MappingSearchQueryRequest;
    response: SearchRankedIndices | null;
  };
  'mapping-search.release': {
    request: ScopedSearchReleaseRequest;
    response: SearchIndexResponse;
  };
}
