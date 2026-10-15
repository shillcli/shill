/** GitHub Action entry: notes into the release body, drafts to files and the job summary. */
import { readFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ShillError } from './errors.js';
import { shill, githubClient } from './index.js';
import { previousTag } from './semver.js';
import { publish, writeDrafts, checkPublish } from './publish.js';
import { parseChannels } from './channels.js';

export const MARK_START = '<!-- shill:start -->';
export const MARK_END = '<!-- shill:end -->';

/** Read an action input the way the runner exposes it (INPUT_<NAME>). */
export function input(env, name, fallback = '') {
  const v = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined || v === '' ? fallback : v.trim();
}

/** Put generated notes between markers, keeping anything the author wrote by hand. */
export function mergeBody(existing, notes) {
  const block = `${MARK_START}\n${notes.trim()}\n${MARK_END}`;
  const body = existing || '';
  const s = body.indexOf(MARK_START);
  const e = body.indexOf(MARK_END);
  if (s !== -1 && e > s) return body.slice(0, s) + block + body.slice(e + MARK_END.length);
  return body.trim() ? `${body.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

async function setOutput(env, name, value) {
  if (!env.GITHUB_OUTPUT) return;
  const d = `ghadelim_${randomUUID()}`;
  await appendFile(env.GITHUB_OUTPUT, `${name}<<${d}\n${value}\n${d}\n`);
}

function summary(result, published) {
  const lines = [`## shill: ${result.repo} ${result.tag || ''}`.trimEnd(), '', `Range: ${result.range}. Commits kept: ${result.stats.kept} of ${result.stats.seen}.`, ''];
  if (result.version) lines.push(`Suggested version: **${result.version.next}** (${result.version.bump || 'no bump'}). ${result.version.reasons.join(' ')}`, '');
  for (const [c, v] of Object.entries(result.posts)) {
    lines.push(`### ${c}`, '', '```text', Array.isArray(v) ? v.join('\n\n') : v, '```', '');
  }
  if (published.length) lines.push(`Posted to: ${published.map((p) => p.channel).join(', ')}`, '');
  return lines.join('\n');
}

export async function runAction(env = process.env, { fetch } = {}) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new ShillError('GITHUB_REPOSITORY is not set; run this inside GitHub Actions');
  let event = {};
  if (env.GITHUB_EVENT_PATH) {
    try { event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')); } catch { /* no event payload */ }
  }
  const token = input(env, 'github_token', env.GITHUB_TOKEN || '');
  const tag = input(env, 'tag', event.release?.tag_name || '');
  const channels = parseChannels(input(env, 'channels', 'x,thread,discord,telegram,linkedin'));
  const post = input(env, 'post') ? input(env, 'post').split(',').map((s) => s.trim()).filter(Boolean) : [];
  const creds = { discordWebhook: input(env, 'discord_webhook'), telegramToken: input(env, 'telegram_token'), telegramChat: input(env, 'telegram_chat'), telegramApi: env.SHILL_TELEGRAM_API, fetch };
  checkPublish(post, creds);
  const llmEnv = { ...env, GITHUB_TOKEN: token, OPENAI_API_KEY: input(env, 'openai_api_key', env.OPENAI_API_KEY || ''), ANTHROPIC_API_KEY: input(env, 'anthropic_api_key', env.ANTHROPIC_API_KEY || '') };
  const client = githubClient({ githubToken: token, fetch }, llmEnv);

  let since = input(env, 'since');
  if (!since && tag) since = previousTag(await client.listTags(repo), tag) || '';
  const result = await shill({
    repo, since: since || undefined, until: tag || undefined, tag: tag || undefined, channels,
    tone: input(env, 'tone', 'plain'), provider: input(env, 'provider') || undefined, model: input(env, 'model') || undefined,
    voiceFile: input(env, 'voice') || undefined, githubToken: token, env: llmEnv, fetch,
  });

  const draftsDir = input(env, 'drafts_dir', 'shill-drafts');
  const files = await writeDrafts(draftsDir, result);
  let updated = false;
  const releaseId = event.release?.id || (tag ? (await client.getReleaseByTag(repo, tag))?.id : null);
  if (input(env, 'update_release', 'true') === 'true' && releaseId) {
    const current = event.release?.id === releaseId ? event.release.body : (await client.getReleaseByTag(repo, tag))?.body;
    await client.updateRelease(repo, releaseId, mergeBody(current, result.markdown));
    updated = true;
  }
  const published = post.length ? await publish(result, post, creds) : [];
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary(result, published) + '\n');
  await setOutput(env, 'notes', result.markdown);
  await setOutput(env, 'next_version', result.version?.next || '');
  await setOutput(env, 'drafts_dir', draftsDir);
  await setOutput(env, 'tweet', result.tweet);
  return { result, files, updated, published };
}
