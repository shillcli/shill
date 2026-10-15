import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shill, nextVersion } from '../src/index.js';
import { localCommits, slugFromRemote, loginFromEmail } from '../src/git.js';
import { makeGitRepo } from '../fixtures/mocks.js';

const BIN = fileURLToPath(new URL('../bin/shill.js', import.meta.url));
const run = (args, cwd) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], { cwd, env: { PATH: process.env.PATH } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});

const repo = makeGitRepo();

test('remote and email helpers', () => {
  assert.equal(slugFromRemote('git@github.com:acme/rocket.git'), 'acme/rocket');
  assert.equal(slugFromRemote('https://github.com/acme/rocket'), 'acme/rocket');
  assert.equal(slugFromRemote('https://gitlab.com/acme/rocket.git'), null);
  assert.equal(loginFromEmail('12+alice@users.noreply.github.com'), 'alice');
  assert.equal(loginFromEmail('bob@example.com'), null);
});

test('reads commits with git log, including file counts and parents', async () => {
  const { commits, label } = await localCommits(repo, { since: 'v1.0.0', until: 'v1.1.0', slug: 'acme/rocket' });
  assert.equal(label, 'since v1.0.0');
  assert.equal(commits.length, 6);
  const dry = commits.find((c) => c.commit.message.includes('dry-run'));
  assert.equal(dry.files, 4);
  assert.equal(dry.author.login, 'alice');
  assert.match(dry.html_url, /^https:\/\/github\.com\/acme\/rocket\/commit\/[0-9a-f]{40}$/);
  assert.equal(dry.parents.length, 1);
  await assert.rejects(localCommits(repo, { since: 'v9.9.9' }), /"v9\.9\.9" not found/);
});

test('local mode end to end: notes, first-timers, version, highlights', async () => {
  const r = await shill({ local: true, dir: repo, since: 'v1.0.0', until: 'v1.1.0', channels: 'all', env: {} });
  assert.equal(r.source, 'local');
  assert.equal(r.repo, 'acme/rocket');
  assert.equal(r.stats.kept, 4);
  assert.equal(r.version.next, 'v1.1.0');
  assert.deepEqual(r.contributors.filter((c) => c.firstTime).map((c) => c.name).sort(), ['Carol', 'dave']);
  assert.equal(r.highlights[0].subject, 'add --dry-run flag to preview uploads');
  assert.match(r.markdown, /First-time contributors: Carol, @dave\. Welcome\./);
  assert.equal(r.posts.thread.length, 6);
});

test('next defaults to the latest tag', async () => {
  const n = await nextVersion({ local: true, dir: repo, env: {} });
  assert.equal(n.current, 'v1.1.0');
  assert.equal(n.next, 'v2.0.0');
  assert.equal(n.bump, 'major');
});

test('CLI --local, next and changelog --write (idempotent)', async () => {
  const gen = await run(['--local', '--since', 'v1.0.0', '--until', 'v1.1.0', '--channels', 'x,thread'], repo);
  assert.equal(gen.code, 0, gen.stderr);
  assert.match(gen.stdout, /^## acme\/rocket: since v1\.0\.0 up to v1\.1\.0/);
  assert.match(gen.stdout, /X thread \(6 posts\):/);
  assert.match(gen.stdout, /Suggested version: v1\.1\.0 \(minor\)/);

  const next = await run(['next', '--local'], repo);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, /^v2\.0\.0\n/);
  assert.match(next.stdout, /Why:\n- 1 breaking change: "drop support for config\.yml"/);

  await writeFile(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [1.1.0] - 2026-09-01\n\n- older\n');
  const w1 = await run(['changelog', '--local', '--write'], repo);
  assert.equal(w1.code, 0, w1.stderr);
  assert.match(w1.stderr, /updated CHANGELOG\.md with v2\.0\.0/);
  const w2 = await run(['changelog', '--local', '--write'], repo);
  assert.match(w2.stderr, /already has v2\.0\.0, no change/);
  const text = await readFile(join(repo, 'CHANGELOG.md'), 'utf8');
  assert.ok(text.indexOf('## [2.0.0]') < text.indexOf('## [1.1.0]'));
  assert.match(text, /\[2\.0\.0\]: https:\/\/github\.com\/acme\/rocket\/compare\/v1\.1\.0\.\.\.v2\.0\.0/);
});

test('local mode outside a git repo fails clearly', async () => {
  await assert.rejects(shill({ local: true, dir: '/', env: {} }), /git rev-parse failed/);
});
