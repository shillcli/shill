import test from 'node:test';
import assert from 'node:assert/strict';
import { shill } from '../src/index.js';
import { buildSummary, parseJsonReply } from '../src/llm.js';
import { analyze } from '../src/parse.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, githubHandler, commit, SAMPLE } from '../fixtures/mocks.js';

const NOTES = '### Features\n\n- Dry run mode (abc1234) @alice';
const GOOD_TWEET = 'rocket 1.1 is out: dry runs, safer uploads and faster builds. Upgrade notes in the release.';

async function setup(t, llmHandler) {
  const gh = await startServer(githubHandler(SAMPLE.map((m) => commit(m))));
  const llm = await startServer(llmHandler);
  t.after(() => Promise.all([gh.close(), llm.close()]));
  return { gh, llm, env: { SHILL_GITHUB_API: gh.base, SHILL_LLM_BASE: llm.base } };
}

const openaiReply = (obj) => ({ json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }] } });
const anthropicReply = (text) => ({ json: { content: [{ type: 'text', text }] } });

test('summary sent to the model contains commit messages only', () => {
  const a = { repo: 'acme/rocket', label: 'last 7d', ...analyze(SAMPLE.map((m) => commit(m))) };
  const s = buildSummary(a);
  assert.match(s, /Features:\n- cli: add --dry-run flag to preview uploads \([0-9a-f]{7} #42 @alice\)/);
  assert.match(s, /BREAKING: use rocket\.config\.json instead/);
  assert.doesNotMatch(s, /bump undici|Merge pull/);
});

test('parseJsonReply handles code fences and rejects garbage', () => {
  assert.deepEqual(parseJsonReply('```json\n{"notes":"a","tweet":"b"}\n```'), { notes: 'a', tweet: 'b' });
  assert.throws(() => parseJsonReply('no json here'), /did not contain a JSON object/);
});

test('OpenAI provider: request shape and output', async (t) => {
  const { llm, env } = await setup(t, (req) => req.url === '/v1/chat/completions' ? openaiReply({ notes: NOTES, tweet: GOOD_TWEET }) : null);
  const r = await shill({ repo: 'acme/rocket', since: 'v1.0.0', env: { ...env, OPENAI_API_KEY: 'sk-test' } });
  assert.equal(r.provider, 'openai');
  assert.equal(r.markdown, NOTES + '\n');
  assert.equal(r.tweet, GOOD_TWEET);
  assert.equal(llm.requests.length, 1);
  const req = llm.requests[0];
  assert.equal(req.headers.authorization, 'Bearer sk-test');
  assert.equal(req.body.model, 'gpt-4o-mini');
  assert.equal(req.body.messages[0].role, 'system');
  assert.match(req.body.messages[1].content, /add --dry-run flag/);
});

test('Anthropic provider: headers, model override and tone', async (t) => {
  const { llm, env } = await setup(t, (req) => req.url === '/v1/messages'
    ? anthropicReply(`Here you go:\n${JSON.stringify({ notes: NOTES, tweet: GOOD_TWEET })}`)
    : null);
  const r = await shill({ repo: 'acme/rocket', model: 'claude-test', tone: 'technical', env: { ...env, ANTHROPIC_API_KEY: 'ak-test' } });
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.tweet, GOOD_TWEET);
  const req = llm.requests[0];
  assert.equal(req.headers['x-api-key'], 'ak-test');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.body.model, 'claude-test');
  assert.match(req.body.system, /experienced developers/);
});

test('retries once when the tweet is too long, then uses the retry', async (t) => {
  let calls = 0;
  const { llm, env } = await setup(t, () => {
    calls++;
    return calls === 1 ? openaiReply({ notes: NOTES, tweet: 'a'.repeat(400) }) : openaiReply({ notes: '', tweet: 'Short and valid.' });
  });
  const r = await shill({ repo: 'acme/rocket', env: { ...env, OPENAI_API_KEY: 'k' } });
  assert.equal(r.tweet, 'Short and valid.');
  assert.equal(r.markdown, NOTES + '\n');
  assert.equal(llm.requests.length, 2);
  assert.match(llm.requests[1].body.messages[1].content, /too long/);
});

