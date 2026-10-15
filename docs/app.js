// shillcli.com: the tool above the fold. Plain ES module, no build, no dependencies.
// Talks to api.github.com straight from the browser; falls back to /api/github
// (a read-only proxy on this site) only when the visitor's hourly limit runs out.
import { generate, parseRepoInput, clampCount } from './lib/web.js';
import { CHANNELS } from './lib/channels.js';
import { demoFetch } from './demo.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const len = (s) => [...String(s)].length;
const fmt = (n) => Number(n).toLocaleString('en-US');

// Tests point the page at a local mock with ?api=http://127.0.0.1:PORT. Ignored anywhere else.
const params = new URLSearchParams(location.search);
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const TEST_API = LOCAL && /^http:\/\/127\.0\.0\.1:\d+$/.test(params.get('api') || '') ? params.get('api') : null;
const GITHUB = TEST_API || 'https://api.github.com';

const state = { range: 'release', view: 'posts', result: null, example: false, busy: false, seq: 0 };
const els = { form: $('#f'), input: $('#repo'), go: $('#go'), n: $('#n'), out: $('#results') };

/* ---------- small renderers ---------- */

const linkify = (h) => h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/(^|[\s(])@([\w-]+)/g, '$1<a href="https://github.com/$2" target="_blank" rel="noopener">@$2</a>');
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(&lt;(https?:[^)\s]+?)&gt;\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/&lt;(https?:[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}
function markdown(md) {
  const out = []; let list = false;
  for (const line of String(md).split('\n')) {
    const h = /^(#{2,3}) (.*)/.exec(line), li = /^- (.*)/.exec(line), sub = /^ {2}- (.*)/.exec(line);
    if (!li && !sub && list) { out.push('</ul>'); list = false; }
    if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
    else if (li || sub) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li${sub ? ' class="subli"' : ''}>${inline((li || sub)[1])}</li>`); }
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}
// Telegram HTML: escape everything, then allow b, i, code and http(s) links back in.
function tgHtml(s) {
  return esc(s).replace(/&lt;(\/?)(b|i|u|s|code)&gt;/g, '<$1$2>')
    .replace(/&lt;a href=&quot;(https?:[^&"]+)&quot;&gt;/g, '<a href="$1" target="_blank" rel="noopener">').replace(/&lt;\/a&gt;/g, '</a>')
    .replace(/&amp;(lt|gt|amp|quot);/g, '&$1;').replace(/\n/g, '<br>');
}
function ring(n, limit) {
  const r = 8, c = 2 * Math.PI * r, pct = Math.min(1, n / limit);
  return `<span class="ring${pct > .9 ? ' hot' : ''}" title="${n} of ${limit} characters"><svg viewBox="0 0 20 20" aria-hidden="true"><circle class="t" cx="10" cy="10" r="${r}" fill="none" stroke-width="2.5"/><circle class="p" cx="10" cy="10" r="${r}" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${(c * pct).toFixed(2)} ${c.toFixed(2)}"/></svg><span class="num">${n}/${limit}</span></span>`;
}
const copyBtn = (text, label = 'Copy') => `<button type="button" class="ghost" data-copy="${esc(text)}" data-label="${esc(label)}">${esc(label)}</button>`;
const initials = (s) => String(s || '?').replace(/^@/, '').slice(0, 1).toUpperCase();
function avatarUrl(a) {
  try { const u = new URL(a); if (u.protocol !== 'https:') return null; u.searchParams.set('s', '80'); return u.href; } catch { return null; }
}
function avatar(r, cls = '') {
  const letter = initials(r.repo.split('/')[1]);
  const src = r.meta.avatar ? avatarUrl(r.meta.avatar) : null;
  return src ? `<img class="av ${cls}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-letter="${esc(letter)}">` : `<div class="av ${cls}">${esc(letter)}</div>`;
}
// A broken avatar turns back into the letter tile.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains('av')) {
    const d = document.createElement('div');
    d.className = img.className;
    d.textContent = img.dataset.letter || '?';
    img.replaceWith(d);
  }
}, true);
const clock = () => new Date().toTimeString().slice(0, 5);

/* ---------- post previews ---------- */

