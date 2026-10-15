import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, latestTag, previousTag, suggestNext } from '../src/semver.js';
import { pickHighlights, leaderboard, scoreEntry } from '../src/highlights.js';
import { analyze } from '../src/parse.js';
import { commit, SAMPLE } from '../fixtures/mocks.js';

const e = (type, extra = {}) => ({ type, subject: `${type} thing`, breaking: false, ...extra });

test('parseVersion, latestTag and previousTag', () => {
  assert.deepEqual(parseVersion('v1.2.3-rc.1'), { prefix: 'v', major: 1, minor: 2, patch: 3, pre: 'rc.1', raw: 'v1.2.3-rc.1' });
  assert.equal(parseVersion('release-7'), null);
  assert.equal(latestTag(['v1.2.0', 'v1.10.0', 'v1.9.9', 'v2.0.0-beta.1', 'nightly']), 'v1.10.0');
  assert.equal(latestTag(['v0.1.0-alpha', 'v0.1.0-beta']), 'v0.1.0-beta');
  assert.equal(latestTag(['nightly']), null);
  assert.equal(previousTag(['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.1.5-rc.1'], 'v1.2.0'), 'v1.1.0');
  assert.equal(previousTag(['v1.0.0'], 'v1.0.0'), null);
});

test('suggestNext: breaking -> major, feat -> minor, else patch', () => {
  const major = suggestNext('v1.4.2', [e('fix'), e('feat', { breaking: true, subject: 'drop config.yml' })]);
  assert.equal(major.next, 'v2.0.0');
  assert.equal(major.bump, 'major');
  assert.match(major.reasons[0], /1 breaking change: "drop config.yml"/);
  assert.equal(suggestNext('v1.4.2', [e('feat'), e('fix')]).next, 'v1.5.0');
  assert.equal(suggestNext('1.4.2', [e('fix'), e('docs')]).next, '1.4.3');
  const none = suggestNext('v1.4.2', []);
  assert.equal(none.bump, null);
  assert.equal(none.next, 'v1.4.2');
  const fresh = suggestNext(null, [e('feat')]);
  assert.equal(fresh.next, 'v0.1.0');
  assert.match(fresh.reasons.at(-1), /No semver tag/);
  assert.equal(suggestNext('v2.0.0-rc.2', [e('feat')]).next, 'v2.0.0');
});

test('highlights rank breaking, then features with PRs and files', () => {
  const { entries } = analyze(SAMPLE.map((m) => commit(m)), { repo: 'acme/rocket' });
  const top = pickHighlights(entries, 3).map((h) => h.subject);
  assert.deepEqual(top, ['drop support for config.yml', 'add --dry-run flag to preview uploads', 'cache compiled templates between runs']);
  assert.ok(scoreEntry(e('feat', { files: 12 })) > scoreEntry(e('feat', { files: 1 })));
  assert.ok(scoreEntry(e('fix', { pr: '7' })) > scoreEntry(e('fix')));
  assert.deepEqual(pickHighlights([e('docs'), e('chore')]), []);
});

test('leaderboard counts commits and flags first-timers', () => {
  const rows = leaderboard([
    { type: 'feat', author: 'alice' }, { type: 'fix', author: 'alice' }, { type: 'fix', author: null, authorName: 'Bob' }, { type: 'feat', author: 'dave' },
  ], new Set(['dave']));
  assert.deepEqual(rows.map((r) => [r.name, r.commits, r.firstTime]), [['alice', 2, false], ['Bob', 1, false], ['dave', 1, true]]);
  assert.equal(rows[0].features, 1);
  assert.equal(rows[1].login, null);
});
