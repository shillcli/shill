/** Channel drafts: X post, X thread, Discord, Telegram and LinkedIn. Deterministic templates plus validators. */
import { ShillError } from './errors.js';
import { SECTIONS } from './parse.js';
import { TWEET_LIMIT, tweetLength, tweetProblems, truncateTweet, cleanTweet } from './render.js';
import { handle } from './highlights.js';

export const CHANNELS = {
  x: { label: 'X post', limit: TWEET_LIMIT },
  thread: { label: 'X thread', limit: TWEET_LIMIT, min: 3, max: 6 },
  discord: { label: 'Discord', limit: 2000 },
  telegram: { label: 'Telegram', limit: 4096 },
  linkedin: { label: 'LinkedIn', limit: 3000 },
};
const ALIASES = { tweet: 'x', twitter: 'x', tg: 'telegram', li: 'linkedin' };

/** Parse "x,thread,discord" into a validated, de-duplicated list. */
export function parseChannels(value) {
  if (!value) return ['x'];
  const list = (Array.isArray(value) ? value : String(value).split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const raw of list) {
    const name = ALIASES[raw] || raw;
    if (raw === 'all') { out.push(...Object.keys(CHANNELS)); continue; }
    if (!CHANNELS[name]) throw new ShillError(`Unknown channel "${raw}" (use ${Object.keys(CHANNELS).join(', ')} or all)`, { exitCode: 2 });
    out.push(name);
  }
  return [...new Set(out)];
}

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LEAD = (e) => (e.breaking ? 'Breaking' : { feat: 'New', fix: 'Fixed', perf: 'Faster' }[e.type] || 'Changed');

function plural(n, word, many = `${word}s`) { return `${n} ${n === 1 ? word : many}`; }

/** "1 breaking change, 2 new features, 3 fixes." */
export function countsLine({ groups, stats }) {
  const c = [];
  if (groups.breaking?.length) c.push(plural(groups.breaking.length, 'breaking change'));
  if (groups.feat?.length) c.push(plural(groups.feat.length, 'new feature'));
  if (groups.fix?.length) c.push(plural(groups.fix.length, 'fix', 'fixes'));
  if (groups.perf?.length) c.push(plural(groups.perf.length, 'performance improvement'));
  return c.length ? `${c.join(', ')}.` : `${plural(stats.kept, 'change')}.`;
}

function title(ctx) {
  return ctx.version ? `${ctx.name} ${ctx.version}` : ctx.name;
}

function thanksLine(ctx, { at = true } = {}) {
  const people = ctx.contributors || [];
  if (!people.length) return '';
  const name = (c) => (at ? handle(c) : c.name);
  const shown = people.slice(0, 5).map(name);
  let line = `Thanks to ${shown.join(', ')}${people.length > 5 ? ` and ${people.length - 5} more` : ''}.`;
  const first = people.filter((c) => c.firstTime).map(name);
  if (first.length) line += ` First contribution from ${first.join(', ')}. Welcome.`;
  return line;
}

function highlightText(e) {
  const pr = e.pr ? ` (#${e.pr})` : '';
  let text = `${LEAD(e)}${e.scope ? ` in ${e.scope}` : ''}: ${e.subject.replace(/\.$/, '')}${pr}.`;
  if (e.breakingNote && e.breakingNote !== e.subject) text += ` Migration: ${e.breakingNote.replace(/\.$/, '')}.`;
  return text;
}

/** Single post for X, always within 280 characters. */
export function xPost(ctx) {
  const head = ctx.version ? `${title(ctx)} is out: ${countsLine(ctx)}` : `New in ${ctx.name}: ${countsLine(ctx)}`;
  let body = head;
  for (const h of ctx.highlights || []) {
    const candidate = `${body}\n- ${h.subject.replace(/\.$/, '')}`;
    if (tweetLength(ctx.link ? `${candidate}\n\n${ctx.link}` : candidate) > TWEET_LIMIT) break;
    body = candidate;
  }
  const full = ctx.link ? `${body}\n\n${ctx.link}` : body;
  return tweetLength(full) <= TWEET_LIMIT ? full : truncateTweet(body);
}

/** Number posts "1/4 ..." and make each fit. */
export function numberThread(posts) {
  const n = posts.length;
  return posts.map((p, i) => {
    const prefix = `${i + 1}/${n} `;
    return prefix + truncateTweet(cleanTweet(p), TWEET_LIMIT - tweetLength(prefix));
  });
}

/** X thread: 3 to 6 numbered posts. */
export function xThread(ctx) {
  const posts = [`${ctx.version ? `${title(ctx)} is out.` : `New in ${ctx.name} (${ctx.label}).`}\n\n${countsLine(ctx)}`];
  const hl = (ctx.highlights || []).slice(0, 3);
  if (hl.length) posts[0] += ' The highlights:';
  for (const h of hl) posts.push(highlightText(h));
  if (!hl.length) posts.push(ctx.stats.kept ? `Mostly maintenance this time: ${plural(ctx.stats.kept, 'change')} under the hood.` : 'No notable changes in this range.');
  const thanks = thanksLine(ctx);
  if (thanks) posts.push(thanks);
  posts.push(ctx.link ? `Full release notes:\n${ctx.link}` : 'Full release notes are in the changelog.');
  return numberThread(posts.slice(0, CHANNELS.thread.max));
}

const migration = (e) => (e.breakingNote && e.breakingNote !== e.subject ? `. Migration: ${e.breakingNote}` : '');