function pvHead(label, n, limit, extra = '') {
  return `<header><b>${esc(label)}</b>${extra}<span class="sp"></span>${limit ? ring(n, limit) : ''}</header>`;
}
function preview(c, val, r) {
  const spec = CHANNELS[c];
  const name = r.repo.split('/')[1], owner = r.meta.owner;
  if (c === 'x') return `<article class="card pv" data-channel="x">${pvHead(spec.label, len(val), spec.limit)}<div class="body"><div class="tw">${avatar(r)}<div><span class="nm">${esc(name)}</span> <span class="hd">@${esc(owner)} · now</span><div class="txt">${linkify(esc(val))}</div></div></div></div><div class="foot2"><span class="note">X counts each link as 23</span>${copyBtn(val)}</div></article>`;
  if (c === 'thread') return `<article class="card pv" data-channel="thread">${pvHead(spec.label, 0, 0, ` <span class="pill num">${val.length} posts</span>`)}<div class="body">${val.map((p) => `<div class="tw">${avatar(r)}<div><span class="nm">${esc(name)}</span> <span class="hd">@${esc(owner)}</span><div class="txt">${linkify(esc(p))}</div><div class="foot">${ring(len(p), spec.limit)}${copyBtn(p)}</div></div></div>`).join('')}</div><div class="foot2"><span class="note">each post under ${spec.limit}</span>${copyBtn(val.join('\n\n'), 'Copy thread')}</div></article>`;
  if (c === 'discord') return `<article class="card pv" data-channel="discord">${pvHead(spec.label, len(val), spec.limit)}<div class="body"><div class="dc">${avatar(r)}<div class="min"><span class="nm">${esc(name)} releases</span><span class="tag">APP</span> <span class="hd sm">Today at ${clock()}</span><div class="clamp"><div class="rich">${markdown(val)}</div></div><button type="button" class="more" data-more>Show full post</button></div></div></div><div class="foot2"><span class="note">mentions are not pinged</span>${copyBtn(val)}</div></article>`;
  if (c === 'telegram') return `<article class="card pv" data-channel="telegram">${pvHead(spec.label, len(val), spec.limit)}<div class="body"><div class="tgwrap"><div class="bubble"><div class="nm">${esc(name)} updates</div><div class="clamp"><div class="rich">${tgHtml(val)}</div></div><div class="meta num">${clock()}</div></div><button type="button" class="more" data-more>Show full post</button></div></div><div class="foot2"><span class="note">HTML parse mode, escaped</span>${copyBtn(val)}</div></article>`;
  if (c === 'linkedin') return `<article class="card pv li" data-channel="linkedin">${pvHead(spec.label, len(val), spec.limit)}<div class="body"><div class="who">${avatar(r, 'sq')}<div><div class="nm">${esc(name)}</div><div class="sub2">Open source project · now</div></div></div><div class="txt">${linkify(esc(val))}</div></div><div class="foot2"><span class="note">short paragraphs, no hashtags</span>${copyBtn(val)}</div></article>`;
  return '';
}

/* ---------- result views ---------- */

const TABS = [['posts', 'Posts'], ['notes', 'Release notes'], ['changelog', 'CHANGELOG'], ['raw', 'Markdown']];

function headHtml(r) {
  const v = r.version;
  const ann = r.tag || '';
  const meta = [];
  if (r.meta.stars !== null && r.meta.stars !== undefined) meta.push(`<span class="num">${fmt(r.meta.stars)}</span> stars`);
  meta.push(`<a href="${esc(r.meta.url)}" target="_blank" rel="noopener">github.com/${esc(r.repo)}</a>`);
  return `
    ${state.example ? '<div class="card demo-note"><b>example data.</b> acme/rocket is a made-up repo so you can see the output. paste a real one above, or <button type="button" class="linkish" data-example="honojs/hono">try honojs/hono</button>.</div>' : ''}
    ${r.notes.length ? `<div class="card warns">${r.notes.map(esc).join('<br>')}</div>` : ''}
    <div class="rhead">
      <div class="min">
        <p class="eyebrow">${esc(r.label)} · templates${state.example ? ' · example data' : ''}</p>
        <h2 class="rtitle">${esc(r.repo)}${ann ? ` <span class="num">${esc(ann)}</span>` : ''}</h2>
        <p class="rmeta">${r.meta.description ? `${esc(r.meta.description)} · ` : ''}${meta.join(' · ')}</p>
      </div>
      ${r.empty ? '' : `<div class="seg tabs" role="tablist" aria-label="Output">${TABS.map(([k, l]) => `<button type="button" role="tab" data-view="${k}" aria-selected="${state.view === k}" class="${state.view === k ? 'on' : ''}">${l}</button>`).join('')}</div>`}
    </div>`;
}

