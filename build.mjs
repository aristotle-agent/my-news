// Builds a private, ad-free news homepage from RSS feeds.
// Output: public/index.html (homepage) + public/a/<id>.html (reader-view articles).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';

const OUT = 'public';
// Cache lives OUTSIDE public on purpose: anything under public/ is copied
// verbatim to the published site by StatiCrypt, so a cache file there would
// publish every article's full text in plaintext, bypassing the password.
const CACHE = path.join('.cache', 'data.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MIN_FULLTEXT = 1500; // feed content shorter than this is treated as a summary

const parser = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': UA },
  customFields: { item: [['media:content', 'mediaContent', { keepArray: true }], ['media:thumbnail', 'mediaThumb'], ['content:encoded', 'contentEncoded']] },
});
const { window } = new JSDOM('');
const DOMPurify = createDOMPurify(window);

const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const idFor = (link) => crypto.createHash('sha1').update(link).digest('hex').slice(0, 12);

function clean(html, baseUrl) {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  const doc = dom.window.document;
  // Make relative image/link URLs absolute; prefer lazy-load sources.
  doc.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src');
    if (src) img.setAttribute('src', new URL(src, baseUrl).href);
    ['srcset', 'sizes', 'data-src', 'data-lazy-src', 'data-srcset'].forEach(a => img.removeAttribute(a));
    img.setAttribute('loading', 'lazy');
  });
  doc.querySelectorAll('a[href]').forEach(a => { a.href = new URL(a.getAttribute('href'), baseUrl).href; a.target = '_blank'; a.rel = 'noopener'; });
  return DOMPurify.sanitize(doc.body.innerHTML, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'button', 'svg', 'noscript', 'aside'],
    FORBID_ATTR: ['style', 'class', 'id', 'onclick', 'onerror'],
    ADD_ATTR: ['target', 'loading'],
  });
}

function thumbOf(item, html) {
  const mc = item.mediaContent?.find(m => m?.$?.url && (!m.$.medium || m.$.medium === 'image'));
  if (mc) return mc.$.url;
  if (item.mediaThumb?.$?.url) return item.mediaThumb.$.url;
  if (item.enclosure?.url && /image/.test(item.enclosure.type || 'image')) return item.enclosure.url;
  const m = html && html.match(/<img[^>]+src="([^"]+)"/i);
  return m ? m[1] : null;
}

function teaser(item, html) {
  const text = (item.contentSnippet || new JSDOM(`<body>${html || ''}</body>`).window.document.body.textContent || '')
    .replace(/\s+/g, ' ').trim();
  return text.length > 180 ? text.slice(0, 177).replace(/\s\S*$/, '') + '…' : text;
}

async function fetchArticle(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const dom = new JSDOM(await res.text(), { url });
  const art = new Readability(dom.window.document).parse();
  if (!art?.content) throw new Error('no readable content');
  return art.content;
}

async function loadFeed(feeds) {
  let lastErr;
  for (const url of [].concat(feeds)) {
    // Feeds occasionally stall for one request (observed live: a feed that
    // times out once parses in <1s on the next try). Retry before giving up.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await parser.parseURL(url); }
      catch (e) { lastErr = e; if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt)); }
    }
  }
  throw lastErr;
}

async function buildSource(src, old) {
  const feed = await loadFeed(src.feed);
  const items = [];
  for (const item of feed.items.slice(0, src.limit)) {
    if (!item.link) continue;
    const id = idFor(item.link);
    let body = item.contentEncoded || item.content || '';
    let full = body.length >= MIN_FULLTEXT;
    if (!full) {
      const prev = old?.items?.find(i => i.id === id && i.full);
      if (prev) { items.push(prev); continue; }           // reuse earlier extraction
      try { body = await fetchArticle(item.link); full = true; } catch { /* keep feed summary */ }
    }
    const html = clean(body, item.link);
    items.push({
      id, full, title: item.title?.trim() || '(untitled)', link: item.link,
      date: item.isoDate || item.pubDate || null,
      thumb: thumbOf(item, html), teaser: teaser(item, html), html,
    });
  }
  return { ok: true, updated: new Date().toISOString(), items };
}