test('truncates cleanly when the retry is still too long', async (t) => {
  const long = 'This release adds many things '.repeat(20) + '#launch \u{1F680}';
  const { env } = await setup(t, () => openaiReply({ notes: NOTES, tweet: long }));
  const r = await shill({ repo: 'acme/rocket', env: { ...env, OPENAI_API_KEY: 'k' } });
  assert.ok([...r.tweet].length <= 280);
  assert.match(r.tweet, /\w\.\.\.$/);
  assert.doesNotMatch(r.tweet, /#launch|\u{1F680}/u);
});

test('surfaces LLM HTTP errors', async (t) => {
  const { env } = await setup(t, () => ({ status: 401, json: { error: { message: 'bad key' } } }));
  await assert.rejects(shill({ repo: 'acme/rocket', env: { ...env, OPENAI_API_KEY: 'k' } }), /LLM API 401.*bad key/);
});

test('provider none: no LLM calls, deterministic output', async (t) => {
  const { llm, env } = await setup(t, () => openaiReply({}));
  const r = await shill({ repo: 'acme/rocket', since: 'v1.0.0', env });
  assert.equal(r.provider, 'none');
  assert.equal(llm.requests.length, 0);
  assert.match(r.markdown, /### Features/);
  assert.ok([...r.tweet].length <= 280);
  assert.equal(r.stats.kept, 7);
  const forced = await shill({ repo: 'acme/rocket', provider: 'none', env: { ...env, OPENAI_API_KEY: 'k' } });
  assert.equal(forced.provider, 'none');
  assert.equal(llm.requests.length, 0);
});

test('voice file and channels steer the prompt; valid AI drafts are used', async (t) => {
  const thread = ['rocket 2.0 is here.', 'Dry runs land in the CLI.', 'Uploads retry on 503 now.', 'Notes in the release.'];
  const { llm, env } = await setup(t, () => openaiReply({ notes: NOTES, tweet: GOOD_TWEET, thread, discord: '## rocket 2.0\nDry runs \u2014 finally.', telegram: 'rocket 2.0: <dry runs> & retries' }));
  const dir = await mkdtemp(join(tmpdir(), 'shill-voice-'));
  const voiceFile = join(dir, 'voice.md');
  await writeFile(voiceFile, 'shipped the thing. no fluff. go break it.');
  const r = await shill({ repo: 'acme/rocket', since: 'v1.0.0', channels: 'x,thread,discord,telegram,linkedin', voiceFile, env: { ...env, OPENAI_API_KEY: 'k' } });
  const system = llm.requests[0].body.messages[0].content;
  assert.match(system, /<voice>\nshipped the thing\. no fluff\. go break it\.\n<\/voice>/);
  assert.match(system, /"thread": an array of 3 to 6 strings/);
  assert.match(llm.requests[0].body.messages[1].content, /Version: v2\.0\.0/);
  assert.deepEqual(r.posts.thread, thread.map((p, i) => `${i + 1}/4 ${p}`));
  assert.equal(r.posts.discord, '## rocket 2.0\nDry runs, finally.');
  assert.equal(r.posts.telegram, 'rocket 2.0: &lt;dry runs&gt; &amp; retries');
  assert.match(r.posts.linkedin, /^We just shipped rocket v2\.0\.0\./, 'missing AI field falls back to the template');
  assert.equal(r.posts.x, GOOD_TWEET);
});

test('AI drafts that break channel rules fall back to templates with a warning', async (t) => {
  const { env } = await setup(t, () => openaiReply({ notes: NOTES, tweet: GOOD_TWEET, thread: ['only one'], discord: 'x'.repeat(2500) }));
  const r = await shill({ repo: 'acme/rocket', channels: 'thread,discord', env: { ...env, OPENAI_API_KEY: 'k' } });
  assert.equal(r.posts.thread.length >= 3, true);
  assert.match(r.posts.discord, /^## rocket/);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /AI thread draft rejected \(thread needs 3 to 6 posts, got 1\)/);
});

test('missing voice file is a usage error', async () => {
  await assert.rejects(shill({ repo: 'acme/rocket', voiceFile: '/nope/voice.md', env: {} }), (err) => err.exitCode === 2 && /--voice/.test(err.message));
});