function mainHtml(r) {
  if (state.view === 'notes') return `<div class="card doc"><div class="bar2"><p class="eyebrow">Release notes</p>${copyBtn(r.markdown, 'Copy Markdown')}</div><div class="rich">${markdown(r.markdown)}</div></div>`;
  if (state.view === 'raw') return `<div class="card doc"><div class="bar2"><p class="eyebrow">Markdown</p>${copyBtn(r.markdown, 'Copy Markdown')}</div><pre class="raw">${esc(r.markdown)}</pre></div>`;
  if (state.view === 'changelog') {
    const full = r.changelog.section.trimEnd() + (r.changelog.link ? `\n\n${r.changelog.link}\n` : '\n');
    return `<div class="card doc"><div class="bar2"><div><p class="eyebrow">CHANGELOG.md entry</p><p class="note" style="margin:4px 0 0">Keep a Changelog format. Paste it under <code>## [Unreleased]</code>, the link line goes at the bottom.</p></div>${copyBtn(full, 'Copy entry')}</div><pre class="raw">${esc(full)}</pre></div>`;
  }
  const order = ['x', 'discord', 'thread', 'telegram', 'linkedin'];
  return `<p class="note tpl">5 drafts from templates, each under its channel's limit. With the CLI and your own AI key, a model writes them in your voice.</p><div class="previews">${order.filter((c) => r.posts[c] !== undefined).map((c) => preview(c, r.posts[c], r)).join('')}</div>`;
}

function railHtml(r) {
  const v = r.version;
  const first = r.contributors.filter((c) => c.firstTime);
  const max = Math.max(1, ...r.highlights.map((h) => h.score));
  const rate = r.rate || {};
  const firstNote = r.firstTimerStatus === 'skipped' ? (r.range === 'release' ? 'not checked, saving API calls' : 'only checked for release ranges') : r.firstTimerStatus === 'partial' ? 'top 4 checked' : 'checked';
  return `
    <div class="card vcard">
      <p class="eyebrow">Next version${v.estimate ? ' <span class="pill est">estimate</span>' : ''}</p>
      <div class="big num">${esc(v.next || 'v0.1.0')}</div>
      <div class="from">${v.bump ? `<span class="pill">${esc(v.bump)}</span>` : ''}<span>from <span class="num">${esc(v.current || '0.0.0')}</span></span></div>
      ${v.reasons.length ? `<p class="why">${v.reasons.map(esc).join('<br>')}</p>` : ''}
      <div class="stats"><div><b class="num">${r.stats.kept}<span class="muted">/${r.stats.seen}</span></b><span>commits kept</span></div><div><b class="num">${r.contributors.length}</b><span>people</span></div><div><b class="num">${r.firstTimerStatus === 'skipped' ? 'n/a' : first.length}</b><span>first-time</span></div></div>
    </div>
    <div class="card list"><p class="eyebrow">Highlights</p>
      ${r.highlights.map((h, i) => `<div class="hl"><span class="rk num">${String(i + 1).padStart(2, '0')}</span><div><div class="s">${esc(h.subject)}</div><div class="m num"><span>${esc(h.breaking ? 'breaking' : h.type)}${h.scope ? `/${esc(h.scope)}` : ''}</span><span class="meter"><i style="width:${Math.round((h.score / max) * 100)}%"></i></span><span>${h.pr ? `#${esc(h.pr)}` : esc(h.shortSha)}</span></div></div></div>`).join('') || '<p class="muted sm">No highlights in this range.</p>'}
    </div>
    <div class="card list"><p class="eyebrow">Contributors <span class="note">first-time: ${firstNote}</span></p>
      ${r.contributors.slice(0, 8).map((c) => `<div class="ppl"><div class="av sm">${initials(c.login || c.name)}</div><span class="n">${esc(c.login ? '@' + c.login : c.name)}</span>${c.firstTime ? '<span class="pill v">first commit</span>' : ''}<span class="c num">${c.commits}</span></div>`).join('') || '<p class="muted sm">No contributors found.</p>'}
      ${r.contributors.length > 8 ? `<p class="note">and ${r.contributors.length - 8} more</p>` : ''}
    </div>
    ${state.example ? '' : `<p class="note rate">${rate.remaining !== undefined ? `GitHub API: <span class="num">${rate.remaining}/${rate.limit || 60}</span> calls left this hour${r.proxied ? ', through shillcli.com' : ' for your connection'}.` : ''} ${r.stats.seen} commits read with <span class="num">${rate.calls || 0}</span> calls.</p>`}`;
}

