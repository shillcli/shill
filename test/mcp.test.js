import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startServer, githubHandler, commit, SAMPLE, makeGitRepo } from '../fixtures/mocks.js';

const BIN = fileURLToPath(new URL('../bin/shill.js', import.meta.url));

function startMcp(env) {
  const child = spawn(process.execPath, [BIN, 'mcp'], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const n = ++id;
    waiting.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  const stop = () => new Promise((resolve) => { child.on('close', resolve); child.stdin.end(); });
  return { call, notify, stop, child };
}

test('MCP server: handshake, tools/list, tools/call against mocks, errors', async (t) => {
  const tags = ['v1.0.0', 'v0.9.0'];
  const gh = await startServer(githubHandler(SAMPLE.map((m) => commit(m)), { tags }));
  const mcp = startMcp({ SHILL_GITHUB_API: gh.base });
  t.after(async () => { await mcp.stop(); await gh.close(); });

  const init = await mcp.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, 'shill');
  const unknownVersion = await mcp.call('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(unknownVersion.result.protocolVersion, '2025-06-18');
  mcp.notify('notifications/initialized');
  assert.deepEqual((await mcp.call('ping')).result, {});

  const list = await mcp.call('tools/list', {});
  assert.deepEqual(list.result.tools.map((x) => x.name), ['release_notes', 'next_version', 'draft_posts', 'changelog_entry']);
  for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, 'object');

  const next = await mcp.call('tools/call', { name: 'next_version', arguments: { repo: 'acme/rocket' } });
  const v = JSON.parse(next.result.content[0].text);
  assert.equal(v.current, 'v1.0.0');
  assert.equal(v.next, 'v2.0.0');

  const drafts = await mcp.call('tools/call', { name: 'draft_posts', arguments: { repo: 'acme/rocket', channels: ['thread', 'telegram'] } });
  const d = JSON.parse(drafts.result.content[0].text);
  assert.deepEqual(Object.keys(d.posts), ['thread', 'telegram']);
  assert.equal(d.counts.thread.length, d.posts.thread.length);

  const notes = await mcp.call('tools/call', { name: 'release_notes', arguments: { repo: 'acme/rocket', since: 'v1.0.0' } });
  assert.match(notes.result.content[0].text, /^## acme\/rocket: since v1\.0\.0/);

  const missing = await mcp.call('tools/call', { name: 'release_notes', arguments: { repo: 'acme/missing' } });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /GitHub API 404/);

  assert.equal((await mcp.call('tools/call', { name: 'release_notes', arguments: {} })).error.code, -32602);
  assert.equal((await mcp.call('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.equal((await mcp.call('resources/list', {})).error.code, -32601);
});

test('MCP changelog_entry writes into a local repo', async (t) => {
  const repo = makeGitRepo();
  const mcp = startMcp({});
  t.after(() => mcp.stop());
  await mcp.call('initialize', {});
  const r = await mcp.call('tools/call', { name: 'changelog_entry', arguments: { local_path: repo, write: true, date: '2026-10-14' } });
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.version, 'v2.0.0');
  assert.equal(out.written.changed, true);
  assert.match(out.section, /^## \[2\.0\.0\] - 2026-10-14/);
});
