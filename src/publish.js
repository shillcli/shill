/** Opt-in publishing to Discord and Telegram, and draft files for everything else. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ShillError } from './errors.js';
import { CHANNELS } from './channels.js';

export const DEFAULT_TELEGRAM_API = 'https://api.telegram.org';
export const PUBLISHABLE = ['discord', 'telegram'];

async function send(fetchImpl, url, body, label, secret) {
  const hide = (s) => (secret ? String(s).split(secret).join('***') : String(s));
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'shill' }, body: JSON.stringify(body) });
  } catch (err) {
    throw new ShillError(`Could not reach ${label}: ${hide(err.message)}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok || (data && data.ok === false)) {
    const detail = data?.description || data?.message || text.slice(0, 200);
    throw new ShillError(`${label} returned ${res.status}: ${hide(detail)}`);
  }
  return data;
}

/** POST a message to a Discord webhook (https://discord.com/developers/docs/resources/webhook#execute-webhook). */
export async function postDiscord(webhookUrl, content, { fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!/^https?:\/\//.test(webhookUrl || '')) throw new ShillError('--discord-webhook must be a webhook URL', { exitCode: 2 });
  if ([...content].length > CHANNELS.discord.limit) throw new ShillError(`Discord message is over ${CHANNELS.discord.limit} characters`);
  const url = new URL(webhookUrl);
  url.searchParams.set('wait', 'true');
  const data = await send(fetchImpl, url.toString(), { content, allowed_mentions: { parse: [] } }, 'Discord webhook', url.pathname.split('/').pop());
  return { channel: 'discord', id: data?.id ?? null };
}

/** Send a message with the Telegram Bot API sendMessage method in HTML parse mode. */
export async function postTelegram({ token, chatId, text, base = DEFAULT_TELEGRAM_API, fetch: fetchImpl = globalThis.fetch }) {
  if (!token || !chatId) throw new ShillError('Telegram needs --telegram-token and --telegram-chat', { exitCode: 2 });
  if ([...text].length > CHANNELS.telegram.limit) throw new ShillError(`Telegram message is over ${CHANNELS.telegram.limit} characters`);
  const url = `${base.replace(/\/+$/, '')}/bot${token}/sendMessage`;
  const data = await send(fetchImpl, url, { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, 'Telegram API', token);
  return { channel: 'telegram', id: data?.result?.message_id ?? null };
}

/** Validate --post targets and their credentials before any network call. */
export function checkPublish(targets = [], creds = {}) {
  for (const t of targets) {
    if (t === 'x' || t === 'thread') throw new ShillError('shill never posts to X. Use --drafts-dir to write the X drafts to files.', { exitCode: 2 });
    if (!PUBLISHABLE.includes(t)) throw new ShillError(`Cannot post to "${t}" (use ${PUBLISHABLE.join(', ')})`, { exitCode: 2 });
    if (t === 'discord' && !creds.discordWebhook) throw new ShillError('--post discord needs --discord-webhook <url>', { exitCode: 2 });
    if (t === 'telegram' && (!creds.telegramToken || !creds.telegramChat)) throw new ShillError('--post telegram needs --telegram-token and --telegram-chat', { exitCode: 2 });
  }
  return targets;
}

/** Publish the drafts in `result.posts` to each target. Returns one entry per target. */
export async function publish(result, targets = [], creds = {}) {
  checkPublish(targets, creds);
  const out = [];
  for (const t of targets) {
    if (!result.posts[t]) throw new ShillError(`No ${t} draft to post. Add ${t} to --channels.`, { exitCode: 2 });
    if (t === 'discord') out.push(await postDiscord(creds.discordWebhook, result.posts.discord, creds));
    if (t === 'telegram') out.push(await postTelegram({ token: creds.telegramToken, chatId: creds.telegramChat, text: result.posts.telegram, base: creds.telegramApi, fetch: creds.fetch }));
  }
  return out;
}

const FILES = { x: 'x.txt', thread: 'x-thread.txt', discord: 'discord.md', telegram: 'telegram.html', linkedin: 'linkedin.txt' };

/** Write notes.md plus one file per channel draft. Returns the written paths. */
export async function writeDrafts(dir, result) {
  await mkdir(dir, { recursive: true });
  const written = [];
  const put = async (name, text) => { const p = join(dir, name); await writeFile(p, text.endsWith('\n') ? text : text + '\n'); written.push(p); };
  await put('notes.md', result.markdown);
  for (const [c, v] of Object.entries(result.posts)) await put(FILES[c], Array.isArray(v) ? v.join('\n\n---\n\n') : v);
  return written;
}