function renderResult(r) {
  if (r.empty) {
    els.out.innerHTML = `${headHtml(r)}<div class="card state"><div class="ic">0</div><div><h3>Nothing new since ${esc(r.base)}.</h3><p>Every commit on ${esc(r.branch)} is already in ${esc(r.base)}, so there is nothing to shill yet. Want drafts from recent work anyway?</p><button type="button" class="btn sm" data-switch="commits">Use the last ${clampCount(els.n.value)} commits</button></div></div>`;
    return;
  }
  els.out.innerHTML = `${headHtml(r)}<div class="rgrid"><div class="main min">${mainHtml(r)}</div><aside class="rail">${railHtml(r)}</aside></div>`;
}

function renderLoading(repo) {
  const sk = (rows) => `<div class="card pv"><div class="skc"><div class="skrow"><div class="sk" style="width:40px;height:40px;border-radius:50%"></div><div class="sk" style="width:40%;height:14px"></div></div>${rows.map((w) => `<div class="sk" style="width:${w}%;height:12px"></div>`).join('')}</div></div>`;
  els.out.innerHTML = `
    <div class="rhead"><div class="min"><p class="eyebrow" id="stepline">Reading commits</p><h2 class="rtitle">${esc(repo)}</h2><div class="sk" style="width:min(420px,80%);height:14px;margin-top:12px"></div></div></div>
    <div class="rgrid" aria-busy="true"><div class="main min"><p class="note tpl"><span class="sk" style="display:inline-block;width:60%;height:12px"></span></p><div class="previews">${sk([92, 80, 64, 30])}${sk([96, 88, 90, 70, 40])}${sk([85, 60, 75])}${sk([90, 75, 50])}</div></div>
    <aside class="rail"><div class="card vcard"><p class="eyebrow">Next version</p><div class="sk" style="width:60%;height:44px"></div><div class="sk" style="width:40%;height:14px"></div><div class="sk" style="width:100%;height:56px"></div></div><div class="card list"><p class="eyebrow">Highlights</p><div class="sk" style="height:40px"></div><div class="sk" style="height:40px"></div></div></aside></div>`;
}

function renderError(err, repo) {
  let title = 'Could not read that repo';
  let body = esc(err.message);
  let actions = '<button type="button" class="btn sm" data-retry>Try again</button>';
  if (err.kind === 'bad_input') { title = 'That does not look like a GitHub repo'; body = 'Paste it as <code>owner/repo</code>, like <code>honojs/hono</code>, or a full github.com link.'; actions = '<button type="button" class="btn sm" data-example="honojs/hono">Try honojs/hono</button>'; }
  if (err.kind === 'not_found') { title = 'Repo not found'; actions += ' <button type="button" class="btn sm" data-example="honojs/hono">Try honojs/hono</button>'; }
  if (err.kind === 'rate_limited') {
    title = 'Rate limited by GitHub';
    const at = err.reset ? new Date(err.reset * 1000) : null;
    body = `${esc(err.message)}${at && !Number.isNaN(at.getTime()) ? ` It resets at <span class="num">${at.toTimeString().slice(0, 5)}</span>.` : ''} The CLI has no such limit with a token: <code>GITHUB_TOKEN=... npx shill ${esc(repo || 'owner/repo')} --since latest --channels all</code>`;
  }
  if (err.kind === 'network') title = 'GitHub did not answer';
  els.out.innerHTML = `<div class="card state err" role="alert"><div class="ic">!</div><div><h3>${title}</h3><p>${body}</p>${actions}</div></div>`;
}

/* ---------- running ---------- */

