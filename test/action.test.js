import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAction, mergeBody, input, MARK_START, MARK_END } from '../src/action.js';
import { startServer, githubHandler, discordHandler, commit, SAMPLE } from '../fixtures/mocks.js';

test('mergeBody keeps hand-written text and replaces only the shill block', () => {
  const first = mergeBody('Thanks for testing the RC.', '## notes v1');
  assert.equal(first, `Thanks for testing the RC.\n\n${MARK_START}\n## notes v1\n${MARK_END}\n`);
  const again = mergeBody(first, '## notes v2');
  assert.equal(again, `Thanks for testing the RC.\n\n${MARK_START}\n## notes v2\n${MARK_END}\n`);
  assert.equal(mergeBody('', 'x'), `${MARK_START}\nx\n${MARK_END}\n`);
  assert.equal(input({ 'INPUT_DRAFTS_DIR': ' out ' }, 'drafts_dir'), 'out');
});

test('action: notes into the release body, drafts, summary, outputs, opt-in post', async (t) => {
  const patched = [];
  const releases = [{ id: 7, tag_name: 'v1.1.0', draft: false, body: 'Hand-written intro.' }];
  const gh = await startServer(githubHandler(SAMPLE.map((m) => commit(m)), { tags: ['v1.1.0', 'v1.0.0'], releases, patched }));
  const dc = await startServer(discordHandler());
  t.after(() => Promise.all([gh.close(), dc.close()]));
  const dir = await mkdtemp(join(tmpdir(), 'shill-action-'));
  const eventPath = join(dir, 'event.json');
  await writeFile(eventPath, JSON.stringify({ action: 'published', release: releases[0] }));
  const env = {
    GITHUB_REPOSITORY: 'acme/rocket', GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), GITHUB_OUTPUT: join(dir, 'out.txt'),
    SHILL_GITHUB_API: gh.base, INPUT_GITHUB_TOKEN: 'ghs_test', INPUT_CHANNELS: 'x,thread,discord', INPUT_DRAFTS_DIR: join(dir, 'drafts'),
    INPUT_POST: 'discord', INPUT_DISCORD_WEBHOOK: `${dc.base}/api/webhooks/1/abc`, INPUT_UPDATE_RELEASE: 'true',
  };
  const { result, updated, published } = await runAction(env);
  assert.equal(result.range, 'since v1.0.0 up to v1.1.0');
  assert.equal(result.tag, 'v1.1.0');
  assert.equal(updated, true);
  assert.equal(patched.length, 1);
  assert.equal(patched[0].id, 7);
  assert.match(patched[0].body, /^Hand-written intro\.\n\n<!-- shill:start -->\n## acme\/rocket: since v1\.0\.0 up to v1\.1\.0/);
  assert.deepEqual(published, [{ channel: 'discord', id: 'msg1' }]);
  assert.deepEqual((await readdir(join(dir, 'drafts'))).sort(), ['discord.md', 'notes.md', 'x-thread.txt', 'x.txt']);
  const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(summary, /## shill: acme\/rocket v1\.1\.0/);
  assert.match(summary, /### thread/);
  const outputs = await readFile(env.GITHUB_OUTPUT, 'utf8');
  assert.match(outputs, /^notes<<ghadelim_[0-9a-f-]+\n## acme\/rocket/);
  assert.match(outputs, /next_version<<ghadelim_[0-9a-f-]+\nv2\.0\.0\n/);
  const sent = gh.requests.find((r) => r.method === 'PATCH');
  assert.equal(sent.headers.authorization, 'Bearer ghs_test');
});

test('action fails clearly outside GitHub Actions', async () => {
  await assert.rejects(runAction({}), /GITHUB_REPOSITORY is not set/);
});
