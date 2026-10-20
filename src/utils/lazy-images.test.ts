// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Morph = typeof import('./morph').morph;
type Html = typeof import('./dom').html;
type LazySrc = typeof import('./lazy-images').lazySrc;

class FakeIO {
  static all: FakeIO[] = [];
  readonly targets = new Set<Element>();
  live = true;
  constructor(
    private readonly callback: (entries: unknown[], io: FakeIO) => void,
    readonly options: { root?: Element | null; rootMargin?: string } = {},
  ) {
    FakeIO.all.push(this);
  }
  observe(el: Element): void { this.targets.add(el); }
  unobserve(el: Element): void { this.targets.delete(el); }
  disconnect(): void { this.targets.clear(); this.live = false; }
  takeRecords(): unknown[] { return []; }
  fire(el: Element, near: boolean): void {
    this.callback([{ target: el, isIntersecting: near, intersectionRatio: near ? 1 : 0 }], this);
  }
  // Chromium 53 entries predate isIntersecting (Chrome 58).
  fireLegacy(el: Element, ratio: number): void {
    this.callback([{ target: el, intersectionRatio: ratio }], this);
  }
}

function observerOf(root: Element | null): FakeIO {
  const io = FakeIO.all.filter((o) => o.live && (o.options.root ?? null) === root);
  expect(io).toHaveLength(1);
  return io[0];
}

let morph: Morph;
let html: Html;
let lazySrc: LazySrc;
let host: HTMLElement;

async function load(): Promise<void> {
  vi.resetModules();
  ({ morph } = await import('./morph'));
  ({ html } = await import('./dom'));
  ({ lazySrc } = await import('./lazy-images'));
}

function poster(url: string, key = url): ReturnType<Html> {
  return html`<div data-key="${key}"><img class="p" ${lazySrc(url)} alt=""></div>`;
}

function img(key: string): HTMLImageElement {
  return host.querySelector<HTMLImageElement>(`[data-key="${key}"] img`)!;
}

beforeEach(() => {
  FakeIO.all = [];
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  vi.unstubAllGlobals();
});

describe('lazy images without IntersectionObserver', () => {
  it('renders a plain src, as before', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    await load();
    morph(host, poster('http://host/a'));
    expect(img('http://host/a').getAttribute('src')).toBe('http://host/a');
    expect(img('http://host/a').hasAttribute('data-lazy-src')).toBe(false);
  });

  it('loads a pending image at once', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    await load();
    morph(host, html`<img data-lazy-src="http://host/a" alt="">`);
    expect(host.querySelector('img')!.getAttribute('src')).toBe('http://host/a');
  });
});

