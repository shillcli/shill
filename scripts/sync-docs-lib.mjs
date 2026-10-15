// Copy the browser-safe modules from src/ into docs/lib/ so the static site can import them.
// Run after editing any of them: node scripts/sync-docs-lib.mjs
// test/site.test.js fails when a copy drifts from its source.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LIB_FILES = ['errors.js', 'github.js', 'parse.js', 'render.js', 'semver.js', 'highlights.js', 'channels.js', 'changelog-core.js', 'web.js'];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../', import.meta.url);
  mkdirSync(new URL('docs/lib/', root), { recursive: true });
  for (const f of LIB_FILES) copyFileSync(new URL(`src/${f}`, root), new URL(`docs/lib/${f}`, root));
  console.log(`synced ${LIB_FILES.length} files into docs/lib/`);
}
