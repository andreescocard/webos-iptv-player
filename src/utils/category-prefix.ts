// Providers often prefix every category with the same word and a separator
// ("Series | Drama", "Series | Comedy"). The shared prefix says nothing in a
// section that already names the content type, so the browse view drops it.

// Share of categories that must carry the same leading word.
const SHARED_RATIO = 0.7;
const MAX_SEPARATOR_LENGTH = 3;

function isLetterOrDigit(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase() || (ch >= '0' && ch <= '9');
}

function isSeparator(token: string): boolean {
  if (!token || token.length > MAX_SEPARATOR_LENGTH) return false;
  for (let i = 0; i < token.length; i++) {
    if (isLetterOrDigit(token.charAt(i))) return false;
  }
  return true;
}

function hasLetterOrDigit(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    if (isLetterOrDigit(word.charAt(i))) return true;
  }
  return false;
}

interface SplitName {
  word: string;
  rest: string;
}

// "Word | Rest" or "Word: Rest"; a separator needs whitespace after it, so
// hyphenated names ("Sci-Fi") never split.
function splitName(name: string): SplitName | null {
  const match = /^\s*(\S+)\s+(\S+)\s+(\S[\s\S]*)$/.exec(name);
  if (match && isSeparator(match[2]) && hasLetterOrDigit(match[1])) {
    return { word: match[1], rest: match[3].trim() };
  }
  const glued = /^\s*(\S+)\s+(\S[\s\S]*)$/.exec(name);
  if (!glued) return null;
  const head = glued[1];
  const tail = head.charAt(head.length - 1);
  const word = head.slice(0, -1);
  if (!isSeparator(tail) || !hasLetterOrDigit(word)) return null;
  return { word, rest: glued[2].trim() };
}

// The leading word most category names share, lowercased, or null when no
// word is shared widely enough to be a provider prefix.
export function sharedCategoryPrefix(names: string[]): string | null {
  if (names.length < 2) return null;
  const counts = new Map<string, number>();
  for (const name of names) {
    const split = splitName(name);
    if (!split) continue;
    const word = split.word.toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  counts.forEach((count, word) => {
    if (count > bestCount) {
      best = word;
      bestCount = count;
    }
  });
  if (bestCount < 2 || bestCount < names.length * SHARED_RATIO) return null;
  return best;
}

export function stripCategoryPrefix(name: string, prefix: string | null): string {
  if (prefix === null) return name;
  const split = splitName(name);
  if (!split || split.word.toLowerCase() !== prefix || !split.rest) return name;
  return split.rest;
}
