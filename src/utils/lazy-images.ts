import { html, Safe } from './dom';

// Viewport-based image loading for poster rails. Native `loading="lazy"` is
// Chrome 77+, so webOS 4/5 fetched every poster a rail rendered at once.
//
// An image renders with `data-lazy-src` and gets its `src` once it nears the
// screen. A scroller marked `data-lazy-root` is a zone: IntersectionObserver's
// rootMargin never reaches past a scroller's clip, so each zone observes its
// own images (one screen ahead of it), and only while the zone itself is near
// its parent zone or the viewport. A URL once requested renders as a plain
// `src`, so a morph() re-render matches the loaded node instead of resetting it.

const LAZY_SRC = 'data-lazy-src';
const LAZY_ROOT = 'data-lazy-root';
const MARGIN = '100%';

interface Zone {
  root: Element | null;
  io: IntersectionObserver | null;
  targets: Set<Element>;
}

const requested = new Set<string>();
const zones = new Map<Element, Zone>();
const owners = new Map<Element, Zone>();
let viewport: Zone | null = null;

function supported(): boolean {
  return typeof IntersectionObserver === 'function';
}

/** The `src` attribute of a lazily loaded image, for an `html` template. */
export function lazySrc(url: string): Safe {
  return supported() && !requested.has(url)
    ? html`${LAZY_SRC}="${url}"`
    : html`src="${url}"`;
}

/** Observes the pending images under `scope`; morph() calls it after each patch. */
export function observeLazyImages(scope: Element): void {
  if (owners.size) sweep();
  const pending = scope.querySelectorAll(`img[${LAZY_SRC}]`);
  if (!pending.length) return;
  const eager = !supported();
  Array.from(pending).forEach((img) => {
    if (eager) load(img);
    else if (!owners.has(img)) track(zoneOf(img), img);
  });
}

// isIntersecting is Chrome 58+.
function isNear(entry: IntersectionObserverEntry): boolean {
  const e = entry as { isIntersecting?: boolean; intersectionRatio: number };
  return typeof e.isIntersecting === 'boolean' ? e.isIntersecting : e.intersectionRatio > 0;
}

function viewportZone(): Zone {
  if (!viewport) {
    viewport = { root: null, io: null, targets: new Set() };
    activate(viewport);
  }
  return viewport;
}

function zoneOf(el: Element): Zone {
  const parent = el.parentElement;
  const root = parent ? parent.closest(`[${LAZY_ROOT}]`) : null;
  if (!root) return viewportZone();
  let zone = zones.get(root);
  if (!zone) {
    zone = { root, io: null, targets: new Set() };
    zones.set(root, zone);
    track(zoneOf(root), root);
  }
  return zone;
}

function track(zone: Zone, el: Element): void {
  zone.targets.add(el);
  owners.set(el, zone);
  if (zone.io) zone.io.observe(el);
}

function untrack(el: Element): void {
  const zone = owners.get(el);
  if (!zone) return;
  owners.delete(el);
  zone.targets.delete(el);
  if (zone.io) zone.io.unobserve(el);
  const own = zones.get(el);
  if (own) {
    deactivate(own);
    zones.delete(el);
  }
}

function activate(zone: Zone): void {
  if (zone.io) return;
  // eslint-disable-next-line compat/compat -- Chrome 51+; caniuse's "partial" is isIntersecting, which isNear covers
  const io = new IntersectionObserver(
    (entries) => onEntries(zone, entries),
    zone.root ? { root: zone.root, rootMargin: MARGIN } : { rootMargin: MARGIN },
  );
  zone.io = io;
  zone.targets.forEach((el) => io.observe(el));
}

// A zone that left the screen stops watching, and so do the zones inside it.
function deactivate(zone: Zone): void {
  if (!zone.io) return;
  zone.io.disconnect();
  zone.io = null;
  zone.targets.forEach((el) => {
    const inner = zones.get(el);
    if (inner) deactivate(inner);
  });
}

function onEntries(zone: Zone, entries: IntersectionObserverEntry[]): void {
  if (zone.io === null) return;
  for (const entry of entries) {
    const el = entry.target;
    if (owners.get(el) !== zone) continue;
    const inner = zones.get(el);
    const near = isNear(entry);
    if (inner) {
      if (near) activate(inner);
      else deactivate(inner);
    } else if (near) {
      load(el);
    }
  }
}

function load(img: Element): void {
  untrack(img);
  const url = img.getAttribute(LAZY_SRC);
  if (url === null) return;
  requested.add(url);
  img.setAttribute('src', url);
  img.removeAttribute(LAZY_SRC);
}

// Drops what a re-render removed, or no longer waits on a URL.
function sweep(): void {
  const doc = document.documentElement;
  owners.forEach((zone, el) => {
    const gone = !doc.contains(el)
      || (zone.root !== null && !zone.root.contains(el))
      || (!zones.has(el) && !el.hasAttribute(LAZY_SRC));
    if (gone) untrack(el);
  });
}
