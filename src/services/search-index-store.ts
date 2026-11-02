import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { retainAppWorker, runAppWorkerTask } from '../workers/app-worker-client';
import type { SearchIndexCandidate, SearchPrewarmSource } from '../workers/tasks';
import {
  onPlaylistCacheWritten,
  reserveSearchIndex,
  settleSearchIndex,
  type SearchIndexReservation,
} from './idb-cache';
import { onCatalogListWritten } from './xtream-catalog';

const log = createLogger('SearchIndex');
let persistChain: Promise<void> = Promise.resolve();

// The page reserves room for each index the worker built, then the worker
// writes the ones that fit. A failed write is dropped, never retried. The
// built indexes live only in that worker, so it must outlast the reservation.
export function persistSearchIndexes(candidates: SearchIndexCandidate[] | undefined): Promise<void> {
  if (!candidates?.length) return persistChain;
  const release = retainAppWorker();
  const run = () => persistNow(candidates);
  persistChain = persistChain.then(run, run);
  void persistChain.then(release, release);
  return persistChain;
}

async function persistNow(candidates: SearchIndexCandidate[]): Promise<void> {
  const reserved: Array<{
    candidate: SearchIndexCandidate;
    reservation: SearchIndexReservation;
  }> = [];
  for (const candidate of candidates) {
    try {
      const reservation = await reserveSearchIndex(candidate);
      if (reservation) reserved.push({ candidate, reservation });
    } catch (error) {
      log.warn(
        'Search index reservation failed',
        'event=search.index.persist.skipped',
        'reason=error',
        `bytes=${String(candidate.bytes)}`,
        error,
      );
    }
  }
  if (!reserved.length) return;
  let written: string[] = [];
  let failed: Array<{ key: string; reason: string }> = [];
  try {
    const response = await runAppWorkerTask('search.persist', {
      entries: reserved.map(({ candidate, reservation }) => ({
        key: candidate.key,
        prefix: candidate.prefix,
        fields: { ...reservation.fields },
      })),
    });
    written = response.written;
    failed = response.failed ?? [];
  } catch {
    failed = reserved.map(({ candidate }) => ({ key: candidate.key, reason: 'worker_failed' }));
  }
  let count = 0;
  let bytes = 0;
  let evicted = 0;
  for (const { candidate, reservation } of reserved) {
    const stored = written.indexOf(candidate.key) >= 0;
    await settleSearchIndex(candidate.key, reservation, stored).catch(() => undefined);
    evicted += reservation.evicted;
    if (stored) {
      count++;
      bytes += candidate.bytes;
      continue;
    }
    const failure = failed.find(entry => entry.key === candidate.key);
    log.warn(
      'Search index not stored',
      'event=search.index.persist.failed',
      `reason=${failure?.reason ?? 'not_written'}`,
      `bytes=${String(candidate.bytes)}`,
    );
  }
  if (count) {
    log.info(
      'Search index stored',
      'event=search.index.persist.completed',
      `count=${String(count)}`,
      `bytes=${String(bytes)}`,
      `evicted=${String(evicted)}`,
    );
  }
}

interface IdleWindow {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
}

function whenIdle(callback: () => void): void {
  const idle = (typeof window === 'undefined' ? undefined : window) as IdleWindow | undefined;
  if (idle && typeof idle.requestIdleCallback === 'function') {
    idle.requestIdleCallback(callback, { timeout: CONFIG.SEARCH.PREWARM_IDLE_TIMEOUT_MS });
  } else {
    setTimeout(callback, 0);
  }
}

/**
 * Builds and stores the Search index of each source in the app worker while
 * the UI is idle, so the next Search open reads prepared text. It holds the
 * worker only until the built indexes are stored; idle termination follows.
 */
export class SearchIndexPrewarmer {
  private scheduled = false;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly sources: () => SearchPrewarmSource[]) {}

  /** Re-index whenever a source cache record is stored. */
  watchSourceWrites(): () => void {
    const stops = [
      onPlaylistCacheWritten(() => this.schedule('playlist')),
      onCatalogListWritten((key) => {
        if (this.sources().some(source => source.key === key)) this.schedule('catalog');
      }),
    ];
    return () => stops.forEach(stop => stop());
  }

  schedule(reason: string): void {
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    whenIdle(() => {
      this.scheduled = false;
      const done = (): void => {
        this.running = null;
        if (!this.again) return;
        this.again = false;
        this.schedule('repeat');
      };
      this.running = this.run(reason).then(done, done);
    });
  }

  private async run(reason: string): Promise<void> {
    const sources = this.sources();
    if (!sources.length) return;
    const startedAt = Date.now();
    try {
      const response = await runAppWorkerTask('search.prewarm', { sources });
      const skipped = response.skipped ?? [];
      for (const entry of skipped) {
        log.info(
          'Search index prewarm skipped a source',
          'event=search.index.prewarm.skipped',
          `source=${entry.store}`,
          `reason=${entry.reason}`,
        );
      }
      log.info(
        'Search index prewarm completed',
        'event=search.index.prewarm.completed',
        `reason=${reason}`,
        `sources=${String(sources.length)}`,
        `built=${String(response.persist.length)}`,
        `skipped=${String(skipped.length)}`,
        `elapsedMs=${String(Date.now() - startedAt)}`,
      );
      await persistSearchIndexes(response.persist);
    } catch (error) {
      log.warn(
        'Search index prewarm failed',
        'event=search.index.prewarm.failed',
        `reason=${reason}`,
        `elapsedMs=${String(Date.now() - startedAt)}`,
        error,
      );
    }
  }
}
