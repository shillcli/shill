import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postDiscord, postTelegram, checkPublish, writeDrafts } from '../src/publish.js';
import { startServer, discordHandler, telegramHandler, githubHandler, commit, SAMPLE } from '../fixtures/mocks.js';

const BIN = fileURLToPath(new URL('../bin/shill.js', import.meta.url));
const run = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});

test('Discord webhook: wait=true, no mentions, returns message id', async (t) => {
  const srv = await startServer(discordHandler());
  t.after(srv.close);
  const r = await postDiscord(`${srv.base}/api/webhooks/1/secret`, 'hello @everyone');
  assert.deepEqual(r, { channel: 'discord', id: 'msg1' });
  assert.match(srv.requests[0].url, /\?wait=true$/);
  assert.deepEqual(srv.requests[0].body, { content: 'hello @everyone', allowed_mentions: { parse: [] } });
  await assert.rejects(postDiscord(`${srv.base}/api/webhooks/1/secret`, 'x'.repeat(2001)), /over 2000/);
});

test('Discord errors do not leak the webhook token', async (t) => {
  const srv = await startServer(discordHandler(404));
  t.after(srv.close);
  await assert.rejects(postDiscord(`${srv.base}/api/webhooks/1/s3cr3t`, 'hi'), (err) => /404: Unknown Webhook/.test(err.message) && !err.message.includes('s3cr3t'));
});

test('Telegram sendMessage with HTML parse mode; token hidden in errors', async (t) => {
  const srv = await startServer(telegramHandler());
  t.after(srv.close);
  const r = await postTelegram({ token: 'TEST:TOKEN', chatId: '@rocket', text: '<b>hi</b>', base: srv.base });
  assert.deepEqual(r, { channel: 'telegram', id: 1 });
  assert.deepEqual(srv.requests[0].body, { chat_id: '@rocket', text: '<b>hi</b>', parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  await assert.rejects(postTelegram({ token: 'BAD:SECRET', chatId: '1', text: 'x', base: srv.base }), (err) => /401: Unauthorized/.test(err.message) && !err.message.includes('BAD:SECRET'));
});

test('checkPublish refuses X and missing credentials', () => {
  assert.throws(() => checkPublish(['x']), /never posts to X/);
  assert.throws(() => checkPublish(['thread']), /never posts to X/);
  assert.throws(() => checkPublish(['discord']), /needs --discord-webhook/);
  assert.throws(() => checkPublish(['telegram'], { telegramToken: 't' }), /needs --telegram-token and --telegram-chat/);
  assert.throws(() => checkPublish(['mastodon']), /Cannot post to "mastodon"/);
});

test('writeDrafts writes notes and one file per channel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shill-drafts-'));
  await writeDrafts(dir, { markdown: '## notes', posts: { x: 'post', thread: ['1/3 a', '2/3 b', '3/3 c'], telegram: '<b>t</b>' } });
  assert.deepEqual((await readdir(dir)).sort(), ['notes.md', 'telegram.html', 'x-thread.txt', 'x.txt']);
  assert.equal(await readFile(join(dir, 'x-thread.txt'), 'utf8'), '1/3 a\n\n---\n\n2/3 b\n\n---\n\n3/3 c\n');
});

test('CLI posts to Discord and Telegram only with explicit flags', async (t) => {
  const gh = await startServer(githubHandler(SAMPLE.map((m) => commit(m))));
  const dc = await startServer(discordHandler());
  const tg = await startServer(telegramHandler());
  t.after(() => Promise.all([gh.close(), dc.close(), tg.close()]));
  const env = { SHILL_GITHUB_API: gh.base, SHILL_TELEGRAM_API: tg.base };
  const dir = await mkdtemp(join(tmpdir(), 'shill-cli-'));

  const dry = await run(['acme/rocket', '--channels', 'discord,telegram', '--json'], env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dc.requests.length + tg.requests.length, 0);

  const r = await run(['acme/rocket', '--since', 'v1.0.0', '--post', 'discord,telegram', '--discord-webhook', `${dc.base}/api/webhooks/1/abc`,
    '--telegram-token', 'TEST:TOKEN', '--telegram-chat', '-100123', '--drafts-dir', dir, '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.published, [{ channel: 'discord', id: 'msg1' }, { channel: 'telegram', id: 1 }]);
  assert.match(dc.requests[0].body.content, /^## rocket v2\.0\.0/);
  assert.match(tg.requests[0].body.text, /^<b>rocket v2\.0\.0<\/b>/);
  assert.ok((await readdir(dir)).includes('discord.md'));

  const x = await run(['acme/rocket', '--post', 'x'], env);
  assert.equal(x.code, 2);
  assert.match(x.stderr, /never posts to X/);
});
