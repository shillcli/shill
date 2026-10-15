import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';
import { startServer, githubHandler, commit, SAMPLE } from '../fixtures/mocks.js';

const BIN = fileURLToPath(new URL('../bin/shill.js', import.meta.url));

function run(args, env = {}) {
  const clean = { PATH: process.env.PATH, ...env };
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: clean }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

test('parseArgs handles flags, = syntax and errors', () => {
  assert.deepEqual(parseArgs(['a/b', '--since=7d', '--json']), { format: 'json', since: '7d', repo: 'a/b' });
  assert.throws(() => parseArgs(['a/b', '--format', 'xml']), /Unknown format/);
  assert.throws(() => parseArgs(['a/b', '--since']), /Missing value/);
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
});

test('--help and --version exit 0', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage/);
  const v = await run(['--version']);
  assert.equal(v.stdout.trim(), '1.1.0');
});

test('bad input exits 2 with a clear message', async () => {
  const none = await run([]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /missing <owner\/repo>/);
  const bad = await run(['not-a-repo']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /owner\/repo/);
});

test('end to end against mock GitHub: json and file output', async (t) => {
  const gh = await startServer(githubHandler(SAMPLE.map((m) => commit(m))));
  t.after(gh.close);
  const env = { SHILL_GITHUB_API: gh.base };
  const r = await run(['acme/rocket', '--since', 'v1.0.0', '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.provider, 'none');
  assert.equal(out.stats.seen, 12);
  assert.equal(out.stats.kept, 7);
  assert.match(out.markdown, /### Breaking Changes/);

  const dir = await mkdtemp(join(tmpdir(), 'shill-'));
  const file = join(dir, 'notes.md');
  const w = await run(['acme/rocket', '--format', 'markdown', '--out', file], env);
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stderr, /wrote .*notes\.md/);
  assert.match(await readFile(file, 'utf8'), /^## acme\/rocket: all history/);

  const missing = await run(['acme/missing'], env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /error: GitHub API 404/);
});

test('choosing a provider without its API key fails before any network call', async () => {
  const r = await run(['acme/rocket', '--provider', 'openai'], { SHILL_GITHUB_API: 'http://127.0.0.1:9' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs OPENAI_API_KEY/);
});

test('parseArgs reads subcommands and the new flags', () => {
  const o = parseArgs(['watch', 'acme/rocket', '--interval', '60', '--once', '--post', 'Discord,telegram', '--channels=x,thread']);
  assert.equal(o.command, 'watch');
  assert.equal(o.repo, 'acme/rocket');
  assert.equal(o.interval, '60');
  assert.equal(o.once, true);
  assert.deepEqual(o.post, ['discord', 'telegram']);
  assert.equal(o.channels, 'x,thread');
  const l = parseArgs(['next', '--local', '--dir', '/tmp/x']);
  assert.deepEqual([l.command, l.local, l.dir, l.repo], ['next', true, '/tmp/x', undefined]);
});

test('channel output shows character counts per draft', async (t) => {
  const gh = await startServer(githubHandler(SAMPLE.map((m) => commit(m))));
  t.after(gh.close);
  const r = await run(['acme/rocket', '--since', 'v1.0.0', '--channels', 'x,discord'], { SHILL_GITHUB_API: gh.base });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /X post \(\d+\/280\):/);
  assert.match(r.stdout, /Discord \(\d+\/2000\):\n\n## rocket v2\.0\.0/);
  assert.match(r.stdout, /Suggested version: v2\.0\.0 \(major\)/);
});
