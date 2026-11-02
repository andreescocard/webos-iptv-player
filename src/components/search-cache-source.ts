import type { Channel } from '../types';
import { cacheRecordRef } from '../services/idb-cache';
import type { ChannelCacheSource } from '../services/playlist-service';
import type {
  SearchCachedChannels,
  SearchCachedNames,
  SearchDocumentSamples,
} from '../workers/tasks';

// Builds the compact selections that let the app worker read Search documents
// from IndexedDB instead of receiving every string through postMessage.

const SAMPLE_COUNT = 8;

export function channelDocument(channel: Channel): string[] {
  return [channel.name, channel.group, channel.sourceName ?? ''];
}

export function sampleDocuments(
  count: number,
  documentAt: (index: number) => string[],
): SearchDocumentSamples {
  const indices: number[] = [];
  const documents: string[][] = [];
  if (count <= 0) return { indices, documents };
  const step = count <= SAMPLE_COUNT ? 1 : (count - 1) / (SAMPLE_COUNT - 1);
  for (let i = 0; i < Math.min(count, SAMPLE_COUNT); i++) {
    const index = Math.round(i * step);
    indices.push(index);
    documents.push(documentAt(index));
  }
  return { indices, documents };
}

export function cachedChannelsRequest(
  channels: Channel[],
  source: ChannelCacheSource | null,
): SearchCachedChannels | null {
  if (!source || source.selection.length !== channels.length) return null;
  const overrideIndices: number[] = [];
  const overrides: string[][] = [];
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    if (channel.sourceName === undefined && channel.sourceGroup === undefined) continue;
    overrideIndices.push(i);
    overrides.push(channelDocument(channel));
  }
  return {
    record: source.record,
    length: source.length,
    selection: source.selection,
    overrideIndices,
    overrides,
    samples: sampleDocuments(channels.length, index => channelDocument(channels[index])),
  };
}

/**
 * Selects the visible catalog items in one pass. Without concealment every
 * item stays, in order, and the worker needs no selection at all.
 */
export function selectCatalogItems<T>(
  items: T[],
  concealing: boolean,
  concealed: (item: T) => boolean,
): { items: T[]; selection: Uint32Array | null } {
  if (!concealing) return { items, selection: null };
  const visible: T[] = [];
  const selection = new Uint32Array(items.length);
  for (let i = 0; i < items.length; i++) {
    if (concealed(items[i])) continue;
    selection[visible.length] = i;
    visible.push(items[i]);
  }
  return { items: visible, selection: selection.slice(0, visible.length) };
}

export function cachedNamesRequest(
  source: unknown[],
  items: Array<{ name: string }>,
  selection: Uint32Array | null,
): SearchCachedNames | null {
  const record = cacheRecordRef(source);
  if (!record || record.store !== 'catalog-cache') return null;
  if ((selection ? selection.length : source.length) !== items.length) return null;
  return {
    record,
    length: source.length,
    selection,
    samples: sampleDocuments(items.length, index => [items[index].name]),
  };
}

