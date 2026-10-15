import { ShillError } from './errors.js';
import { SECTIONS } from './parse.js';
import { TWEET_LIMIT, cleanTweet, tweetProblems, truncateTweet } from './render.js';
import { CHANNELS, escapeHtml, numberThread, postProblems } from './channels.js';
import { handle } from './highlights.js';

export const PROVIDERS = {
  openai: { base: 'https://api.openai.com', model: 'gpt-4o-mini', envKey: 'OPENAI_API_KEY' },
  anthropic: { base: 'https://api.anthropic.com', model: 'claude-3-5-haiku-latest', envKey: 'ANTHROPIC_API_KEY' },
};

const TONES = {
  plain: 'Write in a plain, neutral, factual voice.',
  hype: 'Write with energy and enthusiasm, but stay accurate and avoid exaggeration.',
  technical: 'Write for experienced developers: precise, specific, mention APIs and behavior changes.',
};

/** Build the text the model sees. Only commit subjects and metadata, never code. */
export function buildSummary({ repo, label, groups, version, highlights = [], contributors = [] }) {
  const lines = [`Repository: ${repo}`, `Range: ${label}`];
  if (version) lines.push(`Version: ${version}`);
  if (highlights.length) lines.push(`Lead with these highlights: ${highlights.map((h) => h.subject).join('; ')}`);
  if (contributors.length) {
    const first = contributors.filter((c) => c.firstTime).map(handle);
    lines.push(`Contributors: ${contributors.map(handle).join(', ')}${first.length ? ` (first-time: ${first.join(', ')})` : ''}`);
  }
  lines.push('');
  for (const [key, title] of SECTIONS) {
    const list = groups[key];
    if (!list?.length) continue;
    lines.push(`${title}:`);
    for (const e of list) {
      const scope = e.scope ? `${e.scope}: ` : '';
      const note = e.breakingNote ? ` [BREAKING: ${e.breakingNote}]` : '';
      lines.push(`- ${scope}${e.subject}${note} (${e.shortSha}${e.pr ? ` #${e.pr}` : ''}${e.author ? ` @${e.author}` : ''})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const CHANNEL_PROMPTS = {
  thread: `"thread": an array of ${CHANNELS.thread.min} to ${CHANNELS.thread.max} strings forming an X thread, each under ${TWEET_LIMIT - 8} characters, without numbering (it is added for you).`,
  discord: `"discord": a Discord announcement in Markdown under ${CHANNELS.discord.limit} characters.`,
  telegram: `"telegram": a Telegram announcement in plain text (no Markdown, no HTML) under ${CHANNELS.telegram.limit - 200} characters.`,
  linkedin: `"linkedin": a LinkedIn post in plain text with short paragraphs, no Markdown, under ${CHANNELS.linkedin.limit} characters.`,
};

export function systemPrompt(tone = 'plain', { channels = [], voice = '' } = {}) {
  const extra = channels.filter((c) => CHANNEL_PROMPTS[c]);
  const fields = ['"notes"', '"tweet"', ...extra.map((c) => `"${c}"`)];
  const lines = [
    'You are a release notes writer for an open source project.',
    TONES[tone] || TONES.plain,
    `Respond with a single JSON object with these fields: ${fields.join(', ')}.`,
    '"notes": Markdown release notes with ### section headings, grouping related changes, keeping commit short SHAs and @authors as references. Do not invent changes that are not in the input.',
    `"tweet": one launch post under ${TWEET_LIMIT} characters announcing the release. No hashtags. No emojis. No em dashes.`,
    ...extra.map((c) => CHANNEL_PROMPTS[c]),
    'Never use hashtags, emojis, em dashes or en dashes in any field. Credit first-time contributors when listed.',
  ];
  if (voice && voice.trim()) {
    lines.push('Match the voice of these past posts by the same author (tone, sentence length, vocabulary). Do not copy their facts:', '<voice>', voice.trim().slice(0, 4000), '</voice>');
  }
  lines.push('Output only the JSON object, with no code fences.');
  return lines.join('\n');
}

/** Extract the first JSON object from a model reply. */
export function parseJsonReply(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new ShillError('LLM reply did not contain a JSON object');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new ShillError(`LLM reply was not valid JSON: ${err.message}`);
  }
}

async function post(fetchImpl, url, headers, body) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch (err) {
    throw new ShillError(`Could not reach LLM API at ${url}: ${err.message}`, { cause: err });
  }
  const text = await res.text();
  if (!res.ok) throw new ShillError(`LLM API ${res.status} at ${url}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ShillError(`LLM API returned non-JSON response at ${url}`);
  }
}

/** Send one chat turn to the configured provider and return the reply text. */
export async function complete({ provider, apiKey, model, baseUrl, fetch: fetchImpl = globalThis.fetch }, system, user) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new ShillError(`Unknown provider "${provider}"`);
  if (!apiKey) throw new ShillError(`Provider "${provider}" needs ${cfg.envKey} to be set`);
  const base = (baseUrl || cfg.base).replace(/\/+$/, '');
  const useModel = model || cfg.model;
  if (provider === 'openai') {
    const data = await post(fetchImpl, `${base}/v1/chat/completions`, { authorization: `Bearer ${apiKey}` }, {
      model: useModel,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new ShillError('OpenAI response had no message content');
    return content;
  }
  const data = await post(fetchImpl, `${base}/v1/messages`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, {
    model: useModel,
    max_tokens: 2048,
    temperature: 0.3,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const content = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!content) throw new ShillError('Anthropic response had no text content');
  return content;
}

/**
 * Ask the model for notes and a tweet. If the tweet breaks the rules, ask once more
 * for a shorter one, then fall back to truncating it.
 */
export async function generate(opts, analysis) {
  const summary = buildSummary(analysis);
  const system = systemPrompt(opts.tone, { channels: opts.channels || [], voice: opts.voice });
  const reply = parseJsonReply(await complete(opts, system, summary));
  if (typeof reply.notes !== 'string' || typeof reply.tweet !== 'string') {
    throw new ShillError('LLM reply JSON must contain string fields "notes" and "tweet"');
  }
  let tweet = cleanTweet(reply.tweet);
  let retried = false;
  const problems = tweetProblems(reply.tweet);
  if (problems.length) {
    retried = true;
    const retry = `${summary}\nYour previous tweet was rejected: ${problems.join(', ')}.\nPrevious tweet: ${reply.tweet}\nReturn JSON with "notes" set to "" and a new "tweet" well under ${TWEET_LIMIT} characters.`;
    try {
      const second = parseJsonReply(await complete(opts, system, retry));
      if (typeof second.tweet === 'string' && second.tweet.trim()) tweet = cleanTweet(second.tweet);
    } catch {
      // keep the cleaned first attempt and truncate below
    }
  }
  const posts = {};
  const warnings = [];
  const undash = (t) => String(t).replace(/\s*[\u2013\u2014]\s*/g, ', ').trim();
  for (const c of opts.channels || []) {
    if (!CHANNEL_PROMPTS[c] || reply[c] === undefined) continue;
    let value = reply[c];
    if (c === 'thread') value = Array.isArray(value) ? numberThread(value.map(String)) : value;
    else if (typeof value === 'string') value = c === 'telegram' ? escapeHtml(undash(value)) : undash(value);
    const problems = postProblems(c, value);
    if (problems.length) warnings.push(`AI ${c} draft rejected (${problems.join(', ')}), using the template instead`);
    else posts[c] = value;
  }
  return { notes: reply.notes.replace(/\s*[\u2013\u2014]\s*/g, ' - ').trim() + '\n', tweet: truncateTweet(tweet), posts, warnings, retried };
}
