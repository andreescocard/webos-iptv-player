import { Safe } from './dom';
import { createLogger } from './logger';
import { isRingAttr, ringClasses } from '../navigation/focus-ring';
import { Focus } from '../navigation/focus-scope';
import { observeLazyImages } from './lazy-images';

const log = createLogger('morph');

/**
 * In-place keyed DOM reconciler. Patches `parent`'s subtree to match the nodes
 * described by `next` (the escaped output of the `html` tagged template),
 * reusing existing nodes wherever possible.
 *
 * Reused nodes keep their listeners, scroll position, and focus. Template
 * `class` is authoritative, except that a node keeps the ring a focus scope
 * painted on it; the scopes move or drop their ring by key once the patch
 * lands.
 *
 * List items SHOULD carry a `data-key` with a stable semantic id (channel id,
 * group name, day ISO, programme start ms). Unkeyed children fall back to
 * position-based matching by tag name.
 */
export function morph(parent: HTMLElement, next: Safe): void {
  const tmpl = document.createElement('template');
  tmpl.innerHTML = next.value;
  const outer = kept;
  kept = [];
  let held: Element[];
  try {
    patchChildren(parent, Array.from(tmpl.content.childNodes));
  } finally {
    held = kept;
    kept = outer;
  }
  observeLazyImages(parent);
  Focus.afterMorph(parent, held);
}

// Nodes whose ring the template dropped but the current patch kept.
let kept: Element[] = [];

const ELEMENT = 1;
const TEXT = 3;

function getKey(node: Node): string | null {
  if (node.nodeType !== ELEMENT) return null;
  return (node as Element).getAttribute('data-key');
}

function sameTagAndType(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === ELEMENT) return (a as Element).tagName === (b as Element).tagName;
  return true;
}

function patchChildren(parent: Node, nextChildren: Node[]): void {
  const oldChildren = Array.from(parent.childNodes);

  const oldByKey = new Map<string, Node>();
  for (const o of oldChildren) {
    const k = getKey(o);
    if (k == null) continue;
    if (oldByKey.has(k)) {
      // Duplicate old key — keep first, treat the rest as unkeyed for fallback.
      log.warn('duplicate old data-key:', k);
    } else {
      oldByKey.set(k, o);
    }
  }

  const seenNewKeys = new Set<string>();
  const used = new Set<Node>();
  let unkeyedCursor = 0;

  for (let i = 0; i < nextChildren.length; i++) {
    const newChild = nextChildren[i];
    const key = getKey(newChild);
    let match: Node | null = null;
    let allowUnkeyedFallback = key == null;

    if (key != null) {
      if (seenNewKeys.has(key)) {
        // Duplicate new key — treat this one as unkeyed.
        log.warn('duplicate new data-key:', key);
        allowUnkeyedFallback = true;
      } else {
        seenNewKeys.add(key);
        const candidate = oldByKey.get(key);
        if (candidate && !used.has(candidate) && sameTagAndType(candidate, newChild)) {
          match = candidate;
        }
      }
    }

    if (!match && allowUnkeyedFallback) {
      // Unkeyed fallback. Scan from the cursor for the next compatible old node;
      // only advance the cursor when we actually consume one. Skipping on a
      // non-match (e.g. text vs element) would eat real candidates needed by a
      // later new child.
      let found = -1;
      for (let j = unkeyedCursor; j < oldChildren.length; j++) {
        const c = oldChildren[j];
        if (used.has(c)) continue;
        if (getKey(c) != null) continue;
        if (!sameTagAndType(c, newChild)) continue;
        found = j;
        break;
      }
      if (found >= 0) {
        match = oldChildren[found];
        unkeyedCursor = found + 1;
      }
    }

    if (match) {
      used.add(match);
      patchNode(match, newChild);
      const current = parent.childNodes[i];
      if (current !== match) {
        parent.insertBefore(match, current || null);
      }
    } else {
      parent.insertBefore(newChild, parent.childNodes[i] || null);
    }
  }

  // Remove any old children that were not reused.
  for (const o of oldChildren) {
    if (!used.has(o) && o.parentNode === parent) {
      parent.removeChild(o);
    }
  }
}

function patchNode(oldNode: Node, newNode: Node): void {
  if (!sameTagAndType(oldNode, newNode)) {
    oldNode.parentNode!.replaceChild(newNode, oldNode);
    return;
  }

  if (oldNode.nodeType === TEXT) {
    if (oldNode.nodeValue !== newNode.nodeValue) {
      oldNode.nodeValue = newNode.nodeValue;
    }
    return;
  }

  if (oldNode.nodeType === ELEMENT) {
    // Fast path: a native deep-equality check (C++) is much cheaper than the
    // JS attribute-by-attribute + recursive child walk. Unchanged keyed rows
    // (the common re-render case) skip the whole subtree.
    if ((oldNode as Element).isEqualNode(newNode)) return;
    syncAttributes(oldNode as Element, newNode as Element);
    // A `data-morph-preserve` node is a mount point owned by a sub-component:
    // reuse the node and sync its attributes, but never reconcile its children
    // (the template supplies none — the component renders into it separately).
    if ((newNode as Element).hasAttribute('data-morph-preserve')) return;
    patchChildren(oldNode, Array.from(newNode.childNodes));
  }
}

function syncAttributes(oldEl: Element, newEl: Element): void {
  const newAttrs = Array.from(newEl.attributes);
  const oldAttrs = Array.from(oldEl.attributes);

  for (const a of newAttrs) {
    const value = a.name === 'class' ? classWithRing(oldEl, a.value) : a.value;
    if (oldEl.getAttribute(a.name) !== value) {
      oldEl.setAttribute(a.name, value);
    }
  }
  for (const a of oldAttrs) {
    if (newEl.hasAttribute(a.name) || isRingAttr(a.name)) continue;
    const ringOnly = a.name === 'class' ? classWithRing(oldEl, '') : '';
    if (ringOnly) oldEl.setAttribute(a.name, ringOnly);
    else oldEl.removeAttribute(a.name);
  }
}

// A style recalc between the patch and the scopes' pass would otherwise see
// the ring stripped and restart its transitions, then again once repainted.
function classWithRing(el: Element, next: string): string {
  const ring = ringClasses(el);
  if (!ring.length || !Focus.paints(el)) return next;
  const tokens = next.split(/\s+/).filter(Boolean);
  let added = false;
  for (const name of ring) {
    if (tokens.indexOf(name) >= 0) continue;
    tokens.push(name);
    added = true;
  }
  if (added) kept.push(el);
  return tokens.join(' ');
}
