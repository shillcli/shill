import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/parse.js';
import { renderMarkdown, templateTweet, truncateTweet, tweetLength, tweetProblems, cleanTweet } from '../src/render.js';
import { commit, SAMPLE } from '../fixtures/mocks.js';

const analysis = () => ({ repo: 'acme/rocket', label: 'since v1.0.0', ...analyze(SAMPLE.map((m) => commit(m)), { repo: 'acme/rocket' }) });

test('markdown has ordered sections, links and authors', () => {
  const md = renderMarkdown(analysis());
  assert.match(md, /^## acme\/rocket: since v1\.0\.0/);
  const order = ['### Breaking Changes', '### Features', '### Bug Fixes', '### Performance', '### Refactoring', '### Documentation', '### Other Changes'];
  const idx = order.map((h) => md.indexOf(h));
  assert.ok(idx.every((i) => i >= 0), md);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx);
  assert.match(md, /- \*\*cli:\*\* add --dry-run flag to preview uploads \(\[[0-9a-f]{7}\]\(https:\/\/github\.com\/acme\/rocket\/commit\/[0-9a-f]+\) #42\) by @alice/);
  assert.match(md, /  - use rocket\.config\.json instead/);
  assert.doesNotMatch(md, /typo|bump undici|Merge pull/);
});

test('markdown for an empty range says so', () => {
  const md = renderMarkdown({ repo: 'a/b', label: 'last 7d', ...analyze([]) });
  assert.match(md, /No notable changes/);
});

test('template tweet fits, mentions counts, has no hashtags or emojis', () => {
  const t = templateTweet(analysis());
  assert.ok(tweetLength(t) <= 280);
  assert.deepEqual(tweetProblems(t), []);
  assert.match(t, /New in rocket: 1 breaking change, 1 new feature, 1 fix, 1 performance improvement\./);
  assert.match(t, /https:\/\/github\.com\/acme\/rocket\/releases$/);
});

test('template tweet stays under the limit with very long subjects', () => {
  const long = Array.from({ length: 30 }, (_, i) => commit(`feat: ${'very long feature description '.repeat(6)}${i}`));
  const t = templateTweet({ repo: 'acme/rocket', ...analyze(long) });
  assert.ok(tweetLength(t) <= 280, `length ${tweetLength(t)}`);
});

test('tweet guard detects problems and truncates on a word boundary', () => {
  assert.deepEqual(tweetProblems('hello world'), []);
  assert.ok(tweetProblems('ship it #release').includes('contains hashtags'));
  assert.ok(tweetProblems('ship it \u{1F680}').includes('contains emojis'));
  assert.ok(tweetProblems('x'.repeat(281))[0].startsWith('too long'));
  const long = 'word '.repeat(100).trim();
  const cut = truncateTweet(long);
  assert.ok(tweetLength(cut) <= 280);
  assert.match(cut, /word\.\.\.$/);
  assert.equal(truncateTweet('short'), 'short');
});

test('cleanTweet strips hashtags, emojis and long dashes', () => {
  assert.equal(cleanTweet('"v2 is out \u{1F680} \u2014 faster builds #dev #oss"'), 'v2 is out, faster builds');
});
