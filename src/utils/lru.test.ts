import { describe, it, expect } from 'vitest';
import { LruCache } from './lru';

describe('LruCache', () => {
  it('drops the least recently used entry past its capacity', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('refreshes an entry that is set again', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(10);
    expect(cache.has('b')).toBe(false);
  });
});
