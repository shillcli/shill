import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, noiseReason, dedupeKey, analyze } from '../src/parse.js';
import { commit, SAMPLE } from '../fixtures/mocks.js';

test('parses type, scope and subject', () => {
  const p = parseMessage('feat(cli): add --dry-run flag');
  assert.equal(p.type, 'feat');
  assert.equal(p.scope, 'cli');
  assert.equal(p.subject, 'add --dry-run flag');
  assert.equal(p.breaking, false);
  assert.equal(p.conventional, true);
});

test('detects breaking changes from "!" and from the footer', () => {
  assert.equal(parseMessage('refactor(api)!: rename client').breaking, true);
  const p = parseMessage('feat: new config\n\nSome body.\n\nBREAKING CHANGE: config.yml is gone');
  assert.equal(p.breaking, true);
  assert.equal(p.breakingNote, 'config.yml is gone');
  assert.equal(parseMessage('fix: x\n\nBREAKING-CHANGE: y').breaking, true);
});

test('maps aliases and unknown types', () => {
  assert.equal(parseMessage('ci: run on node 22').type, 'chore');
  assert.equal(parseMessage('build: switch bundler').type, 'chore');
  assert.equal(parseMessage('feature: thing').type, 'feat');
  assert.equal(parseMessage('wat: thing').type, 'other');
  const plain = parseMessage('Add a progress bar');
  assert.equal(plain.type, 'other');
  assert.equal(plain.conventional, false);
  assert.equal(plain.subject, 'Add a progress bar');
});

test('flags noise: merges, bumps, typos, wip', () => {
  assert.equal(noiseReason('Merge pull request #1 from a/b'), 'merge');
  assert.equal(noiseReason('Merge branch main into dev'), 'merge');
  assert.equal(noiseReason('feat: real change', undefined, 2), 'merge');
  assert.equal(noiseReason('chore(deps): bump undici from 6.1.0 to 6.2.1'), 'bump');
  assert.equal(noiseReason('Bump lodash from 4.17.20 to 4.17.21'), 'bump');
  assert.equal(noiseReason('v1.2.3'), 'bump');
  assert.equal(noiseReason('chore: release 1.2.3'), 'bump');
  assert.equal(noiseReason('docs: fix typo in README'), 'typo');
  assert.equal(noiseReason('fixup! feat: x'), 'wip');
  assert.equal(noiseReason('feat: add retries'), null);
});

test('dedupe key ignores case, punctuation and PR suffix', () => {
  assert.equal(dedupeKey('Fix: Retry uploads! (#12)'), dedupeKey('fix retry uploads'));
});

test('analyze groups, filters, dedupes and links', () => {
  const raw = SAMPLE.map((m) => commit(m));
  const { entries, groups, stats } = analyze(raw, { repo: 'acme/rocket' });
  assert.equal(stats.seen, 12);
  assert.equal(stats.kept, 7);
  assert.deepEqual(stats.dropped, { merge: 1, bump: 2, typo: 1, wip: 0, empty: 0, duplicate: 1 });
  assert.equal(groups.feat.length, 1);
  assert.equal(groups.breaking.length, 1);
  assert.equal(groups.fix.length, 1);
  assert.equal(groups.other.length, 1);
  assert.equal(stats.byType.breaking, 1);
  const flag = entries.find((e) => e.scope === 'cli');
  assert.equal(flag.pr, '42');
  assert.equal(flag.subject, 'add --dry-run flag to preview uploads');
  assert.equal(flag.shortSha.length, 7);
  assert.equal(flag.author, 'alice');
  assert.match(flag.url, /^https:\/\/github.com\/acme\/rocket\/commit\//);
});

test('analyze skips the tag commit itself', () => {
  const tagged = commit('feat: released thing', { sha: 'b'.repeat(40) });
  const { stats } = analyze([tagged, commit('fix: after tag')], { excludeSha: 'b'.repeat(40) });
  assert.equal(stats.seen, 1);
});
