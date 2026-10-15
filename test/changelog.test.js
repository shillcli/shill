import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changelogSection, insertSection, writeChangelog, compareLink, HEADER } from '../src/changelog.js';
import { analyze } from '../src/parse.js';
import { commit, SAMPLE } from '../fixtures/mocks.js';

const { entries } = analyze(SAMPLE.map((m) => commit(m)), { repo: 'acme/rocket' });

test('section follows Keep a Changelog with Added, Changed, Fixed', () => {
  const s = changelogSection({ version: 'v2.0.0', date: '2026-10-14', entries });
  assert.match(s, /^## \[2\.0\.0\] - 2026-10-14\n/);
  assert.ok(s.indexOf('### Added') < s.indexOf('### Changed') && s.indexOf('### Changed') < s.indexOf('### Fixed'));
  assert.match(s, /- \*\*Breaking:\*\* drop support for config\.yml \([0-9a-f]{7}\)\n  use rocket\.config\.json instead/);
  assert.match(s, /- \*\*cli:\*\* add --dry-run flag to preview uploads \(#42\)/);
  assert.doesNotMatch(s, /document the --dry-run flag/);
  assert.match(changelogSection({ version: '1.0.1', date: '2026-01-01', entries: [] }), /Maintenance only/);
});

test('insertSection: new file, below Unreleased, above older releases', () => {
  const sec = changelogSection({ version: '1.1.0', date: '2026-10-14', entries });
  const fresh = insertSection('', sec, '1.1.0');
  assert.ok(fresh.startsWith(HEADER));
  assert.match(fresh, /\n## \[1\.1\.0\] - 2026-10-14\n/);
  const existing = `${HEADER}\n## [Unreleased]\n\n- wip notes\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- first\n\n[1.0.0]: https://github.com/acme/rocket/releases/tag/v1.0.0\n`;
  const out = insertSection(existing, sec, 'v1.1.0', compareLink('acme/rocket', 'v1.1.0', 'v1.0.0'));
  const iu = out.indexOf('## [Unreleased]'); const i1 = out.indexOf('## [1.1.0]'); const i0 = out.indexOf('## [1.0.0]');
  assert.ok(iu < i1 && i1 < i0, out);
  assert.match(out, /\[1\.1\.0\]: https:\/\/github\.com\/acme\/rocket\/compare\/v1\.0\.0\.\.\.v1\.1\.0\n\[1\.0\.0\]:/);
});

test('writeChangelog is idempotent and keeps the original date', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shill-cl-'));
  const file = join(dir, 'CHANGELOG.md');
  await writeFile(file, `${HEADER}\n## [1.0.0] - 2026-01-01\n\n- first\n`);
  const sec = changelogSection({ version: '1.1.0', date: '2026-10-14', entries });
  const first = await writeChangelog(file, sec, '1.1.0');
  assert.equal(first.changed, true);
  const second = await writeChangelog(file, sec, '1.1.0');
  assert.equal(second.changed, false);
  const later = changelogSection({ version: '1.1.0', date: '2026-10-20', entries });
  const third = await writeChangelog(file, later, '1.1.0');
  assert.equal(third.changed, false);
  const text = await readFile(file, 'utf8');
  assert.equal(text.match(/## \[1\.1\.0\]/g).length, 1);
  assert.match(text, /## \[1\.1\.0\] - 2026-10-14/);
});