const css = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1b1b1b;--muted:#6b6b6b;--line:#e4e2dc}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1d1d1d;--ink:#ececec;--muted:#9a9a9a;--line:#2c2c2c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:16px}
h1.site{font-size:22px;margin:8px 0 4px}.stamp{color:var(--muted);font-size:13px;margin-bottom:16px}
details{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 14px;overflow:hidden}
summary{list-style:none;cursor:pointer;padding:14px 16px;font-weight:700;font-size:18px;display:flex;align-items:center;gap:10px;border-left:6px solid var(--accent)}
summary::-webkit-details-marker{display:none}summary .n{margin-left:auto;color:var(--muted);font-weight:500;font-size:13px}
summary::after{content:"▾";color:var(--muted);transition:transform .2s}details:not([open]) summary::after{transform:rotate(-90deg)}
.lead{display:block;text-decoration:none;color:inherit;border-top:1px solid var(--line)}
.lead img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
.lead h2{font-size:22px;line-height:1.25;margin:12px 16px 4px}.lead p{margin:0 16px 14px;color:var(--muted)}
.row{display:flex;gap:12px;padding:12px 16px;border-top:1px solid var(--line);text-decoration:none;color:inherit}
.row img{width:96px;height:72px;object-fit:cover;border-radius:6px;flex:none;background:var(--line)}
.row h3{font-size:16px;line-height:1.3;margin:0 0 4px}.row p{margin:0;font-size:13px;color:var(--muted)}
.err{padding:12px 16px;color:var(--muted);border-top:1px solid var(--line)}
article{background:var(--card);border-radius:12px;padding:20px 18px;border-top:6px solid var(--accent)}
article h1{font-size:28px;line-height:1.2;margin:4px 0 8px}.meta{color:var(--muted);font-size:13px;margin-bottom:16px}
.body{font-family:Georgia,"Iowan Old Style",serif;font-size:19px;line-height:1.65}
.body img,.body video{max-width:100%;height:auto;border-radius:6px;display:block;margin:14px auto}
.body figure{margin:16px 0}.body figcaption{font-family:-apple-system,sans-serif;font-size:13px;color:var(--muted)}
.body a{color:var(--accent)}.body blockquote{border-left:3px solid var(--line);margin:0;padding-left:14px;color:var(--muted)}
.nav{display:flex;justify-content:space-between;margin:12px 0;font-size:14px}.nav a{color:var(--muted);text-decoration:none}
`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${css}</style></head><body><div class="wrap">${body}</div></body></html>`;

const when = d => d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

function homepage(sources, data) {
  const sections = sources.map((src, i) => {
    const d = data[src.id];
    const items = d?.items || [];
    const [lead, ...rest] = items;
    const inner = !items.length
      ? `<div class="err">Couldn't load this feed on the last update.</div>`
      : `<a class="lead" href="a/${lead.id}.html">${lead.thumb ? `<img src="${esc(lead.thumb)}" alt="" loading="lazy">` : ''}
           <h2>${esc(lead.title)}</h2><p>${esc(lead.teaser)}</p></a>` +
        rest.map(it => `<a class="row" href="a/${it.id}.html">${it.thumb ? `<img src="${esc(it.thumb)}" alt="" loading="lazy">` : ''}
           <div><h3>${esc(it.title)}</h3><p>${esc(when(it.date))}</p></div></a>`).join('');
    return `<details style="--accent:${src.accent}"${i === 0 ? ' open' : ''}>
      <summary>${esc(src.name)}<span class="n">${items.length} stories</span></summary>${inner}</details>`;
  }).join('\n');
  return page('My News', `<h1 class="site">My News</h1><div class="stamp">Updated ${esc(when(new Date()))} ET</div>${sections}`);
}

function articlePage(src, it) {
  return page(it.title, `<div class="nav"><a href="../index.html">← My News</a><a href="${esc(it.link)}" target="_blank" rel="noopener">Original ↗</a></div>
  <article style="--accent:${src.accent}"><div class="meta">${esc(src.name)} · ${esc(when(it.date))}</div>
  <h1>${esc(it.title)}</h1><div class="body">${it.html}</div>
  ${it.full ? '' : `<p class="meta">Only a summary was available. <a href="${esc(it.link)}" target="_blank" rel="noopener">Read the full story ↗</a></p>`}
  </article>`);
}

async function main() {
  const sources = JSON.parse(await fs.readFile('sources.json', 'utf8'));
  let old = {};
  try { old = JSON.parse(await fs.readFile(CACHE, 'utf8')); } catch {}
  const data = {};
  for (const src of sources) {
    try { data[src.id] = await buildSource(src, old[src.id]); console.log(`✓ ${src.name}: ${data[src.id].items.length}`); }
    catch (e) { data[src.id] = old[src.id] || { ok: false, items: [] }; console.log(`✗ ${src.name}: ${e.message} (kept previous)`); }
  }
  await fs.rm(path.join(OUT, 'a'), { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, 'a'), { recursive: true });
  for (const src of sources) for (const it of data[src.id].items) await fs.writeFile(path.join(OUT, 'a', `${it.id}.html`), articlePage(src, it));
  await fs.writeFile(path.join(OUT, 'index.html'), homepage(sources, data));
  await fs.mkdir(path.dirname(CACHE), { recursive: true });
  await fs.writeFile(CACHE, JSON.stringify(data));
  await fs.writeFile(path.join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
}
main();
