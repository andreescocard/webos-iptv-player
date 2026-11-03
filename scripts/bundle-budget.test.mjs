import { describe, expect, it } from 'vitest';
import { checkBundleBudgets } from './bundle-budget.mjs';

describe('bundle size budgets', () => {
  it('accepts scripts within their budgets', () => {
    expect(checkBundleBudgets([
      { path: 'app.js', bytes: 1_000_000 },
      { path: 'app-worker.js', bytes: 80_000 },
      { path: 'locales/ru.js', bytes: 64_000 },
    ])).toEqual([]);
  });

  it('reports each script over its budget', () => {
    expect(checkBundleBudgets([
      { path: 'app.js', bytes: 1_150_001 },
      { path: 'locales/de.js', bytes: 70_000 },
    ])).toEqual([
      'app.js is 1150001 bytes, over its 1150000-byte budget',
      'locales/de.js is 70000 bytes, over its 64000-byte budget',
    ]);
  });

  it('ignores scripts without a budget', () => {
    expect(checkBundleBudgets([{ path: 'shaka-player.dash.js', bytes: 9_000_000 }])).toEqual([]);
  });
});
