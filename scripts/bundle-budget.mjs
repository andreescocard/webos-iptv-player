// Size ceilings for the shipped scripts. webOS 4 TVs parse every byte of
// the app bundle before the first frame, so growth must be a choice:
// raise a ceiling in the same change that needs it.
export const BUNDLE_BUDGETS = [
  { pattern: /^app\.js$/, maxBytes: 1_150_000 },
  { pattern: /^app-worker\.js$/, maxBytes: 90_000 },
  { pattern: /^locales\/[^/]+\.js$/, maxBytes: 64_000 },
];

// files: [{ path, bytes }] with paths relative to dist/js.
export function checkBundleBudgets(files, budgets = BUNDLE_BUDGETS) {
  const violations = [];
  for (const { path, bytes } of files) {
    const budget = budgets.find(({ pattern }) => pattern.test(path));
    if (budget && bytes > budget.maxBytes) {
      violations.push(`${path} is ${bytes} bytes, over its ${budget.maxBytes}-byte budget`);
    }
  }
  return violations;
}
