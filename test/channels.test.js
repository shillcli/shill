import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/parse.js';
import { pickHighlights, leaderboard } from '../src/highlights.js';
import { renderPosts, parseChannels, postProblems, escapeHtml, CHANNELS } from '../src/channels.js';
import { tweetLength } from '../src/render.js';
import { commit, SAMPLE } from '../fixtures/mocks.js';

function ctx(messages = SAMPLE, extra = {}) {
  const a = analyze(messages.map((m, i) => commit(m, { login: ['alice', 'bob', 'carol'][i % 3] })), { repo: 'acme/rocket' });
  return {
    repo: 'acme/rocket', name: 'rocket', version: 'v2.0.0', label: 'since v1.0.0', groups: a.groups, stats: a.stats,
    highlights: pickHighlights(a.entries), contributors: leaderboard(a.entries, new Set(['carol'])), link: 'https://github.com/acme/rocket/releases/tag/v2.0.0', ...extra,
  };
}

test('parseChannels accepts lists, aliases and all; rejects unknown', () => {
  assert.deepEqual(parseChannels('x,thread, Discord,tg'), ['x', 'thread', 'discord', 'telegram']);
  assert.deepEqual(parseChannels('all'), Object.keys(CHANNELS));
  assert.deepEqual(parseChannels(undefined), ['x']);
  assert.throws(() => parseChannels('x,myspace'), /Unknown channel "myspace"/);
});

test('every template is within its channel limit and passes validation', () => {
  const posts = renderPosts(ctx(), Object.keys(CHANNELS));
  for (const [c, v] of Object.entries(posts)) assert.deepEqual(postProblems(c, v), [], `${c}: ${v}`);
  assert.match(posts.x, /^rocket v2\.0\.0 is out: 1 breaking change, 1 new feature, 1 fix, 1 performance improvement\./);
  assert.match(posts.x, /releases\/tag\/v2\.0\.0$/);
  assert.match(posts.discord, /^## rocket v2\.0\.0/);
  assert.match(posts.discord, /\[#42\]\(<https:\/\/github\.com\/acme\/rocket\/pull\/42>\)/);
  assert.match(posts.linkedin, /^We just shipped rocket v2\.0\.0\./);
  assert.doesNotMatch(posts.linkedin, /\*\*|##/);
  assert.match(posts.thread.at(-2), /First contribution from @carol\. Welcome\./);
});

test('thread: 3 to 6 numbered posts, each at most 280 characters', () => {
  const long = Array.from({ length: 12 }, (_, i) => `feat(core): ${'a very long description of an important change '.repeat(8)}${i} (#${100 + i})`);
  for (const messages of [SAMPLE, long, ['chore: tidy up']]) {
    const t = renderPosts(ctx(messages), ['thread']).thread;
    assert.ok(t.length >= 3 && t.length <= 6, `got ${t.length}`);
    t.forEach((p, i) => {
      assert.ok(p.startsWith(`${i + 1}/${t.length} `), p);
      assert.ok(tweetLength(p) <= 280, `post ${i + 1} is ${tweetLength(p)}`);
    });
  }
});

test('discord and telegram trim long releases and say how many were left out', () => {
  const many = Array.from({ length: 200 }, (_, i) => `fix: handle edge case number ${i} in the upload queue when retries overlap`);
  const posts = renderPosts(ctx(many), ['discord', 'telegram']);
  assert.ok([...posts.discord].length <= 2000);
  assert.match(posts.discord, /And \d+ more in the full notes\./);
  assert.ok([...posts.telegram].length <= 4096);
  assert.match(posts.telegram, /And \d+ more in the full notes\./);
});

test('telegram escapes HTML in commit subjects', () => {
  const t = renderPosts(ctx(['feat: support <script> & "quotes" in titles']), ['telegram']).telegram;
  assert.match(t, /support &lt;script&gt; &amp; &quot;quotes&quot; in titles/);
  assert.doesNotMatch(t, /<script>/);
  const tags = t.match(/<\/?[a-z]+[^>]*>/g);
  assert.ok(tags.every((tag) => /^<\/?(b|i|a)( href="[^"]+")?>$/.test(tag)), tags.join(' '));
  assert.equal(escapeHtml('a<b>&'), 'a&lt;b&gt;&amp;');
});

test('postProblems catches bad drafts', () => {
  assert.deepEqual(postProblems('thread', ['one', 'two']), ['thread needs 3 to 6 posts, got 2']);
  assert.match(postProblems('discord', 'x'.repeat(2001))[0], /too long/);
  assert.deepEqual(postProblems('linkedin', ''), ['empty']);
  assert.ok(postProblems('x', 'ship it #launch').includes('contains hashtags'));
});