function proxyFetch(url, init) {
  const u = new URL(String(url));
  return fetch(`/api/github?path=${encodeURIComponent(u.pathname + u.search)}`, init).then((res) => {
    if (!res.headers.get('x-shill-proxy')) throw Object.assign(new Error('proxy unavailable'), { noProxy: true });
    return res;
  });
}

async function run(repoText, { push = true } = {}) {
  const repo = parseRepoInput(repoText);
  const seq = ++state.seq;
  state.example = false;
  state.view = 'posts';
  if (!repo) { els.input.value = String(repoText || '').trim(); renderError({ kind: 'bad_input', message: '' }); els.input.focus(); return; }
  const count = clampCount(els.n.value);
  if (push) {
    const q = new URLSearchParams({ repo });
    if (state.range === 'commits') { q.set('range', 'commits'); q.set('n', String(count)); }
    if (TEST_API) q.set('api', TEST_API);
    history.replaceState(null, '', `?${q}#tool`);
  }
  els.input.value = repo;
  setBusy(true);
  renderLoading(repo);
  const onStep = (s) => { const el = $('#stepline'); if (el && seq === state.seq) el.textContent = s; };
  const opts = { repo, range: state.range, count, onStep, baseUrl: GITHUB };
  let r;
  try {
    r = await generate(opts);
  } catch (err) {
    if (err.kind === 'rate_limited') {
      onStep('Your hourly GitHub limit is used up, trying through shillcli.com');
      try { r = await generate({ ...opts, baseUrl: 'https://api.github.com', fetch: proxyFetch }); r.proxied = true; } catch (err2) { if (seq === state.seq) renderError(['network', 'unknown'].includes(err2.kind) ? err : err2, repo); }
    } else if (seq === state.seq) renderError(err, repo);
  }
  if (seq !== state.seq) return;
  setBusy(false);
  if (r) { state.result = r; renderResult(r); }
}

function setBusy(on) {
  state.busy = on;
  els.go.disabled = on;
  els.go.innerHTML = on ? '<span class="spin"></span>Reading commits' : 'Write the drafts';
}

function setRange(range) {
  state.range = range === 'commits' ? 'commits' : 'release';
  document.querySelectorAll('[data-range]').forEach((b) => { const on = b.dataset.range === state.range; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  els.n.disabled = state.range !== 'commits';
}

async function showExample() {
  state.example = true;
  try { const r = await generate({ repo: 'acme/rocket', fetch: demoFetch, baseUrl: 'https://api.github.com' }); state.result = r; renderResult(r); } catch { /* the page still works without it */ }
}

/* ---------- events ---------- */

els.form.addEventListener('submit', (e) => { e.preventDefault(); if (!state.busy) run(els.input.value); });
els.n.addEventListener('change', () => { if (state.range === 'commits' && state.result && !state.example) run(els.input.value); });

document.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const text = copy.dataset.copy;
    try { await navigator.clipboard.writeText(text); } catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
    copy.textContent = 'Copied'; copy.classList.add('done');
    setTimeout(() => { copy.textContent = copy.dataset.label || 'Copy'; copy.classList.remove('done'); }, 1400);
    return;
  }
  const ex = e.target.closest('[data-example]');
  if (ex) { e.preventDefault(); els.input.value = ex.dataset.example; setRange('release'); run(ex.dataset.example); return; }
  const rg = e.target.closest('[data-range]');
  if (rg) { setRange(rg.dataset.range); if (state.result && !state.example && !state.busy) run(els.input.value); return; }
  const sw = e.target.closest('[data-switch]');
  if (sw) { setRange(sw.dataset.switch); run(els.input.value); return; }
  const v = e.target.closest('[data-view]');
  if (v && state.result) { state.view = v.dataset.view; renderResult(state.result); return; }
  if (e.target.closest('[data-retry]')) { run(els.input.value); return; }
  const m = e.target.closest('[data-more]');
  if (m) { const pv = m.closest('.pv'); pv.classList.toggle('open'); m.textContent = pv.classList.contains('open') ? 'Show less' : 'Show full post'; }
});

/* ---------- start ---------- */

const n0 = params.get('n');
if (n0) els.n.value = String([10, 20, 30, 50, 100].includes(clampCount(n0)) ? clampCount(n0) : 30);
setRange(params.get('range'));
if (params.get('repo')) run(params.get('repo'), { push: false });
else showExample();
window.__shill = { state, run };