function sectionItems(ctx, fmt) {
  const out = [];
  for (const [key, name] of SECTIONS) {
    if (['chore', 'docs'].includes(key)) continue;
    const list = ctx.groups[key];
    if (list?.length) out.push({ name, items: list.map(fmt) });
  }
  return out;
}

/** Fill `lines` with section blocks until `limit`, then add an overflow note. */
function fitSections(headLines, sections, tailLines, limit, heading) {
  const lines = [...headLines];
  const len = (arr) => [...arr.join('\n')].length;
  let dropped = 0;
  for (const s of sections) {
    const block = ['', heading(s.name)];
    for (const item of s.items) {
      if (len([...lines, ...block, item, '', 'and 999 more in the full notes.', ...tailLines]) > limit) { dropped++; continue; }
      block.push(item);
    }
    if (block.length > 2) lines.push(...block);
  }
  if (dropped) lines.push('', `And ${dropped} more in the full notes.`);
  lines.push(...tailLines);
  return lines.join('\n');
}

/** Discord message in Markdown, at most 2000 characters. */
export function discordPost(ctx) {
  const prLink = (e) => (e.pr && ctx.repo ? ` ([#${e.pr}](<https://github.com/${ctx.repo}/pull/${e.pr}>))` : e.pr ? ` (#${e.pr})` : '');
  const head = [`## ${title(ctx)}`, countsLine(ctx)];
  const hl = ctx.highlights || [];
  if (hl.length) head.push('', '**Highlights**', ...hl.map((e) => `- **${LEAD(e)}:** ${e.subject}`));
  const sections = sectionItems(ctx, (e) => `- ${e.scope ? `**${e.scope}:** ` : ''}${e.subject}${prLink(e)}${migration(e)}`);
  const tail = [];
  const thanks = thanksLine(ctx);
  if (thanks) tail.push('', thanks);
  if (ctx.link) tail.push('', `Release notes: <${ctx.link}>`);
  return fitSections(head, sections, tail, CHANNELS.discord.limit, (n) => `**${n}**`);
}

/** Telegram message for parse_mode HTML. All user text is escaped. */
export function telegramPost(ctx) {
  const prLink = (e) => (e.pr && ctx.repo ? ` (<a href="https://github.com/${ctx.repo}/pull/${e.pr}">#${e.pr}</a>)` : e.pr ? ` (#${e.pr})` : '');
  const head = [`<b>${escapeHtml(title(ctx))}</b>`, escapeHtml(countsLine(ctx))];
  const hl = ctx.highlights || [];
  if (hl.length) head.push('', '<b>Highlights</b>', ...hl.map((e) => `- <b>${LEAD(e)}:</b> ${escapeHtml(e.subject)}`));
  const sections = sectionItems(ctx, (e) => `- ${e.scope ? `<i>${escapeHtml(e.scope)}:</i> ` : ''}${escapeHtml(e.subject)}${prLink(e)}${escapeHtml(migration(e))}`);
  const tail = [];
  const thanks = thanksLine(ctx);
  if (thanks) tail.push('', escapeHtml(thanks));
  if (ctx.link) tail.push('', `<a href="${escapeHtml(ctx.link)}">Release notes</a>`);
  return fitSections(head, sections, tail, CHANNELS.telegram.limit, (n) => `<b>${escapeHtml(n)}</b>`);
}

/** LinkedIn post: plain text, short paragraphs, no Markdown. */
export function linkedinPost(ctx) {
  const parts = [`We just shipped ${title(ctx)}.`, countsLine(ctx)];
  const hl = ctx.highlights || [];
  if (hl.length) parts.push(`What changed:\n${hl.map((e) => `- ${highlightText(e)}`).join('\n')}`);
  const thanks = thanksLine(ctx, { at: false });
  if (thanks) parts.push(thanks);
  if (ctx.link) parts.push(`Release notes: ${ctx.link}`);
  let text = parts.join('\n\n');
  if ([...text].length > CHANNELS.linkedin.limit) text = [...text].slice(0, CHANNELS.linkedin.limit - 3).join('') + '...';
  return text;
}

const RENDERERS = { x: xPost, thread: xThread, discord: discordPost, telegram: telegramPost, linkedin: linkedinPost };

/** Render drafts for every requested channel. */
export function renderPosts(ctx, channels = ['x']) {
  const out = {};
  for (const c of channels) out[c] = RENDERERS[c](ctx);
  return out;
}

/** Problems with a draft for a channel. Empty array means it is usable. */
export function postProblems(channel, value) {
  const spec = CHANNELS[channel];
  if (channel === 'x') return tweetProblems(value);
  if (channel === 'thread') {
    if (!Array.isArray(value)) return ['thread must be a list of posts'];
    const p = [];
    if (value.length < spec.min || value.length > spec.max) p.push(`thread needs ${spec.min} to ${spec.max} posts, got ${value.length}`);
    value.forEach((post, i) => { if (tweetLength(post) > spec.limit) p.push(`post ${i + 1} is too long (${tweetLength(post)} > ${spec.limit})`); });
    return p;
  }
  if (typeof value !== 'string' || !value.trim()) return ['empty'];
  const n = [...value].length;
  return n > spec.limit ? [`too long (${n} > ${spec.limit} characters)`] : [];
}

/** Character counts for display: { channel: { length, limit } } or per-post for threads. */
export function postStats(posts) {
  const out = {};
  for (const [c, v] of Object.entries(posts)) {
    const limit = CHANNELS[c].limit;
    out[c] = Array.isArray(v) ? v.map((p) => ({ length: tweetLength(p), limit })) : { length: tweetLength(v), limit };
  }
  return out;
}
