import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch, loadState } from '../src/watch.js';
import { startServer, githubHandler, discordHandler, commit, SAMPLE } from '../fixtures/mocks.js';

async function setup(t, { discordStatus = 200 } = {}) {
  let tags = ['v1.0.0'];
  let releases = [{ id: 1, tag_name: 'v1.0.0', draft: false }];
  const gh = await startServer(githubHandler(SAMPLE.map((m) => commit(m)), { tags: () => tags, releases: () => releases }));
  const dc = await startServer(discordHandler(discordStatus));
  t.after(() => Promise.all([gh.close(), dc.close()]));
  const dir = await mkdtemp(join(tmpdir(), 'shill-watch-'));
  const logs = [];
  const opts = {
    repo: 'acme/rocket', once: true, stateFile: join(dir, 'state.json'), draftsDir: join(dir, 'drafts'), channels: ['x', 'discord'], post: ['discord'],
    creds: { discordWebhook: `${dc.base}/api/webhooks/9/tok` }, env: { SHILL_GITHUB_API: gh.base }, log: (m) => logs.push(m),
  };
  return { gh, dc, opts, logs, dir, set: (t2, r2) => { tags = t2; releases = r2; } };
}

test('first poll is a baseline, a new release posts exactly once', async (t) => {
  const { dc, opts, logs, set, dir } = await setup(t);
  assert.deepEqual(await watch(opts), []);
  assert.match(logs[0], /baseline: 1 existing/);
  assert.equal(dc.requests.length, 0);

  set(['v1.0.0', 'v1.1.0'], [{ id: 2, tag_name: 'v1.1.0', draft: false }, { id: 1, tag_name: 'v1.0.0', draft: false }, { id: 3, tag_name: 'v9.0.0', draft: true }]);
  const events = await watch(opts);
  assert.equal(events.length, 1);
  assert.equal(events[0].tag, 'v1.1.0');
  assert.equal(events[0].since, 'v1.0.0');
  assert.deepEqual(events[0].posted, ['discord']);
  assert.equal(dc.requests.length, 1);
  assert.match(dc.requests[0].body.content, /^## rocket v1\.1\.0/);
  assert.ok((await readdir(join(dir, 'drafts', 'v1.1.0'))).includes('discord.md'));

  assert.deepEqual(await watch(opts), []);
  assert.equal(dc.requests.length, 1, 'no double post');
  const state = await loadState(opts.stateFile);
  assert.deepEqual(state.repos['acme/rocket'].tags['v1.1.0'].posted, ['discord']);
  assert.equal(state.repos['acme/rocket'].tags['v1.1.0'].done, true);
  assert.equal(state.repos['acme/rocket'].tags['v9.0.0'], undefined, 'drafts are ignored');
});

test('bare tags count as releases; failed posts retry, then give up', async (t) => {
  const { dc, opts, set } = await setup(t, { discordStatus: 500 });
  await watch(opts);
  set(['v1.0.0', 'v1.0.1'], [{ id: 1, tag_name: 'v1.0.0', draft: false }]);
  for (let i = 0; i < 4; i++) await watch(opts);
  assert.equal(dc.requests.length, 3, 'three attempts, then stop');
  const state = JSON.parse(await readFile(opts.stateFile, 'utf8'));
  const rec = state.repos['acme/rocket'].tags['v1.0.1'];
  assert.equal(rec.done, true);
  assert.deepEqual(rec.posted, []);
  assert.match(rec.lastError, /discord: Discord webhook returned 500/);
});

test('watch validates its options', async () => {
  await assert.rejects(watch({ repo: 'nope' }), /owner\/repo/);
  await assert.rejects(watch({ repo: 'a/b', interval: 2 }), /at least 10 seconds/);
  await assert.rejects(watch({ repo: 'a/b', post: ['discord'] }), /needs --discord-webhook/);
});
