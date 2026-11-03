const warm = new Set<string>();

// Warms the HTTP cache so a swapped-in <img> paints at once; `done` runs on
// load or error, synchronously when the URL is already warm.
export function preloadImage(url: string, done: () => void = () => undefined): void {
  if (!url || warm.has(url)) {
    done();
    return;
  }
  const img = new Image();
  img.onload = () => { warm.add(url); done(); };
  img.onerror = () => done();
  img.src = url;
}