describe('lazy images with IntersectionObserver', () => {
  beforeEach(async () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    await load();
  });

  it('holds the src until the image nears the screen', () => {
    morph(host, poster('http://host/a'));
    const el = img('http://host/a');
    expect(el.hasAttribute('src')).toBe(false);
    const io = observerOf(null);
    expect(io.options.rootMargin).toBe('100%');
    expect(io.targets.has(el)).toBe(true);

    io.fire(el, false);
    expect(el.hasAttribute('src')).toBe(false);
    io.fire(el, true);
    expect(el.getAttribute('src')).toBe('http://host/a');
    expect(el.hasAttribute('data-lazy-src')).toBe(false);
    expect(io.targets.has(el)).toBe(false);
  });

  it('reads intersectionRatio where isIntersecting is missing', () => {
    morph(host, poster('http://host/a'));
    const el = img('http://host/a');
    const io = observerOf(null);
    io.fireLegacy(el, 0);
    expect(el.hasAttribute('src')).toBe(false);
    io.fireLegacy(el, 0.25);
    expect(el.getAttribute('src')).toBe('http://host/a');
  });

  it('keeps a loaded image on re-render instead of resetting it', () => {
    morph(host, poster('http://host/a'));
    const el = img('http://host/a');
    observerOf(null).fire(el, true);

    const setAttribute = vi.spyOn(el, 'setAttribute');
    const removeAttribute = vi.spyOn(el, 'removeAttribute');
    morph(host, poster('http://host/a'));
    expect(img('http://host/a')).toBe(el);
    expect(el.getAttribute('src')).toBe('http://host/a');
    expect(el.hasAttribute('data-lazy-src')).toBe(false);
    expect(setAttribute).not.toHaveBeenCalled();
    expect(removeAttribute).not.toHaveBeenCalled();
    expect(observerOf(null).targets.has(el)).toBe(false);
  });

  it('keeps a pending image pending across re-renders', () => {
    morph(host, poster('http://host/a'));
    const el = img('http://host/a');
    morph(host, poster('http://host/a'));
    expect(img('http://host/a')).toBe(el);
    expect(el.hasAttribute('src')).toBe(false);
    expect(observerOf(null).targets.has(el)).toBe(true);
  });

  it('observes images a later render adds', () => {
    morph(host, poster('http://host/a'));
    morph(host, html`${poster('http://host/a')}${poster('http://host/b')}`);
    const io = observerOf(null);
    expect(io.targets.has(img('http://host/b'))).toBe(true);
    io.fire(img('http://host/b'), true);
    expect(img('http://host/b').getAttribute('src')).toBe('http://host/b');
    expect(img('http://host/a').hasAttribute('src')).toBe(false);
  });

  it('renders an already requested URL with its src', () => {
    morph(host, poster('http://host/a', 'k1'));
    observerOf(null).fire(img('k1'), true);
    morph(host, html`${poster('http://host/a', 'k1')}${poster('http://host/a', 'k2')}`);
    expect(img('k2').getAttribute('src')).toBe('http://host/a');
  });

  it('waits again when a reused node gets a new URL', () => {
    morph(host, poster('http://host/a', 'k1'));
    const el = img('k1');
    observerOf(null).fire(el, true);
    morph(host, poster('http://host/b', 'k1'));
    expect(img('k1')).toBe(el);
    expect(el.hasAttribute('src')).toBe(false);
    expect(el.getAttribute('data-lazy-src')).toBe('http://host/b');
    const io = observerOf(null);
    expect(io.targets.has(el)).toBe(true);
    io.fire(el, true);
    expect(el.getAttribute('src')).toBe('http://host/b');
  });

  it('stops observing an image a re-render removed', () => {
    morph(host, html`${poster('http://host/a')}${poster('http://host/b')}`);
    const removed = img('http://host/b');
    morph(host, poster('http://host/a'));
    const io = observerOf(null);
    expect(io.targets.has(removed)).toBe(false);
    io.fire(removed, true);
    expect(removed.hasAttribute('src')).toBe(false);
  });

  it('loads a scroller\'s images only while the scroller is near', () => {
    const rail = (urls: string[]): ReturnType<Html> => html`
      <div class="rails" data-lazy-root>
        <div class="track" data-key="track" data-lazy-root>${urls.map((u) => poster(u))}</div>
      </div>`;
    morph(host, rail(['http://host/a', 'http://host/b']));
    const rails = host.querySelector('.rails')!;
    const track = host.querySelector('.track')!;
    const a = img('http://host/a');

    const viewport = observerOf(null);
    expect([...viewport.targets]).toEqual([rails]);
    viewport.fire(rails, true);
    const railsIo = observerOf(rails);
    expect(railsIo.options.rootMargin).toBe('100%');
    expect([...railsIo.targets]).toEqual([track]);

    // A rail below the fold fetches nothing.
    railsIo.fire(track, false);
    expect(FakeIO.all.some((o) => o.live && o.options.root === track)).toBe(false);

    railsIo.fire(track, true);
    const trackIo = observerOf(track);
    expect(trackIo.targets.has(a)).toBe(true);
    trackIo.fire(a, true);
    expect(a.getAttribute('src')).toBe('http://host/a');
    expect(img('http://host/b').hasAttribute('src')).toBe(false);

    // Scrolled away, the rail stops watching; back near, it resumes.
    railsIo.fire(track, false);
    expect(trackIo.live).toBe(false);
    railsIo.fire(track, true);
    expect([...observerOf(track).targets]).toEqual([img('http://host/b')]);
  });
});
